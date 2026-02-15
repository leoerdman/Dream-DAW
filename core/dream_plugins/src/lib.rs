// ═══════════════════════════════════════════════════════════════════════════
// Dream DAW — Plugin Hosting Foundation
// ═══════════════════════════════════════════════════════════════════════════
//
// This crate provides the cross-platform plugin hosting infrastructure:
//   - Format-agnostic plugin interface (VST3, CLAP, AU)
//   - Plugin scanner for discovering installed plugins
//   - Plugin descriptor model for the UI
//   - Instance lifecycle management
//
// Architecture:
//   PluginScanner → discovers plugin files on disk
//   PluginDescriptor → metadata for the UI (name, vendor, format, etc.)
//   PluginInstance → trait for format-specific processing
//
// Out-of-process sandboxing will be added in a future sprint.
//
// ═══════════════════════════════════════════════════════════════════════════

pub mod descriptor;
pub mod format;
pub mod instance;
pub mod sandbox_host;
pub mod sandbox_instance;
pub mod sandbox_ipc;
pub mod scanner;
pub mod shared_memory;
pub mod vst3_host;

pub use descriptor::PluginDescriptor;
pub use format::PluginFormat;
pub use instance::{PluginInstance, TransportContext};
pub use sandbox_host::{
    PluginSandboxConfig, PluginSandboxSnapshot, PluginSandboxStatus, PluginSandboxSupervisor,
};
pub use scanner::PluginScanner;
pub use vst3_host::{PluginHost, Vst3Instance};
