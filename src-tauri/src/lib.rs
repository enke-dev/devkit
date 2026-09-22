mod cursors;
#[macro_use]
mod notes;
mod frame_channel;
mod frames;
mod protocol;
mod sessions;
mod sidecar;
mod windows;

use tauri::menu::{MenuBuilder, MenuItemBuilder, SubmenuBuilder};
use tauri::{Emitter, Manager, RunEvent, WindowEvent};

use frames::FrameStore;
use sessions::Sessions;
use sidecar::Sidecar;

/// Relay one command to the sidecar. The reply arrives asynchronously on the
/// `devkit://sidecar` event channel, correlated by the command's `id`.
///
/// The session is stamped here, from the webview that invoked the command,
/// rather than being sent by the frontend. A window cannot then claim to be
/// another one, cannot forget to say which it is, and does not have to be told
/// its own name to send its first command. `slot` rides along for the frame
/// headers, which have room for a byte and not for a label.
#[tauri::command]
fn sidecar_send(
    webview: tauri::Webview,
    state: tauri::State<'_, Sidecar>,
    sessions: tauri::State<'_, Sessions>,
    request: serde_json::Value,
) -> Result<(), String> {
    let label = webview.label().to_string();
    let slot = sessions.slot(&label)?;

    let mut request = request;
    let object = request
        .as_object_mut()
        .ok_or_else(|| "a command has to be an object".to_string())?;
    object.insert("session".into(), serde_json::Value::from(label));
    object.insert("slot".into(), serde_json::Value::from(slot));

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

/// Ask macOS for the one grant a refused Gecko pane needs.
///
/// Nothing requests a TCC permission directly — not Tauri, not a plugin, not
/// macOS itself. The prompt is raised by the access: the first time a
/// foreground app reads another app's data, the user is asked. Today the read
/// is made by Firefox, which the sidecar spawned, and nobody is asked; made
/// from the app, on a click, there is somebody to ask and something to explain.
///
/// Full Disk Access can never be reached this way — it has no prompt at all.
/// App Data can, which is why it is worth trying before sending anyone to
/// Settings.
///
/// `false` means macOS refused rather than asked, which is what happens once a
/// decision is already on file.
#[tauri::command]
fn request_app_data_access() -> Result<bool, String> {
    if !cfg!(target_os = "macos") {
        return Ok(true);
    }

    let home = std::env::var("HOME").map_err(|_| "no home directory".to_string())?;
    let directory = std::path::Path::new(&home).join("Library/Application Support/Firefox");
    let read = std::fs::read(directory.join("profiles.ini"))
        .map(|_| ())
        // No profiles.ini yet is not a refusal: the directory is what is gated,
        // and Firefox writes the file itself once it can.
        .or_else(|error| match error.kind() {
            std::io::ErrorKind::NotFound => std::fs::read_dir(&directory).map(|_| ()),
            _ => Err(error),
        });

    match read {
        Ok(()) => Ok(true),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(true),
        Err(_) => Ok(false),
    }
}

/// Open the Privacy & Security pane a blocked pane needs a grant from.
///
/// Here rather than in the frontend because the frontend is given no shell
/// permission at all, and one opener is not worth making it the exception.
/// macOS only: this is the only platform that withholds the grant.
#[tauri::command]
fn open_privacy_settings(url: String) -> Result<(), String> {
    // The frontend names the pane, so the scheme is checked here rather than
    // trusted: this is a process spawn taking an argument from the webview.
    if !url.starts_with("x-apple.systempreferences:") {
        return Err("not a settings url".into());
    }
    if !cfg!(target_os = "macos") {
        return Err("only macOS withholds this grant".into());
    }

    std::process::Command::new("open")
        .arg(&url)
        .spawn()
        .map(|_| ())
        .map_err(|error| error.to_string())
}

/// Restart the sidecar after a crash, or after the user retries a failed launch.
#[tauri::command]
fn sidecar_restart(app: tauri::AppHandle) -> Result<(), String> {
    app.state::<Sidecar>().kill();
    // Frames from the old process describe panes that no longer exist — every
    // window's, since the process they came from is the one being replaced.
    app.state::<FrameStore>().clear();
    sidecar::spawn(&app)
}

/// Close a window's session, when the window itself has gone.
///
/// Sent from here rather than from the webview: a window that is being
/// destroyed cannot be relied on to finish an asynchronous send, and a session
/// nobody closes keeps three headless browsers rendering for nobody until the
/// app exits.
fn close_session(app: &tauri::AppHandle, label: &str) {
    let Some(slot) = app.state::<Sessions>().forget(label) else {
        // A window that never sent a command has no session to close.
        return;
    };
    app.state::<FrameStore>().clear_session(label);

    // A detached inspector is a view of panes that no longer exist. Closed from
    // here rather than by the window it belongs to, which is in no position to
    // do anything: it is being destroyed, which is what brought us here.
    if let Some(inspector) = app.get_webview_window(&format!("inspector:{label}")) {
        let _ = inspector.close();
    }

    let request = serde_json::json!({
        "type": "close-session",
        // The ack goes to a window that is gone, which is why the id says who
        // asked rather than pretending to correlate with anything.
        "id": format!("backend:close:{label}"),
        "session": label,
        "slot": slot,
    });
    if let Err(error) = app.state::<Sidecar>().send(&request) {
        note!("[devkit] could not close the session for {label}: {error}");
    }
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

    // Called a tab where the platform makes one, a window where it does not, so
    // the menu says what will actually appear.
    #[cfg(target_os = "macos")]
    let comparison = MenuItemBuilder::with_id("new-comparison", "New Tab")
        .accelerator("Cmd+T")
        .build(app)?;
    #[cfg(not(target_os = "macos"))]
    let comparison = MenuItemBuilder::with_id("new-comparison", "New Window")
        .accelerator("Ctrl+N")
        .build(app)?;

    // Kept out of the block it is built in, because AppKit has to be told which
    // submenu is *the* Window menu once the menu is installed.
    #[cfg(target_os = "macos")]
    let windows_menu;

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
        // A comparison is opened and closed from here, which is also where the
        // shortcuts live: ⌘W is the menu item, not something the window does by
        // itself.
        let file = SubmenuBuilder::new(app, "File")
            .item(&comparison)
            .separator()
            .close_window()
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
        // Naming this submenu as the Window menu (below) gets AppKit's own
        // items — Minimize All, Zoom All, Fill, Center, the list of open
        // windows — but not the tab commands, which it only volunteers to
        // document-based apps. They are stated here instead and handed
        // straight back to AppKit, which is the only thing that knows which
        // windows may be merged.
        let merge = MenuItemBuilder::with_id("merge-all-windows", "Merge All Windows").build(app)?;
        let untab = MenuItemBuilder::with_id("move-tab-to-new-window", "Move Tab to New Window")
            .build(app)?;
        let window = SubmenuBuilder::new(app, "Window")
            .minimize()
            .maximize()
            .separator()
            .item(&merge)
            .item(&untab)
            .separator()
            .close_window()
            .build()?;
        windows_menu = window.clone();
        MenuBuilder::new(app)
            .items(&[&application, &file, &edit, &window])
            .build()?
    };

    #[cfg(not(target_os = "macos"))]
    let menu = {
        let file = SubmenuBuilder::new(app, "File")
            .item(&comparison)
            .separator()
            .close_window()
            .build()?;
        let help = SubmenuBuilder::new(app, "Help").item(&check).build()?;
        MenuBuilder::new(app).items(&[&file, &help]).build()?
    };

    app.set_menu(menu)?;

    // After the menu is installed, not before: naming a submenu that is not yet
    // in the menu bar leaves AppKit with a Window menu nobody can see.
    #[cfg(target_os = "macos")]
    if let Err(error) = windows_menu.set_as_windows_menu_for_nsapp() {
        note!("[devkit] no window menu: {error}");
    }

    app.on_menu_event(|app, event| {
        if event.id() == "check-for-updates" {
            // The frontend owns the updater; this only says that somebody asked.
            let _ = app.emit(protocol::CHECK_FOR_UPDATES_EVENT, ());
        }
        if event.id() == "new-comparison" {
            if let Err(error) = windows::open(app) {
                note!("[devkit] could not open another comparison: {error}");
            }
        }
        #[cfg(target_os = "macos")]
        if event.id() == "merge-all-windows" {
            windows::merge_all(app);
        }
        #[cfg(target_os = "macos")]
        if event.id() == "move-tab-to-new-window" {
            windows::move_to_new_window(app);
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
        .manage(Sessions::default())
        .register_uri_scheme_protocol(protocol::FRAME_SCHEME, |ctx, request| {
            frames::respond(&ctx.app_handle().state::<FrameStore>(), &request)
        })
        .invoke_handler(tauri::generate_handler![
            sidecar_send,
            sidecar_restart,
            open_privacy_settings,
            request_app_data_access,
            debug_log,
            cursors::get_native_cursor_by_type
        ])
        .setup(|app| {
            if let Err(error) = install_menu(&app.handle().clone()) {
                eprintln!("[devkit] no menu: {error}");
            }

            // The first window exists already; the rest are opened from here.
            windows::adopt_first_window(&app.handle().clone());

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
        .run(|app, event| match event {
            // Headless browsers outlive their parent unless told otherwise, so
            // the sidecar is killed explicitly on the way out.
            RunEvent::ExitRequested { .. } | RunEvent::Exit => app.state::<Sidecar>().kill(),
            // One window closing is not the app closing: its panes go, and
            // whatever other windows are showing carries on.
            RunEvent::WindowEvent {
                label,
                event: WindowEvent::Destroyed,
                ..
            } => close_session(app, &label),
            _ => {}
        });
}
