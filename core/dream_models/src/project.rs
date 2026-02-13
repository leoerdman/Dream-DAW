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

use crate::pulse_map::PulseMap;
use crate::time::AbsoluteTime;

// ── Track Color ────────────────────────────────────────────────────────

/// Predefined track colors matching the UI palette.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize, TS)]
#[ts(export)]
pub enum TrackColor {
    Red,
    Orange,
    Yellow,
    Green,
    Cyan,
    Blue,
    Purple,
    Pink,
    Gray,
}

impl Default for TrackColor {
    fn default() -> Self {
        Self::Blue
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
        }
    }

    /// Returns the end position of this clip on the timeline.
    #[inline]
    pub fn end_position(&self) -> AbsoluteTime {
        self.position.advanced(self.duration.sample_frame)
    }
}

// ── Track ──────────────────────────────────────────────────────────────

/// A single audio track in the project.
///
/// Contains clips, routing metadata, and mix parameters.
/// The track itself does not process audio — it is a data container
/// consumed by the audio graph's `NodeKind::Track` processor.
#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[ts(export)]
pub struct Track {
    /// Unique track identifier.
    #[ts(type = "string")]
    pub id: Uuid,

    /// Display name (e.g., "Lead Vocal").
    pub name: String,

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

    /// Visual color in the UI.
    pub color: TrackColor,

    /// Output routing destination (track/bus UUID). `None` = master output.
    #[ts(type = "string | null")]
    pub output_destination_id: Option<Uuid>,
}

impl Track {
    /// Creates a new empty track with default settings.
    pub fn new(name: impl Into<String>) -> Self {
        Self {
            id: Uuid::new_v4(),
            name: name.into(),
            clips: Vec::new(),
            volume: 1.0,
            pan: 0.0,
            is_solo: false,
            is_mute: false,
            color: TrackColor::default(),
            output_destination_id: None,
        }
    }
}

// ── Project ────────────────────────────────────────────────────────────

/// The top-level project container — the entire DAW session.
///
/// Serialized to disk as compressed JSON. Loaded on app launch.
/// All tracks, clips, and tempo data live here.
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

    /// Project version string for migration compatibility.
    pub version: String,
}

impl Project {
    /// Creates a new empty project with default settings.
    pub fn new(name: impl Into<String>, bpm: f64, sample_rate: f64) -> Self {
        let mut master = Track::new("Master");
        master.color = TrackColor::Gray;

        Self {
            id: Uuid::new_v4(),
            name: name.into(),
            tracks: Vec::new(),
            master_track: master,
            pulse_map: PulseMap::new(bpm, sample_rate),
            sample_rate,
            version: "0.1.0".to_string(),
        }
    }

    /// Adds a track to the project.
    pub fn add_track(&mut self, track: Track) {
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
}

impl Default for Project {
    fn default() -> Self {
        Self::new("Untitled Project", 120.0, 44100.0)
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
    }

    #[test]
    fn add_and_find_tracks() {
        let mut project = Project::default();

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
        assert_eq!(track.color, TrackColor::Blue);
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
}
