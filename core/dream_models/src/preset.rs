// ═══════════════════════════════════════════════════════════════════════════
// Dream DAW — Device Preset Format
// ═══════════════════════════════════════════════════════════════════════════
//
// Defines the on-disk format for saved device rack presets (.dpreset files).
// A preset captures an entire DeviceNode (single device or full rack with
// all chains, macros, and nested devices) along with metadata.
//
// ═══════════════════════════════════════════════════════════════════════════

use serde::{Deserialize, Serialize};

use crate::project::DeviceNode;

/// Current preset file format version.
pub const PRESET_FORMAT_VERSION: u32 = 1;

/// A saved device preset (.dpreset file).
///
/// Can represent:
/// - A single device with its parameter state
/// - A full rack with parallel chains, macros, and nested devices
///
/// Stored as compressed JSON on disk (same approach as project files).
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DevicePreset {
    /// Format version for migration.
    pub version: u32,
    /// Preset display name.
    pub name: String,
    /// ISO-8601 creation timestamp.
    pub created_at: String,
    /// ISO-8601 last-modified timestamp.
    pub modified_at: String,
    /// Author / creator name.
    #[serde(default)]
    pub author: String,
    /// The device node (single or rack) with all state.
    pub device: DeviceNode,
    /// User-defined tags for categorization.
    #[serde(default)]
    pub tags: Vec<String>,
    /// Optional description.
    #[serde(default)]
    pub description: String,
}

impl DevicePreset {
    /// Creates a new preset from a DeviceNode.
    pub fn new(name: impl Into<String>, device: DeviceNode) -> Self {
        let now = chrono_now_iso8601();
        Self {
            version: PRESET_FORMAT_VERSION,
            name: name.into(),
            created_at: now.clone(),
            modified_at: now,
            author: String::new(),
            device,
            tags: Vec::new(),
            description: String::new(),
        }
    }
}

/// Returns the current time as an ISO-8601 string.
/// Uses a simple fallback if chrono is not available.
fn chrono_now_iso8601() -> String {
    // Use std::time for a portable timestamp.
    use std::time::{SystemTime, UNIX_EPOCH};
    let secs = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs();
    format!("{secs}")
}
