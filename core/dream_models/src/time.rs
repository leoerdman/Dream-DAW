// ═══════════════════════════════════════════════════════════════════════════
// Dream DAW — AbsoluteTime (Sample-Accurate Clock)
// ═══════════════════════════════════════════════════════════════════════════
//
// Direct port of Swift `AbsoluteTime.swift`.
//
// Musical time (beats, bars) is a UI illusion. The single source of truth
// for ALL positions and durations is `i64` sample frames. This eliminates
// floating-point drift that accumulates with `f64`-based beat storage
// over long projects (2+ hours at 96kHz).
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

// ── Tests ──────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;

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
}
