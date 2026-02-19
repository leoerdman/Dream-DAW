// ═══════════════════════════════════════════════════════════════════════════
// Dream DAW — Gain Utilities
// ═══════════════════════════════════════════════════════════════════════════
//
// dB-linear conversion and real-time-safe gain application.
//
// All functions are #[inline] for use in the audio callback hot path.
//
// ═══════════════════════════════════════════════════════════════════════════

/// Converts decibels to linear gain.
///
/// -∞ dB → 0.0,  0 dB → 1.0,  +6 dB → ~2.0
#[inline]
#[must_use]
pub fn db_to_linear(db: f32) -> f32 {
    if db <= -120.0 {
        0.0
    } else {
        // BUG-040 FIX: exp() is 2-3x faster than powf() on all platforms.
        // 10^(db/20) = e^(db/20 * ln(10)) = e^(db * 0.11512925)
        (db * 0.11512925_f32).exp()
    }
}

/// Converts linear gain to decibels.
///
/// 0.0 → -∞ dB,  1.0 → 0 dB,  2.0 → ~6 dB
#[inline]
#[must_use]
pub fn linear_to_db(gain: f32) -> f32 {
    if gain <= 0.0 {
        -120.0 // Effective silence
    } else {
        20.0 * gain.log10()
    }
}

/// Applies a gain value to a buffer of audio samples in-place.
///
/// # Real-Time Safety
/// This function is real-time safe. No allocations, no branches per sample
/// (except the early exit for unity gain).
#[inline]
pub fn apply_gain(buffer: &mut [f32], gain: f32) {
    // Unity gain: no-op
    if (gain - 1.0).abs() < f32::EPSILON {
        return;
    }

    // BUG-039 FIX: Use fill(0.0) — cleaner and SIMD-friendly.
    if gain <= f32::EPSILON {
        buffer.fill(0.0);
        return;
    }

    // Apply gain
    for sample in buffer.iter_mut() {
        *sample *= gain;
    }
}

/// Applies gain with per-sample smoothing (exponential).
///
/// Use this when the gain changes between frames to avoid clicks.
/// `current_gain` is mutated to track the smoothed value.
///
/// # Real-Time Safety
/// Real-time safe — bounded iteration, no allocations.
#[inline]
pub fn apply_gain_smoothed(
    buffer: &mut [f32],
    target_gain: f32,
    current_gain: &mut f32,
    smoothing_coeff: f32,
) {
    for sample in buffer.iter_mut() {
        *current_gain += (target_gain - *current_gain) * smoothing_coeff;
        *sample *= *current_gain;
    }
}

/// Default smoothing coefficient for gain changes.
/// Approximately 5ms at 44.1kHz. Prevents audible clicks.
pub const GAIN_SMOOTH_COEFF: f32 = 0.005;

/// Applies a linear gain ramp from `start_gain` to `end_gain` over the buffer.
///
/// Ported from Swift `TrackMixer.smoothSetVolume()` which uses 32-step
/// linear interpolation. This version operates at sample-level granularity
/// for maximum smoothness.
///
/// Use this instead of `apply_gain_smoothed` for fader movements (linear
/// interpolation is more perceptually accurate for volume changes).
///
/// # Real-Time Safety
/// Real-time safe — bounded iteration, no allocations.
#[inline]
pub fn apply_gain_ramp(buffer: &mut [f32], start_gain: f32, end_gain: f32) {
    let len = buffer.len();
    if len == 0 {
        return;
    }

    // Fast path: no change needed
    if (start_gain - end_gain).abs() < f32::EPSILON {
        apply_gain(buffer, start_gain);
        return;
    }

    let inv_len = 1.0 / len as f32;

    for (i, sample) in buffer.iter_mut().enumerate() {
        let t = i as f32 * inv_len;
        let gain = start_gain + (end_gain - start_gain) * t;
        *sample *= gain;
    }
}

// ═══════════════════════════════════════════════════════════════════════════
// Tests
// ═══════════════════════════════════════════════════════════════════════════

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn db_to_linear_unity() {
        assert!((db_to_linear(0.0) - 1.0).abs() < 0.001);
    }

    #[test]
    fn db_to_linear_plus_6() {
        assert!((db_to_linear(6.0) - 1.995).abs() < 0.01);
    }

    #[test]
    fn db_to_linear_minus_infinity() {
        assert_eq!(db_to_linear(-120.0), 0.0);
        assert_eq!(db_to_linear(-200.0), 0.0);
    }

    #[test]
    fn linear_to_db_unity() {
        assert!((linear_to_db(1.0) - 0.0).abs() < 0.001);
    }

    #[test]
    fn linear_to_db_silence() {
        assert_eq!(linear_to_db(0.0), -120.0);
    }

    #[test]
    fn roundtrip_db_linear() {
        for db in [-60.0, -12.0, -6.0, -3.0, 0.0, 3.0, 6.0, 12.0] {
            let linear = db_to_linear(db);
            let back = linear_to_db(linear);
            assert!(
                (back - db).abs() < 0.01,
                "Roundtrip failed for {db}dB: got {back}dB"
            );
        }
    }

    #[test]
    fn apply_gain_unity_is_noop() {
        let mut buf = vec![0.5, -0.3, 0.8];
        let original = buf.clone();
        apply_gain(&mut buf, 1.0);
        assert_eq!(buf, original);
    }

    #[test]
    fn apply_gain_silence() {
        let mut buf = vec![0.5, -0.3, 0.8];
        apply_gain(&mut buf, 0.0);
        assert!(buf.iter().all(|&s| s == 0.0));
    }

    #[test]
    fn apply_gain_half() {
        let mut buf = vec![1.0, -1.0, 0.5];
        apply_gain(&mut buf, 0.5);
        assert!((buf[0] - 0.5).abs() < 0.001);
        assert!((buf[1] - (-0.5)).abs() < 0.001);
        assert!((buf[2] - 0.25).abs() < 0.001);
    }

    #[test]
    fn smoothed_gain_converges() {
        let mut buf = vec![1.0; 1000];
        let mut current = 0.0;
        apply_gain_smoothed(&mut buf, 1.0, &mut current, 0.01);

        // After 1000 samples with coeff 0.01, should be very close to target
        assert!(
            (current - 1.0).abs() < 0.001,
            "Smoothed gain didn't converge: {current}"
        );
    }

    #[test]
    fn ramp_gain_linear_interpolation() {
        let mut buf = vec![1.0; 100];
        apply_gain_ramp(&mut buf, 0.0, 1.0);

        // First sample should be ~0.0, last sample should be ~1.0
        assert!(buf[0].abs() < 0.02, "Start should be near 0");
        assert!((buf[99] - 0.99).abs() < 0.02, "End should be near 1.0");

        // Middle should be ~0.5
        assert!(
            (buf[50] - 0.5).abs() < 0.02,
            "Middle should be ~0.5, got {}",
            buf[50]
        );
    }

    #[test]
    fn ramp_gain_constant_is_flat() {
        let mut buf = vec![1.0; 100];
        apply_gain_ramp(&mut buf, 0.5, 0.5);

        for sample in &buf {
            assert!(
                (sample - 0.5).abs() < 0.001,
                "Constant ramp should be flat at 0.5"
            );
        }
    }

    #[test]
    fn ramp_gain_empty_buffer() {
        let mut buf: Vec<f32> = Vec::new();
        apply_gain_ramp(&mut buf, 0.0, 1.0); // Should not panic
    }
}
