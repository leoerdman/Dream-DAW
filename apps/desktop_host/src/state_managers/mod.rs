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

pub(crate) mod audio_engine;
pub(crate) mod background_runtime;
pub(crate) mod clip_pool;
pub(crate) mod plugin_host;
pub(crate) mod project_registry;
pub(crate) mod project_state;
pub(crate) mod recording;
pub(crate) mod runtime_bootstrap;
pub mod sync_engine;

pub(crate) use audio_engine::{AudioEngineHandle, SpectrumState, SpectrumStateInner};
pub(crate) use background_runtime::{configure_app_runtime, shutdown_plugins_on_exit};
pub(crate) use clip_pool::ClipPoolState;
pub(crate) use plugin_host::PluginHostState;
pub(crate) use project_registry::ProjectRegistry;
pub(crate) use project_state::ProjectState;
pub(crate) use recording::{AutomationRuntime, MidiInputRuntime, RecordingRuntime};
pub(crate) use runtime_bootstrap::{RuntimeBootstrap, initialize_runtime};
pub use sync_engine::*;
