// ═══════════════════════════════════════════════════════════════════════════
// Dream DAW — Phaser Processor (Enterprise)
// ═══════════════════════════════════════════════════════════════════════════
//
// Multi-stage allpass phaser with:
//   - 2–12 stages (cascaded first-order allpass)
//   - 4 LFO shapes: Sine, Triangle, Saw, Square
//   - Feedback for resonant sweeps
//   - Stereo spread (L/R phase offset)
//   - Configurable frequency range
//   - Mix control
//
// Parameters:
//   0: Rate      (0.01–10 Hz, default 0.5)
//   1: Depth     (0–100%, default 50%)
//   2: Feedback  (-95 to 95%, default 40%)
//   3: Stages    (2–12, default 6)
//   4: Center    (100–8000 Hz, default 1000)
//   5: Mix       (0–100%, default 50%)
//   6: Spread    (0–100%, default 50%) — stereo LFO offset
//   7: LFO Shape (0–3, default 0)
//   8: Range     (200–10000 Hz, default 4000) — sweep range
//
// Real-Time Safety: Zero allocations. O(N × stages) per buffer.
//
// ═══════════════════════════════════════════════════════════════════════════

use crate::dsp_processor::DspProcessor;

const MAX_STAGES: usize = 12;

pub struct PhaserProcessor {
    rate: f32,
    depth: f32,
    feedback: f32,
    num_stages: usize,
    center_freq: f32,
    mix: f32,
    spread: f32,
    lfo_shape: u8,
    range: f32,
    // Allpass states
    ap_state_l: [f32; MAX_STAGES],
    ap_state_r: [f32; MAX_STAGES],
    // Feedback state
    fb_l: f32,
    fb_r: f32,
    // LFO
    lfo_phase: f64,
    sample_rate: f32,
}

impl PhaserProcessor {
    pub fn new(sample_rate: f32) -> Self {
        Self {
            rate: 0.5,
            depth: 0.5,
            feedback: 0.4,
            num_stages: 6,
            center_freq: 1000.0,
            mix: 0.5,
            spread: 0.5,
            lfo_shape: 0,
            range: 4000.0,
            ap_state_l: [0.0; MAX_STAGES],
            ap_state_r: [0.0; MAX_STAGES],
            fb_l: 0.0,
            fb_r: 0.0,
            lfo_phase: 0.0,
            sample_rate,
        }
    }

    #[inline]
    fn lfo(phase: f32, shape: u8) -> f32 {
        match shape {
            1 => 1.0 - 4.0 * (phase - 0.5).abs(),
            2 => 2.0 * phase - 1.0,
            3 => {
                if phase < 0.5 {
                    1.0
                } else {
                    -1.0
                }
            }
            _ => {
                // 0 (Sine) or any unknown: Bhaskara fast sine approximation
                let p = phase.fract();
                let (t, sign) = if p < 0.5 {
                    (p * 2.0, 1.0f32)
                } else {
                    ((p - 0.5) * 2.0, -1.0)
                };
                let t2 = t * (1.0 - t);
                sign * (16.0 * t2) / (5.0 - 4.0 * t2)
            }
        }
    }

    /// First-order allpass: y = (x - state) * a + state; state = y * a + x
    #[inline]
    fn allpass(input: f32, state: &mut f32, coeff: f32) -> f32 {
        // Guard: if state is NaN/Inf, reset it
        if !state.is_finite() {
            *state = 0.0;
        }
        let input = if input.is_finite() { input } else { 0.0 };
        let y = *state + coeff * (input - *state);
        *state = input + coeff * (y - input);
        // Clamp state to prevent runaway
        *state = state.clamp(-10.0, 10.0);
        y.clamp(-10.0, 10.0)
    }
}

