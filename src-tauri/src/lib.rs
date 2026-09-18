mod cursors;
#[macro_use]
mod notes;
mod frame_channel;
mod frames;
mod protocol;
mod sidecar;

use tauri::{Manager, RunEvent};

use frames::FrameStore;
use sidecar::Sidecar;

/// Relay one command to the sidecar. The reply arrives asynchronously on the
/// `devkit://sidecar` event channel, correlated by the command's `id`.
#[tauri::command]
fn sidecar_send(state: tauri::State<'_, Sidecar>, request: serde_json::Value) -> Result<(), String> {
    state.send(&request)
}

/// Print a line from the frontend to the terminal.
///
/// The webview's own console is not visible when running headless or from an
/// agent-driven shell, and the frame rate a pane reports is only measurable
/// inside the webview. This is the only way to read it back.
#[tauri::command]
fn debug_log(message: String) {
    note!("[ui] {message}");
}

/// Restart the sidecar after a crash, or after the user retries a failed launch.
#[tauri::command]
fn sidecar_restart(app: tauri::AppHandle) -> Result<(), String> {
    app.state::<Sidecar>().kill();
    // Frames from the old process describe panes that no longer exist.
    app.state::<FrameStore>().clear();
    sidecar::spawn(&app)
}

pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_shell::init())
        // Updating replaces the running binary, so the app has to be able to
        // restart itself once the download is in place.
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_process::init())
        .manage(Sidecar::default())
        .manage(FrameStore::default())
        .register_uri_scheme_protocol(protocol::FRAME_SCHEME, |ctx, request| {
            frames::respond(&ctx.app_handle().state::<FrameStore>(), &request)
        })
        .invoke_handler(tauri::generate_handler![
            sidecar_send,
            sidecar_restart,
            debug_log,
            cursors::get_native_cursor_by_type
        ])
        .setup(|app| {
            // Frames arrive over their own socket rather than as base64 on
            // stdout; the sidecar is told where to connect.
            match frame_channel::listen(&app.handle().clone()) {
                Ok(channel) => {
                    app.manage(channel);
                }
                Err(error) => note!("[devkit] no frame channel: {error}"),
            }


            // A failed spawn is reported to the UI rather than aborting startup,
            // so the window can explain what is missing instead of vanishing.
            if let Err(error) = sidecar::spawn(&app.handle().clone()) {
                note!("[devkit] {error}");
            }
            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("error while building DevKit")
        .run(|app, event| {
            // Headless browsers outlive their parent unless told otherwise, so
            // the sidecar is killed explicitly on the way out.
            if matches!(event, RunEvent::ExitRequested { .. } | RunEvent::Exit) {
                app.state::<Sidecar>().kill();
            }
        });
}
