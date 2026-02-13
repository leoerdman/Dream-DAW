// ═══════════════════════════════════════════════════════════════════════════
// Dream DAW — Time Domain (Sample-Accurate + Musical Time)
// ═══════════════════════════════════════════════════════════════════════════
//
// This module contains the two canonical time representations:
//
//   1. `AbsoluteTime` — i64 sample frame counter. The SSOT for audio engine,
//      scheduling, and rendering. Eliminates floating-point drift over long
//      sessions (2+ hours at 96kHz).
//
//   2. `TimePosition` — f64 beat-based wrapper used for UI display, grid
//      drawing, and model serialization. Derived from AbsoluteTime via PulseMap.
//
//   3. `TimeRange` — A start/end pair of `TimePosition` for region operations
//      (loop ranges, selection extents, clip bounds).
//
// Key Guarantee: Two `AbsoluteTime` values that differ by even 1 sample
// will always compare as different, enabling sample-accurate editing.
//
// Overflow: i64 at 192kHz → ~1.5 billion years before overflow.
//
// ═══════════════════════════════════════════════════════════════════════════

use serde::{Deserialize, Serialize};
use ts_rs::TS;

use crate::pulse_map::PulseMap;

// ── Constants ──────────────────────────────────────────────────────────────

/// Pulses Per Quarter Note — tick resolution for beat formatting.
/// Industry standard: 960 provides clean division for triplets (÷3),
/// swung 16ths (÷6), and 32nd notes (÷8).
pub const PPQN: u32 = 960;

// ═══════════════════════════════════════════════════════════════════════════
// AbsoluteTime — Sample-Accurate Clock (i64 SSOT)
// ═══════════════════════════════════════════════════════════════════════════

/// Sample-accurate time representation — the SSOT for all positions and
/// durations in the DAW engine.
///
/// Musical time (beats, bars) is derived on-demand via [`PulseMap`] for
/// UI display only. This struct stores only integer sample frames.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash, Serialize, Deserialize, TS)]
#[ts(export)]
pub struct AbsoluteTime {
    /// The absolute sample frame index (64-bit signed).
    /// Supports >13 million hours at 96kHz.
    pub sample_frame: i64,
}

impl AbsoluteTime {
    // ── Constants ───────────────────────────────────────────────────

    /// The zero position (start of project).
    pub const ZERO: Self = Self { sample_frame: 0 };

    // ── Construction ───────────────────────────────────────────────

    /// Creates an `AbsoluteTime` from a raw sample frame index.
    #[inline]
    pub const fn new(sample_frame: i64) -> Self {
        Self { sample_frame }
    }

    /// Creates from seconds and sample rate (convenience for audio file import).
    #[inline]
    pub fn from_seconds(seconds: f64, sample_rate: f64) -> Self {
        Self {
            sample_frame: (seconds * sample_rate) as i64,
        }
    }

    // ── Conversions ────────────────────────────────────────────────

    /// Converts to seconds (tempo-independent, pure division).
    #[inline]
    pub fn to_seconds(self, sample_rate: f64) -> f64 {
        self.sample_frame as f64 / sample_rate
    }

    /// Converts to musical beats using a tempo map.
    /// Use ONLY for grid drawing and position display — never for audio scheduling.
    #[inline]
    pub fn to_beats(self, pulse_map: &PulseMap) -> f64 {
        pulse_map.beats(self.sample_frame)
    }

    /// Converts to a legacy `TimePosition` for backward compatibility.
    /// **Warning**: This loses sample-accuracy. Use during migration only.
    #[inline]
    pub fn to_time_position(self, pulse_map: &PulseMap) -> TimePosition {
        TimePosition {
            beats: pulse_map.beats(self.sample_frame),
        }
    }

    // ── Arithmetic ─────────────────────────────────────────────────

    /// Returns a new `AbsoluteTime` offset by the given number of samples.
    #[inline]
    pub const fn advanced(self, samples: i64) -> Self {
        Self {
            sample_frame: self.sample_frame + samples,
        }
    }

    /// Returns the distance in samples from `self` to `other`.
    #[inline]
    pub const fn distance_to(self, other: Self) -> i64 {
        other.sample_frame - self.sample_frame
    }
}

