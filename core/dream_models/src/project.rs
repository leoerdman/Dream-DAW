// ═══════════════════════════════════════════════════════════════════════════
// Dream DAW — Core Project Data Structures
// ═══════════════════════════════════════════════════════════════════════════
//
// Port of Swift `Project.swift`, `Track.swift`, `AudioClip.swift`.
//
// These are the canonical SSOT structures shared between:
//   - Rust audio engine (runtime processing)
//   - Tauri IPC bridge (serialization to/from frontend)
//   - React UI (auto-generated TypeScript bindings via ts-rs)
//
// ZERO business logic in this file — only data definitions.
//
// ═══════════════════════════════════════════════════════════════════════════

use serde::{Deserialize, Serialize};
use ts_rs::TS;
use uuid::Uuid;

use crate::midi::{MidiClip, SamplerConfig};
use crate::pulse_map::PulseMap;
use crate::time::AbsoluteTime;

/// Current on-disk project document format version.
///
/// Bump this only when serialized project schema changes incompatibly
/// and provide a migration path in `dream_io::project_file`.
pub const PROJECT_FORMAT_VERSION: u32 = 3;

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[ts(export)]
pub struct WarpMarkerPoint {
    pub sec_time: f64,
    pub beat_time: f64,
}

/// A project-level marker / locator (imported from ALS `<Locators>`).
///
/// Used for arrangement navigation, cue points, and section labels.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[ts(export)]
pub struct ProjectMarker {
    /// Unique marker identifier.
    #[ts(type = "string")]
    pub id: Uuid,

    /// Display name (e.g., "Chorus", "Verse 2").
    pub name: String,

    /// Position in beats (relative to project start).
    pub position_beats: f64,

    /// Optional color for visual distinction.
    #[serde(default)]
    pub color: Option<TrackColor>,
}

/// A Session scene imported from ALS `<Scenes>`.
///
/// Stores scene metadata needed for future Session View parity and relaunch.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[ts(export)]
pub struct ProjectScene {
    /// Scene index from ALS `Scene Id`.
    pub index: i32,

    /// Scene display name.
    pub name: String,

    /// Optional scene color.
    #[serde(default)]
    pub color: Option<TrackColor>,

    /// Optional scene tempo.
    #[serde(default)]
    pub tempo: Option<f64>,

    /// Whether scene tempo override is enabled.
    #[serde(default)]
    pub tempo_enabled: bool,

    /// Optional referenced time-signature id from ALS.
    #[serde(default)]
    pub time_signature_id: Option<i32>,

    /// Whether scene time-signature override is enabled.
    #[serde(default)]
    pub time_signature_enabled: bool,

    /// Optional scene time-signature numerator.
    #[serde(default)]
    pub time_signature_numerator: Option<u8>,

    /// Optional scene time-signature denominator.
    #[serde(default)]
    pub time_signature_denominator: Option<u8>,

    /// Follow action enabled for scene launch.
    #[serde(default)]
    pub follow_action_enabled: bool,

    /// Follow action time in beats.
    #[serde(default)]
    pub follow_time: Option<f64>,

    /// Follow action A opcode.
    #[serde(default)]
    pub follow_action_a: Option<i32>,

    /// Follow action B opcode.
    #[serde(default)]
    pub follow_action_b: Option<i32>,

    /// Follow action A chance [0..100].
    #[serde(default)]
    pub follow_chance_a: Option<f64>,

    /// Follow action B chance [0..100].
    #[serde(default)]
    pub follow_chance_b: Option<f64>,
}

/// UI state for a MIDI editor lane model from ALS.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[ts(export)]
pub struct MidiEditorLaneState {
    /// ALS lane id (`MidiEditorLaneModel Id`).
    pub id: i32,
    /// ALS lane type (`Type`).
    pub lane_type: i32,
    /// Lane size (`Size`).
    pub size: f64,
    /// Minimized state (`IsMinimized`).
    pub is_minimized: bool,
}

/// A single automation envelope attached to a clip parameter.
///
/// Represents intra-clip automation (e.g., volume fade within a clip).
/// Distinct from track-level `AutomationLane` which lives at the track scope.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[ts(export)]
pub struct ClipEnvelope {
    /// ALS PointeeId linking this envelope to a specific parameter.
    pub pointee_id: i32,

    /// Human-readable parameter identifier (e.g., "volume", "pan").
    #[serde(default)]
    pub param_id: String,

    /// Automation breakpoints within the clip's local time.
    pub points: Vec<AutomationPoint>,
}

// ── Track Color (16 Ableton-style palette) ─────────────────────────────

/// Predefined track colors matching the Ableton-style palette.
///
/// 16-color palette ported from Swift `TrackColor` enum.
/// Each variant maps to a specific hex value for the frontend.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize, TS, Default)]
#[ts(export)]
pub enum TrackColor {
    Coral,
    Orange,
    Gold,
    Yellow,
    Lime,
    Green,
    Teal,
    Cyan,
    Sky,
    #[default]
    Blue,
    Indigo,
    Purple,
    Magenta,
    Pink,
    Rose,
    Slate,
}

impl TrackColor {
    /// Returns the hex color string for this track color.
    ///
    /// Values ported from Swift `Track.swift` NSColor definitions.
    pub fn hex(&self) -> &'static str {
        match self {
            Self::Coral => "#F05C4D",
            Self::Orange => "#FF8A1A",
            Self::Gold => "#FFBF33",
            Self::Yellow => "#FFE14D",
            Self::Lime => "#A3D94D",
            Self::Green => "#4DC775",
            Self::Teal => "#4DC7B0",
            Self::Cyan => "#4DC7CC",
            Self::Sky => "#4DA6E3",
            Self::Blue => "#4D7AE3",
            Self::Indigo => "#6B5CE3",
            Self::Purple => "#9B59D9",
            Self::Magenta => "#D94DA6",
            Self::Pink => "#E36B96",
            Self::Rose => "#E66673",
            Self::Slate => "#8C949E",
        }
    }

    /// Returns the color for a given track index (cyclic assignment).
    ///
    /// Ported from Swift `TrackColor.forIndex(_:)`.
    pub fn for_index(index: usize) -> Self {
        const ALL: [TrackColor; 16] = [
            TrackColor::Coral,
            TrackColor::Orange,
            TrackColor::Gold,
            TrackColor::Yellow,
            TrackColor::Lime,
            TrackColor::Green,
            TrackColor::Teal,
            TrackColor::Cyan,
            TrackColor::Sky,
            TrackColor::Blue,
            TrackColor::Indigo,
            TrackColor::Purple,
            TrackColor::Magenta,
            TrackColor::Pink,
            TrackColor::Rose,
            TrackColor::Slate,
        ];
        ALL[index % ALL.len()]
    }
}

// ── Track Type ─────────────────────────────────────────────────────────

/// Defines the type of content a track holds.
///
/// Ported from Swift `TrackType` enum.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize, TS, Default)]
#[ts(export)]
pub enum TrackType {
    /// Audio track — hosts audio clips.
    #[default]
    Audio,
    /// MIDI track — hosts MIDI clips routed to an instrument.
    Midi,
    /// Group track — contains child tracks for bus-level processing.
    Group,
    /// Master output track — singleton, always present.
    Master,
}

// ── Time Signature ─────────────────────────────────────────────────────

/// Musical time signature (e.g., 4/4, 3/4, 6/8).
///
/// Ported from Swift `TimeSignature` struct.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize, TS)]
#[ts(export)]
pub struct TimeSignature {
    /// Beats per bar (numerator). E.g., 4 in "4/4".
    pub numerator: u8,

    /// Beat unit (denominator). E.g., 4 = quarter note, 8 = eighth note.
    pub denominator: u8,
}

impl Default for TimeSignature {
    fn default() -> Self {
        Self {
            numerator: 4,
            denominator: 4,
        }
    }
}

impl TimeSignature {
    /// Creates a new time signature.
    pub fn new(numerator: u8, denominator: u8) -> Self {
        Self {
            numerator,
            denominator,
        }
    }

    /// Returns the number of quarter-note beats per bar.
    ///
    /// Converts compound time to quarter-note equivalent:
    /// - 4/4 → 4 beats
    /// - 6/8 → 3 beats (6 × 4 / 8 = 3)
    /// - 3/4 → 3 beats
    pub fn beats_per_bar(&self) -> u8 {
        if self.denominator == 0 {
            return 4;
        }
        (self.numerator as u16 * 4 / self.denominator as u16) as u8
    }

    /// Returns a display string (e.g., "4/4", "6/8").
    pub fn display(&self) -> String {
        format!("{}/{}", self.numerator, self.denominator)
    }
}

// ── Plugin Slot ────────────────────────────────────────────────────────

/// A slot for an audio plugin (instrument or effect) in a track's chain.
///
/// Ported from Swift `AudioEffectConfig` and `InstrumentConfig`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[ts(export)]
pub struct PluginSlot {
    /// Unique slot identifier.
    #[ts(type = "string")]
    pub id: Uuid,

    /// Display name of the plugin (e.g., "Pro-Q 3", "Serum").
    pub name: String,

    /// Plugin identifier (bundle path, AU ID, or VST path).
    pub plugin_id: String,

