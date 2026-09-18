//! Receives frames from the sidecar over a loopback socket.
//!
//! Frames do not come over stdout. That carries newline-delimited JSON, so the
//! image would have to be base64 — a third larger, and a JSON parse of a few
//! hundred kilobytes for every frame, on top of the decode. A socket carries the
//! bytes as they are.
//!
//! The listener binds to port 0 on loopback and hands the port and a token to
//! the sidecar through its environment. The sidecar sends the token first, and a
//! connection that does not match is dropped: nothing else on the machine gets
//! to push pictures into the window.
//!
//! The wire format is described in `packages/protocol/src/index.ts`.

use std::io::Read;
use std::net::{Ipv4Addr, SocketAddr, SocketAddrV4, TcpListener, TcpStream};

use tauri::{AppHandle, Emitter, Manager};

use crate::frames::FrameStore;
use crate::protocol::SIDECAR_EVENT;

/// Engines, in the order the protocol's `ENGINES` declares them.
const ENGINES: [&str; 3] = ["chromium", "firefox", "webkit"];

const HEADER_BYTES: usize = 16;
const TOKEN_BYTES: usize = 32;

/// A frame larger than this is a framing error, not a screenshot.
const MAX_FRAME_BYTES: usize = 64 * 1024 * 1024;

pub struct FrameChannel {
    pub port: u16,
    pub token: String,
}

/// Start listening, and serve connections until the app exits.
pub fn listen(app: &AppHandle) -> std::io::Result<FrameChannel> {
    let listener = TcpListener::bind(SocketAddr::V4(SocketAddrV4::new(Ipv4Addr::LOCALHOST, 0)))?;
    let port = listener.local_addr()?.port();
    let token = random_token();
    if token.is_empty() {
        return Err(std::io::Error::other("no random source for the frame channel token"));
    }

    let expected = token.clone();
    let app = app.clone();
    std::thread::spawn(move || {
        for stream in listener.incoming() {
            let Ok(stream) = stream else { continue };
            let app = app.clone();
            let expected = expected.clone();
            // One connection per sidecar; a relaunched sidecar brings a new one.
            std::thread::spawn(move || serve(app, stream, expected));
        }
    });

    Ok(FrameChannel { port, token })
}

/// A token only our own sidecar can present.
///
/// It guards a port anything on the machine can reach, so it comes from the
/// operating system's random source rather than from the clock and the process
/// id, which are both guessable by whoever would want to guess them.
fn random_token() -> String {
    let mut bytes = [0_u8; TOKEN_BYTES / 2];
    if getrandom::fill(&mut bytes).is_err() {
        // Falling back to something guessable would be worse than not listening.
        return String::new();
    }
    bytes.iter().map(|byte| format!("{byte:02x}")).collect()
}

fn serve(app: AppHandle, mut stream: TcpStream, expected: String) {
    let mut token = [0_u8; TOKEN_BYTES];
    if stream.read_exact(&mut token).is_err() || token != expected.as_bytes() {
        crate::note!("[devkit] rejected a frame connection with the wrong token");
        return;
    }

    let store = app.state::<FrameStore>();
    let mut header = [0_u8; HEADER_BYTES];

    loop {
        if stream.read_exact(&mut header).is_err() {
            // The sidecar went away; its panes are reported closed by other means.
            return;
        }

        let length = u32::from_le_bytes([header[0], header[1], header[2], header[3]]) as usize;
        if length == 0 || length > MAX_FRAME_BYTES {
            crate::note!("[devkit] frame channel out of step ({length} bytes); dropping the connection");
            return;
        }

        let mut payload = vec![0_u8; length];
        if stream.read_exact(&mut payload).is_err() {
            return;
        }

        let seq = u32::from_le_bytes([header[4], header[5], header[6], header[7]]) as u64;
        let width = u16::from_le_bytes([header[8], header[9]]);
        let height = u16::from_le_bytes([header[10], header[11]]);
        let Some(engine) = ENGINES.get(header[12] as usize) else {
            crate::note!("[devkit] frame for unknown engine index {}", header[12]);
            continue;
        };
        let sharp = header[13] == 1;
        let mime = if header[14] == 1 { "image/png" } else { "image/jpeg" };

        store.store((*engine).to_string(), seq, mime.to_string(), payload, sharp);

        // The frontend is told a frame exists; it fetches the bytes over the
        // frame scheme, exactly as before.
        let _ = app.emit(
            SIDECAR_EVENT,
            serde_json::json!({
                "type": "frame",
                "engine": engine,
                "seq": seq,
                "mime": mime,
                "width": width,
                "height": height,
                "sharp": sharp,
            }),
        );
    }
}