impl Default for AbsoluteTime {
    fn default() -> Self {
        Self::ZERO
    }
}

// ── Operator Overloads ─────────────────────────────────────────────────

impl std::ops::Add<i64> for AbsoluteTime {
    type Output = Self;
    #[inline]
    fn add(self, rhs: i64) -> Self {
        Self::new(self.sample_frame + rhs)
    }
}

impl std::ops::Sub<i64> for AbsoluteTime {
    type Output = Self;
    #[inline]
    fn sub(self, rhs: i64) -> Self {
        Self::new(self.sample_frame - rhs)
    }
}

impl std::ops::Sub for AbsoluteTime {
    type Output = i64;
    #[inline]
    fn sub(self, rhs: Self) -> i64 {
        self.sample_frame - rhs.sample_frame
    }
}

impl std::ops::AddAssign<i64> for AbsoluteTime {
    #[inline]
    fn add_assign(&mut self, rhs: i64) {
        self.sample_frame += rhs;
    }
}

impl std::ops::SubAssign<i64> for AbsoluteTime {
    #[inline]
    fn sub_assign(&mut self, rhs: i64) {
        self.sample_frame -= rhs;
    }
}

// ═══════════════════════════════════════════════════════════════════════════
// TimePosition — Musical Beat Coordinate
// ═══════════════════════════════════════════════════════════════════════════

/// Beat-based time position for UI display and grid math.
///
/// This is a lightweight `f64` wrapper. It is NOT used for audio scheduling —
/// all engine-side timing uses [`AbsoluteTime`] (i64 sample frames).
///
/// # Usage
/// - Grid line positions
/// - Bars:Beats:Ticks display formatting
/// - Clip/note position in the arrangement view (UI only)
/// - Serialization of musical positions in project files
#[derive(Debug, Clone, Copy, PartialEq, PartialOrd, Serialize, Deserialize, TS)]
#[ts(export)]
pub struct TimePosition {
    /// Time in quarter-note beats. E.g., 4.0 = bar 2 beat 1 in 4/4.
    pub beats: f64,
}

impl TimePosition {
    // ── Constants ───────────────────────────────────────────────────

    /// The zero position (start of project).
    pub const ZERO: Self = Self { beats: 0.0 };

    // ── Construction ───────────────────────────────────────────────

    /// Creates a `TimePosition` from beats.
    #[inline]
    pub const fn new(beats: f64) -> Self {
        Self { beats }
    }

    /// Creates from bars (1-indexed) and beats per bar.
    /// `bars(3, 4)` = beat 8.0 (start of bar 3 in 4/4).
    #[inline]
    pub fn from_bars(bars: u32, beats_per_bar: u32) -> Self {
        Self {
            beats: (bars.saturating_sub(1) as f64) * (beats_per_bar as f64),
        }
    }

    // ── Conversions ────────────────────────────────────────────────

    /// Converts to seconds at a given BPM.
    #[inline]
    pub fn to_seconds(self, bpm: f64) -> f64 {
        self.beats * (60.0 / bpm)
    }

    /// Converts to sample frames at a given BPM and sample rate.
    #[inline]
    pub fn to_samples(self, bpm: f64, sample_rate: f64) -> i64 {
        let seconds = self.to_seconds(bpm);
        (seconds * sample_rate).round() as i64
    }

    /// Creates from sample count at a given BPM and sample rate.
    #[inline]
    pub fn from_samples(samples: i64, bpm: f64, sample_rate: f64) -> Self {
        let seconds = samples as f64 / sample_rate;
        let beats = seconds * (bpm / 60.0);
        Self { beats }
    }

    /// Converts to sample-accurate `AbsoluteTime` via a `PulseMap`.
    /// This is the canonical bridge from UI-land to engine-land.
    #[inline]
    pub fn to_absolute(self, pulse_map: &PulseMap) -> AbsoluteTime {
        AbsoluteTime::new(pulse_map.sample_frame(self.beats))
    }

    // ── Formatting ─────────────────────────────────────────────────

