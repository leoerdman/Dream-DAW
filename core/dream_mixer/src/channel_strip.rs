// ═══════════════════════════════════════════════════════════════════════════
// Dream DAW — Channel Strip (Per-Track Signal Chain Orchestrator)
// ═══════════════════════════════════════════════════════════════════════════
//
// Wires the mixer primitives (gain, pan, meter) into a single per-track
// processing pass:
//
//   Input → Smoothed Gain → Smoothed Pan → VuMeter (L+R) → Output
//
// Ported from the core pattern in Swift `TrackMixer.swift` (1013 LOC).
// The Swift version also managed insert effects and instruments;
// those are deferred to the audio graph integration.
//
// This struct is allocated ONCE per track and reused every audio callback.
// All processing is REAL-TIME SAFE.
//
// ═══════════════════════════════════════════════════════════════════════════

use crate::gain::GAIN_SMOOTH_COEFF;
use crate::meter::VuMeter;
use crate::pan::{PanLaw, apply_pan_smoothed};

/// Per-track signal chain orchestrator.
///
/// Holds the smoothed state for volume/pan and dual VU meters (L/R).
/// Feed audio through `process_stereo()` each callback.
///
/// # Usage
/// ```ignore
/// // On UI thread: update targets
/// strip.set_volume(0.75);
/// strip.set_pan(-0.3);
///
/// // On audio thread: process buffer
/// strip.process_stereo(&mut left_buf, &mut right_buf);
/// ```
pub struct ChannelStrip {
    // ── Volume ─────────────────────────────────────────────────────────
    /// Target volume (set by UI thread).
    target_volume: f32,

    /// Current smoothed volume (tracks towards target).
    current_volume: f32,

    /// Smoothing coefficient for volume.
    volume_smooth_coeff: f32,

    /// Extra runtime gain multiplier (mute/solo resolution).
    effective_gain: f32,

    // ── Pan ────────────────────────────────────────────────────────────
    /// Target pan position (set by UI thread).
    target_pan: f32,

    /// Current smoothed pan (tracks towards target).
    current_pan: f32,

    /// Smoothing coefficient for pan.
    pan_smooth_coeff: f32,

    /// Pan law to use.
    pan_law: PanLaw,

    // ── Metering ───────────────────────────────────────────────────────
    /// Left channel VU meter.
    meter_left: VuMeter,

    /// Right channel VU meter.
    meter_right: VuMeter,

    // ── Output Enable (Track Enable/Disable) ──────────────────────────
    /// Whether this track's output is routed into the audio graph.
    /// When `false`, the strip still processes gain/pan/metering normally
    /// (so meters stay alive), but the driver skips summing it into the
    /// graph output. This is the "track enable/disable" semantic —
    /// distinct from the old mute, which zeroed the signal before metering.
    output_enabled: bool,
}

impl ChannelStrip {
    /// Creates a new channel strip with unity volume and center pan.
    pub fn new() -> Self {
        Self {
            target_volume: 1.0,
            current_volume: 1.0,
            volume_smooth_coeff: GAIN_SMOOTH_COEFF,
            effective_gain: 1.0,
            target_pan: 0.0,
            current_pan: 0.0,
            pan_smooth_coeff: GAIN_SMOOTH_COEFF,
            pan_law: PanLaw::ConstantPower,
            meter_left: VuMeter::new(),
            meter_right: VuMeter::new(),
            output_enabled: true,
        }
    }

    /// Creates a channel strip with custom pan law.
    pub fn with_pan_law(pan_law: PanLaw) -> Self {
        Self {
            pan_law,
            ..Self::new()
        }
    }

    /// BUG-097 FIX: Creates a channel strip with smoothing tuned for the actual
    /// sample rate.  Without this, `new()` uses `GAIN_SMOOTH_COEFF` (hardcoded
    /// for 44.1kHz), producing 2× faster smoothing at 96kHz until
    /// `set_sample_rate()` is called.
    pub fn with_sample_rate(sample_rate: f32) -> Self {
        let mut strip = Self::new();
        strip.set_sample_rate(sample_rate);
        strip
    }

