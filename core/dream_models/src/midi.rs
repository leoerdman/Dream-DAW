// ═══════════════════════════════════════════════════════════════════════════
// Dream DAW — MIDI Data Model
// ═══════════════════════════════════════════════════════════════════════════
//
// Core MIDI data types used by:
//   - Sampler instrument (pitch-driven sample playback)
//   - MIDI clip scheduling (audio thread)
//   - Piano roll editor (frontend via ts-rs)
//
// Thread Safety:
//   - These types are pure data (Copy/Clone). They cross the RT boundary
//     via Arc<ArcSwap<Vec<_>>> snapshots, never through the command queue.
//
// ═══════════════════════════════════════════════════════════════════════════

use serde::{Deserialize, Serialize};
use ts_rs::TS;
use uuid::Uuid;

use crate::project::{ClipEnvelope, TrackColor};
use crate::time::AbsoluteTime;

// ── MIDI Note ──────────────────────────────────────────────────────────

/// A single MIDI note event within a clip.
///
/// Represents a note-on + note-off pair with velocity.
/// Positions are relative to the parent `MidiClip`'s start.
#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize, TS)]
#[ts(export)]
pub struct MidiNote {
    /// MIDI pitch (0–127). Middle C = 60 (C4).
    pub pitch: u8,

    /// Note velocity (1–127). 0 = note-off.
    pub velocity: u8,

    /// Start position relative to clip start (in sample frames).
    pub start_frame: i64,

    /// Duration in sample frames.
    pub duration_frames: i64,
}

impl MidiNote {
    /// Creates a new MIDI note.
    pub fn new(pitch: u8, velocity: u8, start_frame: i64, duration_frames: i64) -> Self {
        Self {
            pitch: pitch.min(127),
            velocity: velocity.clamp(1, 127),
            start_frame: start_frame.max(0),
            duration_frames: duration_frames.max(1),
        }
    }

    /// Returns the end frame (relative to clip start).
    #[inline]
    pub fn end_frame(&self) -> i64 {
        self.start_frame + self.duration_frames
    }

    /// Returns the MIDI note name (e.g., "C4", "F#5").
    pub fn note_name(&self) -> String {
        const NAMES: [&str; 12] = [
            "C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B",
        ];
        let name = NAMES[(self.pitch % 12) as usize];
        let octave = (self.pitch as i32 / 12) - 1;
        format!("{}{}", name, octave)
    }

    /// Frequency in Hz for this note (A4 = 440 Hz, equal temperament).
    #[inline]
    pub fn frequency(&self) -> f64 {
        440.0 * 2.0_f64.powf((self.pitch as f64 - 69.0) / 12.0)
    }

    /// Pitch ratio relative to a root note.
    ///
    /// Used by the sampler to pitch-shift the loaded sample.
    /// Ratio > 1.0 = higher pitch (faster playback).
    /// Ratio < 1.0 = lower pitch (slower playback).
    #[inline]
    pub fn pitch_ratio(&self, root_note: u8) -> f64 {
        2.0_f64.powf((self.pitch as f64 - root_note as f64) / 12.0)
    }
}

// ── MIDI Clip ──────────────────────────────────────────────────────────

/// A MIDI clip placed on a MIDI track.
///
/// Contains a sequence of `MidiNote` events. Notes are sorted by
/// `start_frame` for efficient scheduling via binary search.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[ts(export)]
pub struct MidiClip {
    /// Unique clip identifier.
    #[ts(type = "string")]
    pub id: Uuid,

    /// Display name (e.g., "Piano Part A").
    pub name: String,

    /// Position on the timeline (sample-accurate).
    pub position: AbsoluteTime,

    /// Duration of the clip in sample frames.
    pub duration: AbsoluteTime,

    /// Notes within this clip (sorted by start_frame).
    pub notes: Vec<MidiNote>,

    /// Whether this clip is currently selected in the UI.
    pub is_selected: bool,

    /// Whether this clip is muted (stays on timeline but doesn't play).
    #[serde(default)]
    pub is_muted: bool,