    /// Formats as `Bar.Beat.Tick` (e.g., `1.1.000`).
    /// Uses 960 PPQN for tick resolution.
    pub fn formatted(self, beats_per_bar: u32) -> String {
        let total_beats = self.beats.max(0.0);
        let bpb = beats_per_bar.max(1) as f64;
        let bar = (total_beats / bpb) as u32 + 1;
        let beat = (total_beats % bpb) as u32 + 1;
        let tick = ((total_beats - total_beats.floor()) * PPQN as f64) as u32;
        format!("{bar}.{beat}.{tick:03}")
    }

    /// Formats as `MM:SS.mmm` (e.g., `01:23.456`).
    pub fn formatted_time(self, bpm: f64) -> String {
        let total_seconds = self.to_seconds(bpm).max(0.0);
        let minutes = (total_seconds / 60.0) as u32;
        let seconds = (total_seconds % 60.0) as u32;
        let millis = ((total_seconds - total_seconds.floor()) * 1000.0) as u32;
        format!("{minutes}:{seconds:02}.{millis:03}")
    }
}

impl Default for TimePosition {
    fn default() -> Self {
        Self::ZERO
    }
}

// ── Operator Overloads ─────────────────────────────────────────────────

impl std::ops::Add for TimePosition {
    type Output = Self;
    #[inline]
    fn add(self, rhs: Self) -> Self {
        Self {
            beats: self.beats + rhs.beats,
        }
    }
}

impl std::ops::Sub for TimePosition {
    type Output = Self;
    #[inline]
    fn sub(self, rhs: Self) -> Self {
        Self {
            beats: self.beats - rhs.beats,
        }
    }
}

impl std::ops::Mul<f64> for TimePosition {
    type Output = Self;
    #[inline]
    fn mul(self, rhs: f64) -> Self {
        Self {
            beats: self.beats * rhs,
        }
    }
}

impl std::ops::Div<f64> for TimePosition {
    type Output = Self;
    #[inline]
    fn div(self, rhs: f64) -> Self {
        Self {
            beats: self.beats / rhs,
        }
    }
}

impl std::ops::AddAssign for TimePosition {
    #[inline]
    fn add_assign(&mut self, rhs: Self) {
        self.beats += rhs.beats;
    }
}

impl std::ops::SubAssign for TimePosition {
    #[inline]
    fn sub_assign(&mut self, rhs: Self) {
        self.beats -= rhs.beats;
    }
}

// ═══════════════════════════════════════════════════════════════════════════
// TimeRange — Musical Beat Range
// ═══════════════════════════════════════════════════════════════════════════

/// A range of musical time defined by start and end `TimePosition`.
///
/// Used for:
/// - Loop region boundaries
/// - Marquee selection extents
/// - Clip time bounds (position + duration as a range)
/// - Automation region queries
#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize, TS)]
#[ts(export)]
pub struct TimeRange {
    pub start: TimePosition,
    pub end: TimePosition,
}

impl TimeRange {
    /// Creates a new `TimeRange` from start and end beats.
    #[inline]
    pub const fn new(start: TimePosition, end: TimePosition) -> Self {
        Self { start, end }
    }

    /// Duration of this range in beats.
    #[inline]
    pub fn duration(self) -> TimePosition {
        TimePosition {
            beats: (self.end.beats - self.start.beats).max(0.0),
        }
    }

    /// Returns `true` if `pos` falls within `[start, end)`.
    #[inline]
    pub fn contains(self, pos: TimePosition) -> bool {
        pos.beats >= self.start.beats && pos.beats < self.end.beats
    }

    /// Returns `true` if this range overlaps with `other`.
    /// Standard AABB overlap: `a.start < b.end && a.end > b.start`.
    #[inline]
    pub fn overlaps(self, other: &TimeRange) -> bool {
        self.start.beats < other.end.beats && self.end.beats > other.start.beats
    }

    /// Computes the intersection of two ranges, or `None` if they don't overlap.
    #[inline]
    pub fn intersection(self, other: &TimeRange) -> Option<TimeRange> {
        let s = self.start.beats.max(other.start.beats);
        let e = self.end.beats.min(other.end.beats);
        if s < e {
            Some(TimeRange {
                start: TimePosition { beats: s },
                end: TimePosition { beats: e },
            })
        } else {
            None
        }
    }

