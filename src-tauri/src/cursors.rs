//! The host's own cursor images, handed to the webview as PNGs.
//!
//! A pane the pointer is not over still has to show where the input landed, and
//! the shape the engine reports — `text`, `pointer`, `wait` — has to look like
//! the shape the user would see if they were really over that page. The webview
//! cannot read the system's cursor theme, so the images are taken from the OS
//! here and cached in the frontend as data URLs.
//!
//! The hotspot travels with the image. Without it a cursor drawn at a viewport
//! coordinate is off by up to its own size: an arrow points from its top left,
//! an I-beam from its middle.

use serde::Serialize;

/// One cursor, ready to be drawn.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NativeCursor {
    /// `data:image/png;base64,…`.
    pub image: String,
    /// Where in the image the pointed-at pixel sits, in image pixels.
    pub hotspot_x: f64,
    pub hotspot_y: f64,
    /// Size of the PNG, in image pixels.
    pub width: u32,
    pub height: u32,
    /// Image pixels per CSS pixel, so the frontend can draw a Retina cursor at
    /// the size it is meant to appear rather than at twice it.
    pub scale: f64,
}

/// The shapes worth extracting, named the way CSS names them.
///
/// Every platform maps these onto its own identifiers; anything else is an
/// error rather than a silent arrow, so the frontend can fall back knowingly.
///
/// The work is handed to the main thread: AppKit vends `NSCursor` only once the
/// application is up and only from the thread it runs on — asked from anywhere
/// else it returns nothing at all. Extraction is a handful of memory copies, so
/// the main thread is held for microseconds, and only while the cache fills.
#[tauri::command]
pub async fn get_native_cursor_by_type(
    app: tauri::AppHandle,
    cursor_type: String,
) -> Result<NativeCursor, String> {
    let (sender, receiver) = tokio::sync::oneshot::channel();
    app.run_on_main_thread(move || {
        let _ = sender.send(platform::load(&cursor_type));
    })
    .map_err(|error| error.to_string())?;
    receiver
        .await
        .map_err(|_| "cursor extraction never reported back".to_string())?
}

#[cfg(windows)]
mod platform {
    use std::mem::{size_of, zeroed};
    use std::ptr::null_mut;

    use base64::Engine as _;
    use windows_sys::Win32::Graphics::Gdi::{
        BITMAP, BITMAPINFO, BITMAPINFOHEADER, BI_RGB, DIB_RGB_COLORS, DeleteObject, GetDC,
        GetDIBits, GetObjectW, HBITMAP, HDC, ReleaseDC,
    };
    use windows_sys::Win32::UI::WindowsAndMessaging::{
        GetIconInfo, ICONINFO, IDC_ARROW, IDC_CROSS, IDC_HAND, IDC_IBEAM, IDC_WAIT, LoadCursorW,
    };
    use windows_sys::core::PCWSTR;

    use super::NativeCursor;

    /// The screen DC, borrowed for as long as bitmaps are being read from it.
    struct ScreenDc(HDC);

    impl Drop for ScreenDc {
        fn drop(&mut self) {
            unsafe { ReleaseDC(null_mut(), self.0) };
        }
    }

    /// A bitmap `GetIconInfo` handed over. These are copies, not the cursor's
    /// own, and leak for the life of the process if they are not deleted.
    struct OwnedBitmap(HBITMAP);

    impl Drop for OwnedBitmap {
        fn drop(&mut self) {
            if !self.0.is_null() {
                unsafe { DeleteObject(self.0) };
            }
        }
    }

    fn resource(kind: &str) -> Result<PCWSTR, String> {
        match kind {
            "default" => Ok(IDC_ARROW),
            "text" => Ok(IDC_IBEAM),
            "hand" => Ok(IDC_HAND),
            "wait" => Ok(IDC_WAIT),
            "crosshair" => Ok(IDC_CROSS),
            other => Err(format!("unknown cursor type: {other}")),
        }
    }

    /// Measure a bitmap without reading it.
    fn describe(bitmap: HBITMAP) -> Result<BITMAP, String> {
        let mut info: BITMAP = unsafe { zeroed() };
        let written = unsafe {
            GetObjectW(
                bitmap,
                size_of::<BITMAP>() as i32,
                (&mut info as *mut BITMAP).cast(),
            )
        };
        if written == 0 {
            return Err("cursor bitmap could not be measured".into());
        }
        Ok(info)
    }

