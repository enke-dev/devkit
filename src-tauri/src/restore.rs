//! Which comparisons were open, so relaunching brings them back.
//!
//! Held here rather than in the frontend because two things have to be known at
//! once and each side only knows one of them. The frontend knows what page a
//! comparison is on; the backend knows *why* a window went away — closed by
//! somebody, or taken down because the app is quitting — and those mean
//! opposite things. A tab you closed should stay closed. A tab that was open
//! when you quit should come back.
//!
//! So the frontend says where it is whenever that changes, this remembers it in
//! the order the windows were opened, and the set is written to disk on the way
//! out. A window closed before then has already been forgotten.

use std::fs;
use std::path::PathBuf;
use std::sync::Mutex;

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Manager};

/// One comparison, as it will be reopened: its window's name and its page.
#[derive(Clone, Serialize, Deserialize)]
pub struct Comparison {
    pub label: String,
    pub url: String,
}

/// The comparisons that are open, in the order their windows were.
///
/// Order is what makes the tabs come back in the order they were left in, which
/// is the difference between restoring a workspace and being handed the same
/// windows in an arbitrary arrangement.
#[derive(Default)]
pub struct Comparisons {
    open: Mutex<Vec<Comparison>>,
}

/// What the file is called, under the app's own config directory.
const FILE: &str = "comparisons.json";

impl Comparisons {
    /// Note where a window is, adding it if this is the first thing it has said.
    pub fn remember(&self, label: &str, url: &str) {
        if let Ok(mut open) = self.open.lock() {
            match open.iter_mut().find(|entry| entry.label == label) {
                Some(entry) => entry.url = url.to_string(),
                None => open.push(Comparison {
                    label: label.to_string(),
                    url: url.to_string(),
                }),
            }
        }
    }

    /// The page a window should be showing, for one that has just loaded.
    ///
    /// Answers a restored window on its first render, and a window whose webview
    /// was reloaded — which has forgotten everything the page knew while the
    /// panes behind it carried on.
    pub fn url_for(&self, label: &str) -> Option<String> {
        let open = self.open.lock().ok()?;
        open.iter()
            .find(|entry| entry.label == label)
            .map(|entry| entry.url.clone())
    }

    /// Forget a window that somebody closed.
    pub fn forget(&self, label: &str) {
        if let Ok(mut open) = self.open.lock() {
            open.retain(|entry| entry.label != label);
        }
    }

    fn snapshot(&self) -> Vec<Comparison> {
        self.open.lock().map(|open| open.clone()).unwrap_or_default()
    }
}

fn file(app: &AppHandle) -> Option<PathBuf> {
    let directory = app.path().app_config_dir().ok()?;
    fs::create_dir_all(&directory).ok()?;
    Some(directory.join(FILE))
}

/// Write down what is open, on the way out.
///
/// Called while the windows still exist: a comparison closed earlier has
/// already been forgotten, and one being torn down because the app is quitting
/// has not, which is exactly the set worth keeping.
pub fn save(app: &AppHandle) {
    let Some(path) = file(app) else { return };
    let comparisons = app.state::<Comparisons>().snapshot();
    match serde_json::to_vec_pretty(&comparisons) {
        Ok(contents) => {
            if let Err(error) = fs::write(&path, contents) {
                crate::note!("[devkit] could not write {}: {error}", path.display());
            }
        }
        Err(error) => crate::note!("[devkit] could not describe the open comparisons: {error}"),
    }
}

/// What was open last time, oldest window first.
///
/// A missing or unreadable file is an ordinary first run, not a failure: the app
/// opens its one window and says nothing.
pub fn load(app: &AppHandle) -> Vec<Comparison> {
    let Some(path) = file(app) else {
        return Vec::new();
    };
    let Ok(contents) = fs::read(&path) else {
        return Vec::new();
    };
    match serde_json::from_slice::<Vec<Comparison>>(&contents) {
        Ok(comparisons) => comparisons,
        Err(error) => {
            crate::note!("[devkit] ignoring an unreadable {}: {error}", path.display());
            Vec::new()
        }
    }
}
