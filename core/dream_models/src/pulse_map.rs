// ═══════════════════════════════════════════════════════════════════════════
// Dream DAW — PulseMap (Tempo Map: Sample ↔ Beat Conversion)
// ═══════════════════════════════════════════════════════════════════════════
//
// Direct port of Swift `PulseMap.swift`.
//
// Musical time (beats/bars) is a *UI illusion* (grid lines). The single
// source of truth for position is always `i64` sample frames.
// This struct provides the math bridge between the two worlds.
//
// Currently supports constant-tempo projects. The architecture is designed
// for future variable-tempo automation — the `TempoEvent` array can hold
// multiple tempo points, and all conversions interpolate correctly.
//
// Complexity:
//   O(1) for constant tempo (fast path).
//   O(log N) for variable tempo (binary search over tempo events).
//
// ═══════════════════════════════════════════════════════════════════════════

use serde::{Deserialize, Serialize};
use ts_rs::TS;

// ── Tempo Event ────────────────────────────────────────────────────────

/// A tempo change point in the project timeline.
///
/// The `beat_position` field is cached (pre-computed) so that conversion
/// from beats→samples can also use binary search, rather than needing
/// to integrate from the start of the project each time.
#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize, TS)]
#[ts(export)]
pub struct TempoEvent {
    /// Sample frame at which this tempo begins.
    pub sample_frame: i64,

    /// Beat position at which this tempo begins (cached for O(1) access).
    pub beat_position: f64,

    /// Tempo in BPM.
    pub bpm: f64,
}

impl TempoEvent {
    /// Creates a new tempo event.
    pub fn new(sample_frame: i64, beat_position: f64, bpm: f64) -> Self {
        Self {
            sample_frame,
            beat_position,
            bpm,
        }
    }
}

impl Default for TempoEvent {
    fn default() -> Self {
        Self {
            sample_frame: 0,
            beat_position: 0.0,
            bpm: 120.0,
        }
    }
}

// ── PulseMap ───────────────────────────────────────────────────────────

/// Enterprise-grade tempo map converting between sample frames and musical time.
///
/// # Thread Safety
/// `PulseMap` is `Send + Sync + Clone`. It contains no interior mutability.
/// For real-time-safe access, share via `Arc<PulseMap>` or include in the
/// RCU-swapped `ExecutionPlan`.
#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[ts(export)]
pub struct PulseMap {
    /// Ordered list of tempo events. Always contains at least one entry.
    tempo_events: Vec<TempoEvent>,

    /// Project sample rate (e.g., 44100.0, 48000.0, 96000.0).
    pub sample_rate: f64,
}

impl PulseMap {
    // ── Construction ───────────────────────────────────────────────

    /// Creates a `PulseMap` with a constant tempo.
    pub fn new(bpm: f64, sample_rate: f64) -> Self {
        Self {
            tempo_events: vec![TempoEvent::new(0, 0.0, bpm)],
            sample_rate,
        }
    }

    /// Creates a `PulseMap` from an existing array of tempo events.
    ///
    /// # Panics
    /// Panics if `events` is empty.
    pub fn from_events(events: Vec<TempoEvent>, sample_rate: f64) -> Self {
        assert!(!events.is_empty(), "PulseMap requires at least one tempo event");
        Self {
            tempo_events: events,
            sample_rate,
        }
    }

    // ── Sample → Beat Conversion ───────────────────────────────────

    /// Converts a sample frame position to musical beats.
    ///
    /// For constant tempo: `beats = samples / sample_rate * bpm / 60`
    /// For variable tempo: interpolates across tempo regions.
    ///
    /// # Complexity
    /// O(1) for constant tempo. O(log N) for variable tempo.
    #[inline]
    pub fn beats(&self, sample_frame: i64) -> f64 {
        let event = self.active_event_at_sample(sample_frame);
        let delta_samples = (sample_frame - event.sample_frame) as f64;
        let delta_seconds = delta_samples / self.sample_rate;
        let delta_beats = delta_seconds * (event.bpm / 60.0);
        event.beat_position + delta_beats
    }