    /// Whether this slot is bypassed (passthrough).
    pub is_bypassed: bool,

    /// Plugin-reported latency in sample frames (for PDC).
    pub latency_frames: u32,

    /// Optional sidechain source track UUID (as string) for plugins that expose sidechain input.
    #[serde(default)]
    pub sidechain_source_track_id: Option<String>,

    /// Whether the external plugin exposes a dedicated sidechain input bus.
    #[serde(default)]
    pub supports_sidechain_input: Option<bool>,

    /// Number of external plugin audio input channels as reported by scanner/descriptor.
    #[serde(default)]
    pub external_audio_inputs: Option<u32>,

    /// External plugin format hint (`vst2`, `vst3`, `au`, ...).
    #[serde(default)]
    pub external_format: Option<String>,

    /// External plugin unique identifier (if available from host/project metadata).
    #[serde(default)]
    pub external_uid: Option<String>,

    /// External plugin preset/program display name.
    #[serde(default)]
    pub external_preset_name: Option<String>,

    /// External plugin active program number.
    #[serde(default)]
    pub external_program_number: Option<i32>,

    /// External plugin declared parameter count.
    #[serde(default)]
    pub external_parameter_count: Option<i32>,

    /// Whether ALS indicates that all plugin parameters were serialized.
    #[serde(default)]
    pub external_stored_all_parameters: Option<bool>,

    /// External plugin version from ALS metadata.
    #[serde(default)]
    pub external_plugin_version: Option<String>,

    /// Raw serialized external plugin state blob (typically base64), when present in ALS.
    #[serde(default)]
    pub external_state_blob: Option<String>,

    /// Kind/source tag for `external_state_blob` (for diagnostics/reconstruction).
    #[serde(default)]
    pub external_state_blob_kind: Option<String>,

    /// Raw serialized external plugin preset blob (typically base64), when present in ALS.
    #[serde(default)]
    pub external_preset_blob: Option<String>,

    /// Kind/source tag for `external_preset_blob` (for diagnostics/reconstruction).
    #[serde(default)]
    pub external_preset_blob_kind: Option<String>,
}

impl PluginSlot {
    /// Creates a new plugin slot.
    pub fn new(name: impl Into<String>, plugin_id: impl Into<String>) -> Self {
        Self {
            id: Uuid::new_v4(),
            name: name.into(),
            plugin_id: plugin_id.into(),
            is_bypassed: false,
            latency_frames: 0,
            sidechain_source_track_id: None,
            supports_sidechain_input: None,
            external_audio_inputs: None,
            external_format: None,
            external_uid: None,
            external_preset_name: None,
            external_program_number: None,
            external_parameter_count: None,
            external_stored_all_parameters: None,
            external_plugin_version: None,
            external_state_blob: None,
            external_state_blob_kind: None,
            external_preset_blob: None,
            external_preset_blob_kind: None,
        }
    }
}

// ── Device Rack ────────────────────────────────────────────────────────

/// Type of device rack.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize, TS, Default)]
#[ts(export)]
pub enum RackType {
    /// Instrument rack (contains instruments + effects, parallel chains).
    Instrument,
    /// Audio effect rack (parallel effect chains).
    #[default]
    AudioEffect,
    /// Drum rack (pad-based instrument container).
    DrumRack,
    /// MIDI effect rack (MIDI processing chains).
    MidiEffect,
}

/// Zone settings for a rack chain — key, velocity, and chain selector ranges.
///
/// Determines which notes/velocities route to this chain (Ableton-style).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[ts(export)]
pub struct ZoneSettings {
    /// Minimum MIDI key (0–127).
    pub key_range_min: u8,
    /// Maximum MIDI key (0–127).
    pub key_range_max: u8,
    /// Minimum velocity (1–127).
    pub velocity_range_min: u8,
    /// Maximum velocity (1–127).
    pub velocity_range_max: u8,
    /// Minimum chain selector value (0–127).
    pub chain_selector_min: u8,
    /// Maximum chain selector value (0–127).
    pub chain_selector_max: u8,
}

impl Default for ZoneSettings {
    fn default() -> Self {
        Self {
            key_range_min: 0,
            key_range_max: 127,
            velocity_range_min: 1,
            velocity_range_max: 127,
            chain_selector_min: 0,
            chain_selector_max: 127,
        }
    }
}

/// Maps a macro control to a device parameter inside a rack.
///
/// When the macro value changes, the mapped parameter is linearly
/// interpolated: macro at 0 → `min_value`, macro at 127 → `max_value`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[ts(export)]
pub struct MacroMapping {
    /// Target device ID within this rack.
    #[ts(type = "string")]
    pub device_id: Uuid,
    /// Target parameter identifier (e.g. "eq.low", "compressor.ratio").
    pub param_id: String,
    /// Value sent when macro is at minimum.
    pub min_value: f64,
    /// Value sent when macro is at maximum.
    pub max_value: f64,
}

/// A single macro control knob on a device rack.
///
/// Racks expose up to 16 macro knobs that can be mapped to parameters
/// of devices inside the rack's chains.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[ts(export)]
pub struct MacroControl {
    /// Macro index (0–15).
    pub index: u8,
    /// Display name (e.g., "Filter Cutoff", "Macro 1").
    pub name: String,
    /// Current value (0.0–127.0).
    pub value: f64,
    /// Default value (0.0–127.0).
    pub default_value: f64,
    /// Parameter mappings controlled by this macro.
    #[serde(default)]
    pub mappings: Vec<MacroMapping>,
}

impl MacroControl {
    /// Creates a new macro control with default name and zero value.
    pub fn new(index: u8) -> Self {
        Self {
            index,
            name: format!("Macro {}", index + 1),
            value: 0.0,
            default_value: 0.0,
            mappings: Vec::new(),
        }
    }
}

/// A single parallel chain inside a device rack.
///
/// Each chain contains its own ordered device list, zone settings,
/// and mix parameters. Multiple chains run in parallel and their
/// outputs are summed.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[ts(export)]
pub struct RackChain {
    /// Unique chain identifier.
    #[ts(type = "string")]
    pub id: Uuid,
    /// Display name for this chain.
    pub name: String,
    /// Ordered list of devices in this chain (supports nesting).
    pub devices: Vec<DeviceNode>,
    /// Zone settings controlling which notes/velocities route here.
    #[serde(default)]
    pub zone_settings: ZoneSettings,
    /// Whether this chain is soloed.
    #[serde(default)]
    pub is_solo: bool,
    /// Whether this chain is muted.
    #[serde(default)]
    pub is_mute: bool,
    /// Chain volume (0.0–2.0, 1.0 = unity).
    #[serde(default = "default_unity")]
    pub volume: f64,
    /// Chain pan (-1.0 to 1.0).
    #[serde(default)]
    pub pan: f64,
}

fn default_unity() -> f64 {
    1.0
}

impl RackChain {
    /// Creates a new empty chain with default settings.
    pub fn new(name: impl Into<String>) -> Self {
        Self {
            id: Uuid::new_v4(),
            name: name.into(),
            devices: Vec::new(),
            zone_settings: ZoneSettings::default(),
            is_solo: false,
            is_mute: false,
            volume: 1.0,
            pan: 0.0,
        }
    }
}

/// A device rack container with parallel chains and macro controls.
///
/// Modeled after Ableton's Instrument Rack / Audio Effect Rack.
/// Supports unlimited nesting depth (racks within racks).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[ts(export)]
pub struct DeviceRack {
    /// Unique rack identifier.
    #[ts(type = "string")]
    pub id: Uuid,
    /// Display name (e.g., "Childhood Home Piano", "Bass Rack").
    pub name: String,
    /// Type of rack (instrument, audio effect, etc.).
    pub rack_type: RackType,
    /// Parallel chains inside this rack.
    pub chains: Vec<RackChain>,
    /// Macro control knobs (up to 16).
    pub macro_controls: Vec<MacroControl>,
    /// Whether this rack is bypassed.
    #[serde(default)]
    pub is_bypassed: bool,
    /// Whether the rack is expanded in the UI.
    #[serde(default = "default_true")]
    pub is_expanded: bool,
}

fn default_true() -> bool {
    true
}

impl DeviceRack {
    /// Creates a new empty rack.
    pub fn new(name: impl Into<String>, rack_type: RackType) -> Self {
        Self {
            id: Uuid::new_v4(),
            name: name.into(),
            rack_type,
            chains: Vec::new(),
            macro_controls: (0..8).map(MacroControl::new).collect(),
            is_bypassed: false,
            is_expanded: true,
        }
    }

    /// Total latency of the rack (max of all chain latencies).
    pub fn total_latency_frames(&self) -> u32 {
        self.chains
            .iter()
            .map(|chain| {
                chain
                    .devices
                    .iter()
                    .filter(|d| !d.is_bypassed())
                    .map(|d| d.latency_frames())
                    .sum::<u32>()
            })
            .max()
            .unwrap_or(0)
    }
}

/// A single node in the device tree — either a standalone plugin or a rack.
///
/// This enum enables unlimited nesting: a rack chain contains `DeviceNode`s,
/// which can themselves be racks containing more chains and nodes.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[ts(export)]
#[serde(tag = "type")]
pub enum DeviceNode {
    /// A single plugin (instrument or effect).
    Single(PluginSlot),
    /// A device rack containing parallel chains.
    Rack(DeviceRack),
}

