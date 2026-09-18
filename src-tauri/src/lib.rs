mod cursors;
#[macro_use]
mod notes;
mod frame_channel;
mod frames;
mod protocol;
mod sidecar;

use tauri::menu::{MenuBuilder, MenuItemBuilder, SubmenuBuilder};
use tauri::{Emitter, Manager, RunEvent};

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

/// The one thing worth a menu: asking whether there is a newer DevKit.
///
/// The check on the way up answers that once, and a window that has been open
/// since yesterday has no way to ask again. Where it belongs differs by
/// platform and both conventions are followed: the application menu on macOS,
/// where everything of this kind lives, and a Help menu elsewhere, which is
/// where Windows and Linux put it.
fn install_menu(app: &tauri::AppHandle) -> tauri::Result<()> {
    let check = MenuItemBuilder::with_id("check-for-updates", "Check for Updates…").build(app)?;

    #[cfg(target_os = "macos")]
    let menu = {
        let application = SubmenuBuilder::new(app, "DevKit")
            .item(&check)
            .separator()
            .services()
            .separator()
            .hide()
            .hide_others()
            .show_all()
            .separator()
            .quit()
            .build()?;
        // Without an Edit menu the standard editing shortcuts stop working in
        // the address bar: on macOS they are the menu, not the text field.
        let edit = SubmenuBuilder::new(app, "Edit")
            .undo()
            .redo()
            .separator()
            .cut()
            .copy()
            .paste()
            .select_all()
            .build()?;
        MenuBuilder::new(app).items(&[&application, &edit]).build()?
    };

    #[cfg(not(target_os = "macos"))]
    let menu = {
        let help = SubmenuBuilder::new(app, "Help").item(&check).build()?;
        MenuBuilder::new(app).items(&[&help]).build()?
    };

    app.set_menu(menu)?;
    app.on_menu_event(|app, event| {
        if event.id() == "check-for-updates" {
            // The frontend owns the updater; this only says that somebody asked.
            let _ = app.emit(protocol::CHECK_FOR_UPDATES_EVENT, ());
        }
    });
    Ok(())
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
            if let Err(error) = install_menu(&app.handle().clone()) {
                eprintln!("[devkit] no menu: {error}");
            }

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
