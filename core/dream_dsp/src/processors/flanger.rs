// ═══════════════════════════════════════════════════════════════════════════
// Dream DAW — Flanger Processor
// ═══════════════════════════════════════════════════════════════════════════
//
// Through-zero capable flanger with LFO modulation and feedback.
//
// Architecture:
//   - Fractional delay line (linear interpolation)
//   - Sinusoidal LFO modulates delay time
//   - Feedback loop with sign inversion option
//
// Parameters:
//   0: Rate      (0.01–10 Hz, default 0.3)
//   1: Depth     (0–1, default 0.7)
//   2: Feedback  (-0.95 to 0.95, default 0.5)
//   3: Delay     (0.1–10 ms, default 2.0 ms) — center delay time
//   4: Mix       (0–1, default 0.5)
//
// Real-Time Safety: Pre-allocated delay buffer. O(N) per buffer.
//
// ═══════════════════════════════════════════════════════════════════════════

use crate::dsp_processor::DspProcessor;

/// Maximum delay in samples (≈ 10 ms at 192 kHz).
const MAX_DELAY_SAMPLES: usize = 2048;

pub struct FlangerProcessor {
    rate: f32,
    depth: f32,
    feedback: f32,
    delay_ms: f32,
    mix: f32,
    // Internal
    buffer_l: [f32; MAX_DELAY_SAMPLES],
    buffer_r: [f32; MAX_DELAY_SAMPLES],
    write_pos: usize,
    lfo_phase: f64,
    feedback_l: f32,
    feedback_r: f32,
    sample_rate: f32,
}

impl FlangerProcessor {
    pub fn new(sample_rate: f32) -> Self {
        Self {
            rate: 0.3,
            depth: 0.7,
            feedback: 0.5,
            delay_ms: 2.0,
            mix: 0.5,
            buffer_l: [0.0; MAX_DELAY_SAMPLES],
            buffer_r: [0.0; MAX_DELAY_SAMPLES],
            write_pos: 0,
            lfo_phase: 0.0,
            feedback_l: 0.0,
            feedback_r: 0.0,
            sample_rate,
        }
    }

    /// Read from delay buffer with fractional index (linear interpolation).
    #[inline]
    fn read_delay(buffer: &[f32; MAX_DELAY_SAMPLES], write_pos: usize, delay_samples: f32) -> f32 {
        let delay = delay_samples.max(0.0);
        let idx_f = write_pos as f32 - delay;
        let idx_floor = idx_f.floor() as i32;
        let frac = idx_f - idx_floor as f32;
        let i0 = idx_floor.rem_euclid(MAX_DELAY_SAMPLES as i32) as usize;
        let i1 = (i0 + 1) % MAX_DELAY_SAMPLES;
        buffer[i0] * (1.0 - frac) + buffer[i1] * frac
    }
}

impl DspProcessor for FlangerProcessor {
    fn process_stereo(&mut self, left: &mut [f32], right: &mut [f32], _sample_rate: f32) {
        let len = left.len().min(right.len());
        let sr = self.sample_rate;
        let lfo_inc = self.rate as f64 / sr as f64;
        let center_delay_samples = self.delay_ms * 0.001 * sr;

        for i in 0..len {
            // Sinusoidal LFO
            let lfo = (self.lfo_phase as f32 * std::f32::consts::TAU).sin();
            self.lfo_phase += lfo_inc;
            if self.lfo_phase >= 1.0 {
                self.lfo_phase -= 1.0;
            }

            // Modulated delay time
            let mod_delay = center_delay_samples * (1.0 + lfo * self.depth);
            let delay_samples = mod_delay.clamp(0.0, (MAX_DELAY_SAMPLES - 2) as f32);

            // Write input + feedback into delay buffer
            self.buffer_l[self.write_pos] = left[i] + self.feedback_l * self.feedback;
            self.buffer_r[self.write_pos] = right[i] + self.feedback_r * self.feedback;

            // Read delayed signal
            let delayed_l = Self::read_delay(&self.buffer_l, self.write_pos, delay_samples);
            let delayed_r = Self::read_delay(&self.buffer_r, self.write_pos, delay_samples);

            self.feedback_l = delayed_l;
            self.feedback_r = delayed_r;

            self.write_pos = (self.write_pos + 1) % MAX_DELAY_SAMPLES;

            // Mix
            left[i] = left[i] * (1.0 - self.mix) + delayed_l * self.mix;
            right[i] = right[i] * (1.0 - self.mix) + delayed_r * self.mix;
        }
    }

    fn set_param(&mut self, index: u8, value: f32) {
        match index {
            0 => self.rate = value.clamp(0.01, 10.0),
            1 => self.depth = value.clamp(0.0, 1.0),
            2 => self.feedback = value.clamp(-0.95, 0.95),
            3 => self.delay_ms = value.clamp(0.1, 10.0),
            4 => self.mix = value.clamp(0.0, 1.0),
            _ => {}
        }
    }

    fn reset(&mut self) {
        self.buffer_l = [0.0; MAX_DELAY_SAMPLES];
        self.buffer_r = [0.0; MAX_DELAY_SAMPLES];
        self.write_pos = 0;
        self.lfo_phase = 0.0;
        self.feedback_l = 0.0;
        self.feedback_r = 0.0;
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn flanger_processes_without_panic() {
        let mut proc = FlangerProcessor::new(44100.0);
        let mut left = vec![0.5f32; 1024];
        let mut right = vec![0.5f32; 1024];
        proc.process_stereo(&mut left, &mut right, 44100.0);
    }

    #[test]
    fn flanger_modifies_signal() {
        let mut proc = FlangerProcessor::new(44100.0);
        proc.set_param(4, 1.0); // full wet
        let sr = 44100.0;
        let mut left: Vec<f32> = (0..4096)
            .map(|i| (2.0 * std::f32::consts::PI * 440.0 * i as f32 / sr).sin())
            .collect();
        let original = left.clone();
        let mut right = left.clone();
        proc.process_stereo(&mut left, &mut right, sr);
        let diff: f32 = left.iter().zip(original.iter())
            .map(|(a, b)| (a - b).abs())
            .sum::<f32>() / left.len() as f32;
        assert!(diff > 0.001, "Flanger should modify signal, avg diff: {diff}");
    }
}
