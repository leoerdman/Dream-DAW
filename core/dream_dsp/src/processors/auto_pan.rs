// ═══════════════════════════════════════════════════════════════════════════
// Dream DAW — Auto Pan Processor
// ═══════════════════════════════════════════════════════════════════════════
//
// Stereo auto-pan / tremolo style modulation:
//   - Rate, depth, phase offset, waveform shape, and dry/wet mix
//   - Supports sine, triangle, saw-up, saw-down and square shapes
//   - Constant-power panning law between channels
//
// Parameters:
//   0: Rate   (0.01–20 Hz, default 1.0)
//   1: Depth  (0–100%, default 70)
//   2: Phase  (0–180 deg, default 180)
//   3: Shape  (0..4, default 0)
//   4: Mix    (0–100%, default 100)
//
// Real-Time Safety: zero allocations, O(N) per block.
//
// ═══════════════════════════════════════════════════════════════════════════

use crate::dsp_processor::DspProcessor;

pub struct AutoPanProcessor {
    rate_hz: f32,
    depth: f32,
    phase_offset_norm: f32,
    shape: u8,
    mix: f32,
    lfo_phase: f32,
    sample_rate: f32,
}

impl AutoPanProcessor {
    pub fn new(sample_rate: f32) -> Self {
        Self {
            rate_hz: 1.0,
            depth: 0.7,
            phase_offset_norm: 0.5, // 180deg default
            shape: 0,
            mix: 1.0,
            lfo_phase: 0.0,
            sample_rate,
        }
    }

    #[inline]
    fn wave(shape: u8, phase: f32) -> f32 {
        let p = phase.fract();
        match shape {
            1 => 1.0 - 4.0 * (p - 0.5).abs(), // triangle
            2 => 2.0 * p - 1.0,               // saw up
            3 => 1.0 - 2.0 * p,               // saw down
            4 => {
                if p < 0.5 {
                    1.0
                } else {
                    -1.0
                }
            } // square
            _ => (p * std::f32::consts::TAU).sin(), // sine
        }
    }
}

impl DspProcessor for AutoPanProcessor {
    fn process_stereo(&mut self, left: &mut [f32], right: &mut [f32], _sample_rate: f32) {
        let len = left.len().min(right.len());
        if len == 0 {
            return;
        }
        let phase_inc = self.rate_hz / self.sample_rate.max(1.0);
        let depth = self.depth.clamp(0.0, 1.0);
        let mix = self.mix.clamp(0.0, 1.0);
        let shape = self.shape;
        let phase_offset = self.phase_offset_norm;

        for i in 0..len {
            let dry_l = left[i];
            let dry_r = right[i];

            let mod_l = Self::wave(shape, self.lfo_phase);
            let mod_r = Self::wave(shape, self.lfo_phase + phase_offset);

            // Convert bipolar LFO to constant-power gains.
            let pan_l = (mod_l * depth).clamp(-1.0, 1.0);
            let pan_r = (mod_r * depth).clamp(-1.0, 1.0);
            let angle_l = (pan_l + 1.0) * 0.25 * std::f32::consts::PI;
            let angle_r = (pan_r + 1.0) * 0.25 * std::f32::consts::PI;
            let gain_ll = angle_l.cos() * std::f32::consts::SQRT_2;
            let gain_rr = angle_r.sin() * std::f32::consts::SQRT_2;

            let wet_l = dry_l * gain_ll;
            let wet_r = dry_r * gain_rr;
            left[i] = dry_l * (1.0 - mix) + wet_l * mix;
            right[i] = dry_r * (1.0 - mix) + wet_r * mix;

            self.lfo_phase += phase_inc;
            if self.lfo_phase >= 1.0 {
                self.lfo_phase -= 1.0;
            }
        }
    }

    fn set_param(&mut self, index: u8, value: f32) {
        match index {
            0 => self.rate_hz = value.clamp(0.01, 20.0),
            1 => self.depth = (value / 100.0).clamp(0.0, 1.0),
            2 => self.phase_offset_norm = (value / 360.0).clamp(0.0, 1.0),
            3 => self.shape = (value as u8).min(4),
            4 => self.mix = (value / 100.0).clamp(0.0, 1.0),
            _ => {}
        }
    }

    fn reset(&mut self) {
        self.lfo_phase = 0.0;
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn auto_pan_processes_and_changes_signal() {
        let mut proc = AutoPanProcessor::new(44100.0);
        proc.set_param(0, 2.5);
        proc.set_param(1, 100.0);
        proc.set_param(2, 90.0);
        proc.set_param(3, 4.0);
        let mut l = vec![0.5f32; 2048];
        let mut r = vec![0.5f32; 2048];
        proc.process_stereo(&mut l, &mut r, 44100.0);
        let diff: f32 = l.iter().zip(r.iter()).map(|(a, b)| (a - b).abs()).sum();
        assert!(
            diff > 1e-3,
            "Auto Pan should create channel difference: {diff}"
        );
    }
}
