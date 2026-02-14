// ═══════════════════════════════════════════════════════════════════════════
// Dream DAW — Lock-Free Audio Metering (VU Meters at 120 FPS)
// ═══════════════════════════════════════════════════════════════════════════
//
// This module provides zero-lock, zero-alloc metering primitives for
// transmitting audio levels (RMS, Peak) from the real-time audio thread
// to the UI thread. Standard mutexes destroy audio performance — we use
// atomic bitwise casts (`f32::to_bits` / `f32::from_bits`) instead.
//
// The `f32 ↔ u32` bit-cast trick is valid because:
//   1. `AtomicU32` operations are lock-free on all modern architectures.
//   2. `f32::to_bits` and `f32::from_bits` are bit-exact round-trips.
//   3. `Ordering::Relaxed` is sufficient here — we display at 60–144fps,
//      so eventual consistency is perfectly acceptable.
//
// The only case where `from_bits` produces a signaling NaN is when the
// audio thread stores a sNaN (which never happens with real audio data).
//
// ═══════════════════════════════════════════════════════════════════════════

use std::sync::atomic::{AtomicU32, Ordering};

// ── Constants ──────────────────────────────────────────────────────────────

/// Floor value for metering in dB. Below this, the meter reads as silence.
pub const METER_FLOOR_DB: f32 = -160.0;

/// Clipping threshold in linear amplitude (0 dBFS).
pub const CLIP_THRESHOLD: f32 = 1.0;

/// Default peak hold decay factor per UI frame.
/// At 60fps: peak decays to 50% in ~0.5 seconds.
/// `0.99^30 ≈ 0.74`, `0.99^60 ≈ 0.545`.
pub const DEFAULT_PEAK_DECAY: f32 = 0.99;

// ── LockFreeLevel ──────────────────────────────────────────────────────────

/// Lock-free, wait-free audio level storage for a single channel or track.
///
/// # Thread Safety
/// - **Writer**: Audio callback exclusively (`store_rms`, `store_peak`).
/// - **Reader**: UI thread for display (`load_rms`, `load_peak`).
/// - Both use `Ordering::Relaxed` — eventual consistency is optimal here.
///
/// # Real-Time Safety
/// Zero allocations. Zero locks. Zero syscalls. All operations are single
/// atomic CPU instructions.
pub struct LockFreeLevel {
    /// RMS level in dB, stored as raw `u32` bits of an `f32`.
    rms: AtomicU32,
    /// Peak level in dB, stored as raw `u32` bits of an `f32`.
    peak: AtomicU32,
}

impl LockFreeLevel {
    /// Creates a new meter at silence level.
    pub const fn new() -> Self {
        Self {
            // METER_FLOOR_DB as f32 bits — computed at const time
            rms: AtomicU32::new(METER_FLOOR_DB.to_bits()),
            peak: AtomicU32::new(METER_FLOOR_DB.to_bits()),
        }
    }

    // ── Writer API (Audio Thread) ──────────────────────────────────

    /// Store an RMS value (in dB). Called from the audio callback.
    ///
    /// # Real-Time Safety
    /// Single `store` instruction with `Relaxed` ordering.
    #[inline(always)]
    pub fn store_rms(&self, val: f32) {
        self.rms.store(val.to_bits(), Ordering::Relaxed);
    }

    /// Store a peak value (in dB). Called from the audio callback.
    #[inline(always)]
    pub fn store_peak(&self, val: f32) {
        self.peak.store(val.to_bits(), Ordering::Relaxed);
    }

