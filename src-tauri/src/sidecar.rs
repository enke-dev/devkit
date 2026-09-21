//! Supervises the Node/Playwright sidecar process.
//!
//! The backend is deliberately a thin relay: it owns the process lifetime and
//! the stdin/stdout pipes, but does not interpret the protocol beyond what the
//! frontend needs to receive it. Message shapes live in `packages/protocol/src/index.ts`
//! and `protocol.rs`.

use std::path::PathBuf;
use std::sync::Mutex;

use tauri::{AppHandle, Emitter, Manager};
use tauri_plugin_shell::process::{CommandChild, CommandEvent};
use tauri_plugin_shell::ShellExt;

use crate::frame_channel::FrameChannel;
use crate::protocol::{is_global_event, SidecarStatus, SIDECAR_EVENT, SIDECAR_STATUS_EVENT};

/// Basename of the sidecar declared in `tauri.conf.json` as `binaries/devkit-node`.
///
/// Tauri flattens `externalBin` entries next to the app executable and drops the
/// target triple, so the lookup name here is the bare filename, not the config path.
///
/// The binary is a copy of the Node runtime rather than a compiled program:
/// Playwright needs a real Node environment and its own package layout on disk,
/// so the "binary" is the interpreter and the entry script ships as a resource.
const SIDECAR_BIN: &str = "devkit-node";

/// Handle to the running sidecar, held in Tauri's managed state.
#[derive(Default)]
pub struct Sidecar {
    child: Mutex<Option<CommandChild>>,
    /// Why the last spawn failed, if it did.
    ///
    /// The spawn happens before the window exists, so nothing is listening when
    /// it fails; the frontend learns of it from the first command it sends. That
    /// used to be a bare "not running", which after an update that shipped the
    /// sidecar in the wrong place said nothing about where to look.
    failure: Mutex<Option<String>>,
}

impl Sidecar {
    /// Write one newline-delimited JSON command to the sidecar's stdin.
    pub fn send(&self, request: &serde_json::Value) -> Result<(), String> {
        let mut guard = self.child.lock().map_err(|_| "sidecar lock poisoned".to_string())?;
        let child = guard.as_mut().ok_or_else(|| match self.failure.lock() {
            Ok(failure) => match failure.as_deref() {
                Some(reason) => format!("sidecar is not running: {reason}"),
                None => "sidecar is not running".to_string(),
            },
            Err(_) => "sidecar is not running".to_string(),
        })?;
        let mut line = serde_json::to_vec(request).map_err(|error| error.to_string())?;
        line.push(b'\n');
        child.write(&line).map_err(|error| error.to_string())
    }

    /// Stop the sidecar. Safe to call when it is already gone.
    pub fn kill(&self) {
        let Ok(mut guard) = self.child.lock() else { return };
        if let Some(child) = guard.take() {
            let _ = child.kill();
        }
    }

    fn remember_failure(&self, reason: Option<String>) {
        if let Ok(mut failure) = self.failure.lock() {
            *failure = reason;
        }
    }

    fn adopt(&self, child: CommandChild) {
        self.remember_failure(None);
        if let Ok(mut guard) = self.child.lock() {
            // Replacing a live child would leak it, so retire the old one first.
            if let Some(previous) = guard.take() {
                let _ = previous.kill();
            }
            *guard = Some(child);
        }
    }
}

/// Absolute path to the sidecar's entry script.
///
/// In a bundled app it sits in the resource directory. In development it is the
/// TypeScript build output in the workspace, so `bun run sidecar:dev` rebuilds are
/// picked up by restarting the app rather than by reinstalling anything.
fn entry_script(app: &AppHandle) -> Result<PathBuf, String> {
    if cfg!(debug_assertions) {
        let workspace = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .parent()
            .ok_or_else(|| "cannot locate workspace root".to_string())?
            .join("packages/sidecar/dist/index.js");
        if workspace.exists() {
            return Ok(workspace);
        }
        return Err(format!(
            "sidecar build missing at {}; run `bun run build:libs`",
            workspace.display()
        ));
    }

    let resource = app
        .path()
        .resource_dir()
        .map_err(|error| error.to_string())?
        .join("sidecar/dist/index.js");
    if resource.exists() {
        Ok(resource)
    } else {
        Err(format!("sidecar resource missing at {}", resource.display()))
    }
}

