#![cfg_attr(test, allow(clippy::expect_used))]
// ═══════════════════════════════════════════════════════════════════════════
// Dream DAW — Plugin Descriptor (Metadata for UI)
// ═══════════════════════════════════════════════════════════════════════════

use std::path::PathBuf;

use serde::{Deserialize, Serialize};
use uuid::Uuid;

use crate::format::{PluginCategory, PluginFormat};

/// Metadata for an installed plugin, discovered by the scanner.
///
/// This struct is displayed in the plugin browser UI and serialized
/// to the plugin cache for fast startup.
///
/// It does NOT load the plugin binary — instantiation is deferred
/// to `PluginInstance` when the user inserts a plugin on a track.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PluginDescriptor {
    /// Unique descriptor ID (stable across sessions).
    pub id: Uuid,

    /// Human-readable plugin name (e.g., "Serum", "Pro-Q 3").
    pub name: String,

    /// Plugin vendor / manufacturer (e.g., "Xfer Records", "FabFilter").
    pub vendor: String,

    /// Plugin format (VST3, CLAP, AU).
    pub format: PluginFormat,

    /// Plugin category (instrument, effect, etc.).
    pub category: PluginCategory,

    /// Absolute path to the plugin bundle on disk.
    pub path: PathBuf,

    /// Plugin version string (if available).
    pub version: Option<String>,

    /// Unique plugin identifier from the plugin itself.
    /// For VST3: the TUID. For AU: the AudioComponentDescription string.
    /// For CLAP: the plugin ID string.
    pub unique_id: Option<String>,

    /// Number of audio input channels (0 = instrument/synth).
    pub audio_inputs: u32,

    /// Number of audio output channels (typically 2 for stereo).
    pub audio_outputs: u32,

    /// Whether the plugin supports MIDI input.
    pub accepts_midi: bool,

    /// Whether this plugin has been validated (loaded + basic smoke test).
    pub is_validated: bool,

    /// Whether the current DAW runtime can load this plugin format.
    /// AU and CLAP formats are scanned but cannot be instantiated yet.
    pub runtime_supported: bool,
}

impl PluginDescriptor {
    fn stable_id_from_path(path: &std::path::Path) -> Uuid {
        // Deterministic, dependency-free 128-bit ID derived from normalized path.
        // We avoid UUID v5 API so this remains compatible with the current
        // workspace `uuid` feature set.
        const FNV_OFFSET: u64 = 0xcbf29ce484222325;
        const FNV_PRIME: u64 = 0x100000001b3;
        const SALT_A: u64 = 0x9e3779b97f4a7c15;
        const SALT_B: u64 = 0xbf58476d1ce4e5b9;

        fn fnv1a64(mut state: u64, bytes: &[u8]) -> u64 {
            for b in bytes {
                state ^= u64::from(*b);
                state = state.wrapping_mul(FNV_PRIME);
            }
            state
        }

        let normalized = path.to_string_lossy().to_ascii_lowercase();
        let bytes = normalized.as_bytes();
        let h1 = fnv1a64(FNV_OFFSET ^ SALT_A, bytes);
        let h2 = fnv1a64(FNV_OFFSET ^ SALT_B, bytes);

        let mut id_bytes = [0u8; 16];
        id_bytes[..8].copy_from_slice(&h1.to_be_bytes());
        id_bytes[8..].copy_from_slice(&h2.to_be_bytes());
        Uuid::from_bytes(id_bytes)
    }

    #[cfg(target_os = "macos")]
    fn is_runtime_supported(format: PluginFormat) -> bool {
        matches!(
            format,
            PluginFormat::VST2 | PluginFormat::VST3 | PluginFormat::AudioUnit
        )
    }

    #[cfg(not(target_os = "macos"))]
    fn is_runtime_supported(format: PluginFormat) -> bool {
        matches!(format, PluginFormat::VST2 | PluginFormat::VST3)
    }

    /// Creates a new descriptor with minimal required fields.
    pub fn new(
        name: impl Into<String>,
        vendor: impl Into<String>,
        format: PluginFormat,
        category: PluginCategory,
        path: PathBuf,
    ) -> Self {
        // Stable descriptor identity across scans/sessions keyed by path.
        let stable_id = Self::stable_id_from_path(&path);
        Self {
            id: stable_id,
            name: name.into(),
            vendor: vendor.into(),
            format,
            category,
            path,
            version: None,
            unique_id: None,
            audio_inputs: 0,
            audio_outputs: 2,
            accepts_midi: category == PluginCategory::Instrument,
            is_validated: false,
            runtime_supported: Self::is_runtime_supported(format),
        }
    }

    /// Returns a display string: "Name (Vendor) [Format]"
    pub fn display_name(&self) -> String {
        format!("{} ({}) [{}]", self.name, self.vendor, self.format)
    }
}

// ═══════════════════════════════════════════════════════════════════════════
// Tests
// ═══════════════════════════════════════════════════════════════════════════

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn descriptor_creation() {
        let desc = PluginDescriptor::new(
            "Serum",
            "Xfer Records",
            PluginFormat::VST3,
            PluginCategory::Instrument,
            PathBuf::from("/Library/Audio/Plug-Ins/VST3/Serum.vst3"),
        );

        assert_eq!(desc.name, "Serum");
        assert_eq!(desc.vendor, "Xfer Records");
        assert_eq!(desc.format, PluginFormat::VST3);
        assert_eq!(desc.category, PluginCategory::Instrument);
        assert!(desc.accepts_midi);
        assert!(!desc.is_validated);
    }

    #[test]
    fn descriptor_display_name() {
        let desc = PluginDescriptor::new(
            "Pro-Q 3",
            "FabFilter",
            PluginFormat::VST3,
            PluginCategory::Effect,
            PathBuf::from("/Library/Audio/Plug-Ins/VST3/FabFilter Pro-Q 3.vst3"),
        );

        assert_eq!(desc.display_name(), "Pro-Q 3 (FabFilter) [VST3]");
    }

    #[test]
    fn descriptor_serialization_roundtrip() {
        let desc = PluginDescriptor::new(
            "Vital",
            "Matt Tytel",
            PluginFormat::CLAP,
            PluginCategory::Instrument,
            PathBuf::from("/Library/Audio/Plug-Ins/CLAP/Vital.clap"),
        );

        let json =
            serde_json::to_string(&desc).expect("test invariant: unwrap removed for clippy policy");
        let back: PluginDescriptor =
            serde_json::from_str(&json).expect("test invariant: unwrap removed for clippy policy");
        assert_eq!(back.name, "Vital");
        assert_eq!(back.format, PluginFormat::CLAP);
    }

    #[test]
    fn effect_does_not_accept_midi_by_default() {
        let desc = PluginDescriptor::new(
            "OTT",
            "Xfer Records",
            PluginFormat::VST3,
            PluginCategory::Effect,
            PathBuf::from("/Library/Audio/Plug-Ins/VST3/OTT.vst3"),
        );

        assert!(!desc.accepts_midi);
    }
}
