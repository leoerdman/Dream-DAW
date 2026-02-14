// ═══════════════════════════════════════════════════════════════════════════
// Dream DAW — Limiter Processor
// ═══════════════════════════════════════════════════════════════════════════
//
// Brick-wall look-ahead limiter with configurable release.
//
// Uses a 1 ms look-ahead ring buffer so the gain envelope can
// anticipate peaks and apply gain reduction *before* the peak arrives,
// eliminating overshoot.
//
// Parameters:
//   0: Threshold  (-30 to 0 dB, default -0.3 dB)
//   1: Release    (1 to 1000 ms, default 100 ms)
//   2: Ceiling    (-30 to 0 dB, default -0.1 dB)
//
// Real-Time Safety: Pre-allocated delay line. O(N) per buffer.
//
// ═══════════════════════════════════════════════════════════════════════════

use crate::dsp_processor::DspProcessor;

/// Maximum look-ahead in samples (≈ 1 ms at 48 kHz).
const MAX_LOOKAHEAD: usize = 64;

pub struct LimiterProcessor {
    threshold_db: f32,
    release_ms: f32,
    ceiling_db: f32,
    // Derived
    threshold_lin: f32,
    ceiling_lin: f32,
    release_coeff: f32,
    sample_rate: f32,
    // Look-ahead delay lines (pre-allocated)
    delay_left: [f32; MAX_LOOKAHEAD],
    delay_right: [f32; MAX_LOOKAHEAD],
    delay_pos: usize,
    lookahead_samples: usize,
    // Gain envelope
    envelope: f32,
}

impl LimiterProcessor {
    pub fn new(sample_rate: f32) -> Self {
        let lookahead_samples = ((sample_rate * 0.001) as usize).min(MAX_LOOKAHEAD);
        let mut proc = Self {
            threshold_db: -0.3,
            release_ms: 100.0,
            ceiling_db: -0.1,
            threshold_lin: Self::db_to_lin(-0.3),
            ceiling_lin: Self::db_to_lin(-0.1),
            release_coeff: 0.0,
            sample_rate,
            delay_left: [0.0; MAX_LOOKAHEAD],
            delay_right: [0.0; MAX_LOOKAHEAD],
            delay_pos: 0,
            lookahead_samples,
            envelope: 0.0,
        };
        proc.update_release();
        proc
    }

    #[inline]
    fn db_to_lin(db: f32) -> f32 {
        10.0_f32.powf(db / 20.0)
    }

    fn update_release(&mut self) {
        if self.sample_rate > 0.0 {
            self.release_coeff = (-1.0 / (self.release_ms * 0.001 * self.sample_rate)).exp();
        }
    }
}

impl DspProcessor for LimiterProcessor {
    fn process_stereo(&mut self, left: &mut [f32], right: &mut [f32], _sample_rate: f32) {
        let len = left.len().min(right.len());
        let la = self.lookahead_samples.max(1);
        let thresh = self.threshold_lin;
        let ceiling = self.ceiling_lin;
        let release = self.release_coeff;

        for i in 0..len {
            // Write current sample into delay line
            let dpos = self.delay_pos % la;
            let delayed_l = self.delay_left[dpos];
            let delayed_r = self.delay_right[dpos];
            self.delay_left[dpos] = left[i];
            self.delay_right[dpos] = right[i];
            self.delay_pos = self.delay_pos.wrapping_add(1);

            // Peak detection on incoming (pre-delay) signal
            let peak = left[i].abs().max(right[i].abs());

            // Compute required gain reduction
            let target_gain = if peak > thresh {
                thresh / peak
            } else {
                1.0
            };
            let target_env = 1.0 - target_gain;

            // Envelope: instant attack, smooth release
            if target_env > self.envelope {
                self.envelope = target_env; // instant attack
            } else {
                self.envelope = release * self.envelope + (1.0 - release) * target_env;
            }

            let gain = (1.0 - self.envelope) * (ceiling / thresh.max(1e-10));

            // Output delayed samples with gain applied
            left[i] = delayed_l * gain;
            right[i] = delayed_r * gain;
        }
    }

    fn set_param(&mut self, index: u8, value: f32) {
        match index {
            0 => {
                self.threshold_db = value.clamp(-30.0, 0.0);
                self.threshold_lin = Self::db_to_lin(self.threshold_db);
            }
            1 => {
                self.release_ms = value.clamp(1.0, 1000.0);
                self.update_release();
            }
            2 => {
                self.ceiling_db = value.clamp(-30.0, 0.0);
                self.ceiling_lin = Self::db_to_lin(self.ceiling_db);
            }
            _ => {}
        }
    }

    fn reset(&mut self) {
        self.delay_left = [0.0; MAX_LOOKAHEAD];
        self.delay_right = [0.0; MAX_LOOKAHEAD];
        self.delay_pos = 0;
        self.envelope = 0.0;
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn limiter_prevents_clipping() {
        let mut proc = LimiterProcessor::new(44100.0);
        proc.set_param(0, -6.0); // threshold -6 dB
        proc.set_param(2, -0.1); // ceiling -0.1 dB
        // Feed loud signal through delay warmup + limiting
        let mut left = vec![1.0f32; 2048];
        let mut right = vec![1.0f32; 2048];
        proc.process_stereo(&mut left, &mut right, 44100.0);
        // After lookahead + attack, all output should be below ceiling
        let ceiling_lin = 10.0_f32.powf(-0.1 / 20.0);
        for s in &left[128..] {
            assert!(s.abs() <= ceiling_lin + 0.05, "Sample exceeds ceiling: {s}");
        }
    }

    #[test]
    fn limiter_passes_quiet_signal() {
        let mut proc = LimiterProcessor::new(44100.0);
        let mut left = vec![0.01f32; 512];
        let mut right = vec![0.01f32; 512];
        proc.process_stereo(&mut left, &mut right, 44100.0);
        // Very quiet signal should mostly pass through (after delay)
        let max_out = left.iter().map(|s| s.abs()).fold(0.0f32, f32::max);
        assert!(max_out < 0.05, "Quiet signal changed too much: {max_out}");
    }
}
