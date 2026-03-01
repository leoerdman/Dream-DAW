// ═══════════════════════════════════════════════════════════════════════════
// Dream DAW — Playhead (Sample-Accurate Position Tracker)
// ═══════════════════════════════════════════════════════════════════════════
//
// The playhead tracks the current position on the timeline in sample frames.
//
// It is the authoritative time source for:
//   - Clip scheduling (which clips are active)
//   - Meter display (beat/bar position)
//   - Automation parameter lookup
//   - Waveform cursor in the UI
//
// Advances by exactly `buffer_size` samples per audio callback.
// Supports seamless loop-point wrapping.
//
// ═══════════════════════════════════════════════════════════════════════════

use super::loop_region::LoopRegion;
use num_traits::ToPrimitive;
use std::sync::atomic::{AtomicU32, Ordering};

/// AUD-238 FIX: Counter for invalid-SR rejections. Replaces `log::warn!`
/// which acquires a Mutex (RT safety violation) with a lock-free atomic.
/// The UI thread can read this periodically and display a warning.
static INVALID_SR_COUNT: AtomicU32 = AtomicU32::new(0);

/// Sample-accurate playhead position tracker.
///
/// Lives on the audio thread. Updated once per buffer at the start
/// of the audio callback. Position is read by clip schedulers,
/// automation engines, and the UI (via atomic snap).
#[derive(Debug, Clone)]
pub struct Playhead {
    /// Current position in sample frames.
    position: i64,

    /// Sample rate for time conversions.
    sample_rate: f64,

    /// Whether the playhead is advancing (mirrors TransportState).
    is_advancing: bool,
}

impl Playhead {    /// Creates a new playhead at position 0.
    pub fn new(sample_rate: f64) -> Self {
        Self {
            position: 0,
            sample_rate,
            is_advancing: false,
        }
    }

    /// Returns the current position in sample frames.
    #[inline]
    pub fn position(&self) -> i64 {
        self.position
    }

    /// Returns the current position in seconds.
    #[inline]
    pub fn position_seconds(&self) -> f64 {
        self.position.to_f64().unwrap_or(0.0) / self.sample_rate
    }

    /// Returns the current position in beats, given BPM.
    #[inline]
    pub fn position_beats(&self, bpm: f64) -> f64 {
        let seconds = self.position_seconds();
        seconds * bpm / 60.0
    }

    /// Returns the current bar and beat.
    ///
    /// Returns (bar, beat, tick) where:
    /// - bar: 1-indexed bar number (can be <= 0 for pre-count)
    /// - beat: 1-indexed beat within the bar
    /// - tick: fractional beat (0.0–1.0)
    pub fn bar_beat_tick(&self, bpm: f64, beats_per_bar: u32) -> (i32, i32, f64) {
        let beats_per_bar = beats_per_bar.max(1);
        let total_beats = self.position_beats(bpm);
        if !total_beats.is_finite() {
            return (1, 1, 0.0);
        }
        
        let beats_per_bar_f64 = f64::from(beats_per_bar);
        let bar_zero_based = (total_beats / beats_per_bar_f64).floor() as i32;
        let beat_zero_based = total_beats.rem_euclid(beats_per_bar_f64).floor() as i32;
        
        let bar = bar_zero_based.saturating_add(1);
        let beat_in_bar = beat_zero_based.saturating_add(1);
        let tick = total_beats.rem_euclid(1.0);
        (bar, beat_in_bar, tick)
    }

    /// Whether the playhead is currently advancing.
    #[inline]
    pub fn is_advancing(&self) -> bool {
        self.is_advancing
    }

    /// Sets whether the playhead should advance.
    #[inline]
    pub fn set_advancing(&mut self, advancing: bool) {
        self.is_advancing = advancing;
    }

    /// Seeks to a specific sample frame position.
    #[inline]
    pub fn seek(&mut self, position: i64) {
        self.position = position.max(0);
    }

    /// Returns to position 0.
    #[inline]
    pub fn return_to_zero(&mut self) {
        self.position = 0;
        self.is_advancing = false;
    }

    /// Advances the playhead by `num_frames`, handling loop wrapping.
    ///
    /// If a loop region is active and the playhead would cross the
    /// loop end point, it wraps back to the loop start.
    ///
    /// # Returns
    /// The number of frames before the loop wrap point.
    /// If no wrap occurred, returns `num_frames`.
    ///
    /// # Real-Time Safety
    /// Real-time safe — no allocations, bounded execution.
    #[inline]
    pub fn advance(&mut self, num_frames: usize, loop_region: Option<&LoopRegion>) -> usize {
        if !self.is_advancing {
            return 0;
        }

        let frame_delta = i64::try_from(num_frames).unwrap_or(i64::MAX);
        let new_position = self.position.saturating_add(frame_delta);

        // Check loop wrap
        if let Some(region) = loop_region
            && region.enabled
            && self.position < region.end
            && new_position >= region.end
        {
            // AUD-239 FIX: Use saturating_sub to prevent underflow if
            // position > end after a seek past the loop region.
            let frames_before_wrap =
                usize::try_from((region.end.saturating_sub(self.position)).max(0))
                    .unwrap_or(usize::MAX);
            let overshoot = new_position - region.end;
            let loop_length = region.end - region.start;

            if loop_length > 0 {
                // Wrap position back into the loop
                self.position = region.start + (overshoot % loop_length);
            } else {
                self.position = region.start;
            }

            return frames_before_wrap;
        }

        self.position = new_position;
        num_frames
    }