impl DeviceNode {
    /// Creates a `DeviceNode::Single` from a `PluginSlot`.
    pub fn single(slot: PluginSlot) -> Self {
        Self::Single(slot)
    }

    /// Creates a `DeviceNode::Rack` from a `DeviceRack`.
    pub fn rack(rack: DeviceRack) -> Self {
        Self::Rack(rack)
    }

    /// Whether this device node is bypassed.
    pub fn is_bypassed(&self) -> bool {
        match self {
            Self::Single(slot) => slot.is_bypassed,
            Self::Rack(rack) => rack.is_bypassed,
        }
    }

    /// Returns the latency in sample frames.
    pub fn latency_frames(&self) -> u32 {
        match self {
            Self::Single(slot) => slot.latency_frames,
            Self::Rack(rack) => rack.total_latency_frames(),
        }
    }

    /// Returns the display name.
    pub fn name(&self) -> &str {
        match self {
            Self::Single(slot) => &slot.name,
            Self::Rack(rack) => &rack.name,
        }
    }

    /// Returns the unique ID.
    pub fn id(&self) -> Uuid {
        match self {
            Self::Single(slot) => slot.id,
            Self::Rack(rack) => rack.id,
        }
    }

    /// Returns the plugin_id if this is a Single node, or a synthetic rack:// id.
    pub fn plugin_id(&self) -> String {
        match self {
            Self::Single(slot) => slot.plugin_id.clone(),
            Self::Rack(rack) => format!("rack://{:?}/{}", rack.rack_type, rack.id),
        }
    }

    /// Collects all `PluginSlot` references recursively (flattened).
    pub fn collect_plugin_slots(&self) -> Vec<&PluginSlot> {
        match self {
            Self::Single(slot) => vec![slot],
            Self::Rack(rack) => rack
                .chains
                .iter()
                .flat_map(|chain| chain.devices.iter().flat_map(|d| d.collect_plugin_slots()))
                .collect(),
        }
    }

    /// Collects all `PluginSlot` mutable references recursively (flattened).
    pub fn collect_plugin_slots_mut(&mut self) -> Vec<&mut PluginSlot> {
        match self {
            Self::Single(slot) => vec![slot],
            Self::Rack(rack) => rack
                .chains
                .iter_mut()
                .flat_map(|chain| chain.devices.iter_mut().flat_map(|d| d.collect_plugin_slots_mut()))
                .collect(),
        }
    }

    // ── Mutable Accessors ─────────────────────────────────────────────

    /// Returns a mutable reference to the inner `PluginSlot`, if this is `Single`.
    pub fn as_single_mut(&mut self) -> Option<&mut PluginSlot> {
        match self {
            Self::Single(slot) => Some(slot),
            Self::Rack(_) => None,
        }
    }

    /// Returns a reference to the inner `PluginSlot`, if this is `Single`.
    pub fn as_single(&self) -> Option<&PluginSlot> {
        match self {
            Self::Single(slot) => Some(slot),
            Self::Rack(_) => None,
        }
    }

    /// Sets the display name (works for both Single and Rack).
    pub fn set_name(&mut self, name: impl Into<String>) {
        match self {
            Self::Single(slot) => slot.name = name.into(),
            Self::Rack(rack) => rack.name = name.into(),
        }
    }

    /// Sets the plugin_id (only for Single — no-op for Rack).
    pub fn set_plugin_id(&mut self, plugin_id: impl Into<String>) {
        if let Self::Single(slot) = self {
            slot.plugin_id = plugin_id.into();
        }
    }

    /// Recursively regenerates all IDs within this device node.
    /// Used when duplicating tracks to ensure independent plugin instances.
    pub fn regenerate_ids(&mut self) {
        match self {
            Self::Single(slot) => {
                slot.id = Uuid::new_v4();
            }
            Self::Rack(rack) => {
                rack.id = Uuid::new_v4();
                for chain in &mut rack.chains {
                    chain.id = Uuid::new_v4();
                    for device in &mut chain.devices {
                        device.regenerate_ids();
                    }
                }
            }
        }
    }
}

impl From<PluginSlot> for DeviceNode {
    fn from(slot: PluginSlot) -> Self {
        Self::Single(slot)
    }
}

impl From<DeviceRack> for DeviceNode {
    fn from(rack: DeviceRack) -> Self {
        Self::Rack(rack)
    }
}

// ── Audio Clip ─────────────────────────────────────────────────────────

/// An audio clip placed on a track.
///
/// Represents a region of audio from a source file, positioned at a
/// specific point on the timeline via `AbsoluteTime`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[ts(export)]
pub struct AudioClip {
    /// Unique clip identifier.
    #[ts(type = "string")]
    pub id: Uuid,

    /// Display name (e.g., "Vocal Take 3").
    pub name: String,

    /// Path to the source audio file (relative to project directory).
    pub file_path: String,

    /// Position on the timeline (sample-accurate).
    pub position: AbsoluteTime,

    /// Duration in sample frames.
    pub duration: AbsoluteTime,

    /// Offset into the source file (for trimmed clips).
    pub source_offset: AbsoluteTime,

    /// Gain multiplier for this clip (1.0 = unity).
    pub gain: f64,

    /// User-defined fade-in length in sample frames.
    #[serde(default)]
    pub fade_in_frames: i64,

    /// User-defined fade-out length in sample frames.
    #[serde(default)]
    pub fade_out_frames: i64,

    /// Whether source media is currently missing on disk.
    #[serde(default)]
    pub is_offline: bool,

    /// Whether this clip is currently selected in the UI.
    pub is_selected: bool,

    /// Whether this clip is muted (stays on timeline but doesn't play).
    #[serde(default)]
    pub is_muted: bool,

    /// Optional color override (uses track color when `None`).
    pub color_override: Option<TrackColor>,

    /// Exact hex color override from ALS color index (e.g. "#FF3636").
    /// When present, UI should prefer this over `color_override`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub color_hex: Option<String>,

    /// Session launch mode code (`LaunchMode` in ALS).
    #[serde(default)]
    pub launch_mode: i32,

    /// Session launch quantization code (`LaunchQuantisation`).
    #[serde(default)]
    pub launch_quantization: i32,

    /// Follow action enabled flag.
    #[serde(default)]
    pub follow_action_enabled: bool,

    /// Follow time value from ALS.
    #[serde(default)]
    pub follow_time: f64,

    /// Follow action A code from ALS.
    #[serde(default)]
    pub follow_action_a: i32,

    /// Follow action B code from ALS.
    #[serde(default)]
    pub follow_action_b: i32,

    /// Follow chance A value from ALS (usually 0..100).
    #[serde(default)]
    pub follow_chance_a: f64,

    /// Follow chance B value from ALS (usually 0..100).
    #[serde(default)]
    pub follow_chance_b: f64,

    /// Whether clip is marked in-key (`IsInKey`).
    #[serde(default)]
    pub is_in_key: bool,

    /// ALS scale root (0..11) when present.
    #[serde(default)]
    pub scale_root: Option<u8>,

    /// ALS scale name/id when present.
    #[serde(default)]
    pub scale_name: Option<String>,

    /// Warp enabled state (`IsWarped`).
    #[serde(default)]
    pub is_warped: bool,

    /// ALS warp mode numeric code.
    #[serde(default)]
    pub warp_mode: Option<i32>,

    /// Parsed warp marker points.
    #[serde(default)]
    pub warp_markers: Vec<WarpMarkerPoint>,

    /// Clip base BPM used for warp speed ratio calculations.
    #[serde(default = "default_clip_warp_base_bpm")]
    pub warp_base_bpm: f64,

    /// Source-domain duration (frames) for warp mapping.
    ///
    /// This stays stable while warped clip timeline duration changes with tempo.
    #[serde(default)]
    pub warp_source_duration_frames: i64,

    /// ALS take identifier (`TakeId`).
    #[serde(default)]
    pub take_id: Option<i32>,

    /// Clip legato flag (`Legato`).
    #[serde(default)]
    pub legato: bool,

    /// RAM preload flag (`Ram`).
    #[serde(default)]
    pub ram: bool,

    /// Clip-local time signature numerator (`TimeSignature/TimeSignatures`).
    #[serde(default)]
    pub time_signature_numerator: Option<u8>,

    /// Clip-local time signature denominator (`TimeSignature/TimeSignatures`).
    #[serde(default)]
    pub time_signature_denominator: Option<u8>,

    /// Clip loop start in beats when present in ALS `<Loop>`.
    #[serde(default)]
    pub loop_start_beats: Option<f64>,

    /// Clip loop end in beats when present in ALS `<Loop>`.
    #[serde(default)]
    pub loop_end_beats: Option<f64>,

    /// Clip loop enabled flag from ALS.
    #[serde(default)]
    pub loop_on: bool,

    /// Groove template name from ALS (e.g., "MPC 8th Swing 59%").
    #[serde(default)]
    pub groove_name: Option<String>,

    /// Groove amount (0.0–1.0 normalized from ALS GrooveAmount).
    #[serde(default)]
    pub groove_amount: f64,

    /// Intra-clip automation envelopes.
    #[serde(default)]
    pub envelopes: Vec<ClipEnvelope>,
}