    /// User-defined fade-in length in sample frames.
    #[serde(default)]
    pub fade_in_frames: i64,

    /// User-defined fade-out length in sample frames.
    #[serde(default)]
    pub fade_out_frames: i64,

    /// ALS take identifier (`TakeId`).
    #[serde(default)]
    pub take_id: Option<i32>,

    /// Clip legato flag (`Legato`).
    #[serde(default)]
    pub legato: bool,

    /// RAM preload flag (`Ram`).
    #[serde(default)]
    pub ram: bool,

    /// Velocity amount from ALS (`VelocityAmount`).
    #[serde(default)]
    pub velocity_amount: f64,

    /// Optional bank select coarse value.
    #[serde(default)]
    pub bank_select_coarse: Option<i32>,

    /// Optional bank select fine value.
    #[serde(default)]
    pub bank_select_fine: Option<i32>,

    /// Optional program change value.
    #[serde(default)]
    pub program_change: Option<i32>,

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

    /// Optional color override (uses track color when `None`).
    #[serde(default)]
    pub color_override: Option<TrackColor>,

    /// Exact hex color override from ALS color index (e.g. "#FF3636").
    /// When present, UI should prefer this over `color_override`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub color_hex: Option<String>,

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

impl MidiClip {
    /// Creates a new empty MIDI clip.
    pub fn new(name: impl Into<String>, position: AbsoluteTime, duration: AbsoluteTime) -> Self {
        Self {
            id: Uuid::new_v4(),
            name: name.into(),
            position,
            duration,
            notes: Vec::new(),
            is_selected: false,
            is_muted: false,
            fade_in_frames: 0,
            fade_out_frames: 0,
            take_id: None,
            legato: false,
            ram: false,
            velocity_amount: 0.0,
            bank_select_coarse: None,
            bank_select_fine: None,
            program_change: None,
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
            time_signature_numerator: None,
            time_signature_denominator: None,
            loop_start_beats: None,
            loop_end_beats: None,
            loop_on: false,
            color_override: None,
            color_hex: None,
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

    /// Adds a note, keeping the list sorted by start_frame.
    pub fn add_note(&mut self, note: MidiNote) {
        let pos = self
            .notes
            .binary_search_by_key(&note.start_frame, |n| n.start_frame)
            .unwrap_or_else(|e| e);
        self.notes.insert(pos, note);
    }

    /// Removes a note by pitch and start_frame.
    pub fn remove_note(&mut self, pitch: u8, start_frame: i64) -> bool {
        if let Some(idx) = self
            .notes
            .iter()
            .position(|n| n.pitch == pitch && n.start_frame == start_frame)
        {
            self.notes.remove(idx);
            true
        } else {
            false
        }
    }

    /// Returns notes that overlap with the given frame range
    /// (relative to clip start).
    pub fn notes_in_range(&self, start: i64, end: i64) -> Vec<&MidiNote> {
        self.notes
            .iter()
            .filter(|n| n.start_frame < end && n.end_frame() > start)
            .collect()
    }
}

// ── Sampler Configuration ──────────────────────────────────────────────

/// Configuration for a sampler instrument assigned to a MIDI track.
///
/// Stored in the project model. The actual audio data lives in the
/// `ClipPool` and is referenced by `sample_path`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[ts(export)]
pub struct SamplerConfig {
    /// Path to the loaded sample file (relative to project dir).
    pub sample_path: String,

    /// Root note — the MIDI note at which the sample plays at original pitch.
    /// Default: 60 (C4).
    pub root_note: u8,

    /// Volume gain (0.0–2.0, 1.0 = unity).
    pub volume: f64,

    /// ADSR envelope — attack time in seconds.
    pub attack: f64,

    /// ADSR envelope — decay time in seconds.
    pub decay: f64,

    /// ADSR envelope — sustain level (0.0–1.0).
    pub sustain: f64,

    /// ADSR envelope — release time in seconds.
    pub release: f64,

    /// Waveform for oscillator 2 (0=sine, 1=triangle, 2=saw, 3=square).
    #[serde(default)]
    pub osc2_waveform: u8,

    /// Blend between oscillator 1 and 2 (0.0..1.0).
    /// 0.0 = only osc1, 1.0 = only osc2.
    #[serde(default = "default_sampler_osc_mix")]
    pub osc_mix: f64,

    /// Detune amount for oscillator 2 in cents (-50..+50).
    #[serde(default)]
    pub detune_cents: f64,

    /// Optional sub oscillator level (0.0..1.0), one octave below osc1.
    #[serde(default)]
    pub sub_level: f64,

    /// Filter cutoff frequency in Hz (20..20000).
    #[serde(default = "default_filter_cutoff")]
    pub filter_cutoff: f64,

    /// Filter resonance (0.0..0.99).
    #[serde(default)]
    pub filter_resonance: f64,

    /// Filter type (0=LP, 1=HP, 2=BP, 3=Notch).
    #[serde(default)]
    pub filter_type: u8,

    /// LFO modulation rate in Hz (0.01–20.0).
    #[serde(default = "default_lfo_rate")]
    pub lfo_rate: f64,

    /// LFO modulation depth (0.0–1.0).
    #[serde(default)]
    pub lfo_depth: f64,

    /// LFO modulation target (0=Filter, 1=Pitch, 2=Volume).
    #[serde(default)]
    pub lfo_target: u8,

    /// Square wave pulse width (0.05–0.95).
    #[serde(default = "default_pulse_width")]
    pub pulse_width: f64,
}

impl Default for SamplerConfig {
    fn default() -> Self {
        Self {
            sample_path: String::new(),
            root_note: 60,
            volume: 0.5,
            attack: 0.005, // 5ms — click-free
            decay: 0.1,
            sustain: 1.0,
            release: 0.05, // 50ms — smooth release
            osc2_waveform: 0,
            osc_mix: default_sampler_osc_mix(),
            detune_cents: 0.0,
            sub_level: 0.0,
            filter_cutoff: default_filter_cutoff(),
            filter_resonance: 0.0,
            filter_type: 0,
            lfo_rate: default_lfo_rate(),
            lfo_depth: 0.0,
            lfo_target: 0,
            pulse_width: default_pulse_width(),
        }
    }
}

fn default_sampler_osc_mix() -> f64 {
    0.35
}

fn default_filter_cutoff() -> f64 {
    20000.0
}

fn default_lfo_rate() -> f64 {
    1.0
}

fn default_pulse_width() -> f64 {
    0.5
}

impl SamplerConfig {
    /// Whether a sample is loaded.
    pub fn has_sample(&self) -> bool {
        !self.sample_path.is_empty()
    }
}

// ═══════════════════════════════════════════════════════════════════════════
// Tests
// ═══════════════════════════════════════════════════════════════════════════

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn midi_note_creation() {
        let note = MidiNote::new(60, 100, 0, 22050);
        assert_eq!(note.pitch, 60);
        assert_eq!(note.velocity, 100);
        assert_eq!(note.start_frame, 0);
        assert_eq!(note.duration_frames, 22050);
        assert_eq!(note.end_frame(), 22050);
    }

    #[test]
    fn midi_note_name() {
        assert_eq!(MidiNote::new(60, 100, 0, 1).note_name(), "C4");
        assert_eq!(MidiNote::new(69, 100, 0, 1).note_name(), "A4");
        assert_eq!(MidiNote::new(61, 100, 0, 1).note_name(), "C#4");
        assert_eq!(MidiNote::new(48, 100, 0, 1).note_name(), "C3");
    }

    #[test]
    fn midi_note_frequency() {
        let a4 = MidiNote::new(69, 100, 0, 1);
        assert!((a4.frequency() - 440.0).abs() < 0.01);

        let a5 = MidiNote::new(81, 100, 0, 1);
        assert!((a5.frequency() - 880.0).abs() < 0.01);
    }

    #[test]
    fn midi_note_pitch_ratio() {
        let note = MidiNote::new(72, 100, 0, 1); // C5
        // Relative to root C4 (60), should be 2.0 (one octave up)
        assert!((note.pitch_ratio(60) - 2.0).abs() < 0.001);

        let same = MidiNote::new(60, 100, 0, 1);
        assert!((same.pitch_ratio(60) - 1.0).abs() < 0.001);

        let down = MidiNote::new(48, 100, 0, 1); // C3
        assert!((down.pitch_ratio(60) - 0.5).abs() < 0.001);
    }

    #[test]
    fn midi_note_velocity_clamped() {
        let note = MidiNote::new(60, 0, 0, 1);
        assert_eq!(note.velocity, 1); // Clamped to minimum 1

        let note2 = MidiNote::new(60, 200, 0, 1);
        assert_eq!(note2.velocity, 127); // Clamped to max 127
    }

    #[test]
    fn midi_clip_creation() {
        let clip = MidiClip::new("Test Clip", AbsoluteTime::new(0), AbsoluteTime::new(88200));
        assert_eq!(clip.name, "Test Clip");
        assert!(clip.notes.is_empty());
        assert_eq!(clip.end_position().sample_frame, 88200);
    }

    #[test]
    fn midi_clip_add_note_sorted() {
        let mut clip = MidiClip::new("Test", AbsoluteTime::new(0), AbsoluteTime::new(88200));

        clip.add_note(MidiNote::new(60, 100, 22050, 11025));
        clip.add_note(MidiNote::new(64, 100, 0, 11025));
        clip.add_note(MidiNote::new(67, 100, 44100, 11025));

        // Should be sorted by start_frame
        assert_eq!(clip.notes[0].start_frame, 0);
        assert_eq!(clip.notes[1].start_frame, 22050);
        assert_eq!(clip.notes[2].start_frame, 44100);
    }

    #[test]
    fn midi_clip_remove_note() {
        let mut clip = MidiClip::new("Test", AbsoluteTime::new(0), AbsoluteTime::new(88200));

        clip.add_note(MidiNote::new(60, 100, 0, 11025));
        clip.add_note(MidiNote::new(64, 100, 0, 11025));

        assert!(clip.remove_note(60, 0));
        assert_eq!(clip.notes.len(), 1);
        assert_eq!(clip.notes[0].pitch, 64);
    }

    #[test]
    fn midi_clip_notes_in_range() {
        let mut clip = MidiClip::new("Test", AbsoluteTime::new(0), AbsoluteTime::new(88200));

        clip.add_note(MidiNote::new(60, 100, 0, 11025)); // 0–11025
        clip.add_note(MidiNote::new(64, 100, 22050, 11025)); // 22050–33075
        clip.add_note(MidiNote::new(67, 100, 44100, 11025)); // 44100–55125

        let in_range = clip.notes_in_range(10000, 30000);
        assert_eq!(in_range.len(), 2); // First two notes overlap
    }

    #[test]
    fn midi_clip_overlap_check() {
        let clip = MidiClip::new("Test", AbsoluteTime::new(44100), AbsoluteTime::new(44100));

        assert!(clip.overlaps(0, 88200)); // Fully contains
        assert!(clip.overlaps(44100, 44200)); // Start overlap
        assert!(clip.overlaps(88100, 88300)); // End overlap
        assert!(!clip.overlaps(0, 44100)); // Before (exclusive end)
        assert!(!clip.overlaps(88200, 99999)); // After
    }

    #[test]
    fn sampler_config_defaults() {
        let cfg = SamplerConfig::default();
        assert_eq!(cfg.root_note, 60);
        assert!((cfg.volume - 0.5).abs() < f64::EPSILON);
        assert!(!cfg.has_sample());
    }

    #[test]
    fn midi_serialization_roundtrip() {
        let note = MidiNote::new(60, 100, 0, 22050);
        let json = serde_json::to_string(&note).expect("serialize");
        let roundtripped: MidiNote = serde_json::from_str(&json).expect("deserialize");
        assert_eq!(roundtripped, note);
    }
}
