// ═══════════════════════════════════════════════════════════════════════════
// Dream DAW — Phaser Processor
// ═══════════════════════════════════════════════════════════════════════════
//
// Multi-stage allpass phaser with LFO modulation and feedback.
//
// Architecture:
//   - 2/4/6/8 cascaded first-order allpass filters
//   - Triangle LFO modulates allpass center frequency
//   - Feedback from output back to input
//
// Parameters:
//   0: Rate        (0.01–10 Hz, default 0.5)
//   1: Depth       (0–1, default 0.6)
//   2: Feedback    (-0.95 to 0.95, default 0.5)
//   3: Stages      (2/4/6/8, quantized, default 4)
//   4: Center Freq (100–5000 Hz, default 1000)
//   5: Mix         (0–1, default 0.5)
//
// Real-Time Safety: Zero allocations. O(N × stages) per buffer.
//
// ═══════════════════════════════════════════════════════════════════════════

use crate::dsp_processor::DspProcessor;

const MAX_STAGES: usize = 8;

/// First-order allpass filter for phasing.
#[derive(Clone, Copy)]
struct AllpassStage {
    y1: f32,
    x1: f32,
}

impl AllpassStage {
    fn new() -> Self {
        Self { y1: 0.0, x1: 0.0 }
    }

    #[inline]
    fn process(&mut self, input: f32, coeff: f32) -> f32 {
        let y = coeff * (input - self.y1) + self.x1;
        self.x1 = input;
        self.y1 = y;
        y
    }

    fn reset(&mut self) {
        self.y1 = 0.0;
        self.x1 = 0.0;
    }
}

pub struct PhaserProcessor {
    rate: f32,
    depth: f32,
    feedback: f32,
    stages: usize,
    center_freq: f32,
    mix: f32,
    // Internal
    allpass_l: [AllpassStage; MAX_STAGES],
    allpass_r: [AllpassStage; MAX_STAGES],
    lfo_phase: f64,
    feedback_l: f32,
    feedback_r: f32,
    sample_rate: f32,
}

impl PhaserProcessor {
    pub fn new(sample_rate: f32) -> Self {
        Self {
            rate: 0.5,
            depth: 0.6,
            feedback: 0.5,
            stages: 4,
            center_freq: 1000.0,
            mix: 0.5,
            allpass_l: [AllpassStage::new(); MAX_STAGES],
            allpass_r: [AllpassStage::new(); MAX_STAGES],
            lfo_phase: 0.0,
            feedback_l: 0.0,
            feedback_r: 0.0,
            sample_rate,
        }
    }

    /// Triangle LFO: output in [-1, 1].
    #[inline]
    fn triangle_lfo(phase: f64) -> f32 {
        let p = phase.fract() as f32;
        if p < 0.25 {
            p * 4.0
        } else if p < 0.75 {
            2.0 - p * 4.0
        } else {
            p * 4.0 - 4.0
        }
    }
}

impl DspProcessor for PhaserProcessor {
    fn process_stereo(&mut self, left: &mut [f32], right: &mut [f32], _sample_rate: f32) {
        let len = left.len().min(right.len());
        let sr = self.sample_rate;
        let lfo_inc = self.rate as f64 / sr as f64;
        let num_stages = self.stages.min(MAX_STAGES);

        for i in 0..len {
            let lfo = Self::triangle_lfo(self.lfo_phase);
            self.lfo_phase += lfo_inc;
            if self.lfo_phase >= 1.0 {
                self.lfo_phase -= 1.0;
            }

            // Modulated frequency for allpass coefficient
            let mod_freq = self.center_freq * 2.0_f32.powf(lfo * self.depth * 2.0);
            let coeff = (std::f32::consts::PI * mod_freq / sr).tan();
            let ap_coeff = (coeff - 1.0) / (coeff + 1.0);

            // Left channel
            let mut sample_l = left[i] + self.feedback_l * self.feedback;
            for s in 0..num_stages {
                sample_l = self.allpass_l[s].process(sample_l, ap_coeff);
            }
            self.feedback_l = sample_l;

            // Right channel (slightly offset phase for stereo width)
            let mut sample_r = right[i] + self.feedback_r * self.feedback;
            for s in 0..num_stages {
                sample_r = self.allpass_r[s].process(sample_r, ap_coeff);
            }
            self.feedback_r = sample_r;

            // Mix
            left[i] = left[i] * (1.0 - self.mix) + sample_l * self.mix;
            right[i] = right[i] * (1.0 - self.mix) + sample_r * self.mix;
        }
    }

    fn set_param(&mut self, index: u8, value: f32) {
        match index {
            0 => self.rate = value.clamp(0.01, 10.0),
            1 => self.depth = value.clamp(0.0, 1.0),
            2 => self.feedback = value.clamp(-0.95, 0.95),
            3 => {
                // Quantize to even numbers 2..8
                let v = (value as usize).clamp(2, MAX_STAGES);
                self.stages = v - (v % 2); // ensure even
            }
            4 => self.center_freq = value.clamp(100.0, 5000.0),
            5 => self.mix = value.clamp(0.0, 1.0),
            _ => {}
        }
    }

    fn reset(&mut self) {
        for s in &mut self.allpass_l { s.reset(); }
        for s in &mut self.allpass_r { s.reset(); }
        self.lfo_phase = 0.0;
        self.feedback_l = 0.0;
        self.feedback_r = 0.0;
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn phaser_processes_without_panic() {
        let mut proc = PhaserProcessor::new(44100.0);
        let mut left = vec![0.5f32; 1024];
        let mut right = vec![0.5f32; 1024];
        proc.process_stereo(&mut left, &mut right, 44100.0);
    }

    #[test]
    fn phaser_modifies_signal() {
        let mut proc = PhaserProcessor::new(44100.0);
        proc.set_param(5, 1.0); // full wet
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
        assert!(diff > 0.01, "Phaser should modify signal, avg diff: {diff}");
    }
}