    // ── UI Thread Setters ──────────────────────────────────────────────

    /// Sets the target volume (called from UI thread).
    /// Volume is smoothly ramped to prevent clicks.
    #[inline]
    pub fn set_volume(&mut self, volume: f32) {
        // BUG-M5 FIX: Clamp upper bound to 12.0 (~+21.6 dB).
        // Previously only floored at 0.0, allowing Infinity or absurdly
        // large values that overflow smoothed gain multiplication → NaN.
        self.target_volume = volume.clamp(0.0, 12.0);
    }

    /// Sets the target pan position (called from UI thread).
    /// Pan is smoothly ramped to prevent clicks.
    #[inline]
    pub fn set_pan(&mut self, pan: f32) {
        self.target_pan = pan.clamp(-1.0, 1.0);
    }

    /// BUG-010 FIX: Recalculates smoothing coefficients for the given sample rate.
    ///
    /// Without this, the hardcoded `GAIN_SMOOTH_COEFF` (tuned for ~44.1kHz)
    /// produces 2x faster smoothing at 96kHz and 2x slower at 22.05kHz.
    #[inline]
    pub fn set_sample_rate(&mut self, sample_rate: f32) {
        use crate::gain::gain_smooth_coeff_for_sr;
        // 5ms smoothing time — matches the default GAIN_SMOOTH_COEFF at 44.1kHz
        let coeff = gain_smooth_coeff_for_sr(5.0, sample_rate);
        self.volume_smooth_coeff = coeff;
        self.pan_smooth_coeff = coeff;
    }

    /// Sets effective gain from mute/solo resolver.
    ///
    /// 1.0 = normal, 0.0 = fully silenced.
    #[inline]
    pub fn set_effective_gain(&mut self, gain: f32) {
        // BUG-M5 FIX: Clamp to [0.0, 1.0]. The solo/mute resolver only
        // emits 0.0 or 1.0, but defensive clamping prevents accidental
        // amplification from a future resolver change.
        self.effective_gain = gain.clamp(0.0, 1.0);
    }

    /// Enables or disables this track's output routing.
    ///
    /// When disabled, the strip still processes gain/pan/metering (meters
    /// stay alive and show gray in the UI), but the driver skips summing
    /// this track into the audio graph.
    #[inline]
    pub fn set_output_enabled(&mut self, enabled: bool) {
        self.output_enabled = enabled;
    }

    /// Returns whether this track's output is enabled (routed into graph).
    #[inline]
    pub fn is_output_enabled(&self) -> bool {
        self.output_enabled
    }

    // ── Audio Thread Processing ────────────────────────────────────────

