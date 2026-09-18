// Keep the release build from opening a console window on Windows.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    devkit_lib::run()
}
