// ═══════════════════════════════════════════════════════════════════════════
// Dream DAW — State Managers Module
// ═══════════════════════════════════════════════════════════════════════════
//
// Centralises all long-lived Tauri managed-state structs.
// Each sub-file is re-exported through this module so that `lib.rs`
// can declare `mod state_managers; use state_managers::*;` and gain
// access to every type without any cross-file visibility ceremony.
//
// Sub-modules:
//   plugin_host  — PluginHostState (VST3 lifecycle + sandbox supervisor)
//   recording    — RecordingRuntime, AutomationRuntime, MidiInputRuntime
// ═══════════════════════════════════════════════════════════════════════════

pub(crate) mod plugin_host;
pub(crate) mod recording;

pub(crate) use plugin_host::PluginHostState;
pub(crate) use recording::{AutomationRuntime, MidiInputRuntime, RecordingRuntime};