    /// Processes a stereo buffer through the full signal chain.
    ///
    /// Applies: smoothed gain → smoothed pan → metering.
    ///
    /// # Real-Time Safety
    /// Real-time safe — no allocations, bounded iteration, no locks.
    ///
    /// # STRIKE-6 SIMD Optimization
    /// When volume has converged (steady state), uses `wide::f32x8`
    /// to apply gain as a bulk scalar multiply (8 samples per SIMD op).
    /// During transitions, falls back to per-sample IIR smoother.
    #[inline]
    pub fn process_stereo(&mut self, left: &mut [f32], right: &mut [f32]) {
        let len = left.len().min(right.len());
        if len == 0 {
            return;
        }

        // The strip always processes at the fader volume.
        // Output gating (enable/disable) is handled externally by the driver
        // at the graph summing phase, so meters remain alive on disabled tracks.
        let combined_target = self.target_volume * self.effective_gain;

        // ═══════════════════════════════════════════════════════════════
        // STRIKE-6 SIMD: Fast path when volume has converged.
        // During steady-state playback (not during fader drag), the
        // smoother has settled and every sample gets the same gain.
        // This lets us use SIMD bulk multiply instead of per-sample IIR.
        // ═══════════════════════════════════════════════════════════════
        let delta = (combined_target - self.current_volume).abs();
        // BUG-080 FIX: Relaxed from 1e-6 to 1e-4 (~-80dB, inaudible).
        // The old threshold was so tight that FP drift kept the strip
        // permanently in the slow IIR path; 1e-4 enables SIMD ~10× more often.
        if delta < 1e-4 {
            // Converged — snap to target and use SIMD bulk multiply.
            self.current_volume = combined_target;
            let gain = combined_target;

            // SIMD path: 8 samples per op using wide::f32x8.
            let gain_v = wide::f32x8::splat(gain);
            let chunks = len / 8;
            for i in 0..chunks {
                let offset = i * 8;
                let lv = wide::f32x8::from(&left[offset..offset + 8]);
                let rv = wide::f32x8::from(&right[offset..offset + 8]);
                let l_out = (lv * gain_v).to_array();
                let r_out = (rv * gain_v).to_array();
                left[offset..offset + 8].copy_from_slice(&l_out);
                right[offset..offset + 8].copy_from_slice(&r_out);
            }
            // Scalar tail (0-7 remaining samples).
            for i in (chunks * 8)..len {
                left[i] *= gain;
                right[i] *= gain;
            }
        } else {
            // Transitioning — per-sample IIR smoother (serial dependency).
            let coeff = self.volume_smooth_coeff;
            for i in 0..len {
                self.current_volume += (combined_target - self.current_volume) * coeff;
                left[i] *= self.current_volume;
                right[i] *= self.current_volume;
            }
        }

        // Apply smoothed panning
        apply_pan_smoothed(
            &mut left[..len],
            &mut right[..len],
            self.target_pan,
            &mut self.current_pan,
            self.pan_smooth_coeff,
            self.pan_law,
        );

        // Feed post-fader signal into meters
        self.meter_left.process(&left[..len]);
        self.meter_right.process(&right[..len]);
    }

    // ── Meter Readouts (UI Thread) ─────────────────────────────────────

    /// Returns the left channel peak level in dB.
    #[inline]
    pub fn left_peak_db(&self) -> f32 {
        self.meter_left.peak_db()
    }

    /// Returns the right channel peak level in dB.
    #[inline]
    pub fn right_peak_db(&self) -> f32 {
        self.meter_right.peak_db()
    }

    /// Returns the left channel RMS level in dB.
    #[inline]
    pub fn left_rms_db(&self) -> f32 {
        self.meter_left.rms_db()
    }

    /// Returns the right channel RMS level in dB.
    #[inline]
    pub fn right_rms_db(&self) -> f32 {
        self.meter_right.rms_db()
    }

    /// Returns the left channel peak linear (0.0–1.0+).
    #[inline]
    pub fn left_peak_linear(&self) -> f32 {
        self.meter_left.peak_linear()
    }

    /// Returns the right channel peak linear (0.0–1.0+).
    #[inline]
    pub fn right_peak_linear(&self) -> f32 {
        self.meter_right.peak_linear()
    }

    /// Whether either channel is clipping.
    #[inline]
    pub fn is_clipping(&self) -> bool {
        self.meter_left.is_clipping() || self.meter_right.is_clipping()
    }

    /// Resets all state (meters, smoothers).
    pub fn reset(&mut self) {
        self.current_volume = self.target_volume;
        self.current_pan = self.target_pan;
        self.effective_gain = 1.0;
        self.meter_left.reset();
        self.meter_right.reset();
    }

    /// Returns the current smoothed volume (for UI display).
    #[inline]
    pub fn current_volume(&self) -> f32 {
        self.current_volume
    }

    /// Returns the current smoothed pan (for UI display).
    #[inline]
    pub fn current_pan(&self) -> f32 {
        self.current_pan
    }
}

impl Default for ChannelStrip {
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

    fn stereo_sine(amplitude: f32, len: usize) -> (Vec<f32>, Vec<f32>) {
        let left: Vec<f32> = (0..len)
            .map(|i| (i as f32 * std::f32::consts::TAU / 100.0).sin() * amplitude)
            .collect();
        let right = left.clone();
        (left, right)
    }

