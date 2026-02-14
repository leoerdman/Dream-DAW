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

// ── Track Color (16 Ableton-style palette) ─────────────────────────────

/// Predefined track colors matching the Ableton-style palette.
///
/// 16-color palette ported from Swift `TrackColor` enum.
/// Each variant maps to a specific hex value for the frontend.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize, TS)]
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
    Blue,
    Indigo,
    Purple,
    Magenta,
    Pink,
    Rose,
    Slate,
}

impl Default for TrackColor {
    fn default() -> Self {
        Self::Blue
    }
}

impl TrackColor {
    /// Returns the hex color string for this track color.
    ///
    /// Values ported from Swift `Track.swift` NSColor definitions.
    pub fn hex(&self) -> &'static str {
        match self {
            Self::Coral   => "#F05C4D",
            Self::Orange  => "#FF8A1A",
            Self::Gold    => "#FFBF33",
            Self::Yellow  => "#FFE14D",
            Self::Lime    => "#A3D94D",
            Self::Green   => "#4DC775",
            Self::Teal    => "#4DC7B0",
            Self::Cyan    => "#4DC7CC",
            Self::Sky     => "#4DA6E3",
            Self::Blue    => "#4D7AE3",
            Self::Indigo  => "#6B5CE3",
            Self::Purple  => "#9B59D9",
            Self::Magenta => "#D94DA6",
            Self::Pink    => "#E36B96",
            Self::Rose    => "#E66673",
            Self::Slate   => "#8C949E",
        }
    }

    /// Returns the color for a given track index (cyclic assignment).
    ///
    /// Ported from Swift `TrackColor.forIndex(_:)`.
    pub fn for_index(index: usize) -> Self {
        const ALL: [TrackColor; 16] = [
            TrackColor::Coral,   TrackColor::Orange, TrackColor::Gold,    TrackColor::Yellow,
            TrackColor::Lime,    TrackColor::Green,  TrackColor::Teal,    TrackColor::Cyan,
            TrackColor::Sky,     TrackColor::Blue,   TrackColor::Indigo,  TrackColor::Purple,
            TrackColor::Magenta, TrackColor::Pink,   TrackColor::Rose,    TrackColor::Slate,
        ];
        ALL[index % ALL.len()]
    }
}

// ── Track Type ─────────────────────────────────────────────────────────

/// Defines the type of content a track holds.
///
/// Ported from Swift `TrackType` enum.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize, TS)]
#[ts(export)]
pub enum TrackType {
    /// Audio track — hosts audio clips.
    Audio,
    /// MIDI track — hosts MIDI clips routed to an instrument.
    Midi,
    /// Group track — contains child tracks for bus-level processing.
    Group,
    /// Master output track — singleton, always present.
    Master,
}

impl Default for TrackType {
    fn default() -> Self {
        Self::Audio
    }
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
        Self { numerator, denominator }
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
        }
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

    /// Optional color override (uses track color when `None`).
    pub color_override: Option<TrackColor>,
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
            color_override: None,
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
    /// Optional curve tension for bezier-like shapes.
    #[serde(default)]
    pub tension: Option<f64>,
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

    /// Track height in pixels (for arrangement view).
    pub height: f64,

    /// Output routing destination (track/bus UUID). `None` = master output.
    #[ts(type = "string | null")]
    pub output_destination_id: Option<Uuid>,

    // ── Effect Chain ───────────────────────────────────────────────────

    /// Insert effect slots (processed in order).
    pub effects: Vec<PluginSlot>,

    /// Instrument plugin (for MIDI tracks). `None` for audio tracks.
    pub instrument: Option<PluginSlot>,

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
            height: 80.0,
            output_destination_id: None,
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
    /// Used by PDC to align parallel paths.
    pub fn total_latency_frames(&self) -> u32 {
        let instrument_latency = self.instrument
            .as_ref()
            .map_or(0, |p| p.latency_frames);

        let effects_latency: u32 = self.effects
            .iter()
            .filter(|p| !p.is_bypassed)
            .map(|p| p.latency_frames)
            .sum();

        instrument_latency + effects_latency
    }

    /// Whether this track has any content (clips, MIDI clips, or data).
    pub fn is_empty(&self) -> bool {
        self.clips.is_empty() && self.midi_clips.is_empty()
    }

    /// End position of the last clip on this track.
    pub fn end_position(&self) -> AbsoluteTime {
        self.clips
            .iter()
            .map(|c| c.end_position())
            .max_by_key(|t| t.sample_frame)
            .unwrap_or(AbsoluteTime::ZERO)
    }
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
}

