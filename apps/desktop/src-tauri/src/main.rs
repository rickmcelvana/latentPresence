// Prevents an extra console window on Windows in release. Tauri's own scaffold ships this
// line and it is load-bearing on the platform ADR-07 ships first.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    latentpresence_desktop_lib::run();
}
