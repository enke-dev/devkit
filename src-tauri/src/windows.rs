//! Opening a second comparison, and what each platform calls it.
//!
//! A comparison is a window: its own webview, its own panes, its own session.
//! What differs between platforms is only how those windows are *presented*.
//! macOS groups windows that share a tabbing identifier into one tabbed window,
//! which is real system behaviour — the tab overview, ⌘⇧[ and ⌘⇧], dragging a
//! tab out into a window of its own, Merge All Windows — and none of it is
//! something an app can imitate convincingly. Windows and Linux have no
//! equivalent, so there the windows stay windows.
//!
//! Nothing below this file knows which of the two happened. The sidecar, the
//! frame channel and the frontend see a second session either way.

use tauri::{AppHandle, Manager, WebviewUrl, WebviewWindow, WebviewWindowBuilder};

/// What a comparison's window is called.
///
/// `main` is the one the config opens; the rest are numbered from here. The
/// shape matters twice over: it is the session id the sidecar keys everything
/// by, and it is what `capabilities/default.json` matches with `s*`.
const LABEL_PREFIX: &str = "s";

/// The size a comparison opens at when there is none to copy.
///
/// The same numbers as the configured first window, because this is the same
/// thing: a window that opens smaller than the one it came from would show the
/// panes narrower for no reason anybody asked for.
const DEFAULT_SIZE: (f64, f64) = (1600.0, 960.0);
const MIN_SIZE: (f64, f64) = (900.0, 600.0);

/// Everything opened from one identifier can be tabbed together, and nothing
/// else can join them. Reversed-domain because it is global to the machine.
#[cfg(target_os = "macos")]
const TABBING_IDENTIFIER: &str = "dev.enke.devkit.comparison";

/// The window a new comparison should open beside.
///
/// The focused one, which on macOS is also the tab group the new tab joins.
/// Nothing is focused when the app is in the background, so the first window
/// stands in — a new tab has to be somebody's.
fn host(app: &AppHandle) -> Option<WebviewWindow> {
    let windows = app.webview_windows();
    let comparisons = || {
        windows
            .values()
            .filter(|window| is_comparison(window.label()))
            .cloned()
    };
    comparisons()
        .find(|window| window.is_focused().unwrap_or(false))
        .or_else(|| comparisons().next())
}

/// Whether a label names a comparison rather than one of its inspectors.
fn is_comparison(label: &str) -> bool {
    label == "main" || label.starts_with(LABEL_PREFIX) && label[1..].chars().all(char::is_numeric)
}

/// The lowest number nobody is using.
///
/// Reused rather than counted up: a session's label is in its frames' URLs and
/// in its stored trail, and closing the fourth window should not mean the next
/// one is `s5` forever. Asked of Tauri rather than kept here, because Tauri is
/// what would refuse a duplicate.
fn next_label(app: &AppHandle) -> String {
    let taken = app.webview_windows();
    (1..)
        .map(|number| format!("{LABEL_PREFIX}{number}"))
        .find(|label| !taken.contains_key(label))
        .unwrap_or_else(|| unreachable!("the numbers do not run out"))
}

/// Gather every comparison into one tabbed window.
///
/// The counterpart to dragging a tab out, and the way back from a window that
/// was opened before tabbing was asked for — or on a machine where somebody has
/// told macOS never to prefer tabs. AppKit does the work: it knows which
/// windows share a tabbing identifier and may be merged, and it is the one
/// thing here that would be wrong to reimplement.
#[cfg(target_os = "macos")]
pub fn merge_all(app: &AppHandle) {
    let Some(window) = host(app) else { return };
    macos::merge_all(app, window.label());
}

/// Take the current tab out into a window of its own.
///
/// The inverse, and here because the drag that does it is not discoverable and
/// is awkward on a trackpad. Both directions belong in the menu or neither
/// does: a Merge All Windows with no way back is a one-way door.
#[cfg(target_os = "macos")]
pub fn move_to_new_window(app: &AppHandle) {
    let Some(window) = host(app) else { return };
    macos::move_to_new_window(app, window.label());
}

/// Make the window the app already has one that prefers tabs.
///
/// The configured first window is built by Tauri before anything here runs, so
/// it is the one window that never goes through `open`, and the one that would
/// otherwise still be asking macOS for its opinion about tabs.
pub fn adopt_first_window(app: &AppHandle) {
    #[cfg(target_os = "macos")]
    if let Some(window) = host(app) {
        macos::prepare(app, window.label());
    }
    #[cfg(not(target_os = "macos"))]
    let _ = app;
}