fn default_key_tonic() -> String { "C".to_string() }
fn default_key_mode() -> String { "Major".to_string() }

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
        self.tracks.iter().any(|t| t.is_solo && t.track_type != TrackType::Master)
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

        // Start with 4 Audio + 4 MIDI tracks (typical DAW layout)
        let audio_names = ["Audio 1", "Audio 2", "Audio 3", "Audio 4"];
        let midi_names = ["MIDI 1", "MIDI 2", "MIDI 3", "MIDI 4"];

        for (i, name) in audio_names.iter().enumerate() {
            project.add_track(Track::with_type(*name, TrackType::Audio, i));
        }
        for (i, name) in midi_names.iter().enumerate() {
            project.add_track(Track::with_type(*name, TrackType::Midi, audio_names.len() + i));
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
        assert!((track.height - 80.0).abs() < f64::EPSILON);
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
            TrackColor::Coral,   TrackColor::Orange, TrackColor::Gold,    TrackColor::Yellow,
            TrackColor::Lime,    TrackColor::Green,  TrackColor::Teal,    TrackColor::Cyan,
            TrackColor::Sky,     TrackColor::Blue,   TrackColor::Indigo,  TrackColor::Purple,
            TrackColor::Magenta, TrackColor::Pink,   TrackColor::Rose,    TrackColor::Slate,
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
        for tt in [TrackType::Audio, TrackType::Midi, TrackType::Group, TrackType::Master] {
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

        track.instrument = Some(PluginSlot {
            id: Uuid::new_v4(),
            name: "Serum".into(),
            plugin_id: "com.xfer.serum".into(),
            is_bypassed: false,
            latency_frames: 64,
        });

        track.effects.push(PluginSlot {
            id: Uuid::new_v4(),
            name: "Limiter".into(),
            plugin_id: "com.fabfilter.pro-l-2".into(),
            is_bypassed: false,
            latency_frames: 128,
        });

        track.effects.push(PluginSlot {
            id: Uuid::new_v4(),
            name: "EQ".into(),
            plugin_id: "com.fabfilter.pro-q-3".into(),
            is_bypassed: true, // Bypassed — should NOT count
            latency_frames: 32,
        });

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
        track.clips.push(AudioClip::new("A", "a.wav", AbsoluteTime::new(0), AbsoluteTime::new(44100)));
        project.add_track(track);

        let mut track2 = Track::new("Track 2");
        track2.clips.push(AudioClip::new("B", "b.wav", AbsoluteTime::new(44100), AbsoluteTime::new(88200)));
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

        assert!(clip.overlaps(50, 150));     // Overlaps start
        assert!(clip.overlaps(200, 400));    // Overlaps end
        assert!(clip.overlaps(0, 500));      // Fully contains
        assert!(clip.overlaps(150, 250));    // Straddles
        assert!(!clip.overlaps(0, 100));     // Before (end is exclusive)
        assert!(!clip.overlaps(300, 400));   // After
    }

    #[test]
    fn master_track_is_slate() {
        let project = Project::default();
        assert_eq!(project.master_track.color, TrackColor::Slate);
        assert_eq!(project.master_track.track_type, TrackType::Master);
    }
}
