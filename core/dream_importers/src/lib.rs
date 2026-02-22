// ═══════════════════════════════════════════════════════════════════════
// Dream DAW — File Format Import/Export
// ═══════════════════════════════════════════════════════════════════════
//
// This crate contains all project import/export logic, fully decoupled
// from the Tauri desktop host shell. Every function here is pure
// computation (no Tauri State, no AppHandle, no IPC).
//
// Supported formats:
//   • Ableton Live Set (.als)  → `ableton::import_als_project()`
//
// ═══════════════════════════════════════════════════════════════════════

pub mod ableton;