    /// Returns `true` if this range has zero or negative length.
    #[inline]
    pub fn is_empty(self) -> bool {
        self.end.beats <= self.start.beats
    }
}

// ═══════════════════════════════════════════════════════════════════════════
// Tests
// ═══════════════════════════════════════════════════════════════════════════

#[cfg(test)]
mod tests {
    use super::*;

    // ── AbsoluteTime Tests ─────────────────────────────────────────

    #[test]
    fn zero_constant() {
        assert_eq!(AbsoluteTime::ZERO.sample_frame, 0);
        assert_eq!(AbsoluteTime::default(), AbsoluteTime::ZERO);
    }

    #[test]
    fn from_seconds_converts_correctly() {
        let t = AbsoluteTime::from_seconds(1.0, 48000.0);
        assert_eq!(t.sample_frame, 48000);

        let t2 = AbsoluteTime::from_seconds(2.5, 44100.0);
        assert_eq!(t2.sample_frame, 110250);
    }

    #[test]
    fn to_seconds_roundtrips() {
        let t = AbsoluteTime::new(96000);
        let secs = t.to_seconds(48000.0);
        assert!((secs - 2.0).abs() < f64::EPSILON);
    }

    #[test]
    fn arithmetic_operations() {
        let a = AbsoluteTime::new(1000);
        let b = AbsoluteTime::new(500);

        assert_eq!((a + 200).sample_frame, 1200);
        assert_eq!((a - 200).sample_frame, 800);
        assert_eq!(a - b, 500);
        assert_eq!(a.advanced(300).sample_frame, 1300);
        assert_eq!(b.distance_to(a), 500);
    }

    #[test]
    fn comparison_is_sample_accurate() {
        let a = AbsoluteTime::new(1000);
        let b = AbsoluteTime::new(1001);
        assert!(a < b);
        assert!(a != b);
    }

    #[test]
    fn add_assign_and_sub_assign() {
        let mut t = AbsoluteTime::new(100);
        t += 50;
        assert_eq!(t.sample_frame, 150);
        t -= 30;
        assert_eq!(t.sample_frame, 120);
    }

    #[test]
    fn serialization_roundtrip() {
        let t = AbsoluteTime::new(123456789);
        let json = serde_json::to_string(&t).unwrap();
        let deserialized: AbsoluteTime = serde_json::from_str(&json).unwrap();
        assert_eq!(t, deserialized);
    }

    // ── TimePosition Tests ─────────────────────────────────────────

    #[test]
    fn time_position_zero() {
        assert!((TimePosition::ZERO.beats - 0.0).abs() < f64::EPSILON);
        assert_eq!(TimePosition::default(), TimePosition::ZERO);
    }

    #[test]
    fn time_position_from_bars() {
        let pos = TimePosition::from_bars(3, 4); // Bar 3 in 4/4
        assert!((pos.beats - 8.0).abs() < f64::EPSILON);

        let pos2 = TimePosition::from_bars(1, 4); // Bar 1 = beat 0
        assert!((pos2.beats - 0.0).abs() < f64::EPSILON);
    }

    #[test]
    fn time_position_to_seconds() {
        let pos = TimePosition::new(4.0);
        let secs = pos.to_seconds(120.0); // 4 beats at 120 BPM = 2 seconds
        assert!((secs - 2.0).abs() < 1e-10);
    }

    #[test]
    fn time_position_to_samples() {
        let pos = TimePosition::new(1.0);
        let samples = pos.to_samples(120.0, 44100.0); // 1 beat = 0.5s = 22050 samples
        assert_eq!(samples, 22050);
    }

    #[test]
    fn time_position_from_samples() {
        let pos = TimePosition::from_samples(22050, 120.0, 44100.0);
        assert!((pos.beats - 1.0).abs() < 1e-10);
    }