impl AudioClip {
    /// Creates a new `AudioClip` with default gain.
    pub fn new(
        name: impl Into<String>,
        file_path: impl Into<String>,
        position: AbsoluteTime,
        duration: AbsoluteTime,
    ) -> Self {
        Self {
            id: Uuid::new_v4(),
            name: name.into(),
            file_path: file_path.into(),
            position,
            duration,
            source_offset: AbsoluteTime::ZERO,
            gain: 1.0,
            fade_in_frames: 0,
            fade_out_frames: 0,
            is_offline: false,
            is_selected: false,
            is_muted: false,
            color_override: None,
            color_hex: None,
            launch_mode: 0,
            launch_quantization: 0,
            follow_action_enabled: false,
            follow_time: 0.0,
            follow_action_a: 0,
            follow_action_b: 0,
            follow_chance_a: 0.0,
            follow_chance_b: 0.0,
            is_in_key: false,
            scale_root: None,
            scale_name: None,
            is_warped: false,
            warp_mode: None,
            warp_markers: Vec::new(),
            warp_base_bpm: default_clip_warp_base_bpm(),
            warp_source_duration_frames: duration.sample_frame.max(1),
            take_id: None,
            legato: false,
            ram: false,
            time_signature_numerator: None,
            time_signature_denominator: None,
            loop_start_beats: None,
            loop_end_beats: None,
            loop_on: false,
            groove_name: None,
            groove_amount: 0.0,
            envelopes: Vec::new(),
        }
    }

    /// Returns the end position of this clip on the timeline.
    #[inline]
    pub fn end_position(&self) -> AbsoluteTime {
        self.position.advanced(self.duration.sample_frame)
    }

    /// Whether a given sample frame falls within this clip.
    #[inline]
    pub fn contains_frame(&self, frame: i64) -> bool {
        frame >= self.position.sample_frame && frame < self.end_position().sample_frame
    }

    /// Whether this clip overlaps with a given sample range.
    #[inline]
    pub fn overlaps(&self, start: i64, end: i64) -> bool {
        self.position.sample_frame < end && self.end_position().sample_frame > start
    }
}

fn default_clip_warp_base_bpm() -> f64 {
    120.0
}

// ── Automation ────────────────────────────────────────────────────────

/// A single automation breakpoint.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[ts(export)]
pub struct AutomationPoint {
    /// Position in beats on the timeline.
    pub beat: f64,
    /// Normalized value (semantics depend on parameter).
    pub value: f64,
    /// Curve type to next point ("linear", "bezier", "step").
    #[serde(default = "default_automation_curve_type")]
    pub curve_type: String,
    /// Optional curve tension for bezier-like shapes (legacy approximation).
    #[serde(default)]
    pub tension: Option<f64>,
    /// Full cubic bezier control point 1 X (normalized 0..1 within segment).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub bezier_cp1x: Option<f64>,
    /// Full cubic bezier control point 1 Y (normalized 0..1 within value range).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub bezier_cp1y: Option<f64>,
    /// Full cubic bezier control point 2 X (normalized 0..1 within segment).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub bezier_cp2x: Option<f64>,
    /// Full cubic bezier control point 2 Y (normalized 0..1 within value range).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub bezier_cp2y: Option<f64>,
}

fn default_automation_curve_type() -> String {
    "linear".to_string()
}

/// Automation lane attached to a specific track parameter.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[ts(export)]
pub struct AutomationLane {
    /// Parameter identifier (e.g. "volume", "pan").
    pub param_id: String,
    /// Ordered automation breakpoints.
    #[serde(default)]
    pub points: Vec<AutomationPoint>,
}

// ── Track ──────────────────────────────────────────────────────────────

/// A single track in the project.
///
/// Contains clips, routing metadata, and mix parameters.
/// The track itself does not process audio — it is a data container
/// consumed by the audio graph's `NodeKind::Track` processor.
///
/// Enriched from Swift `Track` class (276 LOC).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[ts(export)]
pub struct Track {
    /// Unique track identifier.
    #[ts(type = "string")]
    pub id: Uuid,

    /// Display name (e.g., "Lead Vocal").
    pub name: String,

    /// The type of content this track holds.
    pub track_type: TrackType,

    /// Audio clips on this track (ordered by position).
    pub clips: Vec<AudioClip>,

    /// Volume fader (0.0 = -∞ dB, 1.0 = 0 dB, 2.0 = +6 dB).
    pub volume: f64,

    /// Pan position (-1.0 = hard left, 0.0 = center, 1.0 = hard right).
    pub pan: f64,

    /// Whether this track is soloed.
    pub is_solo: bool,

    /// Whether this track is muted.
    pub is_mute: bool,

    /// Whether this track is armed for recording.
    pub is_armed: bool,

    /// Visual color in the UI.
    pub color: TrackColor,

    /// Exact hex color override (e.g. "#FF3636" from Ableton import).
    /// When present, the frontend uses this instead of the `color` enum.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub color_hex: Option<String>,

    /// Track height in pixels (for arrangement view).
    pub height: f64,

    /// Output routing destination (track/bus UUID). `None` = master output.
    #[ts(type = "string | null")]
    pub output_destination_id: Option<Uuid>,

    /// Input routing source identifier (`AudioInputRouting` / `MidiInputRouting` target value).
    ///
    /// Kept as raw routing token (e.g. `AudioIn/Ext.1`, `MidiIn/Track.42`) because
    /// ALS uses multiple non-UUID addressing modes.
    #[serde(default)]
    pub input_source_id: Option<String>,

    /// Track monitoring mode (`MonitoringEnum`): 0=In, 1=Auto, 2=Off.
    #[serde(default)]
    pub monitoring_mode: Option<u8>,

    // ── Effect Chain ───────────────────────────────────────────────────
    /// Insert device nodes (processed in order). Each can be a single
    /// plugin or a nested device rack.
    pub effects: Vec<DeviceNode>,

    /// Instrument device (for MIDI tracks). `None` for audio tracks.
    /// Can be a single plugin or an instrument rack.
    pub instrument: Option<DeviceNode>,

    // ── Grouping / Hierarchy ───────────────────────────────────────────
    /// Parent group track ID. `None` = top-level track.
    #[ts(type = "string | null")]
    pub parent_track_id: Option<Uuid>,

    /// Child track IDs (for group tracks only).
    #[ts(type = "string[]")]
    pub child_track_ids: Vec<Uuid>,

    /// Whether a group track is expanded (showing children).
    pub is_expanded: bool,

    // ── MIDI ───────────────────────────────────────────────────────────
    /// MIDI clips on this track (for MIDI tracks).
    pub midi_clips: Vec<MidiClip>,

    /// Sampler instrument configuration (for MIDI tracks).
    pub sampler: Option<SamplerConfig>,

    // ── Automation ────────────────────────────────────────────────────
    /// Automation lanes for this track (volume/pan/plugin params).
    #[serde(default)]
    pub automation_lanes: Vec<AutomationLane>,
}

impl Track {
    /// Creates a new empty track with default settings.
    pub fn new(name: impl Into<String>) -> Self {
        Self {
            id: Uuid::new_v4(),
            name: name.into(),
            track_type: TrackType::Audio,
            clips: Vec::new(),
            volume: 1.0,
            pan: 0.0,
            is_solo: false,
            is_mute: false,
            is_armed: false,
            color: TrackColor::default(),
            color_hex: None,
            height: 48.0,
            output_destination_id: None,
            input_source_id: None,
            monitoring_mode: None,
            effects: Vec::new(),
            instrument: None,
            parent_track_id: None,
            child_track_ids: Vec::new(),
            is_expanded: true,
            midi_clips: Vec::new(),
            sampler: None,
            automation_lanes: Vec::new(),
        }
    }

    /// Creates a new track with a specific type and color index.
    pub fn with_type(name: impl Into<String>, track_type: TrackType, color_index: usize) -> Self {
        let mut track = Self::new(name);
        track.track_type = track_type;
        track.color = TrackColor::for_index(color_index);
        track
    }

    /// Total latency of this track's effect chain in sample frames.
    ///
    /// Used by PDC to align parallel paths. Handles both single plugins
    /// and nested device racks (racks report max-of-chain latencies).
    pub fn total_latency_frames(&self) -> u32 {
        let instrument_latency = self
            .instrument
            .as_ref()
            .filter(|d| !d.is_bypassed())
            .map_or(0, |d| d.latency_frames());

        let effects_latency: u32 = self
            .effects
            .iter()
            .filter(|d| !d.is_bypassed())
            .map(|d| d.latency_frames())
            .sum();

        instrument_latency + effects_latency
    }

    /// Whether this track has any content (clips, MIDI clips, or data).
    pub fn is_empty(&self) -> bool {
        self.clips.is_empty() && self.midi_clips.is_empty()
    }

    /// End position of the last clip on this track.
    pub fn end_position(&self) -> AbsoluteTime {
        let audio_end = self
            .clips
            .iter()
            .map(|c| c.end_position())
            .max_by_key(|t| t.sample_frame)
            .unwrap_or(AbsoluteTime::ZERO);

        let midi_end = self
            .midi_clips
            .iter()
            .map(|c| c.end_position())
            .max_by_key(|t| t.sample_frame)
            .unwrap_or(AbsoluteTime::ZERO);

        if midi_end.sample_frame > audio_end.sample_frame {
            midi_end
        } else {
            audio_end
        }
    }
}

