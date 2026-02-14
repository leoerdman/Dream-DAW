// ═══════════════════════════════════════════════════════════════════════════
// Dream DAW — Reverb Processor (Freeverb Algorithm)
// ═══════════════════════════════════════════════════════════════════════════
//
// Schroeder/Moorer reverb with:
//   - 8 parallel comb filters → 4 series allpass filters
//   - Fully pre-allocated, zero-alloc during processing
//
// Parameters:
//   0: Decay   (0 to 100 %, default 50)
//   1: Tone    (0 to 100 %, default 50)  — lowpass damping
//   2: Dry/Wet (0 to 100 %, default 20)
//
// ═══════════════════════════════════════════════════════════════════════════

use crate::dsp_processor::DspProcessor;

// ── Comb Filter ─────────────────────────────────────────────────────────

struct CombFilter {
    buffer: Vec<f32>,
    index: usize,
    feedback: f32,
    damp1: f32,
    damp2: f32,
    filter_store: f32,
}

impl CombFilter {
    fn new(size: usize) -> Self {
        Self {
            buffer: vec![0.0; size],
            index: 0,
            feedback: 0.5,
            damp1: 0.5,
            damp2: 0.5,
            filter_store: 0.0,
        }
    }

    #[inline]
    fn process(&mut self, input: f32) -> f32 {
        let output = self.buffer[self.index];
        self.filter_store = output * self.damp2 + self.filter_store * self.damp1;
        self.buffer[self.index] = input + self.filter_store * self.feedback;
        self.index = (self.index + 1) % self.buffer.len();
        output
    }

    fn set_damp(&mut self, val: f32) {
        self.damp1 = val;
        self.damp2 = 1.0 - val;
    }

    fn set_feedback(&mut self, val: f32) {
        self.feedback = val;
    }

    fn reset(&mut self) {
        self.buffer.iter_mut().for_each(|s| *s = 0.0);
        self.filter_store = 0.0;
        self.index = 0;
    }
}

// ── Allpass Filter ──────────────────────────────────────────────────────

struct AllpassFilter {
    buffer: Vec<f32>,
    index: usize,
}

impl AllpassFilter {
    fn new(size: usize) -> Self {
        Self {
            buffer: vec![0.0; size],
            index: 0,
        }
    }

    #[inline]
    fn process(&mut self, input: f32) -> f32 {
        let buffered = self.buffer[self.index];
        let output = -input + buffered;
        self.buffer[self.index] = input + buffered * 0.5;
        self.index = (self.index + 1) % self.buffer.len();
        output
    }

    fn reset(&mut self) {
        self.buffer.iter_mut().for_each(|s| *s = 0.0);
        self.index = 0;
    }
}

// ── Freeverb Tuning Constants ───────────────────────────────────────────

/// Comb filter delay line sizes (Freeverb standard tuning).
/// Scaled to sample rate at construction time.
const COMB_TUNING: [usize; 8] = [
    1116, 1188, 1277, 1356, 1422, 1491, 1557, 1617,
];

/// Allpass filter delay line sizes (Freeverb standard tuning).
const ALLPASS_TUNING: [usize; 4] = [556, 441, 341, 225];

/// Stereo spread in samples.
const STEREO_SPREAD: usize = 23;

/// Reference sample rate for the tuning constants.
const REF_SAMPLE_RATE: f32 = 44100.0;

// ── Reverb Processor ────────────────────────────────────────────────────

pub struct ReverbProcessor {
    // Left channel: 8 combs + 4 allpasses
    combs_l: [CombFilter; 8],
    allpasses_l: [AllpassFilter; 4],
    // Right channel: 8 combs + 4 allpasses (spread)
    combs_r: [CombFilter; 8],
    allpasses_r: [AllpassFilter; 4],
    // Parameters
    decay: f32,   // 0..1
    damp: f32,    // 0..1
    dry_wet: f32, // 0..1
}

