//! Diagnostics that cannot take the app down with them.
//!
//! `eprintln!` panics when the write fails — "failed printing to stderr" — and a
//! panic inside a Tauri command aborts the process. Stderr here is a pipe to
//! whatever launched the app, and that pipe dies with the terminal it belongs
//! to, so every diagnostic line was a way for the app to be killed by its own
//! logging. Observed: a crash report whose whole stack was
//! `debug_log` -> `__eprint` -> `panic` -> `abort`, on a machine where the
//! parent process had become `launchd`.
//!
//! Losing a line of diagnostics costs nothing. Losing the app loses three
//! browsers, their pages, and whatever was being compared.

/// Write a line to stderr, ignoring a failed write.
#[macro_export]
macro_rules! note {
    ($($arg:tt)*) => {{
        use std::io::Write as _;
        let _ = writeln!(std::io::stderr(), $($arg)*);
    }};
}
