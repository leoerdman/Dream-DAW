#![cfg_attr(test, allow(clippy::expect_used))]
// ═══════════════════════════════════════════════════════════════════════════
// Dream DAW — Plugin Format Definitions
// ═══════════════════════════════════════════════════════════════════════════

use serde::{Deserialize, Serialize};

/// Supported plugin formats.
///
/// Dream DAW targets the three major plugin APIs:
/// - **VST3**: Steinberg's modern plugin standard (cross-platform)
/// - **CLAP**: Bitwig's open plugin standard (growing ecosystem)
/// - **AU (AudioUnit)**: Apple's macOS/iOS plugin standard
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
pub enum PluginFormat {
    /// Steinberg VST2 — `.vst` bundles (legacy, widely installed).
    VST2,

    /// Steinberg VST3 — `.vst3` bundles.
    VST3,

    /// CLAP — CLever Audio Plugin — `.clap` bundles.
    CLAP,

    /// Apple Audio Unit v3 — `.component` or `.appex` bundles.
    AudioUnit,
}

impl PluginFormat {
    /// Returns the file extension used by this format.
    pub fn extension(&self) -> &'static str {
        match self {
            Self::VST2 => "vst",
            Self::VST3 => "vst3",
            Self::CLAP => "clap",
            Self::AudioUnit => "component",
        }
    }

    /// Returns a human-readable label for the format.
    pub fn label(&self) -> &'static str {
        match self {
            Self::VST2 => "VST2",
            Self::VST3 => "VST3",
            Self::CLAP => "CLAP",
            Self::AudioUnit => "Audio Unit",
        }
    }
}

/// Plugin category for grouping in the browser.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
pub enum PluginCategory {
    /// Instrument / Synthesizer / Sampler.
    Instrument,

    /// Audio effect (EQ, compressor, reverb, etc.).
    Effect,

    /// Analyzer / meter / monitoring tool.
    Analyzer,

    /// Unknown or uncategorized.
    Other,
}

impl std::fmt::Display for PluginFormat {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "{}", self.label())
    }
}

impl std::fmt::Display for PluginCategory {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Instrument => write!(f, "Instrument"),
            Self::Effect => write!(f, "Effect"),
            Self::Analyzer => write!(f, "Analyzer"),
            Self::Other => write!(f, "Other"),
        }
    }
}

// ═══════════════════════════════════════════════════════════════════════════
// Tests
// ═══════════════════════════════════════════════════════════════════════════

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn format_extensions() {
        assert_eq!(PluginFormat::VST2.extension(), "vst");
        assert_eq!(PluginFormat::VST3.extension(), "vst3");
        assert_eq!(PluginFormat::CLAP.extension(), "clap");
        assert_eq!(PluginFormat::AudioUnit.extension(), "component");
    }

    #[test]
    fn format_labels() {
        assert_eq!(PluginFormat::VST2.label(), "VST2");
        assert_eq!(PluginFormat::VST3.label(), "VST3");
        assert_eq!(PluginFormat::CLAP.label(), "CLAP");
        assert_eq!(PluginFormat::AudioUnit.label(), "Audio Unit");
    }

    #[test]
    fn format_display() {
        assert_eq!(format!("{}", PluginFormat::VST2), "VST2");
        assert_eq!(format!("{}", PluginFormat::VST3), "VST3");
        assert_eq!(format!("{}", PluginCategory::Effect), "Effect");
    }

    #[test]
    fn format_serialization_roundtrip() {
        let format = PluginFormat::CLAP;
        let json = serde_json::to_string(&format)
            .expect("test invariant: unwrap removed for clippy policy");
        let back: PluginFormat =
            serde_json::from_str(&json).expect("test invariant: unwrap removed for clippy policy");
        assert_eq!(format, back);
    }
}
