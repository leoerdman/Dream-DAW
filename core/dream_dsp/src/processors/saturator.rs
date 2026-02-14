// ═══════════════════════════════════════════════════════════════════════════
// Dream DAW — Saturator Processor
// ═══════════════════════════════════════════════════════════════════════════
//
// Soft-clipping saturator with tanh waveshaping:
//   - Drive (input gain before saturation)
//   - Tone (post-saturation lowpass to tame harsh harmonics)
//   - Mix (parallel dry/wet blend)
//
// Parameters:
//   0: Drive (0 to 36 dB, default 6)
//   1: Tone  (0 to 100 %, default 50) — lowpass cutoff 1kHz..20kHz
//   2: Mix   (0 to 100 %, default 50)
//
// ═══════════════════════════════════════════════════════════════════════════

use crate::dsp_processor::DspProcessor;

/// One-pole lowpass filter for tone control (zero-alloc).
struct OnePole {
    state: f32,
    coeff: f32,
}

impl OnePole {
    fn new(cutoff: f32, sample_rate: f32) -> Self {
        Self {
            state: 0.0,
            coeff: Self::compute_coeff(cutoff, sample_rate),
        }
    }

    fn compute_coeff(cutoff: f32, sample_rate: f32) -> f32 {
        let w = (std::f32::consts::TAU * cutoff / sample_rate).min(0.99);
        1.0 - (-w).exp()
    }

    #[inline]
    fn process(&mut self, input: f32) -> f32 {
        self.state += self.coeff * (input - self.state);
        self.state
    }

    fn set_cutoff(&mut self, cutoff: f32, sample_rate: f32) {
        self.coeff = Self::compute_coeff(cutoff, sample_rate);
    }

    fn reset(&mut self) {
        self.state = 0.0;
    }
}

pub struct SaturatorProcessor {
    drive_db: f32,
    drive_linear: f32,
    tone_pct: f32,
    mix: f32,
    tone_l: OnePole,
    tone_r: OnePole,
    sample_rate: f32,
}

impl SaturatorProcessor {
    pub fn new() -> Self {
        let sr = 44100.0;
        let cutoff = Self::tone_to_cutoff(50.0);
        Self {
            drive_db: 6.0,
            drive_linear: 10.0_f32.powf(6.0 / 20.0),
            tone_pct: 50.0,
            mix: 0.5,
            tone_l: OnePole::new(cutoff, sr),
            tone_r: OnePole::new(cutoff, sr),
            sample_rate: sr,
        }
    }

    /// Maps tone percentage (0–100) to lowpass cutoff (1kHz–20kHz, log scale).
    fn tone_to_cutoff(pct: f32) -> f32 {
        let min_hz = 1000.0_f32;
        let max_hz = 20000.0_f32;
        let t = pct / 100.0;
        min_hz * (max_hz / min_hz).powf(t)
    }

    /// Soft clip a sample using tanh.
    #[inline]
    fn soft_clip(x: f32) -> f32 {
        x.tanh()
    }
}

impl Default for SaturatorProcessor {
    fn default() -> Self {
        Self::new()
    }
}

impl DspProcessor for SaturatorProcessor {
    fn process_stereo(&mut self, left: &mut [f32], right: &mut [f32], sample_rate: f32) {
        if (sample_rate - self.sample_rate).abs() > 1.0 {
            self.sample_rate = sample_rate;
            let cutoff = Self::tone_to_cutoff(self.tone_pct);
            self.tone_l.set_cutoff(cutoff, sample_rate);
            self.tone_r.set_cutoff(cutoff, sample_rate);
        }

        let len = left.len().min(right.len());
        let drive = self.drive_linear;
        let wet = self.mix;
        let dry = 1.0 - wet;

        for i in 0..len {
            let dry_l = left[i];
            let dry_r = right[i];

            // Apply drive (pre-gain)
            let driven_l = dry_l * drive;
            let driven_r = dry_r * drive;

            // Soft clipping
            let clipped_l = Self::soft_clip(driven_l);
            let clipped_r = Self::soft_clip(driven_r);

            // Tone filter (smooth harsh harmonics)
            let filtered_l = self.tone_l.process(clipped_l);
            let filtered_r = self.tone_r.process(clipped_r);

            // Mix
            left[i] = dry_l * dry + filtered_l * wet;
            right[i] = dry_r * dry + filtered_r * wet;
        }
    }

    fn set_param(&mut self, index: u8, value: f32) {
        match index {
            0 => {
                // Drive (dB)
                self.drive_db = value.clamp(0.0, 36.0);
                self.drive_linear = 10.0_f32.powf(self.drive_db / 20.0);
            }
            1 => {
                // Tone (%)
                self.tone_pct = value.clamp(0.0, 100.0);
                let cutoff = Self::tone_to_cutoff(self.tone_pct);
                self.tone_l.set_cutoff(cutoff, self.sample_rate);
                self.tone_r.set_cutoff(cutoff, self.sample_rate);
            }
            2 => {
                // Mix (%)
                self.mix = (value / 100.0).clamp(0.0, 1.0);
            }
            _ => {}
        }
    }

    fn reset(&mut self) {
        self.tone_l.reset();
        self.tone_r.reset();
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn saturator_clips_loud_signal() {
        let mut proc = SaturatorProcessor::new();
        proc.set_param(0, 24.0); // High drive
        proc.set_param(2, 100.0); // Fully wet

        let mut left = vec![1.0f32; 256];
        let mut right = vec![1.0f32; 256];
        proc.process_stereo(&mut left, &mut right, 44100.0);

        // tanh(10^(24/20)) ≈ tanh(15.85) ≈ 1.0
        // Signal should be limited near 1.0
        for s in &left {
            assert!(s.abs() <= 1.01, "Saturator should soft-clip: {s}");
        }
    }

    #[test]
    fn saturator_zero_drive_passthrough() {
        let mut proc = SaturatorProcessor::new();
        proc.set_param(0, 0.0);   // 0dB drive = unity
        proc.set_param(1, 100.0); // Full tone (20kHz, nearly transparent)
        proc.set_param(2, 100.0); // Full wet

        let mut left = vec![0.3f32; 1024];
        let mut right = vec![0.3f32; 1024];
        proc.process_stereo(&mut left, &mut right, 44100.0);

        // tanh(0.3) ≈ 0.2913
        // After tone filter settles, should be close
        let tail_avg: f32 = left[512..].iter().sum::<f32>() / 512.0;
        assert!((tail_avg - 0.291).abs() < 0.05, "Expected ~0.29, got: {tail_avg}");
    }
}