/// Open another comparison, as a tab where the platform has them.
pub fn open(app: &AppHandle) -> Result<String, String> {
    let label = next_label(app);
    let beside = host(app);

    // The size of the window it came from, so a new tab matches the one it
    // opened beside rather than snapping back to the configured default.
    let (width, height) = beside
        .as_ref()
        .and_then(|window| Some((window.inner_size().ok()?, window.scale_factor().ok()?)))
        .map(|(size, scale)| {
            let logical = size.to_logical::<f64>(scale);
            (logical.width, logical.height)
        })
        .unwrap_or(DEFAULT_SIZE);

    let builder = WebviewWindowBuilder::new(app, &label, WebviewUrl::App("index.html".into()))
        .title("DevKit")
        .inner_size(width, height)
        .min_inner_size(MIN_SIZE.0, MIN_SIZE.1)
        .resizable(true);

    // Set at creation rather than afterwards: a window that was born without an
    // identifier has already been placed, and joining a tab group after the
    // fact is a visible jump.
    #[cfg(target_os = "macos")]
    let builder = builder.tabbing_identifier(TABBING_IDENTIFIER);

    let window = builder.build().map_err(|error| error.to_string())?;

    #[cfg(target_os = "macos")]
    macos::group(
        app,
        beside.as_ref().map(|window| window.label().to_string()),
        &label,
    );
    #[cfg(not(target_os = "macos"))]
    let _ = (&window, &beside);

    let _ = window.set_focus();
    Ok(label)
}

/// Make the new window a tab of the one it was opened from.
///
/// Tauri sets the tabbing identifier and stops there, which is not enough: a
/// window whose tabbing mode is the default `automatic` defers to the user's
/// "Prefer tabs when opening documents" setting, and that is "in full screen
/// only" out of the box — so asking for a tab would open a window instead, on
/// most machines, for no reason the person could see. Saying `preferred` and
/// then adding the window to the group says what was actually meant.
#[cfg(target_os = "macos")]
mod macos {
    use objc2_app_kit::{NSWindow, NSWindowOrderingMode, NSWindowTabbingMode};
    use tauri::{AppHandle, Manager};

    pub fn group(app: &AppHandle, beside: Option<String>, label: &str) {
        on_window(app, label, move |app, opened| {
            let host = beside
                .as_deref()
                .and_then(|label| app.get_webview_window(label))
                .and_then(|window| window.ns_window().ok());
            if let Some(host) = host {
                // Safety: the pointer is that window's own `NSWindow`, and this
                // runs on the thread that owns it.
                let host = unsafe { &*(host as *mut NSWindow) };
                host.addTabbedWindow_ordered(opened, NSWindowOrderingMode::Above);
            }
        });
    }

    /// Give a window the tabbing behaviour without adding it to a group.
    pub fn prepare(app: &AppHandle, label: &str) {
        on_window(app, label, |_, _| {});
    }

    /// Ask AppKit to merge every mergeable window into this one.
    pub fn merge_all(app: &AppHandle, label: &str) {
        on_window(app, label, |_, window| window.mergeAllWindows(None));
    }

    /// Ask AppKit to put this tab in a window of its own.
    pub fn move_to_new_window(app: &AppHandle, label: &str) {
        on_window(app, label, |_, window| window.moveTabToNewWindow(None));
    }

    /// Run something with a window's `NSWindow`, on the thread AppKit insists on.
    ///
    /// Everything common to a window that can be tabbed happens here — the
    /// tabbing mode, and the method that puts a `+` in the bar — so the first
    /// window and every one after it are the same kind of window.
    fn on_window(
        app: &AppHandle,
        label: &str,
        then: impl FnOnce(&AppHandle, &NSWindow) + Send + 'static,
    ) {
        let app = app.clone();
        let label = label.to_string();
        let queued = app.clone().run_on_main_thread(move || {
            let Some(window) = app.get_webview_window(&label) else {
                return;
            };
            let Ok(pointer) = window.ns_window() else {
                return;
            };

            // Safety: `ns_window` hands back this window's own `NSWindow`, and
            // this runs on the thread that owns it.
            let window = unsafe { &*(pointer as *mut NSWindow) };
            window.setTabbingMode(NSWindowTabbingMode::Preferred);
            then(&app, window);
        });
        if let Err(error) = queued {
            crate::note!("[devkit] could not reach the main thread to tab the window: {error}");
        }
    }
}
