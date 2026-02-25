// ═══════════════════════════════════════════════════════════════════════════
// Dream DAW — Corpus Processor (Resonance / Physical Modeling Body)
// ═══════════════════════════════════════════════════════════════════════════
//
// Simulates the resonant body of acoustic instruments using a bank of
// tuned comb filters (Karplus-Strong family). Adds tonal resonance to
// any input — inspired by Ableton Corpus.
//
// Architecture:
//   - Bank of 6 tuned comb filters (Karplus-Strong delay + LP feedback)
//   - Tuning by MIDI note number (frequency)
//   - Decay control (comb feedback coefficient)
//   - Damping LP in feedback loop
//   - Body type selects different comb spacing ratios
//
// Parameters:
//   0: Tune     (24–96 MIDI note, default 48 = C3)
//   1: Decay    (0–100%, default 50%)
//   2: Damping  (0–100%, default 40%)
//   3: Type     (0–4: Plate, Pipe, Tube, String, Membrane)
//   4: Spread   (0–100%, default 50%) — detune between combs
//   5: Dry/Wet  (0–100%, default 50%)
//
// ═══════════════════════════════════════════════════════════════════════════

use crate::dsp_processor::DspProcessor;
use crate::processors::smoothing::SmoothedValue;
use crate::processors::sanitize_sample_rate;

const COMB_SIZE: usize = 4096;
const COMB_MASK: usize = COMB_SIZE - 1;
const NUM_COMBS: usize = 6;

/// Harmonic ratios for different body types
const RATIOS: [[f32; NUM_COMBS]; 5] = [
    [1.0, 1.506, 2.0, 2.506, 3.0, 3.516],   // Plate
    [1.0, 2.0, 3.0, 4.0, 5.0, 6.0],          // Pipe (pure harmonics)
    [1.0, 1.58, 2.12, 2.73, 3.32, 3.95],     // Tube
    [1.0, 2.0, 3.0, 4.0, 5.001, 6.001],      // String (near-harmonic)
    [1.0, 1.59, 2.14, 2.65, 3.16, 3.65],     // Membrane (inharmonic)
];

struct CombFilter {
    buf: [f32; COMB_SIZE],
    pos: usize,
    lp_z: f32,
}

impl CombFilter {
    fn new() -> Self {
        Self { buf: [0.0; COMB_SIZE], pos: 0, lp_z: 0.0 }
    }

    #[inline]
    fn process(&mut self, input: f32, delay: f32, feedback: f32, damp_c: f32) -> f32 {
        let d = delay.clamp(1.0, (COMB_SIZE - 2) as f32);
        let idx = d as usize;
        let frac = d - idx as f32;
        let p1 = (self.pos + COMB_SIZE - idx) & COMB_MASK;
        let p2 = (self.pos + COMB_SIZE - idx - 1) & COMB_MASK;
        let delayed = self.buf[p1] * (1.0 - frac) + self.buf[p2] * frac;

        // LP damping in feedback loop
        self.lp_z = self.lp_z * damp_c + delayed * (1.0 - damp_c);
        if self.lp_z.abs() < 1e-20 { self.lp_z = 0.0; }

        self.buf[self.pos] = input + self.lp_z * feedback;
        self.pos = (self.pos + 1) & COMB_MASK;
        delayed
    }

    fn reset(&mut self) {
        self.buf.fill(0.0);
        self.pos = 0;
        self.lp_z = 0.0;
    }
}

pub struct CorpusProcessor {
    tune_note: f32,
    decay: f32,
    damping: f32,
    body_type: u8,
    spread: f32,
    mix: f32,
    combs_l: [CombFilter; NUM_COMBS],
    combs_r: [CombFilter; NUM_COMBS],
    mix_sm: SmoothedValue,
    decay_sm: SmoothedValue,
    damp_sm: SmoothedValue,
    sample_rate: f32,
}