// ── Tempo & Time Signature Automation ──────────────────────────────────

/// A single tempo change event for variable-BPM playback.
///
/// When `tempo_automation_events` is non-empty on a `Project`, the transport
/// engine should interpolate BPM between events rather than using a single
/// fixed tempo. The `beat` field is in Ableton quarter-note beats.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[ts(export)]
pub struct TempoAutomationEvent {
    /// Beat position (quarter-note beats from project start).
    pub beat: f64,
    /// BPM value at this position.
    pub bpm: f64,
    /// Interpolation type to the NEXT event ("linear" or "step").
    #[serde(default = "default_tempo_curve")]
    pub curve_type: String,
}

fn default_tempo_curve() -> String {
    "linear".to_string()
}

/// A mid-song time signature change.
///
/// Stored in chronological order. The *first* entry (if any) represents the
/// initial time signature. Subsequent entries mark where the signature changes.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[ts(export)]
pub struct TimeSignatureChange {
    /// Beat position where this time signature takes effect.
    pub beat: f64,
    /// Time signature numerator.
    pub numerator: u8,
    /// Time signature denominator.
    pub denominator: u8,
}

// ── Project ────────────────────────────────────────────────────────────

/// The top-level project container — the entire DAW session.
///
/// Serialized to disk as compressed JSON. Loaded on app launch.
/// All tracks, clips, and tempo data live here.
///
/// Enriched from Swift `Project` class (455 LOC).
#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[ts(export)]
pub struct Project {
    /// Unique project identifier.
    #[ts(type = "string")]
    pub id: Uuid,

    /// Project name (shown in title bar).
    pub name: String,

    /// All tracks in the project (ordered top → bottom).
    pub tracks: Vec<Track>,

    /// The master output track (always exists).
    pub master_track: Track,

    /// Tempo map for beat ↔ sample conversion.
    pub pulse_map: PulseMap,

    /// Project sample rate (e.g., 44100, 48000, 96000).
    pub sample_rate: f64,

    /// Musical time signature.
    pub time_signature: TimeSignature,

    /// Project version string for migration compatibility.
    pub version: String,

    // ── View State Persistence (ported from Swift Project.swift) ───────
    /// Zoom level in pixels per beat (persisted for session restore).
    #[serde(default)]
    pub view_zoom_scale: Option<f64>,

    /// Horizontal scroll position in beats (persisted for session restore).
    #[serde(default)]
    pub view_scroll_position: Option<f64>,

    /// Browser panel width in points (persisted for session restore).
    #[serde(default)]
    pub view_browser_width: Option<f64>,

    /// Arrangement/editor grid numerator (e.g. 1 in 1/16).
    #[serde(default = "default_arrangement_grid_numerator")]
    pub arrangement_grid_numerator: u16,

    /// Arrangement/editor grid denominator (e.g. 16 in 1/16).
    #[serde(default = "default_arrangement_grid_denominator")]
    pub arrangement_grid_denominator: u16,

    /// Ableton n-tuple subdivision hint (`Ntoles`).
    #[serde(default = "default_arrangement_grid_ntoles")]
    pub arrangement_grid_ntoles: u8,

    /// Whether snap-to-grid is enabled.
    #[serde(default = "default_arrangement_snap_to_grid")]
    pub arrangement_snap_to_grid: bool,

    /// Project-level markers / locators imported from ALS.
    #[serde(default)]
    pub markers: Vec<ProjectMarker>,

    /// Session scenes imported from ALS `<Scenes>`.
    #[serde(default)]
    pub session_scenes: Vec<ProjectScene>,

    /// Whether fixed grid mode is enabled.
    #[serde(default)]
    pub arrangement_grid_fixed: bool,

    /// Global automation mode toggle (`AutomationMode`).
    #[serde(default)]
    pub automation_mode_enabled: bool,

    /// Whether automation editing snaps to grid (`SnapAutomationToGrid`).
    #[serde(default = "default_true")]
    pub snap_automation_to_grid: bool,

    /// Arrangement overdub mode (`ArrangementOverdub`).
    #[serde(default)]
    pub arrangement_overdub: bool,

    /// Solo in place mode (`SoloInPlace`).
    #[serde(default = "default_true")]
    pub solo_in_place: bool,

    /// Crossfade curve mode value (`CrossfadeCurve`).
    #[serde(default = "default_crossfade_curve")]
    pub crossfade_curve: i32,

    /// Latency compensation mode (`LatencyCompensation`).
    #[serde(default = "default_latency_compensation")]
    pub latency_compensation_mode: i32,

    /// Transport punch-in mode (`Transport/PunchIn`).
    #[serde(default)]
    pub punch_in_enabled: bool,

    /// Transport punch-out mode (`Transport/PunchOut`).
    #[serde(default)]
    pub punch_out_enabled: bool,

    /// Transport metronome tick duration (`Transport/MetronomeTickDuration`).
    #[serde(default)]
    pub metronome_tick_duration: f64,

    /// Global groove amount (`MainTrack/GlobalGrooveAmount/Manual`).
    #[serde(default = "default_global_groove_amount")]
    pub global_groove_amount: f64,

    /// Session view horizontal scroll position (`SessionScrollPos@X`).
    #[serde(default)]
    pub session_scroll_x: i32,

    /// Session view vertical scroll position (`SessionScrollPos@Y`).
    #[serde(default)]
    pub session_scroll_y: i32,

    /// Selected breakpoint value in detail editors (`SelectedBreakpointValue`).
    #[serde(default)]
    pub selected_breakpoint_value: f64,

    /// Root `TimeSelection/AnchorTime` in beats.
    #[serde(default)]
    pub time_selection_anchor_beats: Option<f64>,

    /// Root `TimeSelection/OtherTime` in beats.
    #[serde(default)]
    pub time_selection_other_beats: Option<f64>,

    /// `SequencerNavigator/BeatTimeHelper/CurrentZoom`.
    #[serde(default)]
    pub sequencer_navigator_zoom: Option<f64>,

    /// `SequencerNavigator/ScrollerPos@X`.
    #[serde(default)]
    pub sequencer_navigator_scroll_x: Option<i32>,

    /// `SequencerNavigator/ScrollerPos@Y`.
    #[serde(default)]
    pub sequencer_navigator_scroll_y: Option<i32>,

    /// `SequencerNavigator/ClientSize@X`.
    #[serde(default)]
    pub sequencer_navigator_client_width: Option<i32>,

    /// `SequencerNavigator/ClientSize@Y`.
    #[serde(default)]
    pub sequencer_navigator_client_height: Option<i32>,

    /// Root `IsContentSplitterOpen`.
    #[serde(default)]
    pub is_content_splitter_open: bool,

    /// Root `IsExpressionSplitterOpen`.
    #[serde(default)]
    pub is_expression_splitter_open: bool,

    /// Project annotation (`Annotation`).
    #[serde(default)]
    pub annotation: String,

    /// SMPTE format (`SmpteFormat`).
    #[serde(default)]
    pub smpte_format: i32,

    /// Root `ExpressionLanes/MidiEditorLaneModel`.
    #[serde(default)]
    pub expression_lanes: Vec<MidiEditorLaneState>,

    /// Root `ContentLanes/MidiEditorLaneModel`.
    #[serde(default)]
    pub content_lanes: Vec<MidiEditorLaneState>,

    /// Raw LiveSet `ViewData` JSON string when present.
    #[serde(default)]
    pub view_data_json: Option<String>,

    /// `AutoColorPickerForPlayerAndGroupTracks/NextColorIndex`.
    #[serde(default)]
    pub auto_color_picker_player_group_next_color_index: i32,

    /// `AutoColorPickerForReturnAndMainTracks/NextColorIndex`.
    #[serde(default)]
    pub auto_color_picker_return_main_next_color_index: i32,

    /// `GroovePool/DefaultGrooveId`.
    #[serde(default)]
    pub groove_pool_default_groove_id: Option<i32>,

    /// Number of grooves in `GroovePool/Grooves`.
    #[serde(default)]
    pub groove_pool_groove_count: i32,

    /// Number of groups in `LinkedTrackGroups`.
    #[serde(default)]
    pub linked_track_group_count: i32,

    /// Number of tuning systems in `TuningSystems`.
    #[serde(default)]
    pub tuning_system_count: i32,

    /// Number of algorithms in `NoteAlgorithms`.
    #[serde(default)]
    pub note_algorithm_count: i32,

    /// `VideoWindowRect@Top`.
    #[serde(default)]
    pub video_window_rect_top: Option<i32>,
    /// `VideoWindowRect@Left`.
    #[serde(default)]
    pub video_window_rect_left: Option<i32>,
    /// `VideoWindowRect@Bottom`.
    #[serde(default)]
    pub video_window_rect_bottom: Option<i32>,
    /// `VideoWindowRect@Right`.
    #[serde(default)]
    pub video_window_rect_right: Option<i32>,

    /// Global launch quantisation (`GlobalQuantisation`).
    #[serde(default)]
    pub global_quantisation: i32,