    // ── Beat → Sample Conversion ───────────────────────────────────

    /// Converts musical beats to the nearest sample frame.
    ///
    /// # Complexity
    /// O(1) for constant tempo. O(log N) for variable tempo.
    #[inline]
    pub fn sample_frame(&self, beats: f64) -> i64 {
        let event = self.active_event_at_beat(beats);
        let delta_beats = beats - event.beat_position;
        let delta_seconds = delta_beats * (60.0 / event.bpm);
        let delta_samples = delta_seconds * self.sample_rate;
        event.sample_frame + delta_samples.round() as i64
    }

    // ── Seconds Conversions ────────────────────────────────────────

    /// Converts a sample frame to seconds (tempo-independent, pure math).
    #[inline]
    pub fn seconds(&self, sample_frame: i64) -> f64 {
        sample_frame as f64 / self.sample_rate
    }

    /// Converts seconds to a sample frame (tempo-independent, pure math).
    #[inline]
    pub fn sample_frame_at_seconds(&self, seconds: f64) -> i64 {
        (seconds * self.sample_rate) as i64
    }

    // ── Duration Conversion ────────────────────────────────────────

    /// Converts a duration in beats (starting at a given sample position) to sample frames.
    #[inline]
    pub fn duration_in_samples(&self, beats: f64, starting_at: i64) -> i64 {
        let start_beats = self.beats(starting_at);
        let end_beats = start_beats + beats;
        let end_sample = self.sample_frame(end_beats);
        end_sample - starting_at
    }

    // ── Tempo Query ────────────────────────────────────────────────

    /// Returns the BPM at a given sample frame.
    #[inline]
    pub fn bpm_at(&self, sample_frame: i64) -> f64 {
        self.active_event_at_sample(sample_frame).bpm
    }

    /// The project's initial BPM (first tempo event).
    #[inline]
    pub fn initial_bpm(&self) -> f64 {
        self.tempo_events[0].bpm
    }

    /// Returns a reference to all tempo events.
    pub fn tempo_events(&self) -> &[TempoEvent] {
        &self.tempo_events
    }

    // ── Mutation ───────────────────────────────────────────────────

    /// Updates the global BPM for constant-tempo projects.
    /// Replaces all tempo events with a single event at the new BPM.
    pub fn set_constant_tempo(&mut self, bpm: f64) {
        self.tempo_events = vec![TempoEvent::new(0, 0.0, bpm)];
    }

    // ── Internal: Binary Search ────────────────────────────────────

    /// Finds the active tempo event at a given sample frame.
    ///
    /// Uses `partition_point` (stdlib binary search) for O(log N) lookup.
    /// Returns the last event whose `sample_frame <= sample_frame`.
    #[inline]
    fn active_event_at_sample(&self, sample_frame: i64) -> &TempoEvent {
        // Fast path: constant tempo (single event) — no search needed.
        if self.tempo_events.len() == 1 {
            return &self.tempo_events[0];
        }

        // partition_point returns the first index where predicate is false.
        // We want the last event at or before sample_frame.
        let idx = self
            .tempo_events
            .partition_point(|e| e.sample_frame <= sample_frame);
        // idx is the first event AFTER sample_frame, so we want idx - 1.
        // Clamp to 0 for the case where sample_frame is before all events.
        &self.tempo_events[idx.saturating_sub(1)]
    }

    /// Finds the active tempo event at a given beat position.
    ///
    /// Uses `partition_point` (stdlib binary search) for O(log N) lookup.
    /// Returns the last event whose `beat_position <= beat`.
    #[inline]
    fn active_event_at_beat(&self, beat: f64) -> &TempoEvent {
        // Fast path: constant tempo.
        if self.tempo_events.len() == 1 {
            return &self.tempo_events[0];
        }

        let idx = self
            .tempo_events
            .partition_point(|e| e.beat_position <= beat);
        &self.tempo_events[idx.saturating_sub(1)]
    }
}

