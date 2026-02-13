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
}

impl PluginDescriptor {
    /// Creates a new descriptor with minimal required fields.
    pub fn new(
        name: impl Into<String>,
        vendor: impl Into<String>,
        format: PluginFormat,
        category: PluginCategory,
        path: PathBuf,
    ) -> Self {
        Self {
            id: Uuid::new_v4(),
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

        let json = serde_json::to_string(&desc).unwrap();
        let back: PluginDescriptor = serde_json::from_str(&json).unwrap();
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