    /// Auto quantisation (`AutoQuantisation`).
    #[serde(default)]
    pub auto_quantisation: i32,

    /// Selected document view in main window (`SelectedDocumentViewInMainWindow`).
    #[serde(default)]
    pub selected_document_view: i32,

    /// Number of visible FX slots (`ViewStateFxSlotCount`).
    #[serde(default)]
    pub view_state_fx_slot_count: i32,

    /// Session mixer volume section height (`ViewStateSessionMixerVolumeSectionHeight`).
    #[serde(default)]
    pub view_state_session_mixer_volume_section_height: f64,

    /// Arranger mixer volume section height (`ViewStateArrangerMixerVolumeSectionHeight`).
    #[serde(default)]
    pub view_state_arranger_mixer_volume_section_height: f64,

    /// Session track width (`ViewStateSessionTrackWidth`).
    #[serde(default)]
    pub view_state_session_track_width: f64,

    /// Main window clip detail visibility.
    #[serde(default)]
    pub view_state_main_window_clip_detail_open: bool,

    /// Main window device detail visibility.
    #[serde(default)]
    pub view_state_main_window_device_detail_open: bool,

    /// Second window clip detail visibility.
    #[serde(default)]
    pub view_state_second_window_clip_detail_open: bool,

    /// Second window device detail visibility.
    #[serde(default)]
    pub view_state_second_window_device_detail_open: bool,

    /// Scene tempo/time-signature visibility flag.
    #[serde(default)]
    pub should_scene_tempo_time_signature_be_visible: bool,

    /// Waveform vertical zoom factor.
    #[serde(default)]
    pub waveform_vertical_zoom_factor: f64,

    /// Whether waveform vertical zoom is active.
    #[serde(default)]
    pub is_waveform_vertical_zoom_active: bool,

    /// Highlighted track index in LiveSet UI.
    #[serde(default)]
    pub highlighted_track_index: i32,

    /// Track header width in UI units.
    #[serde(default)]
    pub track_header_width: f64,

    /// Reset non-automated MIDI controllers on clip starts.
    #[serde(default)]
    pub reset_nonautomated_midi_controllers_on_clip_starts: bool,

    /// MIDI fold-in state.
    #[serde(default)]
    pub midi_fold_in: bool,

    /// MIDI fold mode value.
    #[serde(default)]
    pub midi_fold_mode: i32,

    /// Multi-clip focus mode state.
    #[serde(default)]
    pub multi_clip_focus_mode: bool,

    /// Multi-clip loop bar height.
    #[serde(default)]
    pub multi_clip_loop_bar_height: f64,

    /// MIDI prelisten state.
    #[serde(default)]
    pub midi_prelisten: bool,

    /// Warper legacy high-quality mode toggle.
    #[serde(default)]
    pub use_warper_legacy_hiq_mode: bool,

    /// Show video window state.
    #[serde(default)]
    pub show_video_window: bool,

    /// Stored solo/PFL state.
    #[serde(default)]
    pub solo_or_pfl_saved_value: bool,

    /// UI color sequence index.
    #[serde(default)]
    pub color_sequence_index: i32,

    /// Note spelling preference.
    #[serde(default)]
    pub note_spelling_preference: i32,

    /// Accidental spelling preference.
    #[serde(default)]
    pub accidental_spelling_preference: i32,

    /// Prefer flat root note spelling.
    #[serde(default)]
    pub prefer_flat_root_note: bool,

    /// Main window hidden-other-doc clip detail open state.
    #[serde(default)]
    pub view_state_main_window_hidden_other_doc_view_type_clip_detail_open: bool,

    /// Main window hidden-other-doc device detail open state.
    #[serde(default)]
    pub view_state_main_window_hidden_other_doc_view_type_device_detail_open: bool,

    /// Transport phase nudge tempo value.
    #[serde(default)]
    pub transport_phase_nudge_tempo: f64,

    /// Whether transport loop starts from song start.
    #[serde(default)]
    pub transport_loop_is_song_start: bool,

    /// Transport draw mode state.
    #[serde(default)]
    pub transport_draw_mode: bool,

    /// ViewStates/MixerInArrangement.
    #[serde(default)]
    pub view_mixer_in_arrangement: bool,
    /// ViewStates/ArrangerMixerIO.
    #[serde(default)]
    pub view_arranger_mixer_io: bool,
    /// ViewStates/ArrangerMixerSends.
    #[serde(default)]
    pub view_arranger_mixer_sends: bool,
    /// ViewStates/ArrangerMixerReturns.
    #[serde(default)]
    pub view_arranger_mixer_returns: bool,
    /// ViewStates/ArrangerMixerVolume.
    #[serde(default)]
    pub view_arranger_mixer_volume: bool,
    /// ViewStates/ArrangerMixerTrackOptions.
    #[serde(default)]
    pub view_arranger_mixer_track_options: bool,
    /// ViewStates/ArrangerMixerCrossFade.
    #[serde(default)]
    pub view_arranger_mixer_crossfade: bool,
    /// ViewStates/ArrangerMixerTrackPerformanceImpactMeter.
    #[serde(default)]
    pub view_arranger_mixer_track_performance_impact_meter: bool,
    /// ViewStates/MixerInSession.
    #[serde(default)]
    pub view_mixer_in_session: bool,
    /// ViewStates/SessionIO.
    #[serde(default)]
    pub view_session_io: bool,
    /// ViewStates/SessionSends.
    #[serde(default)]
    pub view_session_sends: bool,
    /// ViewStates/SessionReturns.
    #[serde(default)]
    pub view_session_returns: bool,
    /// ViewStates/SessionVolume.
    #[serde(default)]
    pub view_session_volume: bool,
    /// ViewStates/SessionTrackOptions.
    #[serde(default)]
    pub view_session_track_options: bool,
    /// ViewStates/SessionCrossFade.
    #[serde(default)]
    pub view_session_crossfade: bool,
    /// ViewStates/SessionTrackPerformanceImpactMeter.
    #[serde(default)]
    pub view_session_track_performance_impact_meter: bool,
    /// ViewStates/SessionShowOverView.
    #[serde(default)]
    pub view_session_show_overview: bool,
    /// ViewStates/ArrangerIO.
    #[serde(default)]
    pub view_arranger_io: bool,
    /// ViewStates/ArrangerReturns.
    #[serde(default)]
    pub view_arranger_returns: bool,
    /// ViewStates/ArrangerVolume.
    #[serde(default)]
    pub view_arranger_volume: bool,
    /// ViewStates/ArrangerTrackOptions.
    #[serde(default)]
    pub view_arranger_track_options: bool,
    /// ViewStates/ArrangerShowOverView.
    #[serde(default)]
    pub view_arranger_show_overview: bool,

    // ── Playback State ────────────────────────────────────────────────
    /// Persisted transport playhead position (sample frames).
    #[serde(default)]
    pub playhead_position_frames: i64,

    // ── Loop Region ──────────────────────────────────────────────────
    /// Whether looping is enabled.
    #[serde(default)]
    pub is_looping: bool,

    /// Loop start position (sample frames). `None` = not set.
    #[serde(default)]
    pub loop_start_frames: Option<i64>,

    /// Loop end position (sample frames). `None` = not set.
    #[serde(default)]
    pub loop_end_frames: Option<i64>,

    // ── Key Signature ────────────────────────────────────────────────
    /// Whether key signature display is enabled.
    #[serde(default)]
    pub key_sig_enabled: bool,

    /// Key signature tonic (e.g., "C", "D#/Eb"). Empty = not set.
    #[serde(default = "default_key_tonic")]
    pub key_sig_tonic: String,

    /// Key signature mode (e.g., "Major", "Minor", "Dorian").
    #[serde(default = "default_key_mode")]
    pub key_sig_mode: String,

    // ── Tempo Automation ──────────────────────────────────────────────
    /// Tempo automation events for variable-BPM playback.
    ///
    /// Empty = fixed tempo (use `pulse_map` BPM). Non-empty = the transport
    /// should interpolate BPM between these events.
    #[serde(default)]
    pub tempo_automation_events: Vec<TempoAutomationEvent>,

    /// Mid-song time signature changes.
    ///
    /// Empty = single time signature (use `time_signature` field).
    #[serde(default)]
    pub time_signature_changes: Vec<TimeSignatureChange>,
}

fn default_key_tonic() -> String {
    "C".to_string()
}
fn default_key_mode() -> String {
    "Major".to_string()
}
fn default_arrangement_grid_numerator() -> u16 {
    1
}
fn default_arrangement_grid_denominator() -> u16 {
    16
}
fn default_arrangement_grid_ntoles() -> u8 {
    2
}
fn default_arrangement_snap_to_grid() -> bool {
    true
}
fn default_crossfade_curve() -> i32 {
    2
}
fn default_latency_compensation() -> i32 {
    2
}
fn default_global_groove_amount() -> f64 {
    100.0
}

