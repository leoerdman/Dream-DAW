// ═══════════════════════════════════════════════════════════════════════════
// Dream DAW — Utility Processor
// ═══════════════════════════════════════════════════════════════════════════
//
// A simple but essential signal conditioning tool:
//   - Gain (dB)
//   - Pan (stereo balance)
//   - Width (stereo field width: 0% = mono, 100% = normal, 200% = wide)
//   - Mono switch (collapse to mono)
//
// Parameters:
//   0: Gain   (-60.0 to +24.0 dB, default 0.0)
//   1: Pan    (-100 to +100 %, default 0)
//   2: Width  (0 to 200 %, default 100)
//   3: Mono   (0.0 = off, 1.0 = on, default 0.0)
//
// Real-Time Safety: Zero allocations. O(N) per buffer.
//
// ═══════════════════════════════════════════════════════════════════════════

use crate::dsp_processor::DspProcessor;
use crate::processors::{db_to_linear as db_to_linear_fast, sanitize_sample_rate, DEFAULT_SAMPLE_RATE};
use crate::processors::smoothing::SmoothedValue;

/// Utility processor — gain, pan, width, mono.
pub struct UtilityProcessor {
    /// Gain in dB (-60..+24)
    gain_db: f32,
    /// Current smoothed linear gain (avoids clicks on gain changes)
    current_gain: f32,
    /// Target linear gain
    target_gain: f32,
    /// Pan (-1.0 = hard left, 0.0 = center, 1.0 = hard right)
    pan: f32,
    /// Stereo width (0.0 = mono, 1.0 = normal, 2.0 = extra wide)
    width: f32,
    /// Mono switch
    mono: bool,
    /// Smoothing coefficient (per-sample)
    smooth_coeff: f32,
    /// Cached sample rate
    sample_rate: f32,
    pan_sm: SmoothedValue,
    width_sm: SmoothedValue,
    mono_sm: SmoothedValue,
}

impl UtilityProcessor {
    /// BUG-28 FIX: Accept `sample_rate` parameter instead of hardcoding 44100 Hz.
    pub fn new(sample_rate: f32) -> Self {
        let sr = sanitize_sample_rate(sample_rate);
        Self {
            gain_db: 0.0,
            current_gain: 1.0,
            target_gain: 1.0,
            pan: 0.0,
            width: 1.0,
            mono: false,
            // ~5ms smoothing derived from actual sample rate
            smooth_coeff: (-1.0 / (0.005 * sr)).exp(),
            sample_rate: sr,
            pan_sm: SmoothedValue::new(sr, 8.0, 0.0),
            width_sm: SmoothedValue::new(sr, 8.0, 1.0),
            mono_sm: SmoothedValue::new(sr, 6.0, 0.0),
        }
    }

    #[inline]
    fn db_to_linear(db: f32) -> f32 {
        if db <= -60.0 {
            0.0
        } else {
            db_to_linear_fast(db)
        }
    }
}

impl Default for UtilityProcessor {
    fn default() -> Self {
        Self::new(DEFAULT_SAMPLE_RATE)
    }
}