impl ReverbProcessor {
    pub fn new(sample_rate: f32) -> Self {
        let scale = sample_rate / REF_SAMPLE_RATE;

        let combs_l = std::array::from_fn(|i| {
            CombFilter::new(((COMB_TUNING[i] as f32) * scale) as usize)
        });
        let combs_r = std::array::from_fn(|i| {
            CombFilter::new(((COMB_TUNING[i] as f32) * scale) as usize + STEREO_SPREAD)
        });

        let allpasses_l = std::array::from_fn(|i| {
            AllpassFilter::new(((ALLPASS_TUNING[i] as f32) * scale) as usize)
        });
        let allpasses_r = std::array::from_fn(|i| {
            AllpassFilter::new(((ALLPASS_TUNING[i] as f32) * scale) as usize + STEREO_SPREAD)
        });

        let mut proc = Self {
            combs_l,
            allpasses_l,
            combs_r,
            allpasses_r,
            decay: 0.5,
            damp: 0.5,
            dry_wet: 0.2,
        };
        proc.update_combs();
        proc
    }

    fn update_combs(&mut self) {
        // Freeverb room_size → feedback mapping
        let feedback = self.decay * 0.28 + 0.7; // Range: 0.7 → 0.98

        for comb in self.combs_l.iter_mut().chain(self.combs_r.iter_mut()) {
            comb.set_feedback(feedback);
            comb.set_damp(self.damp);
        }
    }
}

impl DspProcessor for ReverbProcessor {
    fn process_stereo(&mut self, left: &mut [f32], right: &mut [f32], _sample_rate: f32) {
        let len = left.len().min(right.len());
        let wet = self.dry_wet;
        let dry = 1.0 - wet;
        let gain = 0.015; // Fixed input gain to prevent clipping

        for i in 0..len {
            let input = (left[i] + right[i]) * gain;
            let dry_l = left[i];
            let dry_r = right[i];

            // Sum all comb filters in parallel
            let mut out_l = 0.0f32;
            let mut out_r = 0.0f32;

            for comb in &mut self.combs_l {
                out_l += comb.process(input);
            }
            for comb in &mut self.combs_r {
                out_r += comb.process(input);
            }

            // Series allpass filters
            for ap in &mut self.allpasses_l {
                out_l = ap.process(out_l);
            }
            for ap in &mut self.allpasses_r {
                out_r = ap.process(out_r);
            }

            // Mix
            left[i] = dry_l * dry + out_l * wet;
            right[i] = dry_r * dry + out_r * wet;
        }
    }

    fn set_param(&mut self, index: u8, value: f32) {
        match index {
            0 => {
                // Decay (%)
                self.decay = (value / 100.0).clamp(0.0, 1.0);
                self.update_combs();
            }
            1 => {
                // Tone (%) — higher = more damped highs
                self.damp = (value / 100.0).clamp(0.0, 1.0);
                self.update_combs();
            }
            2 => {
                // Dry/Wet (%)
                self.dry_wet = (value / 100.0).clamp(0.0, 1.0);
            }
            _ => {}
        }
    }

    fn reset(&mut self) {
        for c in &mut self.combs_l { c.reset(); }
        for c in &mut self.combs_r { c.reset(); }
        for a in &mut self.allpasses_l { a.reset(); }
        for a in &mut self.allpasses_r { a.reset(); }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reverb_processes_without_panic() {
        let mut proc = ReverbProcessor::new(44100.0);
        let mut left = vec![0.0f32; 1024];
        let mut right = vec![0.0f32; 1024];
        left[0] = 1.0;
        right[0] = 1.0;
        proc.process_stereo(&mut left, &mut right, 44100.0);
        // Should not panic and should produce some output
    }

    #[test]
    fn reverb_produces_tail() {
        let mut proc = ReverbProcessor::new(44100.0);
        proc.set_param(0, 80.0); // High decay
        proc.set_param(2, 100.0); // Fully wet

        let buf_size = 44100; // 1 second
        let mut left = vec![0.0f32; buf_size];
        let mut right = vec![0.0f32; buf_size];
        // Impulse
        left[0] = 1.0;
        right[0] = 1.0;
        proc.process_stereo(&mut left, &mut right, 44100.0);

        // Check that there's energy far from the impulse (reverb tail)
        let tail_energy: f32 = left[20000..30000].iter().map(|s| s * s).sum();
        assert!(tail_energy > 1e-6, "Reverb should have a tail, energy: {tail_energy}");
    }
}