impl Project {
    /// Creates a new empty project with default settings.
    pub fn new(name: impl Into<String>, bpm: f64, sample_rate: f64) -> Self {
        let mut master = Track::new("Master");
        master.color = TrackColor::Slate;
        master.track_type = TrackType::Master;

        Self {
            id: Uuid::new_v4(),
            name: name.into(),
            tracks: Vec::new(),
            master_track: master,
            pulse_map: PulseMap::new(bpm, sample_rate),
            sample_rate,
            time_signature: TimeSignature::default(),
            version: "0.1.0".to_string(),
            // View state
            view_zoom_scale: None,
            view_scroll_position: None,
            view_browser_width: None,
            arrangement_grid_numerator: default_arrangement_grid_numerator(),
            arrangement_grid_denominator: default_arrangement_grid_denominator(),
            arrangement_grid_ntoles: default_arrangement_grid_ntoles(),
            arrangement_snap_to_grid: default_arrangement_snap_to_grid(),
            arrangement_grid_fixed: false,
            automation_mode_enabled: false,
            snap_automation_to_grid: true,
            arrangement_overdub: false,
            solo_in_place: true,
            crossfade_curve: default_crossfade_curve(),
            latency_compensation_mode: default_latency_compensation(),
            punch_in_enabled: false,
            punch_out_enabled: false,
            metronome_tick_duration: 0.0,
            global_groove_amount: default_global_groove_amount(),
            session_scroll_x: 0,
            session_scroll_y: 0,
            selected_breakpoint_value: 0.0,
            time_selection_anchor_beats: None,
            time_selection_other_beats: None,
            sequencer_navigator_zoom: None,
            sequencer_navigator_scroll_x: None,
            sequencer_navigator_scroll_y: None,
            sequencer_navigator_client_width: None,
            sequencer_navigator_client_height: None,
            is_content_splitter_open: false,
            is_expression_splitter_open: false,
            annotation: String::new(),
            smpte_format: 0,
            expression_lanes: Vec::new(),
            content_lanes: Vec::new(),
            view_data_json: None,
            auto_color_picker_player_group_next_color_index: 0,
            auto_color_picker_return_main_next_color_index: 0,
            groove_pool_default_groove_id: None,
            groove_pool_groove_count: 0,
            linked_track_group_count: 0,
            tuning_system_count: 0,
            note_algorithm_count: 0,
            video_window_rect_top: None,
            video_window_rect_left: None,
            video_window_rect_bottom: None,
            video_window_rect_right: None,
            global_quantisation: 0,
            auto_quantisation: 0,
            selected_document_view: 0,
            view_state_fx_slot_count: 0,
            view_state_session_mixer_volume_section_height: 0.0,
            view_state_arranger_mixer_volume_section_height: 0.0,
            view_state_session_track_width: 0.0,
            view_state_main_window_clip_detail_open: false,
            view_state_main_window_device_detail_open: false,
            view_state_second_window_clip_detail_open: false,
            view_state_second_window_device_detail_open: false,
            should_scene_tempo_time_signature_be_visible: false,
            waveform_vertical_zoom_factor: 1.0,
            is_waveform_vertical_zoom_active: false,
            highlighted_track_index: -1,
            track_header_width: 0.0,
            reset_nonautomated_midi_controllers_on_clip_starts: false,
            midi_fold_in: false,
            midi_fold_mode: 0,
            multi_clip_focus_mode: false,
            multi_clip_loop_bar_height: 0.0,
            midi_prelisten: false,
            use_warper_legacy_hiq_mode: false,
            show_video_window: false,
            solo_or_pfl_saved_value: false,
            color_sequence_index: 0,
            note_spelling_preference: 0,
            accidental_spelling_preference: 0,
            prefer_flat_root_note: false,
            view_state_main_window_hidden_other_doc_view_type_clip_detail_open: false,
            view_state_main_window_hidden_other_doc_view_type_device_detail_open: false,
            transport_phase_nudge_tempo: 0.0,
            transport_loop_is_song_start: false,
            transport_draw_mode: false,
            view_mixer_in_arrangement: false,
            view_arranger_mixer_io: false,
            view_arranger_mixer_sends: false,
            view_arranger_mixer_returns: false,
            view_arranger_mixer_volume: false,
            view_arranger_mixer_track_options: false,
            view_arranger_mixer_crossfade: false,
            view_arranger_mixer_track_performance_impact_meter: false,
            view_mixer_in_session: false,
            view_session_io: false,
            view_session_sends: false,
            view_session_returns: false,
            view_session_volume: false,
            view_session_track_options: false,
            view_session_crossfade: false,
            view_session_track_performance_impact_meter: false,
            view_session_show_overview: false,
            view_arranger_io: false,
            view_arranger_returns: false,
            view_arranger_volume: false,
            view_arranger_track_options: false,
            view_arranger_show_overview: false,
            markers: Vec::new(),
            session_scenes: Vec::new(),
            // Playback
            playhead_position_frames: 0,
            // Loop
            is_looping: false,
            loop_start_frames: None,
            loop_end_frames: None,
            // Key signature
            key_sig_enabled: false,
            key_sig_tonic: "C".to_string(),
            key_sig_mode: "Major".to_string(),
            // Tempo automation
            tempo_automation_events: Vec::new(),
            time_signature_changes: Vec::new(),
        }
    }

    /// Adds a track to the project, automatically assigning a color.
    pub fn add_track(&mut self, mut track: Track) {
        if track.color == TrackColor::default() {
            track.color = TrackColor::for_index(self.tracks.len());
        }
        self.tracks.push(track);
    }

    /// Returns the number of tracks (excluding master).
    pub fn track_count(&self) -> usize {
        self.tracks.len()
    }

    /// Finds a track by UUID. Returns `None` if not found.
    pub fn find_track(&self, id: Uuid) -> Option<&Track> {
        self.tracks.iter().find(|t| t.id == id)
    }

    /// Finds a mutable track by UUID. Returns `None` if not found.
    pub fn find_track_mut(&mut self, id: Uuid) -> Option<&mut Track> {
        self.tracks.iter_mut().find(|t| t.id == id)
    }

    /// Returns the end position of the project (last clip on any track).
    pub fn end_position(&self) -> AbsoluteTime {
        self.tracks
            .iter()
            .map(|t| t.end_position())
            .max_by_key(|t| t.sample_frame)
            .unwrap_or(AbsoluteTime::ZERO)
    }

    /// Whether any track in the project is soloed.
    pub fn any_solo(&self) -> bool {
        self.tracks
            .iter()
            .any(|t| t.is_solo && t.track_type != TrackType::Master)
    }

    /// Moves a track from one index to another (for drag-to-reorder).
    pub fn move_track(&mut self, from: usize, to: usize) {
        if from < self.tracks.len() && to < self.tracks.len() {
            let track = self.tracks.remove(from);
            self.tracks.insert(to, track);
        }
    }
}

impl Default for Project {
    fn default() -> Self {
        let mut project = Self::new("Untitled Project", 120.0, 44100.0);

        // Start with 3 Audio + 3 MIDI tracks by default.
        let audio_names = ["Audio 1", "Audio 2", "Audio 3"];
        let midi_names = ["MIDI 1", "MIDI 2", "MIDI 3"];

        for (i, name) in audio_names.iter().enumerate() {
            project.add_track(Track::with_type(*name, TrackType::Audio, i));
        }
        for (i, name) in midi_names.iter().enumerate() {
            project.add_track(Track::with_type(
                *name,
                TrackType::Midi,
                audio_names.len() + i,
            ));
        }

        project
    }
}