/// Spawn the sidecar and pump its stdout into Tauri events.
pub fn spawn(app: &AppHandle) -> Result<(), String> {
    let result = try_spawn(app);
    if let Err(reason) = &result {
        app.state::<Sidecar>().remember_failure(Some(reason.clone()));
    }
    result
}

fn try_spawn(app: &AppHandle) -> Result<(), String> {
    let script = entry_script(app)?;

    let mut command = app
        .shell()
        .sidecar(SIDECAR_BIN)
        .map_err(|error| format!("sidecar binary '{SIDECAR_BIN}' unavailable: {error}"))?
        .args([script.to_string_lossy().to_string()]);

    // Where to send frames, and the token proving it is our sidecar.
    if let Some(channel) = app.try_state::<FrameChannel>() {
        command = command
            .env("DEVKIT_FRAME_PORT", channel.port.to_string())
            .env("DEVKIT_FRAME_TOKEN", channel.token.clone());
    }

    let (mut rx, child) = command
        .spawn()
        .map_err(|error| format!("failed to spawn sidecar: {error}"))?;

    let pid = child.pid();
    app.state::<Sidecar>().adopt(child);
    emit_status(app, SidecarStatus::Spawned { pid });

    let app = app.clone();
    tauri::async_runtime::spawn(async move {
        while let Some(event) = rx.recv().await {
            match event {
                // The shell plugin already splits stdout on newlines, so each
                // payload is exactly one protocol message.
                CommandEvent::Stdout(bytes) => forward(&app, &bytes),
                CommandEvent::Stderr(bytes) => {
                    let text = String::from_utf8_lossy(&bytes);
                    if !text.trim().is_empty() {
                        crate::note!("[sidecar] {}", text.trim_end());
                    }
                }
                CommandEvent::Error(reason) => emit_status(&app, SidecarStatus::Crashed { reason }),
                CommandEvent::Terminated(payload) => {
                    emit_status(&app, SidecarStatus::Exited { code: payload.code })
                }
                _ => {}
            }
        }
    });

    Ok(())
}

/// Hand one sidecar message to the window it belongs to.
///
/// Still a dumb relay: the payload passes through untouched and only two fields
/// are read. `session` says which window asked, and an event without one
/// describes the process rather than a comparison — the greeting, the installed
/// browsers, a download, a log line — and goes to everybody.
///
/// A named window that has since closed is not an error worth reporting: its
/// panes are being torn down, and what they say on the way out has nobody left
/// to hear it.
fn forward(app: &AppHandle, bytes: &[u8]) {
    let text = String::from_utf8_lossy(bytes);
    let trimmed = text.trim();
    if trimmed.is_empty() {
        return;
    }
    match serde_json::from_str::<serde_json::Value>(trimmed) {
        Ok(value) => {
            let session = value
                .get("session")
                .and_then(serde_json::Value::as_str)
                .map(str::to_string);
            let kind = value.get("type").and_then(serde_json::Value::as_str).unwrap_or_default();
            match session {
                Some(label) if !is_global_event(kind) => {
                    let _ = app.emit_to(label, SIDECAR_EVENT, value);
                }
                _ => {
                    let _ = app.emit(SIDECAR_EVENT, value);
                }
            }
        }
        Err(error) => crate::note!("[sidecar] unparsable line ({error}): {trimmed}"),
    }
}

fn emit_status(app: &AppHandle, status: SidecarStatus) {
    let _ = app.emit(SIDECAR_STATUS_EVENT, status);
}