    /// Returns the sample rate.
    #[inline]
    pub fn sample_rate(&self) -> f64 {
        self.sample_rate
    }

    /// Updates sample rate used by time-conversion helpers.
    #[inline]
    pub fn set_sample_rate(&mut self, sample_rate: f64) {
        if sample_rate.is_finite() && sample_rate > 0.0 {
            self.sample_rate = sample_rate;
        } else {
            // BUG-92 + AUD-238 FIX: Don't silently ignore invalid sample rates.
            // Uses atomic counter instead of log::warn! to avoid acquiring
            // a Mutex on the RT thread (log backends hold a global lock).
            INVALID_SR_COUNT.fetch_add(1, Ordering::Relaxed);
        }
    }

    /// Returns and resets the count of rejected invalid sample rate attempts.
    /// Call from the UI thread to surface warnings without RT thread locks.
    /// Drains the invalid sample rate count.
    /// Note: Concurrent calls to this function can result in lost counts since it blindly swaps with 0.
    pub fn drain_invalid_sr_count() -> u32 {
        INVALID_SR_COUNT.swap(0, Ordering::Relaxed)
    }
}

// ═══════════════════════════════════════════════════════════════════════════
// Tests
// ═══════════════════════════════════════════════════════════════════════════

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn starts_at_zero() {
        let ph = Playhead::new(44100.0);
        assert_eq!(ph.position(), 0);
        assert!(!ph.is_advancing());
    }

    #[test]
    fn advance_moves_position() {
        let mut ph = Playhead::new(44100.0);
        ph.set_advancing(true);

        let frames = ph.advance(512, None);
        assert_eq!(frames, 512);
        assert_eq!(ph.position(), 512);
    }

    #[test]
    fn advance_while_stopped_is_noop() {
        let mut ph = Playhead::new(44100.0);
        // is_advancing is false by default
        let frames = ph.advance(512, None);
        assert_eq!(frames, 0);
        assert_eq!(ph.position(), 0);
    }

    #[test]
    fn seek_to_position() {
        let mut ph = Playhead::new(44100.0);
        ph.seek(88200);
        assert_eq!(ph.position(), 88200);
    }

    #[test]
    fn seek_clamps_negative() {
        let mut ph = Playhead::new(44100.0);
        ph.seek(-1000);
        assert_eq!(ph.position(), 0);
    }

    #[test]
    fn return_to_zero_resets() {
        let mut ph = Playhead::new(44100.0);
        ph.set_advancing(true);
        ph.advance(44100, None);
        ph.return_to_zero();

        assert_eq!(ph.position(), 0);
        assert!(!ph.is_advancing());
    }

    #[test]
    fn position_seconds() {
        let mut ph = Playhead::new(44100.0);
        ph.seek(44100);
        assert!((ph.position_seconds() - 1.0).abs() < 0.001);
    }

    #[test]
    fn position_beats() {
        let mut ph = Playhead::new(44100.0);
        // At 120 BPM, 1 beat = 0.5 seconds = 22050 samples
        ph.seek(22050);
        assert!((ph.position_beats(120.0) - 1.0).abs() < 0.01);
    }

    #[test]
    fn bar_beat_tick_calculation() {
        let mut ph = Playhead::new(44100.0);
        // At 120 BPM, 4/4 time:
        // Bar 2, Beat 1 = 4 beats = 2 seconds = 88200 samples
        ph.seek(88200);
        let (bar, beat, _tick) = ph.bar_beat_tick(120.0, 4);
        assert_eq!(bar, 2);
        assert_eq!(beat, 1);
    }

    #[test]
    fn loop_wrapping() {
        let mut ph = Playhead::new(44100.0);
        ph.set_advancing(true);
        ph.seek(44000); // Near end of loop

        let region = LoopRegion {
            start: 0,
            end: 44100,
            enabled: true,
        };

        // Advance past loop end
        let frames_before_wrap = ph.advance(512, Some(&region));

        // Should have wrapped
        assert_eq!(frames_before_wrap, 100); // 44100 - 44000
        assert!(ph.position() < 44100); // Wrapped back
        assert!(ph.position() >= 0);
    }

    #[test]
    fn loop_disabled_no_wrap() {
        let mut ph = Playhead::new(44100.0);
        ph.set_advancing(true);
        ph.seek(44000);

        let region = LoopRegion {
            start: 0,
            end: 44100,
            enabled: false, // Loop disabled
        };

        let frames = ph.advance(512, Some(&region));
        assert_eq!(frames, 512);
        assert_eq!(ph.position(), 44512); // No wrap
    }

    #[test]
    fn multiple_advances_accumulate() {
        let mut ph = Playhead::new(44100.0);
        ph.set_advancing(true);

        for _ in 0..100 {
            ph.advance(512, None);
        }

        assert_eq!(ph.position(), 51200);
    }
}