    /// Read any bitmap as top-down 32-bit BGRA.
    ///
    /// GDI converts on the way out, so a 1-bit mask arrives as black and white
    /// pixels and a 24-bit image arrives with its alpha byte zeroed — both are
    /// then handled the same way by the callers below.
    fn read(dc: &ScreenDc, bitmap: HBITMAP, width: i32, height: i32) -> Result<Vec<u8>, String> {
        let mut info: BITMAPINFO = unsafe { zeroed() };
        info.bmiHeader = BITMAPINFOHEADER {
            biSize: size_of::<BITMAPINFOHEADER>() as u32,
            biWidth: width,
            // Negative height asks for top-down rows, which is the order PNG
            // wants; the default bottom-up order would arrive flipped.
            biHeight: -height,
            biPlanes: 1,
            biBitCount: 32,
            biCompression: BI_RGB,
            ..info.bmiHeader
        };

        let mut pixels = vec![0u8; (width as usize) * (height as usize) * 4];
        let rows = unsafe {
            GetDIBits(
                dc.0,
                bitmap,
                0,
                height as u32,
                pixels.as_mut_ptr().cast(),
                &mut info,
                DIB_RGB_COLORS,
            )
        };
        if rows == 0 {
            return Err("cursor bitmap could not be read".into());
        }
        Ok(pixels)
    }

    /// A pixel of a 1-bit mask read back at 32 bits: black means the bit was 0.
    fn bit_set(mask: &[u8], index: usize) -> bool {
        mask.get(index * 4).is_some_and(|&blue| blue != 0)
    }

    /// Colour cursor: an image plus, for the older ones, a separate AND mask.
    ///
    /// Modern cursors carry a real alpha channel and the mask is redundant. The
    /// older ones have every alpha byte zero, which is indistinguishable from a
    /// fully transparent image, so the mask is what decides in that case.
    fn blend_colour(colour: &[u8], mask: &[u8]) -> Vec<u8> {
        let has_alpha = colour.chunks_exact(4).any(|pixel| pixel[3] != 0);
        colour
            .chunks_exact(4)
            .enumerate()
            .flat_map(|(index, pixel)| {
                // AND mask set means "leave the screen alone" — transparent.
                let alpha = match has_alpha {
                    true => pixel[3],
                    false if bit_set(mask, index) => 0,
                    false => 255,
                };
                [pixel[2], pixel[1], pixel[0], alpha]
            })
            .collect()
    }

    /// Monochrome cursor: no colour bitmap at all, just a mask of double height
    /// holding the AND rows above the XOR rows.
    ///
    /// The four combinations are transparent, black, white, and invert. Nothing
    /// in a webview can invert what is behind it, so that last one is drawn
    /// black — which is what it comes out as over a light page anyway.
    fn blend_mono(mask: &[u8], width: usize, height: usize) -> Vec<u8> {
        let xor_offset = width * height;
        (0..xor_offset)
            .flat_map(|index| {
                let and = bit_set(mask, index);
                let xor = bit_set(mask, xor_offset + index);
                match (and, xor) {
                    (true, false) => [0, 0, 0, 0],
                    (false, true) => [255, 255, 255, 255],
                    _ => [0, 0, 0, 255],
                }
            })
            .collect()
    }

    fn encode(rgba: Vec<u8>, width: u32, height: u32) -> Result<Vec<u8>, String> {
        let buffer = image::RgbaImage::from_raw(width, height, rgba)
            .ok_or("cursor pixels do not fill the bitmap")?;
        let mut png = std::io::Cursor::new(Vec::new());
        buffer
            .write_to(&mut png, image::ImageFormat::Png)
            .map_err(|error| error.to_string())?;
        Ok(png.into_inner())
    }

