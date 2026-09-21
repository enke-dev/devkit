//! Rust mirror of the parts of the wire protocol the backend itself touches.
//!
//! Command and event payloads pass through as opaque JSON; only the channel
//! names and the process-level status need typed counterparts here. Keep in
//! sync with `protocol/src/index.ts`.

use serde::Serialize;

/// URI scheme the frontend fetches frame bytes on. Mirrors `FRAME_SCHEME`.
pub const FRAME_SCHEME: &str = "devkit-frame";

/// Tauri event channel asking the frontend to look for a newer DevKit.
/// Mirrors `CHECK_FOR_UPDATES_EVENT`.
pub const CHECK_FOR_UPDATES_EVENT: &str = "devkit://check-for-updates";

/// Tauri event channel carrying every sidecar protocol event, verbatim.
pub const SIDECAR_EVENT: &str = "devkit://sidecar";

/// Tauri event channel for sidecar process lifecycle, which the sidecar itself
/// cannot report (it cannot announce its own crash).
pub const SIDECAR_STATUS_EVENT: &str = "devkit://sidecar-status";

/// The events that describe the process rather than one window's panes.
///
/// Mirrors `GLOBAL_EVENTS` in the protocol. These are the only ones every
/// window hears; anything else is answered to the session that asked for it.
pub const GLOBAL_EVENTS: [&str; 4] = ["hello", "browsers", "install-progress", "log"];

pub fn is_global_event(kind: &str) -> bool {
    GLOBAL_EVENTS.contains(&kind)
}

#[derive(Serialize, Clone)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum SidecarStatus {
    Spawned { pid: u32 },
    Crashed { reason: String },
    Exited { code: Option<i32> },
}
