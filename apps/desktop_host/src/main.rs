// ═══════════════════════════════════════════════════════════════════════════
// Dream DAW — Tauri v2 Desktop Shell (Entry Point)
// ═══════════════════════════════════════════════════════════════════════════
//
// This is the desktop-only entry point. It simply delegates to lib.rs
// where the shared Tauri application is defined.
//
// For mobile builds, the system would call the #[tauri::mobile_entry_point]
// in lib.rs directly, bypassing this file.
//
// ═══════════════════════════════════════════════════════════════════════════

#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    app_lib::run();
}