impl CorpusProcessor {
    pub fn new(sample_rate: f32) -> Self {
        let sr = sanitize_sample_rate(sample_rate);
        Self {
            tune_note: 48.0,
            decay: 0.5,
            damping: 0.4,
            body_type: 0,
            spread: 0.5,
            mix: 0.5,
            combs_l: std::array::from_fn(|_| CombFilter::new()),
            combs_r: std::array::from_fn(|_| CombFilter::new()),
            mix_sm: SmoothedValue::new(sr, 8.0, 0.5),
            decay_sm: SmoothedValue::new(sr, 10.0, 0.5),
            damp_sm: SmoothedValue::new(sr, 10.0, 0.4),
            sample_rate: sr,
        }
    }
}

impl DspProcessor for CorpusProcessor {
    fn process_stereo(&mut self, left: &mut [f32], right: &mut [f32], sample_rate: f32) {
        let sr = sanitize_sample_rate(sample_rate);
        if (sr - self.sample_rate).abs() > 0.5 {
            self.sample_rate = sr;
            self.mix_sm.set_sample_rate(sr);
            self.decay_sm.set_sample_rate(sr);
            self.damp_sm.set_sample_rate(sr);
        }

        let len = left.len().min(right.len());
        self.mix_sm.set_target(self.mix);
        self.decay_sm.set_target(self.decay);
        self.damp_sm.set_target(self.damping);

        let base_freq = 440.0 * 2.0_f32.powf((self.tune_note - 69.0) / 12.0);
        let ratios = &RATIOS[self.body_type.min(4) as usize];

        for i in 0..len {
            let dry_l = left[i];
            let dry_r = right[i];
            let mix = self.mix_sm.next_value();
            let decay = self.decay_sm.next_value().clamp(0.0, 0.99);
            let damp = self.damp_sm.next_value().clamp(0.01, 0.99);

            let mut wet_l = 0.0f32;
            let mut wet_r = 0.0f32;
            let gain = 1.0 / NUM_COMBS as f32;

            for c in 0..NUM_COMBS {
                let spread_offset = 1.0 + self.spread * 0.002 * (c as f32 - 2.5);
                let freq = base_freq * ratios[c] * spread_offset;
                let delay = (sr / freq.max(20.0)).min((COMB_SIZE - 2) as f32);
                wet_l += self.combs_l[c].process(dry_l, delay, decay, damp) * gain;
                // Slightly detune R for stereo width
                let delay_r = delay * (1.0 + 0.001 * (c as f32));
                wet_r += self.combs_r[c].process(dry_r, delay_r, decay, damp) * gain;
            }

            left[i] = dry_l * (1.0 - mix) + wet_l * mix;
            right[i] = dry_r * (1.0 - mix) + wet_r * mix;
        }
    }

    fn set_param(&mut self, index: u8, value: f32) {
        match index {
            0 => self.tune_note = value.clamp(24.0, 96.0),
            1 => self.decay = (value / 100.0).clamp(0.0, 1.0),
            2 => self.damping = (value / 100.0).clamp(0.0, 1.0),
            3 => self.body_type = (value as u8).min(4),
            4 => self.spread = (value / 100.0).clamp(0.0, 1.0),
            5 => self.mix = (value / 100.0).clamp(0.0, 1.0),
            _ => {}
        }
    }

    fn reset(&mut self) {
        for c in &mut self.combs_l { c.reset(); }
        for c in &mut self.combs_r { c.reset(); }
        self.mix_sm.set_instant(self.mix);
        self.decay_sm.set_instant(self.decay);
        self.damp_sm.set_instant(self.damping);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn corpus_resonates() {
        let mut proc = CorpusProcessor::new(44100.0);
        proc.set_param(5, 100.0); // Full wet
        proc.set_param(1, 80.0);  // High decay
        let sr = 44100.0;
        let mut left = vec![0.0f32; 8192];
        let mut right = vec![0.0f32; 8192];
        left[0] = 1.0; right[0] = 1.0;
        proc.process_stereo(&mut left, &mut right, sr);
        let tail_rms: f32 = (left[4096..].iter().map(|x| x * x).sum::<f32>() / 4096.0).sqrt();
        assert!(tail_rms > 0.00001, "Should resonate: {tail_rms}");
        assert!(left.iter().all(|x| x.is_finite()));
    }
}