impl DspProcessor for UtilityProcessor {
    fn process_stereo(&mut self, left: &mut [f32], right: &mut [f32], sample_rate: f32) {
        // Sync sample rate & recalculate coefficient
        let sr = sanitize_sample_rate(sample_rate);
        if (sr - self.sample_rate).abs() > 0.5 {
            self.sample_rate = sr;
            self.smooth_coeff = (-1.0 / (0.005 * sr)).exp();
            self.pan_sm.set_sample_rate(sr);
            self.width_sm.set_sample_rate(sr);
            self.mono_sm.set_sample_rate(sr);
        }
        let len = left.len().min(right.len());
        let coeff = self.smooth_coeff;
        self.pan_sm.set_target(self.pan.clamp(-1.0, 1.0));
        self.width_sm.set_target(self.width.clamp(0.0, 2.0));
        self.mono_sm.set_target(if self.mono { 1.0 } else { 0.0 });

        for i in 0..len {
            // Smooth gain (exponential one-pole)
            self.current_gain = coeff * self.current_gain + (1.0 - coeff) * self.target_gain;
            // BUG-H20 FIX: Flush denormals in gain smoothing state.
            crate::processors::flush_denormal!(self.current_gain);
            let pan = self.pan_sm.next_value();
            let width = self.width_sm.next_value();
            let mono_mix = self.mono_sm.next_value().clamp(0.0, 1.0);

            let mut l = left[i] * self.current_gain;
            let mut r = right[i] * self.current_gain;

            // Mid/Side width processing with smoothed width.
            let mid = (l + r) * 0.5;
            let side = (l - r) * 0.5 * width;
            let width_l = mid + side;
            let width_r = mid - side;
            // Mono blend is smoothed to avoid clicks on toggle automation.
            let mono_sample = (width_l + width_r) * 0.5;
            l = width_l * (1.0 - mono_mix) + mono_sample * mono_mix;
            r = width_r * (1.0 - mono_mix) + mono_sample * mono_mix;

            // Apply smoothed constant-power pan.
            let pan_angle = (pan + 1.0) * 0.25 * std::f32::consts::PI;
            let pan_l = pan_angle.cos();
            let pan_r = pan_angle.sin();
            left[i] = l * pan_l * std::f32::consts::SQRT_2;
            right[i] = r * pan_r * std::f32::consts::SQRT_2;
        }
    }

    fn set_param(&mut self, index: u8, value: f32) {
        match index {
            0 => {
                // Gain (dB)
                self.gain_db = value.clamp(-60.0, 24.0);
                self.target_gain = Self::db_to_linear(self.gain_db);
            }
            1 => {
                // Pan (% → -1..1)
                self.pan = (value / 100.0).clamp(-1.0, 1.0);
            }
            2 => {
                // Width (% → 0..2)
                self.width = (value / 100.0).clamp(0.0, 2.0);
            }
            3 => {
                // Mono (0 or 1)
                self.mono = value > 0.5;
            }
            _ => {}
        }
    }

    fn reset(&mut self) {
        self.current_gain = self.target_gain;
        self.pan_sm.set_instant(self.pan.clamp(-1.0, 1.0));
        self.width_sm.set_instant(self.width.clamp(0.0, 2.0));
        self.mono_sm.set_instant(if self.mono { 1.0 } else { 0.0 });
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn utility_unity_passthrough() {
        let mut proc = UtilityProcessor::new(44100.0);
        proc.current_gain = 1.0; // Skip smoothing
        let mut left = vec![0.5f32; 64];
        let mut right = vec![0.5f32; 64];
        proc.process_stereo(&mut left, &mut right, 44100.0);
        // At center pan, constant-power should preserve level approximately
        for s in &left {
            assert!(s.abs() > 0.3 && s.abs() < 0.8, "Unexpected level: {s}");
        }
    }

    #[test]
    fn utility_mute_at_minus_60() {
        let mut proc = UtilityProcessor::new(44100.0);
        proc.set_param(0, -60.0);
        proc.current_gain = proc.target_gain; // Skip smoothing
        let mut left = vec![1.0f32; 64];
        let mut right = vec![1.0f32; 64];
        proc.process_stereo(&mut left, &mut right, 44100.0);
        for s in &left {
            assert!(s.abs() < 0.001, "Should be silent at -60dB, got: {s}");
        }
    }

    #[test]
    fn utility_mono_collapses_stereo() {
        let mut proc = UtilityProcessor::new(44100.0);
        proc.set_param(3, 1.0); // Mono ON
        proc.current_gain = 1.0;
        let mut left = vec![1.0f32; 2048];
        let mut right = vec![-1.0f32; 2048];
        proc.process_stereo(&mut left, &mut right, 44100.0);
        // Mono switch is smoothed, so validate settled tail.
        for i in 1536..2048 {
            assert!(left[i].abs() < 0.01, "Mono collapse failed L: {}", left[i]);
            assert!(
                right[i].abs() < 0.01,
                "Mono collapse failed R: {}",
                right[i]
            );
        }
    }
}
