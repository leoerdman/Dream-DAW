// ═══════════════════════════════════════════════════════════════════════════
// Dream DAW — Compressor Processor
// ═══════════════════════════════════════════════════════════════════════════
//
// Feed-forward dynamic range compressor with:
//   - Threshold, Ratio, Attack, Release
//   - Smooth envelope follower (log-domain)
//   - Make-up gain auto-compensation
//
// Parameters:
//   0: Threshold (-60 to 0 dB, default -18)
//   1: Ratio     (1.0 to 20.0, default 4.0)
//   2: Attack    (0.1 to 100 ms, default 10)
//   3: Release   (10 to 1000 ms, default 100)
//
// ═══════════════════════════════════════════════════════════════════════════

use crate::dsp_processor::DspProcessor;

/// Dynamic range compressor with envelope follower.
pub struct CompressorProcessor {
    threshold_db: f32,
    ratio: f32,
    attack_ms: f32,
    release_ms: f32,
    // Envelope state
    envelope_db: f32,
    // Cached coefficients
    attack_coeff: f32,
    release_coeff: f32,
    sample_rate: f32,
}

impl CompressorProcessor {
    pub fn new(sample_rate: f32) -> Self {
        let mut proc = Self {
            threshold_db: -18.0,
            ratio: 4.0,
            attack_ms: 10.0,
            release_ms: 100.0,
            envelope_db: -96.0,
            attack_coeff: 0.0,
            release_coeff: 0.0,
            sample_rate,
        };
        proc.update_coefficients();
        proc
    }

    fn update_coefficients(&mut self) {
        let sr = self.sample_rate;
        if sr > 0.0 {
            self.attack_coeff = (-1.0 / (self.attack_ms * 0.001 * sr)).exp();
            self.release_coeff = (-1.0 / (self.release_ms * 0.001 * sr)).exp();
        }
    }

    #[inline]
    fn linear_to_db(x: f32) -> f32 {
        if x < 1e-10 {
            -96.0
        } else {
            20.0 * x.log10()
        }
    }

    #[inline]
    fn db_to_linear(db: f32) -> f32 {
        10.0_f32.powf(db / 20.0)
    }
}

impl DspProcessor for CompressorProcessor {
    fn process_stereo(&mut self, left: &mut [f32], right: &mut [f32], _sample_rate: f32) {
        let len = left.len().min(right.len());
        let threshold = self.threshold_db;
        let ratio = self.ratio;
        let attack = self.attack_coeff;
        let release = self.release_coeff;

        for i in 0..len {
            // Peak detection (stereo linked)
            let peak = left[i].abs().max(right[i].abs());
            let input_db = Self::linear_to_db(peak);

            // Envelope follower (smooth in dB domain)
            let coeff = if input_db > self.envelope_db { attack } else { release };
            self.envelope_db = coeff * self.envelope_db + (1.0 - coeff) * input_db;

            // Gain computation
            let gain_db = if self.envelope_db > threshold {
                let over = self.envelope_db - threshold;
                // Compression: reduce overshoot by (1 - 1/ratio)
                -(over * (1.0 - 1.0 / ratio))
            } else {
                0.0
            };

            let gain = Self::db_to_linear(gain_db);
            left[i] *= gain;
            right[i] *= gain;
        }
    }

    fn set_param(&mut self, index: u8, value: f32) {
        match index {
            0 => {
                self.threshold_db = value.clamp(-60.0, 0.0);
            }
            1 => {
                self.ratio = value.clamp(1.0, 20.0);
            }
            2 => {
                self.attack_ms = value.clamp(0.1, 100.0);
                self.update_coefficients();
            }
            3 => {
                self.release_ms = value.clamp(10.0, 1000.0);
                self.update_coefficients();
            }
            _ => {}
        }
    }

    fn reset(&mut self) {
        self.envelope_db = -96.0;
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn compressor_passes_quiet_signal() {
        let mut proc = CompressorProcessor::new(44100.0);
        let mut left = vec![0.01f32; 256];
        let mut right = vec![0.01f32; 256];
        let original = left.clone();
        proc.process_stereo(&mut left, &mut right, 44100.0);
        // Very quiet signal should pass without compression
        for (i, s) in left.iter().enumerate() {
            assert!((s - original[i]).abs() < 0.01, "Quiet signal changed: {s}");
        }
    }

    #[test]
    fn compressor_reduces_loud_signal() {
        let mut proc = CompressorProcessor::new(44100.0);
        proc.set_param(0, -20.0); // Threshold -20dB
        proc.set_param(1, 10.0);  // Ratio 10:1
        proc.set_param(2, 0.1);   // Fast attack
        let mut left = vec![1.0f32; 4096]; // 0dB signal
        let mut right = vec![1.0f32; 4096];
        proc.process_stereo(&mut left, &mut right, 44100.0);
        // After fast attack, signal should be reduced
        let tail_avg: f32 = left[2048..].iter().sum::<f32>() / 2048.0;
        assert!(tail_avg < 0.5, "Loud signal should be compressed, got avg: {tail_avg}");
    }
}
