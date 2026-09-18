//! Holds the newest frame per engine, and serves it to the webview.
//!
//! Frames do not travel to the frontend as event payloads. A frame at device
//! resolution is a couple of hundred kilobytes; as base64 inside JSON it has to
//! be parsed, `atob`-ed and copied on the webview's main thread, which saturates
//! at a fraction of the rate the engines can produce. Served over a URI scheme
//! instead, the bytes never become a JavaScript string and the webview decodes
//! them off-thread like any other image.
//!
//! A few recent frames are kept per engine, keyed by sequence. Serving only the
//! newest looks equivalent — the frontend asks for the sequence it was just told
//! about — but it is not: an engine that pushes frames continuously can replace
//! a frame between the event and the fetch, so the pane would show a live frame
//! while the UI labelled it as the settled sharp one.

use std::collections::{HashMap, VecDeque};
use std::sync::Mutex;

use tauri::http::{Request, Response, StatusCode};

/// Recent frames retained per engine. Enough to cover the gap between an event
/// being emitted and the webview fetching the image, no more.
const RETAINED_FRAMES: usize = 4;

#[derive(Default)]
pub struct FrameStore {
    engines: Mutex<HashMap<String, EngineFrames>>,
}

#[derive(Default)]
struct EngineFrames {
    recent: VecDeque<Frame>,
    /// The newest settled capture, kept outside the rolling window.
    ///
    /// An engine that pushes continuously can emit several live frames in the
    /// time it takes the webview to fetch an image, so a sharp frame held only
    /// in `recent` can be evicted before it is ever displayed — the pane then
    /// shows a live frame while the UI labels it sharp.
    sharp: Option<Frame>,
}

pub struct Frame {
    seq: u64,
    mime: String,
    bytes: Vec<u8>,
}

impl Frame {
    fn payload(&self) -> (String, Vec<u8>) {
        (self.mime.clone(), self.bytes.clone())
    }
}

impl FrameStore {
    pub fn store(&self, engine: String, seq: u64, mime: String, bytes: Vec<u8>, sharp: bool) {
        if let Ok(mut engines) = self.engines.lock() {
            let frames = engines.entry(engine).or_default();
            if sharp {
                frames.sharp = Some(Frame {
                    seq,
                    mime: mime.clone(),
                    bytes: bytes.clone(),
                });
            }
            frames.recent.push_back(Frame { seq, mime, bytes });
            while frames.recent.len() > RETAINED_FRAMES {
                frames.recent.pop_front();
            }
        }
    }

    /// The frame the caller asked for, falling back to the newest.
    ///
    /// The fallback covers a frame that has already aged out; showing the
    /// current picture beats showing nothing.
    fn get(&self, engine: &str, seq: Option<u64>) -> Option<(String, Vec<u8>)> {
        let engines = self.engines.lock().ok()?;
        let frames = engines.get(engine)?;

        if let Some(seq) = seq {
            if let Some(frame) = frames.recent.iter().find(|frame| frame.seq == seq) {
                return Some(frame.payload());
            }
            if let Some(sharp) = frames.sharp.as_ref().filter(|frame| frame.seq == seq) {
                return Some(sharp.payload());
            }
            crate::note!("[devkit] frame {engine}/{seq} aged out before it was fetched");
        }

        frames.recent.back().map(Frame::payload)
    }

    pub fn clear(&self) {
        if let Ok(mut engines) = self.engines.lock() {
            engines.clear();
        }
    }
}

/// Serve `devkit-frame://<engine>/<seq>`.
///
/// A segment that is not a sequence number asks for whatever this engine last
/// rendered, which is how a webview that just loaded gets a picture: it missed
/// the events naming the sequences, and the pane it is drawing may be settled
/// and about to produce nothing further.
pub fn respond(store: &FrameStore, request: &Request<Vec<u8>>) -> Response<Vec<u8>> {
    // Everything is read from the path and the host ignored: Tauri's scheme URLs
    // differ by platform (`devkit-frame://localhost/...` against
    // `http://devkit-frame.localhost/...`), and the path is the part that does not.
    let mut segments = request.uri().path().split('/').filter(|part| !part.is_empty());
    let engine = segments.next().unwrap_or_default();
    let seq = segments.next().and_then(|value| value.parse::<u64>().ok());

    let not_found = || {
        Response::builder()
            .status(StatusCode::NOT_FOUND)
            .body(Vec::new())
            .expect("static response builds")
    };

    match store.get(engine, seq) {
        Some((mime, bytes)) => Response::builder()
            .status(StatusCode::OK)
            .header("Content-Type", mime)
            // Every frame has its own URL, but say so anyway: a cached frame
            // would freeze the pane.
            .header("Cache-Control", "no-store")
            .body(bytes)
            .unwrap_or_else(|_| not_found()),
        None => not_found(),
    }
}