    #[test]
    fn time_position_arithmetic() {
        let a = TimePosition::new(4.0);
        let b = TimePosition::new(2.5);

        assert!((a + b).beats - 6.5 < 1e-10);
        assert!((a - b).beats - 1.5 < 1e-10);
        assert!((a * 2.0).beats - 8.0 < 1e-10);
        assert!((a / 2.0).beats - 2.0 < 1e-10);

        let mut c = TimePosition::new(1.0);
        c += TimePosition::new(3.0);
        assert!((c.beats - 4.0).abs() < f64::EPSILON);
        c -= TimePosition::new(1.5);
        assert!((c.beats - 2.5).abs() < f64::EPSILON);
    }

    #[test]
    fn time_position_formatted() {
        let pos = TimePosition::new(4.5); // Bar 2 beat 1 tick 480 in 4/4
        let s = pos.formatted(4);
        assert_eq!(s, "2.1.480");

        let pos2 = TimePosition::new(0.0);
        assert_eq!(pos2.formatted(4), "1.1.000");
    }

    #[test]
    fn time_position_formatted_time() {
        let pos = TimePosition::new(120.0); // 120 beats at 120 BPM = 60 seconds
        let s = pos.formatted_time(120.0);
        assert_eq!(s, "1:00.000");
    }

    #[test]
    fn time_position_serialization_roundtrip() {
        let pos = TimePosition::new(4.567);
        let json = serde_json::to_string(&pos).unwrap();
        let deserialized: TimePosition = serde_json::from_str(&json).unwrap();
        assert!((deserialized.beats - pos.beats).abs() < f64::EPSILON);
    }

    // ── TimeRange Tests ────────────────────────────────────────────

    #[test]
    fn time_range_duration() {
        let range = TimeRange::new(TimePosition::new(2.0), TimePosition::new(6.0));
        assert!((range.duration().beats - 4.0).abs() < f64::EPSILON);
    }

    #[test]
    fn time_range_contains() {
        let range = TimeRange::new(TimePosition::new(4.0), TimePosition::new(8.0));
        assert!(range.contains(TimePosition::new(4.0))); // start inclusive
        assert!(range.contains(TimePosition::new(6.0)));
        assert!(!range.contains(TimePosition::new(8.0))); // end exclusive
        assert!(!range.contains(TimePosition::new(3.9)));
    }

    #[test]
    fn time_range_overlaps() {
        let a = TimeRange::new(TimePosition::new(0.0), TimePosition::new(4.0));
        let b = TimeRange::new(TimePosition::new(2.0), TimePosition::new(6.0));
        let c = TimeRange::new(TimePosition::new(4.0), TimePosition::new(8.0));
        let d = TimeRange::new(TimePosition::new(5.0), TimePosition::new(6.0));

        assert!(a.overlaps(&b));  // Partial overlap
        assert!(!a.overlaps(&c)); // Adjacent, no overlap (end exclusive)
        assert!(!a.overlaps(&d)); // No overlap
        assert!(b.overlaps(&c));  // Partial overlap
    }

    #[test]
    fn time_range_intersection() {
        let a = TimeRange::new(TimePosition::new(0.0), TimePosition::new(4.0));
        let b = TimeRange::new(TimePosition::new(2.0), TimePosition::new(6.0));

        let intersection = a.intersection(&b).expect("should overlap");
        assert!((intersection.start.beats - 2.0).abs() < f64::EPSILON);
        assert!((intersection.end.beats - 4.0).abs() < f64::EPSILON);

        let c = TimeRange::new(TimePosition::new(5.0), TimePosition::new(6.0));
        assert!(a.intersection(&c).is_none());
    }

    #[test]
    fn time_range_is_empty() {
        let empty = TimeRange::new(TimePosition::new(4.0), TimePosition::new(4.0));
        assert!(empty.is_empty());

        let inverted = TimeRange::new(TimePosition::new(6.0), TimePosition::new(4.0));
        assert!(inverted.is_empty());

        let valid = TimeRange::new(TimePosition::new(0.0), TimePosition::new(0.001));
        assert!(!valid.is_empty());
    }

    #[test]
    fn time_range_serialization_roundtrip() {
        let range = TimeRange::new(TimePosition::new(1.5), TimePosition::new(5.5));
        let json = serde_json::to_string(&range).unwrap();
        let deserialized: TimeRange = serde_json::from_str(&json).unwrap();
        assert_eq!(deserialized, range);
    }
}