    #[test]
    fn unity_passthrough() {
        let mut strip = ChannelStrip::new();
        let (mut left, mut right) = stereo_sine(0.5, 512);
        let original_left = left.clone();

        strip.process_stereo(&mut left, &mut right);

        // At unity volume and center pan (constant power), samples are
        // scaled by ~0.707 due to pan law
        let mid = left[256];
        assert!(
            (mid.abs() - (original_left[256] * 0.707).abs()).abs() < 0.1,
            "Expected ~0.707× for center pan, got {mid}"
        );
    }

    #[test]
    fn volume_change_converges() {
        let mut strip = ChannelStrip::new();
        strip.set_volume(0.5);

        // Process many blocks to let smoothing converge
        for _ in 0..20 {
            let (mut left, mut right) = stereo_sine(1.0, 512);
            strip.process_stereo(&mut left, &mut right);
        }

        assert!(
            (strip.current_volume() - 0.5).abs() < 0.01,
            "Volume didn't converge: {}",
            strip.current_volume()
        );
    }

    #[test]
    fn output_enabled_flag_does_not_silence_strip() {
        // When output_enabled is false, the strip still processes audio
        // (gain, pan, metering). The driver handles output gating externally.
        let mut strip = ChannelStrip::new();
        assert!(strip.is_output_enabled());

        strip.set_output_enabled(false);
        assert!(!strip.is_output_enabled());

        // Process several blocks to let smoothing converge
        for _ in 0..10 {
            let (mut left, mut right) = stereo_sine(1.0, 512);
            strip.process_stereo(&mut left, &mut right);
        }

        // Output should NOT be silent — the strip processes normally
        let (mut left, mut right) = stereo_sine(1.0, 512);
        strip.process_stereo(&mut left, &mut right);

        let max_level = left.iter().map(|s| s.abs()).fold(0.0f32, f32::max);
        assert!(
            max_level > 0.1,
            "Disabled track strip should still produce audio, got {max_level}"
        );

        // Metering should still update
        assert!(
            strip.left_peak_linear() > 0.1,
            "Disabled track meter should still update"
        );
    }

    #[test]
    fn metering_updates() {
        let mut strip = ChannelStrip::new();
        let (mut left, mut right) = stereo_sine(0.8, 512);

        strip.process_stereo(&mut left, &mut right);

        assert!(strip.left_peak_linear() > 0.1, "Left meter not updated");
        assert!(strip.right_peak_linear() > 0.1, "Right meter not updated");
    }

    #[test]
    fn pan_hard_left() {
        let mut strip = ChannelStrip::new();
        strip.set_pan(-1.0);

        // Process enough to converge pan
        for _ in 0..20 {
            let (mut left, mut right) = stereo_sine(1.0, 512);
            strip.process_stereo(&mut left, &mut right);
        }

        let (mut left, mut right) = stereo_sine(1.0, 512);
        strip.process_stereo(&mut left, &mut right);

        let right_max = right.iter().map(|s| s.abs()).fold(0.0f32, f32::max);
        assert!(
            right_max < 0.05,
            "Right channel should be near-silent for hard-left pan, got {right_max}"
        );
    }

    #[test]
    fn reset_clears_state() {
        let mut strip = ChannelStrip::new();
        strip.set_volume(0.3);

        // Process to diverge from initial state
        let (mut left, mut right) = stereo_sine(1.0, 512);
        strip.process_stereo(&mut left, &mut right);

        strip.reset();

        assert!(
            (strip.current_volume() - 0.3).abs() < f32::EPSILON,
            "Reset should snap current to target"
        );
    }

    #[test]
    fn empty_buffer_is_safe() {
        let mut strip = ChannelStrip::new();
        let mut left: Vec<f32> = Vec::new();
        let mut right: Vec<f32> = Vec::new();
        strip.process_stereo(&mut left, &mut right);
        // Should not panic
    }

    #[test]
    fn clipping_detection() {
        let mut strip = ChannelStrip::new();
        strip.set_volume(3.0); // Intentionally over-drive

        for _ in 0..20 {
            let (mut left, mut right) = stereo_sine(1.0, 512);
            strip.process_stereo(&mut left, &mut right);
        }

        // After converging at 3× gain, the signal should clip
        assert!(strip.is_clipping(), "Should detect clipping at 3× gain");
    }
}