    /// Store a peak value with exponential decay (peak hold behavior).
    ///
    /// Reads the current peak and decays it toward silence (`METER_FLOOR_DB`)
    /// using: `decayed = floor + (current - floor) × decay_factor`.
    /// Then takes `max(new_val, decayed)` for fast-attack / slow-release.
    ///
    /// **Important**: We operate in dB space (negative values), so straight
    /// multiplication (`peak × 0.99`) would push peaks TOWARD 0 dB (louder).
    /// This lerp-toward-floor approach correctly decays toward silence.
    ///
    /// # Note
    /// This is NOT a true CAS loop — it simply reads and writes.
    /// If two threads race (impossible in SPSC audio), the worst case
    /// is a single dropped peak update (inaudible, invisible).
    #[inline(always)]
    pub fn store_peak_decay(&self, val: f32, decay_factor: f32) {
        let current = self.load_peak();
        // Lerp toward the floor: decayed moves toward METER_FLOOR_DB
        let decayed = METER_FLOOR_DB + (current - METER_FLOOR_DB) * decay_factor;
        let new_peak = val.max(decayed);
        self.store_peak(new_peak);
    }

    // ── Reader API (UI Thread) ─────────────────────────────────────

    /// Load the current RMS value (in dB). Called from the UI render loop.
    ///
    /// # Real-Time Safety
    /// Single `load` instruction with `Relaxed` ordering.
    #[inline(always)]
    pub fn load_rms(&self) -> f32 {
        f32::from_bits(self.rms.load(Ordering::Relaxed))
    }

    /// Load the current peak value (in dB). Called from the UI render loop.
    #[inline(always)]
    pub fn load_peak(&self) -> f32 {
        f32::from_bits(self.peak.load(Ordering::Relaxed))
    }

    /// Returns `true` if the peak level exceeds 0 dBFS (clipping).
    #[inline]
    pub fn is_clipping(&self) -> bool {
        self.load_peak() >= 0.0
    }

    /// Reset both RMS and peak to silence. Non-RT only.
    pub fn reset(&self) {
        self.store_rms(METER_FLOOR_DB);
        self.store_peak(METER_FLOOR_DB);
    }
}

impl Default for LockFreeLevel {
    fn default() -> Self {
        Self::new()
    }
}

// ── MeterBank ──────────────────────────────────────────────────────────────

/// A bank of lock-free meters for multiple tracks + master.
///
/// Pre-allocated with fixed capacity. The audio thread writes per-track
/// levels; the UI thread reads them for VU meter rendering.
///
/// # Layout
/// ```text
/// [Track 0] [Track 1] ... [Track N-1] [Master L] [Master R]
/// ```
pub struct MeterBank {
    /// Per-track meters (stereo: left + right interleaved).
    track_meters: Vec<(LockFreeLevel, LockFreeLevel)>,

    /// Master bus meters (left, right).
    master_left: LockFreeLevel,
    master_right: LockFreeLevel,
}

impl MeterBank {
    /// Creates a meter bank for `track_count` tracks + master bus.
    pub fn new(track_count: usize) -> Self {
        let mut track_meters = Vec::with_capacity(track_count);
        for _ in 0..track_count {
            track_meters.push((LockFreeLevel::new(), LockFreeLevel::new()));
        }

        Self {
            track_meters,
            master_left: LockFreeLevel::new(),
            master_right: LockFreeLevel::new(),
        }
    }

    /// Returns a reference to the stereo meter pair for a track.
    #[inline]
    pub fn track(&self, index: usize) -> Option<&(LockFreeLevel, LockFreeLevel)> {
        self.track_meters.get(index)
    }

    /// Returns a reference to the master left channel meter.
    #[inline]
    pub fn master_left(&self) -> &LockFreeLevel {
        &self.master_left
    }

    /// Returns a reference to the master right channel meter.
    #[inline]
    pub fn master_right(&self) -> &LockFreeLevel {
        &self.master_right
    }

    /// Number of tracks in this bank.
    #[inline]
    pub fn track_count(&self) -> usize {
        self.track_meters.len()
    }

    /// Reset all meters to silence. Non-RT only.
    pub fn reset_all(&self) {
        for (l, r) in &self.track_meters {
            l.reset();
            r.reset();
        }
        self.master_left.reset();
        self.master_right.reset();
    }
}