impl Default for PulseMap {
    fn default() -> Self {
        Self::new(120.0, 44100.0)
    }
}

// ── Tests ──────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn constant_tempo_beats_conversion() {
        let pm = PulseMap::new(120.0, 44100.0);

        // At 120 BPM: 1 beat = 0.5 seconds = 22050 samples
        let beats = pm.beats(22050);
        assert!((beats - 1.0).abs() < 1e-10, "Expected 1.0 beat, got {beats}");

        let beats_at_4 = pm.beats(88200);
        assert!(
            (beats_at_4 - 4.0).abs() < 1e-10,
            "Expected 4.0 beats, got {beats_at_4}"
        );
    }

    #[test]
    fn constant_tempo_sample_frame_conversion() {
        let pm = PulseMap::new(120.0, 44100.0);

        // 1 beat at 120 BPM = 22050 samples at 44.1kHz
        let sf = pm.sample_frame(1.0);
        assert_eq!(sf, 22050);

        let sf4 = pm.sample_frame(4.0);
        assert_eq!(sf4, 88200);
    }

    #[test]
    fn beats_and_sample_frame_roundtrip() {
        let pm = PulseMap::new(140.0, 48000.0);

        for target_beats in [0.0, 1.0, 2.5, 8.0, 16.0, 100.0] {
            let sf = pm.sample_frame(target_beats);
            let back = pm.beats(sf);
            assert!(
                (back - target_beats).abs() < 0.001,
                "Roundtrip failed for {target_beats} beats: got {back}"
            );
        }
    }

    #[test]
    fn seconds_conversion_is_tempo_independent() {
        let pm = PulseMap::new(999.0, 48000.0); // BPM doesn't matter
        let secs = pm.seconds(96000);
        assert!((secs - 2.0).abs() < f64::EPSILON);
    }

    #[test]
    fn duration_in_samples() {
        let pm = PulseMap::new(120.0, 44100.0);
        // 4 beats starting at sample 0 = 88200 samples
        let dur = pm.duration_in_samples(4.0, 0);
        assert_eq!(dur, 88200);
    }

    #[test]
    fn set_constant_tempo() {
        let mut pm = PulseMap::new(120.0, 44100.0);
        pm.set_constant_tempo(60.0);

        // At 60 BPM: 1 beat = 1 second = 44100 samples
        let sf = pm.sample_frame(1.0);
        assert_eq!(sf, 44100);
        assert_eq!(pm.initial_bpm(), 60.0);
    }

    #[test]
    fn variable_tempo_two_events() {
        // Event 0: BPM 120 starts at sample 0, beat 0
        // Event 1: BPM 60 starts at sample 88200 (= 4 beats at 120 BPM), beat 4
        let events = vec![
            TempoEvent::new(0, 0.0, 120.0),
            TempoEvent::new(88200, 4.0, 60.0),
        ];
        let pm = PulseMap::from_events(events, 44100.0);

        // In the first region (120 BPM), 1 beat = 22050 samples
        assert!((pm.beats(22050) - 1.0).abs() < 1e-10);

        // In the second region (60 BPM), 1 beat = 44100 samples
        // At sample 88200 + 44100 = 132300 → should be beat 5.0
        let b = pm.beats(132300);
        assert!(
            (b - 5.0).abs() < 1e-10,
            "Expected 5.0, got {b}"
        );

        // BPM query
        assert_eq!(pm.bpm_at(0), 120.0);
        assert_eq!(pm.bpm_at(88200), 60.0);
    }

    #[test]
    fn serialization_roundtrip() {
        let pm = PulseMap::new(145.0, 96000.0);
        let json = serde_json::to_string(&pm).unwrap();
        let deserialized: PulseMap = serde_json::from_str(&json).unwrap();
        assert!((deserialized.initial_bpm() - 145.0).abs() < f64::EPSILON);
        assert!((deserialized.sample_rate - 96000.0).abs() < f64::EPSILON);
    }
}
