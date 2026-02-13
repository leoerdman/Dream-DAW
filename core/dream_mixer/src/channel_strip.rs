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

use crate::gain::{apply_gain_smoothed, GAIN_SMOOTH_COEFF};
use crate::meter::VuMeter;
use crate::pan::{apply_pan_smoothed, PanLaw};

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

    // ── Mute/Solo multiplier ───────────────────────────────────────────

    /// Effective gain multiplier from solo/mute logic (0.0 or 1.0).
    /// Set externally by the `SoloResolver`.
    effective_gain: f32,
}

impl ChannelStrip {
    /// Creates a new channel strip with unity volume and center pan.
    pub fn new() -> Self {
        Self {
            target_volume: 1.0,
            current_volume: 1.0,
            volume_smooth_coeff: GAIN_SMOOTH_COEFF,
            target_pan: 0.0,
            current_pan: 0.0,
            pan_smooth_coeff: GAIN_SMOOTH_COEFF,
            pan_law: PanLaw::ConstantPower,
            meter_left: VuMeter::new(),
            meter_right: VuMeter::new(),
            effective_gain: 1.0,
        }
    }

    /// Creates a channel strip with custom pan law.
    pub fn with_pan_law(pan_law: PanLaw) -> Self {
        Self {
            pan_law,
            ..Self::new()
        }
    }

    // ── UI Thread Setters ──────────────────────────────────────────────

    /// Sets the target volume (called from UI thread).
    /// Volume is smoothly ramped to prevent clicks.
    #[inline]
    pub fn set_volume(&mut self, volume: f32) {
        self.target_volume = volume.max(0.0);
    }

    /// Sets the target pan position (called from UI thread).
    /// Pan is smoothly ramped to prevent clicks.
    #[inline]
    pub fn set_pan(&mut self, pan: f32) {
        self.target_pan = pan.clamp(-1.0, 1.0);
    }

    /// Sets the effective gain multiplier from solo/mute logic.
    /// This is typically 0.0 (muted by solo) or 1.0 (audible).
    #[inline]
    pub fn set_effective_gain(&mut self, gain: f32) {
        self.effective_gain = gain;
    }

    // ── Audio Thread Processing ────────────────────────────────────────

    /// Processes a stereo buffer through the full signal chain.
    ///
    /// Applies: smoothed gain → smoothed pan → metering.
    ///
    /// # Real-Time Safety
    /// Real-time safe — no allocations, bounded iteration, no locks.
    #[inline]
    pub fn process_stereo(&mut self, left: &mut [f32], right: &mut [f32]) {
        let len = left.len().min(right.len());
        if len == 0 {
            return;
        }

        // Combined target = fader volume × solo/mute multiplier
        let combined_target = self.target_volume * self.effective_gain;

        // Apply smoothed gain to both channels
        apply_gain_smoothed(
            &mut left[..len],
            combined_target,
            &mut self.current_volume,
            self.volume_smooth_coeff,
        );

        // For right channel, we create a shadow smoother that tracks
        // the same target (the left smoother already moved current_volume).
        // We use the already-converged current_volume as a constant gain.
        let right_gain = self.current_volume;
        for sample in right[..len].iter_mut() {
            *sample *= right_gain;
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
    fn mute_via_effective_gain() {
        let mut strip = ChannelStrip::new();
        strip.set_effective_gain(0.0);

        for _ in 0..10 {
            let (mut left, mut right) = stereo_sine(1.0, 512);
            strip.process_stereo(&mut left, &mut right);
        }

        // After convergence, output should be near-silent
        let (mut left, mut right) = stereo_sine(1.0, 512);
        strip.process_stereo(&mut left, &mut right);

        let max_level = left.iter().map(|s| s.abs()).fold(0.0f32, f32::max);
        assert!(
            max_level < 0.01,
            "Expected silence when effective_gain=0, got {max_level}"
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