// ── Utility: Linear → dB Conversion ───────────────────────────────────────

/// Converts linear amplitude (0.0–1.0+) to decibels.
/// Returns `METER_FLOOR_DB` for values at or below the noise floor.
///
/// Formula: `dB = 20 × log₁₀(linear)`
#[inline(always)]
pub fn linear_to_db(linear: f32) -> f32 {
    if linear <= 1e-8 {
        METER_FLOOR_DB
    } else {
        20.0 * linear.log10()
    }
}

/// Converts decibels to linear amplitude (0.0–1.0+).
/// Returns `0.0` for values at or below the meter floor.
///
/// Formula: `linear = 10^(dB / 20)`
#[inline(always)]
pub fn db_to_linear(db: f32) -> f32 {
    if db <= METER_FLOOR_DB {
        0.0
    } else {
        10.0_f32.powf(db / 20.0)
    }
}

/// Computes RMS of a sample buffer (mono).
/// Returns the RMS value in linear amplitude.
///
/// # Real-Time Safety
/// Zero allocations. Pure arithmetic over the input slice.
#[inline]
pub fn compute_rms(samples: &[f32]) -> f32 {
    if samples.is_empty() {
        return 0.0;
    }
    let sum_sq: f32 = samples.iter().map(|s| s * s).sum();
    (sum_sq / samples.len() as f32).sqrt()
}

/// Computes peak of a sample buffer (mono).
/// Returns the peak value in linear amplitude.
///
/// # Real-Time Safety
/// Zero allocations. Single pass over the input slice.
#[inline]
pub fn compute_peak(samples: &[f32]) -> f32 {
    samples.iter().fold(0.0_f32, |max, s| max.max(s.abs()))
}

