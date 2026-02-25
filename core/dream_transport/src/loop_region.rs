// ═══════════════════════════════════════════════════════════════════════════
// Dream DAW — Loop Region
// ═══════════════════════════════════════════════════════════════════════════
//
// Defines a loop region on the timeline for seamless looping.
//
// The loop region is defined by start/end positions in sample frames.
// When enabled, the playhead wraps from end → start automatically.
//
// ═══════════════════════════════════════════════════════════════════════════

/// A loop region on the timeline.
///
/// When `enabled`, the `Playhead` wraps from `end` to `start`
/// during advancing, creating seamless loop playback.
#[derive(Debug, Clone, Copy)]
pub struct LoopRegion {
    /// Loop start position in sample frames.
    pub start: i64,

    /// Loop end position in sample frames.
    pub end: i64,

    /// Whether the loop is active.
    pub enabled: bool,
}

impl LoopRegion {
    /// Creates a new disabled loop region.
    pub fn new() -> Self {
        Self {
            start: 0,
            end: 0,
            enabled: false,
        }
    }

    /// Creates a loop region with specific boundaries.
    pub fn with_range(start: i64, end: i64) -> Self {
        Self {
            start: start.min(end),
            end: start.max(end),
            enabled: true,
        }
    }

    /// Returns the loop length in sample frames.
    ///
    /// # Panics (debug)
    /// Debug-asserts that end > start. In release, returns 0 for degenerate regions.
    #[inline]
    #[must_use]
    pub fn length(&self) -> i64 {
        debug_assert!(
            self.end >= self.start,
            "LoopRegion::length() called with end ({}) < start ({})",
            self.end,
            self.start
        );
        self.end - self.start
    }

    /// Returns the loop length in seconds at the given sample rate.
    ///
    /// Returns 0.0 if sample_rate ≤ 0.
    #[inline]
    #[must_use]
    pub fn length_seconds(&self, sample_rate: f64) -> f64 {
        if sample_rate <= 0.0 {
            return 0.0;
        }
        self.length().to_f64().unwrap_or(0.0) / sample_rate
    }

    /// Returns the loop length in beats at the given BPM and sample rate.
    #[inline]
    #[must_use]
    pub fn length_beats(&self, bpm: f64, sample_rate: f64) -> f64 {
        self.length_seconds(sample_rate) * bpm / 60.0
    }

    /// Sets the loop boundaries, ensuring start < end.
    /// BUG-055 FIX: Forcefully disable if zero-length to prevent wrapping edge cases.
    pub fn set_range(&mut self, start: i64, end: i64) {
        self.start = start.min(end);
        self.end = start.max(end);
        if self.start == self.end {
            self.enabled = false;
        }
    }

    /// Returns whether a sample position falls within the loop.
    #[inline]
    pub fn contains(&self, position: i64) -> bool {
        position >= self.start && position < self.end
    }

    /// Toggles the loop on/off.
    #[inline]
    pub fn toggle(&mut self) {
        self.enabled = !self.enabled;
    }

    /// Validates that the loop region is usable.
    /// Returns `true` if the loop has a positive length.
    #[inline]
    pub fn is_valid(&self) -> bool {
        self.end > self.start
    }
}

impl Default for LoopRegion {
    fn default() -> Self {
        Self::new()
    }
}

// ═══════════════════════════════════════════════════════════════════════════
// Tests
// ═══════════════════════════════════════════════════════════════════════════

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn default_is_disabled() {
        let lr = LoopRegion::new();
        assert!(!lr.enabled);
        assert_eq!(lr.length(), 0);
    }

    #[test]
    fn with_range_enables() {
        let lr = LoopRegion::with_range(44100, 88200);
        assert!(lr.enabled);
        assert_eq!(lr.start, 44100);
        assert_eq!(lr.end, 88200);
        assert_eq!(lr.length(), 44100);
    }

    #[test]
    fn with_range_swaps_if_inverted() {
        let lr = LoopRegion::with_range(88200, 44100);
        assert_eq!(lr.start, 44100);
        assert_eq!(lr.end, 88200);
    }

    #[test]
    fn length_seconds() {
        let lr = LoopRegion::with_range(0, 44100);
        assert!((lr.length_seconds(44100.0) - 1.0).abs() < 0.001);
    }

    #[test]
    fn length_beats() {
        let lr = LoopRegion::with_range(0, 44100);
        // At 120 BPM, 1 second = 2 beats
        assert!((lr.length_beats(120.0, 44100.0) - 2.0).abs() < 0.01);
    }

    #[test]
    fn contains_position() {
        let lr = LoopRegion::with_range(1000, 2000);
        assert!(!lr.contains(999));
        assert!(lr.contains(1000));
        assert!(lr.contains(1500));
        assert!(!lr.contains(2000)); // End is exclusive
    }

    #[test]
    fn toggle() {
        let mut lr = LoopRegion::with_range(0, 44100);
        assert!(lr.enabled);
        lr.toggle();
        assert!(!lr.enabled);
        lr.toggle();
        assert!(lr.enabled);
    }

    #[test]
    fn set_range_normalizes() {
        let mut lr = LoopRegion::new();
        lr.set_range(200, 100);
        assert_eq!(lr.start, 100);
        assert_eq!(lr.end, 200);
    }

    #[test]
    fn is_valid() {
        let valid = LoopRegion::with_range(0, 100);
        assert!(valid.is_valid());

        let invalid = LoopRegion::new();
        assert!(!invalid.is_valid());
    }
}
use num_traits::ToPrimitive;
