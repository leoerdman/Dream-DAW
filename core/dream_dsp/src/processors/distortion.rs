// ═══════════════════════════════════════════════════════════════════════════
// Dream DAW — Distortion / Amp Processor
// ═══════════════════════════════════════════════════════════════════════════
//
// Multi-mode distortion with tone shaping and dry/wet mix.
// Modes: Overdrive(0), Crunch(1), Lead(2), Fuzz(3)
//
// Params: 0=Drive(0–100), 1=Tone(0–1), 2=Mix(0–1), 3=Mode(0–3)
//
// ═══════════════════════════════════════════════════════════════════════════

use crate::dsp_processor::DspProcessor;

pub struct DistortionProcessor {
    drive: f32,
    tone: f32,
    mix: f32,
    mode: u8,
    tone_state_l: f32,
    tone_state_r: f32,
}

impl DistortionProcessor {
    pub fn new() -> Self {
        Self { drive: 30.0, tone: 0.5, mix: 1.0, mode: 0, tone_state_l: 0.0, tone_state_r: 0.0 }
    }

    #[inline]
    fn waveshape(sample: f32, drive: f32, mode: u8) -> f32 {
        let driven = sample * (1.0 + drive * 0.5);
        match mode {
            0 => driven.tanh(),
            1 => {
                let x = driven.clamp(-2.0, 2.0);
                if x >= 0.0 { 1.0 - (1.0 - x.min(1.0)).powi(3) }
                else { -1.0 + (1.0 - (-x).min(1.0)).powi(2) }
            }
            2 => {
                let clipped = driven.clamp(-1.0, 1.0);
                clipped - (driven - clipped) * 0.3
            }
            3 => {
                let shaped = driven.signum() * (1.0 - (-driven.abs() * 3.0).exp());
                shaped * 0.7 + driven.abs().min(1.0) * 0.3 * driven.signum()
            }
            _ => driven.tanh(),
        }
    }
}

impl DspProcessor for DistortionProcessor {
    fn process_stereo(&mut self, left: &mut [f32], right: &mut [f32], sample_rate: f32) {
        let len = left.len().min(right.len());
        let tone_freq = 500.0 + self.tone * 15000.0;
        let tone_coeff = (std::f32::consts::TAU * tone_freq / sample_rate).min(1.0);
        let comp = 1.0 / (1.0 + self.drive * 0.1).sqrt();

        for i in 0..len {
            let (dry_l, dry_r) = (left[i], right[i]);
            let mut wet_l = Self::waveshape(dry_l, self.drive, self.mode);
            let mut wet_r = Self::waveshape(dry_r, self.drive, self.mode);
            // Tone filter (one-pole LP)
            self.tone_state_l += tone_coeff * (wet_l - self.tone_state_l);
            self.tone_state_r += tone_coeff * (wet_r - self.tone_state_r);
            wet_l = self.tone_state_l * comp;
            wet_r = self.tone_state_r * comp;
            left[i] = dry_l * (1.0 - self.mix) + wet_l * self.mix;
            right[i] = dry_r * (1.0 - self.mix) + wet_r * self.mix;
        }
    }

    fn set_param(&mut self, index: u8, value: f32) {
        match index {
            0 => self.drive = value.clamp(0.0, 100.0),
            1 => self.tone = value.clamp(0.0, 1.0),
            2 => self.mix = value.clamp(0.0, 1.0),
            3 => self.mode = (value as u8).min(3),
            _ => {}
        }
    }

    fn reset(&mut self) {
        self.tone_state_l = 0.0;
        self.tone_state_r = 0.0;
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn distortion_clips_loud_signal() {
        let mut proc = DistortionProcessor::new();
        proc.set_param(0, 80.0);
        proc.set_param(2, 1.0);
        let mut left = vec![0.8f32; 2048];
        let mut right = vec![0.8f32; 2048];
        proc.process_stereo(&mut left, &mut right, 44100.0);
        let max_out = left.iter().map(|s| s.abs()).fold(0.0f32, f32::max);
        assert!(max_out < 2.0, "Distortion output too hot: {max_out}");
    }

    #[test]
    fn all_modes_work() {
        for mode in 0..=3u8 {
            let mut proc = DistortionProcessor::new();
            proc.set_param(3, mode as f32);
            proc.set_param(0, 50.0);
            let mut left = vec![0.5f32; 512];
            let mut right = vec![0.5f32; 512];
            proc.process_stereo(&mut left, &mut right, 44100.0);
        }
    }
}
