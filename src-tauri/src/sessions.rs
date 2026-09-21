//! Which window a message belongs to, and the byte the frame channel calls it by.
//!
//! One session is one window: the window's own Tauri label is the id, so
//! nothing has to be allocated, agreed or kept in step — a label is unique, it
//! lasts exactly as long as the window, and it is already what `emit_to` needs
//! to answer one webview rather than all of them.
//!
//! The slot exists only because a frame header is fixed-width and read on every
//! frame. A label of arbitrary length has no place in sixteen bytes, so each
//! session is also given a number here, handed to the sidecar with its first
//! command and mapped back when its frames arrive.

use std::collections::HashMap;
use std::sync::Mutex;

/// Slots are a byte, so this is how many comparisons can be open at once.
///
/// Three browsers apiece means the machine gives out long before the numbers
/// do; this is a limit on the encoding, not a budget.
pub const MAX_SESSIONS: u16 = 255;

#[derive(Default)]
struct Table {
    by_label: HashMap<String, u8>,
    by_slot: HashMap<u8, String>,
}

#[derive(Default)]
pub struct Sessions {
    table: Mutex<Table>,
}

impl Sessions {
    /// This window's slot, handing out a new one the first time it speaks.
    ///
    /// Assigned here rather than in the sidecar because this is the side that
    /// has to turn a slot back into a window when a frame arrives; a number the
    /// sidecar chose would have to be announced, and an announcement on stdout
    /// can arrive after the frames it explains.
    pub fn slot(&self, label: &str) -> Result<u8, String> {
        let mut table = self.table.lock().map_err(|_| "session table poisoned".to_string())?;
        if let Some(slot) = table.by_label.get(label) {
            return Ok(*slot);
        }

        let slot = (0..MAX_SESSIONS)
            .map(|candidate| candidate as u8)
            .find(|candidate| !table.by_slot.contains_key(candidate))
            .ok_or_else(|| format!("no free session slot; {MAX_SESSIONS} windows are already open"))?;
        table.by_label.insert(label.to_string(), slot);
        table.by_slot.insert(slot, label.to_string());
        Ok(slot)
    }

    /// The window a frame belongs to, or nothing if it has since closed.
    pub fn label(&self, slot: u8) -> Option<String> {
        self.table.lock().ok()?.by_slot.get(&slot).cloned()
    }

    /// Give the slot back, so a long-lived app does not run out of them.
    ///
    /// Returns what the window was using, which is what the caller needs to
    /// clear the frames it left behind.
    pub fn forget(&self, label: &str) -> Option<u8> {
        let mut table = self.table.lock().ok()?;
        let slot = table.by_label.remove(label)?;
        table.by_slot.remove(&slot);
        Some(slot)
    }
}