// ── Tests ──────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn project_creation() {
        let project = Project::new("Test Song", 140.0, 48000.0);
        assert_eq!(project.name, "Test Song");
        assert_eq!(project.track_count(), 0);
        assert!((project.sample_rate - 48000.0).abs() < f64::EPSILON);
        assert!((project.pulse_map.initial_bpm() - 140.0).abs() < f64::EPSILON);
        assert_eq!(project.time_signature, TimeSignature::default());
    }

    #[test]
    fn add_and_find_tracks() {
        let mut project = Project::new("Test", 120.0, 44100.0);

        let track = Track::new("Lead Vocal");
        let tid = track.id;
        project.add_track(track);

        assert_eq!(project.track_count(), 1);
        assert!(project.find_track(tid).is_some());
        assert_eq!(project.find_track(tid).unwrap().name, "Lead Vocal");
    }

    #[test]
    fn clip_end_position() {
        let clip = AudioClip::new(
            "Test Clip",
            "audio/test.wav",
            AbsoluteTime::new(44100), // starts at 1s
            AbsoluteTime::new(88200), // duration 2s
        );
        assert_eq!(clip.end_position().sample_frame, 132300); // 3s
    }

    #[test]
    fn track_defaults() {
        let track = Track::new("Guitar");
        assert!((track.volume - 1.0).abs() < f64::EPSILON);
        assert!((track.pan - 0.0).abs() < f64::EPSILON);
        assert!(!track.is_solo);
        assert!(!track.is_mute);
        assert!(!track.is_armed);
        assert_eq!(track.track_type, TrackType::Audio);
        assert!((track.height - 48.0).abs() < f64::EPSILON);
        assert!(track.effects.is_empty());
        assert!(track.instrument.is_none());
        assert!(track.parent_track_id.is_none());
        assert!(track.child_track_ids.is_empty());
        assert!(track.is_expanded);
    }

    #[test]
    fn project_serialization_roundtrip() {
        let mut project = Project::new("Roundtrip Test", 128.0, 96000.0);
        let mut track = Track::new("Drums");
        track.volume = 0.8;
        track.pan = -0.5;
        track.clips.push(AudioClip::new(
            "Kick",
            "audio/kick.wav",
            AbsoluteTime::ZERO,
            AbsoluteTime::new(48000),
        ));
        project.add_track(track);

        let json = serde_json::to_string_pretty(&project).unwrap();
        let restored: Project = serde_json::from_str(&json).unwrap();

        assert_eq!(restored.name, "Roundtrip Test");
        assert_eq!(restored.track_count(), 1);
        assert_eq!(restored.tracks[0].name, "Drums");
        assert_eq!(restored.tracks[0].clips.len(), 1);
        assert_eq!(restored.tracks[0].clips[0].name, "Kick");
    }

    // ── New Sprint 13 tests ────────────────────────────────────────────

    #[test]
    fn track_color_16_variants() {
        // Verify all 16 colors serialize and deserialize
        let colors = [
            TrackColor::Coral,
            TrackColor::Orange,
            TrackColor::Gold,
            TrackColor::Yellow,
            TrackColor::Lime,
            TrackColor::Green,
            TrackColor::Teal,
            TrackColor::Cyan,
            TrackColor::Sky,
            TrackColor::Blue,
            TrackColor::Indigo,
            TrackColor::Purple,
            TrackColor::Magenta,
            TrackColor::Pink,
            TrackColor::Rose,
            TrackColor::Slate,
        ];

        for (i, color) in colors.iter().enumerate() {
            let json = serde_json::to_string(color).unwrap();
            let restored: TrackColor = serde_json::from_str(&json).unwrap();
            assert_eq!(*color, restored, "Color roundtrip failed for index {i}");
            assert!(!color.hex().is_empty());
        }
    }

    #[test]
    fn track_color_for_index_cycles() {
        assert_eq!(TrackColor::for_index(0), TrackColor::Coral);
        assert_eq!(TrackColor::for_index(15), TrackColor::Slate);
        assert_eq!(TrackColor::for_index(16), TrackColor::Coral); // Wraps around
    }

    #[test]
    fn track_type_serialization() {
        for tt in [
            TrackType::Audio,
            TrackType::Midi,
            TrackType::Group,
            TrackType::Master,
        ] {
            let json = serde_json::to_string(&tt).unwrap();
            let restored: TrackType = serde_json::from_str(&json).unwrap();
            assert_eq!(tt, restored);
        }
    }

    #[test]
    fn time_signature_beats_per_bar() {
        assert_eq!(TimeSignature::new(4, 4).beats_per_bar(), 4);
        assert_eq!(TimeSignature::new(3, 4).beats_per_bar(), 3);
        assert_eq!(TimeSignature::new(6, 8).beats_per_bar(), 3);
        assert_eq!(TimeSignature::new(7, 8).beats_per_bar(), 3); // integer division: 7*4/8 = 3
        assert_eq!(TimeSignature::new(2, 4).beats_per_bar(), 2);
    }

    #[test]
    fn time_signature_display() {
        assert_eq!(TimeSignature::new(4, 4).display(), "4/4");
        assert_eq!(TimeSignature::new(6, 8).display(), "6/8");
    }

    #[test]
    fn plugin_slot_creation() {
        let slot = PluginSlot::new("Pro-Q 3", "com.fabfilter.pro-q-3");
        assert_eq!(slot.name, "Pro-Q 3");
        assert_eq!(slot.plugin_id, "com.fabfilter.pro-q-3");
        assert!(!slot.is_bypassed);
        assert_eq!(slot.latency_frames, 0);
    }

    #[test]
    fn track_total_latency() {
        let mut track = Track::new("Test");
        assert_eq!(track.total_latency_frames(), 0);

        track.instrument = Some(DeviceNode::Single(PluginSlot {
            id: Uuid::new_v4(),
            name: "Serum".into(),
            plugin_id: "com.xfer.serum".into(),
            is_bypassed: false,
            latency_frames: 64,
            sidechain_source_track_id: None,
            supports_sidechain_input: None,
            external_audio_inputs: None,
            external_format: None,
            external_uid: None,
            external_preset_name: None,
            external_program_number: None,
            external_parameter_count: None,
            external_stored_all_parameters: None,
            external_plugin_version: None,
            external_state_blob: None,
            external_state_blob_kind: None,
            external_preset_blob: None,
            external_preset_blob_kind: None,
        }));

        track.effects.push(DeviceNode::Single(PluginSlot {
            id: Uuid::new_v4(),
            name: "Limiter".into(),
            plugin_id: "com.fabfilter.pro-l-2".into(),
            is_bypassed: false,
            latency_frames: 128,
            sidechain_source_track_id: None,
            supports_sidechain_input: None,
            external_audio_inputs: None,
            external_format: None,
            external_uid: None,
            external_preset_name: None,
            external_program_number: None,
            external_parameter_count: None,
            external_stored_all_parameters: None,
            external_plugin_version: None,
            external_state_blob: None,
            external_state_blob_kind: None,
            external_preset_blob: None,
            external_preset_blob_kind: None,
        }));

        track.effects.push(DeviceNode::Single(PluginSlot {
            id: Uuid::new_v4(),
            name: "EQ".into(),
            plugin_id: "com.fabfilter.pro-q-3".into(),
            is_bypassed: true, // Bypassed — should NOT count
            latency_frames: 32,
            sidechain_source_track_id: None,
            supports_sidechain_input: None,
            external_audio_inputs: None,
            external_format: None,
            external_uid: None,
            external_preset_name: None,
            external_program_number: None,
            external_parameter_count: None,
            external_stored_all_parameters: None,
            external_plugin_version: None,
            external_state_blob: None,
            external_state_blob_kind: None,
            external_preset_blob: None,
            external_preset_blob_kind: None,
        }));

        assert_eq!(track.total_latency_frames(), 64 + 128); // Instrument + active effect
    }

    #[test]
    fn track_with_type() {
        let track = Track::with_type("Synth Lead", TrackType::Midi, 5);
        assert_eq!(track.track_type, TrackType::Midi);
        assert_eq!(track.color, TrackColor::Green); // Index 5
    }

    #[test]
    fn project_any_solo() {
        let mut project = Project::default();
        assert!(!project.any_solo());

        let mut track = Track::new("Solo Track");
        track.is_solo = true;
        project.add_track(track);

        assert!(project.any_solo());
    }

    #[test]
    fn project_end_position() {
        let mut project = Project::default();
        let mut track = Track::new("Track 1");
        track.clips.push(AudioClip::new(
            "A",
            "a.wav",
            AbsoluteTime::new(0),
            AbsoluteTime::new(44100),
        ));
        project.add_track(track);

        let mut track2 = Track::new("Track 2");
        track2.clips.push(AudioClip::new(
            "B",
            "b.wav",
            AbsoluteTime::new(44100),
            AbsoluteTime::new(88200),
        ));
        project.add_track(track2);

        assert_eq!(project.end_position().sample_frame, 132300); // 44100 + 88200
    }

    #[test]
    fn project_move_track() {
        let mut project = Project::new("Test", 120.0, 44100.0);
        project.add_track(Track::new("A"));
        project.add_track(Track::new("B"));
        project.add_track(Track::new("C"));

        project.move_track(0, 2);

        assert_eq!(project.tracks[0].name, "B");
        assert_eq!(project.tracks[1].name, "C");
        assert_eq!(project.tracks[2].name, "A");
    }

    #[test]
    fn clip_contains_frame() {
        let clip = AudioClip::new(
            "Test",
            "test.wav",
            AbsoluteTime::new(100),
            AbsoluteTime::new(200),
        );

        assert!(!clip.contains_frame(99));
        assert!(clip.contains_frame(100));
        assert!(clip.contains_frame(200));
        assert!(!clip.contains_frame(300));
    }

    #[test]
    fn clip_overlaps_range() {
        let clip = AudioClip::new(
            "Test",
            "test.wav",
            AbsoluteTime::new(100),
            AbsoluteTime::new(200),
        );

        assert!(clip.overlaps(50, 150)); // Overlaps start
        assert!(clip.overlaps(200, 400)); // Overlaps end
        assert!(clip.overlaps(0, 500)); // Fully contains
        assert!(clip.overlaps(150, 250)); // Straddles
        assert!(!clip.overlaps(0, 100)); // Before (end is exclusive)
        assert!(!clip.overlaps(300, 400)); // After
    }

    #[test]
    fn master_track_is_slate() {
        let project = Project::default();
        assert_eq!(project.master_track.color, TrackColor::Slate);
        assert_eq!(project.master_track.track_type, TrackType::Master);
    }

    #[test]
    fn default_project_starts_with_three_audio_and_three_midi_tracks() {
        let project = Project::default();

        assert_eq!(project.tracks.len(), 6);
        assert!(project
            .tracks
            .iter()
            .take(3)
            .all(|t| t.track_type == TrackType::Audio));
        assert!(project
            .tracks
            .iter()
            .skip(3)
            .take(3)
            .all(|t| t.track_type == TrackType::Midi));
        assert_eq!(project.tracks[0].name, "Audio 1");
        assert_eq!(project.tracks[2].name, "Audio 3");
        assert_eq!(project.tracks[3].name, "MIDI 1");
        assert_eq!(project.tracks[5].name, "MIDI 3");
    }
}