// ═══════════════════════════════════════════════════════════════════════════
// Tests
// ═══════════════════════════════════════════════════════════════════════════

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn lock_free_level_initial_value() {
        let lfl = LockFreeLevel::new();
        assert!((lfl.load_rms() - METER_FLOOR_DB).abs() < f32::EPSILON);
        assert!((lfl.load_peak() - METER_FLOOR_DB).abs() < f32::EPSILON);
    }

    #[test]
    fn lock_free_level_store_and_load() {
        let lfl = LockFreeLevel::new();

        lfl.store_rms(-20.0);
        assert!((lfl.load_rms() - (-20.0)).abs() < f32::EPSILON);

        lfl.store_peak(-6.0);
        assert!((lfl.load_peak() - (-6.0)).abs() < f32::EPSILON);
    }

    #[test]
    fn lock_free_level_peak_decay() {
        let lfl = LockFreeLevel::new();

        // Set an initial peak
        lfl.store_peak(-3.0);

        // Apply decay with a lower new value — peak should decay toward silence
        lfl.store_peak_decay(-20.0, 0.99);
        let result = lfl.load_peak();
        // Expected: max(-20.0, FLOOR + (-3.0 - FLOOR) × 0.99)
        //         = max(-20.0, -160 + 157 × 0.99)
        //         = max(-20.0, -160 + 155.43)
        //         = max(-20.0, -4.57)
        //         = -4.57
        let expected = METER_FLOOR_DB + (-3.0 - METER_FLOOR_DB) * 0.99;
        assert!((result - expected).abs() < 0.01,
            "Expected {expected}, got {result}");

        // Apply decay with a HIGHER new value — peak should jump up
        lfl.store_peak_decay(0.0, 0.99);
        assert!((lfl.load_peak() - 0.0).abs() < f32::EPSILON);
    }

    #[test]
    fn lock_free_level_clipping_detection() {
        let lfl = LockFreeLevel::new();
        assert!(!lfl.is_clipping());

        lfl.store_peak(0.0);
        assert!(lfl.is_clipping()); // 0 dBFS = clipping

        lfl.store_peak(3.0);
        assert!(lfl.is_clipping()); // Above 0 dBFS

        lfl.store_peak(-0.1);
        assert!(!lfl.is_clipping());
    }

    #[test]
    fn lock_free_level_reset() {
        let lfl = LockFreeLevel::new();
        lfl.store_rms(-6.0);
        lfl.store_peak(-3.0);

        lfl.reset();
        assert!((lfl.load_rms() - METER_FLOOR_DB).abs() < f32::EPSILON);
        assert!((lfl.load_peak() - METER_FLOOR_DB).abs() < f32::EPSILON);
    }

    #[test]
    fn f32_bits_roundtrip_fidelity() {
        // Verify the bit-cast trick preserves exact values
        let test_values = [
            0.0_f32, -0.0, 1.0, -1.0, 0.5, -80.0, -160.0, 6.0, f32::INFINITY,
            f32::NEG_INFINITY, f32::MIN_POSITIVE, f32::MAX,
        ];
        for val in test_values {
            let bits = val.to_bits();
            let recovered = f32::from_bits(bits);
            assert!(
                val.to_bits() == recovered.to_bits(),
                "Bit-cast failed for {val}",
            );
        }
    }

    #[test]
    fn meter_bank_creation_and_access() {
        let bank = MeterBank::new(32);
        assert_eq!(bank.track_count(), 32);

        // All tracks should start at floor
        for i in 0..32 {
            let (l, r) = bank.track(i).unwrap();
            assert!((l.load_rms() - METER_FLOOR_DB).abs() < f32::EPSILON);
            assert!((r.load_rms() - METER_FLOOR_DB).abs() < f32::EPSILON);
        }

        assert!(bank.track(32).is_none()); // Out of bounds
    }

    #[test]
    fn meter_bank_reset() {
        let bank = MeterBank::new(4);
        bank.track(0).unwrap().0.store_rms(-6.0);
        bank.master_left().store_peak(-3.0);

        bank.reset_all();

        assert!((bank.track(0).unwrap().0.load_rms() - METER_FLOOR_DB).abs() < f32::EPSILON);
        assert!(
            (bank.master_left().load_peak() - METER_FLOOR_DB).abs() < f32::EPSILON
        );
    }

    #[test]
    fn linear_to_db_conversion() {
        assert!((linear_to_db(1.0) - 0.0).abs() < 0.001);        // Unity = 0 dB
        assert!((linear_to_db(0.5) - (-6.02)).abs() < 0.01);     // Half = ~-6 dB
        assert!((linear_to_db(0.1) - (-20.0)).abs() < 0.01);
        assert_eq!(linear_to_db(0.0), METER_FLOOR_DB);
        assert_eq!(linear_to_db(1e-9), METER_FLOOR_DB);
    }

    #[test]
    fn db_to_linear_conversion() {
        assert!((db_to_linear(0.0) - 1.0).abs() < 0.001);
        assert!((db_to_linear(-6.02) - 0.5).abs() < 0.01);
        assert!((db_to_linear(-20.0) - 0.1).abs() < 0.001);
        assert_eq!(db_to_linear(METER_FLOOR_DB), 0.0);
        assert_eq!(db_to_linear(-200.0), 0.0);
    }

    #[test]
    fn compute_rms_correctness() {
        let silence: Vec<f32> = vec![0.0; 1024];
        assert_eq!(compute_rms(&silence), 0.0);

        // RMS of a constant signal = the signal itself
        let constant: Vec<f32> = vec![0.5; 1024];
        assert!((compute_rms(&constant) - 0.5).abs() < 0.001);

        // Empty buffer
        assert_eq!(compute_rms(&[]), 0.0);
    }

    #[test]
    fn compute_peak_correctness() {
        assert_eq!(compute_peak(&[0.0, 0.5, -0.8, 0.3]), 0.8);
        assert_eq!(compute_peak(&[0.0; 100]), 0.0);
        assert_eq!(compute_peak(&[1.0, -1.0]), 1.0);
        assert_eq!(compute_peak(&[]), 0.0);
    }
}