impl DspProcessor for PhaserProcessor {
    fn process_stereo(&mut self, left: &mut [f32], right: &mut [f32], sample_rate: f32) {
        // Sync sample rate
        if sample_rate.is_finite()
            && sample_rate > 1000.0
            && (sample_rate - self.sample_rate).abs() > 0.5
        {
            self.sample_rate = sample_rate;
        }
        let len = left.len().min(right.len());
        let sr = self.sample_rate;
        let lfo_inc = self.rate as f64 / sr as f64;
        let stages = self.num_stages.min(MAX_STAGES);
        let center_log = (self.center_freq / 20.0).max(0.001).ln();
        let range_log = (self.range / 20.0).max(0.001).ln().max(0.001);

        for i in 0..len {
            let phase_l = (self.lfo_phase as f32).fract();
            let phase_r = (self.lfo_phase as f32 + 0.5 * self.spread).fract();

            let lfo_l = Self::lfo(phase_l, self.lfo_shape);
            let lfo_r = Self::lfo(phase_r, self.lfo_shape);

            // Modulated frequency (log scale)
            let freq_l = 20.0 * (center_log + lfo_l * self.depth * range_log * 0.5).exp();
            let freq_r = 20.0 * (center_log + lfo_r * self.depth * range_log * 0.5).exp();
            let freq_l = freq_l.clamp(20.0, sr * 0.45);
            let freq_r = freq_r.clamp(20.0, sr * 0.45);

            // Allpass coefficient from frequency
            let coeff_l = (std::f32::consts::PI * freq_l / sr).tan();
            let coeff_l = ((coeff_l - 1.0) / (coeff_l + 1.0)).clamp(-0.999, 0.999);
            let coeff_r = (std::f32::consts::PI * freq_r / sr).tan();
            let coeff_r = ((coeff_r - 1.0) / (coeff_r + 1.0)).clamp(-0.999, 0.999);

            // Input with feedback
            let in_l = left[i] + self.fb_l * self.feedback;
            let in_r = right[i] + self.fb_r * self.feedback;

            // Cascade allpass stages
            let mut out_l = in_l;
            let mut out_r = in_r;
            for s in 0..stages {
                out_l = Self::allpass(out_l, &mut self.ap_state_l[s], coeff_l);
                out_r = Self::allpass(out_r, &mut self.ap_state_r[s], coeff_r);
            }

            // AUD-130 FIX: Flush denormals in allpass states to prevent
            // 100× CPU slowdown on x86 during quiet passages.
            for s in 0..stages {
                if self.ap_state_l[s].abs() < 1e-18 {
                    self.ap_state_l[s] = 0.0;
                }
                if self.ap_state_r[s].abs() < 1e-18 {
                    self.ap_state_r[s] = 0.0;
                }
            }

            self.fb_l = if out_l.is_finite() {
                out_l.clamp(-5.0, 5.0)
            } else {
                0.0
            };
            self.fb_r = if out_r.is_finite() {
                out_r.clamp(-5.0, 5.0)
            } else {
                0.0
            };

            // Mix
            left[i] = left[i] * (1.0 - self.mix) + out_l * self.mix;
            right[i] = right[i] * (1.0 - self.mix) + out_r * self.mix;

            self.lfo_phase += lfo_inc;
            self.lfo_phase = self.lfo_phase.fract();
        }
    }

    fn set_param(&mut self, index: u8, value: f32) {
        match index {
            0 => self.rate = value.clamp(0.01, 10.0),
            1 => self.depth = (value / 100.0).clamp(0.0, 1.0),
            2 => self.feedback = (value / 100.0).clamp(-0.95, 0.95),
            3 => self.num_stages = (value as usize).clamp(2, MAX_STAGES),
            4 => self.center_freq = value.clamp(100.0, 8000.0),
            5 => self.mix = (value / 100.0).clamp(0.0, 1.0),
            6 => self.spread = (value / 100.0).clamp(0.0, 1.0),
            7 => self.lfo_shape = (value as u8).min(3),
            8 => self.range = value.clamp(200.0, 10000.0),
            _ => {}
        }
    }

    fn reset(&mut self) {
        self.ap_state_l = [0.0; MAX_STAGES];
        self.ap_state_r = [0.0; MAX_STAGES];
        self.fb_l = 0.0;
        self.fb_r = 0.0;
        self.lfo_phase = 0.0;
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn phaser_processes_without_panic() {
        let mut proc = PhaserProcessor::new(44100.0);
        let mut l = vec![0.5f32; 512];
        let mut r = vec![0.5f32; 512];
        proc.process_stereo(&mut l, &mut r, 44100.0);
    }

    #[test]
    fn phaser_modifies_signal() {
        let mut proc = PhaserProcessor::new(44100.0);
        proc.set_param(0, 2.0);
        proc.set_param(1, 100.0);
        proc.set_param(5, 100.0);
        let sr = 44100.0;
        let mut l: Vec<f32> = (0..4096)
            .map(|i| (2.0 * std::f32::consts::PI * 440.0 * i as f32 / sr).sin() * 0.5)
            .collect();
        let orig = l.clone();
        let mut r = l.clone();
        proc.process_stereo(&mut l, &mut r, sr);
        let diff: f32 = l.iter().zip(orig.iter()).map(|(a, b)| (a - b).abs()).sum();
        assert!(diff > 1.0, "Phaser should modify: {diff}");
    }
}
