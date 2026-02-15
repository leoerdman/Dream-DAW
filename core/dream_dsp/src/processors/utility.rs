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
}

impl UtilityProcessor {
    pub fn new() -> Self {
        Self {
            gain_db: 0.0,
            current_gain: 1.0,
            target_gain: 1.0,
            pan: 0.0,
            width: 1.0,
            mono: false,
            // ~5ms smoothing at 44.1kHz
            smooth_coeff: 0.993,
        }
    }

    #[inline]
    fn db_to_linear(db: f32) -> f32 {
        if db <= -60.0 {
            0.0
        } else {
            10.0_f32.powf(db / 20.0)
        }
    }
}

impl Default for UtilityProcessor {
    fn default() -> Self {
        Self::new()
    }
}

impl DspProcessor for UtilityProcessor {
    fn process_stereo(&mut self, left: &mut [f32], right: &mut [f32], _sample_rate: f32) {
        let len = left.len().min(right.len());
        let coeff = self.smooth_coeff;

        // Pre-compute pan gains (constant power panning)
        let pan_angle = (self.pan + 1.0) * 0.25 * std::f32::consts::PI;
        let pan_l = pan_angle.cos();
        let pan_r = pan_angle.sin();

        // Width coefficients (Mid/Side encoding)
        let mid_coeff = 1.0;
        let side_coeff = self.width;

        for i in 0..len {
            // Smooth gain (exponential one-pole)
            self.current_gain = coeff * self.current_gain + (1.0 - coeff) * self.target_gain;

            let mut l = left[i] * self.current_gain;
            let mut r = right[i] * self.current_gain;

            // Mono collapse
            if self.mono {
                let mono_sample = (l + r) * 0.5;
                l = mono_sample;
                r = mono_sample;
            } else if (self.width - 1.0).abs() > 0.001 {
                // Mid/Side width processing
                let mid = (l + r) * 0.5 * mid_coeff;
                let side = (l - r) * 0.5 * side_coeff;
                l = mid + side;
                r = mid - side;
            }

            // Apply pan
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
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn utility_unity_passthrough() {
        let mut proc = UtilityProcessor::new();
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
        let mut proc = UtilityProcessor::new();
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
        let mut proc = UtilityProcessor::new();
        proc.set_param(3, 1.0); // Mono ON
        proc.current_gain = 1.0;
        let mut left = vec![1.0f32; 64];
        let mut right = vec![-1.0f32; 64];
        proc.process_stereo(&mut left, &mut right, 44100.0);
        // Mid = (1 + -1) / 2 = 0, so both channels should be ~0
        for i in 0..64 {
            assert!(left[i].abs() < 0.01, "Mono collapse failed L: {}", left[i]);
            assert!(
                right[i].abs() < 0.01,
                "Mono collapse failed R: {}",
                right[i]
            );
        }
    }
}