    pub fn load(kind: &str) -> Result<NativeCursor, String> {
        let name = resource(kind)?;

        // Shared with the whole system: never destroyed, only the bitmaps
        // `GetIconInfo` copies out below belong to us.
        let cursor = unsafe { LoadCursorW(null_mut(), name) };
        if cursor.is_null() {
            return Err(format!("no system cursor for {kind}"));
        }

        let mut icon: ICONINFO = unsafe { zeroed() };
        if unsafe { GetIconInfo(cursor, &mut icon) } == 0 {
            return Err(format!("cursor {kind} has no bitmaps"));
        }
        let mask = OwnedBitmap(icon.hbmMask);
        let colour = OwnedBitmap(icon.hbmColor);

        let dc = ScreenDc(unsafe { GetDC(null_mut()) });
        if dc.0.is_null() {
            return Err("no screen device context".into());
        }

        let mask_shape = describe(mask.0)?;
        let (width, height, rgba) = match colour.0.is_null() {
            false => {
                let shape = describe(colour.0)?;
                let pixels = read(&dc, colour.0, shape.bmWidth, shape.bmHeight)?;
                let mask_pixels = read(&dc, mask.0, shape.bmWidth, shape.bmHeight)?;
                (
                    shape.bmWidth,
                    shape.bmHeight,
                    blend_colour(&pixels, &mask_pixels),
                )
            }
            true => {
                // Both masks are stacked in the one bitmap.
                let height = mask_shape.bmHeight / 2;
                let pixels = read(&dc, mask.0, mask_shape.bmWidth, mask_shape.bmHeight)?;
                (
                    mask_shape.bmWidth,
                    height,
                    blend_mono(&pixels, mask_shape.bmWidth as usize, height as usize),
                )
            }
        };

        let png = encode(rgba, width as u32, height as u32)?;
        Ok(NativeCursor {
            image: format!(
                "data:image/png;base64,{}",
                base64::engine::general_purpose::STANDARD.encode(png)
            ),
            hotspot_x: f64::from(icon.xHotspot),
            hotspot_y: f64::from(icon.yHotspot),
            width: width as u32,
            height: height as u32,
            // `LoadCursorW` hands back the cursor at the size the system draws
            // it, so its pixels are already CSS pixels.
            scale: 1.0,
        })
    }
}

#[cfg(target_os = "macos")]
mod platform {
    use base64::Engine as _;
    use objc2::rc::Retained;
    use objc2::runtime::AnyObject;
    use objc2_app_kit::{
        NSBitmapImageFileType, NSBitmapImageRep, NSBitmapImageRepPropertyKey, NSCursor,
    };
    use objc2_foundation::NSDictionary;

    use super::NativeCursor;

    pub fn load(kind: &str) -> Result<NativeCursor, String> {
        // AppKit vends these as shared objects; reading their images does not
        // touch the window server, so no main-thread hop is needed.
        let cursor = match kind {
            "default" => NSCursor::arrowCursor(),
            "text" => NSCursor::IBeamCursor(),
            "hand" => NSCursor::pointingHandCursor(),
            "crosshair" => NSCursor::crosshairCursor(),
            // The spinning wait cursor is drawn by the window server and has no
            // public NSCursor; the frontend keeps its drawn stand-in for it.
            "wait" => return Err("macOS has no public wait cursor".into()),
            other => return Err(format!("unknown cursor type: {other}")),
        };

        let image = cursor.image();
        let tiff = image
            .TIFFRepresentation()
            .ok_or("cursor image has no bitmap")?;
        let rep = NSBitmapImageRep::imageRepWithData(&tiff).ok_or("cursor bitmap unreadable")?;

        let properties: Retained<NSDictionary<NSBitmapImageRepPropertyKey, AnyObject>> =
            NSDictionary::new();
        let png = unsafe { rep.representationUsingType_properties(NSBitmapImageFileType::PNG, &properties) }
            .ok_or("cursor bitmap could not be encoded as PNG")?;

        let width = rep.pixelsWide() as f64;
        let height = rep.pixelsHigh() as f64;
        // The image is in points and the bitmap in pixels; on a Retina display
        // the second is twice the first, and drawing it 1:1 would double it.
        let size = image.size();
        let scale = match size.width > 0.0 {
            true => width / size.width,
            false => 1.0,
        };

        let hotspot = cursor.hotSpot();
        Ok(NativeCursor {
            image: format!(
                "data:image/png;base64,{}",
                base64::engine::general_purpose::STANDARD.encode(png.to_vec())
            ),
            // The hotspot is quoted in points, like the image's own size.
            hotspot_x: hotspot.x * scale,
            hotspot_y: hotspot.y * scale,
            width: width as u32,
            height: height as u32,
            scale,
        })
    }
}

#[cfg(not(any(windows, target_os = "macos")))]
mod platform {
    use super::NativeCursor;

    pub fn load(kind: &str) -> Result<NativeCursor, String> {
        Err(format!("no native cursor for {kind} on this platform"))
    }
}
