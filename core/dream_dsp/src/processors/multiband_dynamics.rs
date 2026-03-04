// ═══════════════════════════════════════════════════════════════════════════
// Dream DAW — Multiband Dynamics Processor
// ═══════════════════════════════════════════════════════════════════════════
//
// 3-band multiband compressor/expander. Distinct from the single-band
// Compressor which processes the full spectrum uniformly.
//
// Architecture:
//   - Linkwitz-Riley 4th-order crossover (2-stage Butterworth cascade)
//   - Independent compressor per band (threshold, ratio, gain)
//   - Per-band envelope followers with independent attack/release
//
// Parameters:
//   0: Low-Mid XOver    (40–1000 Hz, default 200)
//   1: Mid-High XOver   (1000–16000 Hz, default 3000)
//   2: Low Threshold    (-40 to 0 dB, default -20)
//   3: Low Ratio        (1–20, default 4)
//   4: Low Gain         (-12 to +12 dB, default 0)
//   5: Mid Threshold    (-40 to 0 dB, default -20)
//   6: Mid Ratio        (1–20, default 4)
//   7: Mid Gain         (-12 to +12 dB, default 0)
//   8: High Threshold   (-40 to 0 dB, default -20)
//   9: High Ratio       (1–20, default 4)
//   10: High Gain       (-12 to +12 dB, default 0)
//   11: Output          (-12 to +12 dB, default 0)
//
// ═══════════════════════════════════════════════════════════════════════════

use crate::dsp_processor::DspProcessor;
use crate::processors::{db_to_linear, sanitize_sample_rate};
use crate::svf::SvfFilter;

/// Per-band compressor state
struct BandCompressor {
    env_l: f32,
    env_r: f32,
    threshold_db: f32,
    ratio: f32,
    gain_db: f32,
    attack_c: f32,
    release_c: f32,
}

impl BandCompressor {
    fn new(sr: f32) -> Self {
        Self {
            env_l: 0.0, env_r: 0.0,
            threshold_db: -20.0,
            ratio: 4.0,
            gain_db: 0.0,
            attack_c: crate::processors::envelope_coeff(5.0, sr),
            release_c: crate::processors::envelope_coeff(50.0, sr),
        }
    }

    #[inline]
    fn process(&mut self, l: &mut f32, r: &mut f32) {
        let peak = l.abs().max(r.abs());
        let c = if peak > self.env_l { self.attack_c } else { self.release_c };
        self.env_l = c * self.env_l + (1.0 - c) * peak;
        if self.env_l.abs() < 1e-20 { self.env_l = 0.0; }

        let env_db = if self.env_l > 1e-10 {
            20.0 * self.env_l.log10()
        } else {
            -200.0
        };

        let gain_reduction = if env_db > self.threshold_db {
            let over = env_db - self.threshold_db;
            let compressed = over / self.ratio;
            -(over - compressed)
        } else {
            0.0
        };

        let total_gain = db_to_linear(gain_reduction + self.gain_db);
        *l *= total_gain;
        *r *= total_gain;
    }

    fn update_coeffs(&mut self, sr: f32) {
        self.attack_c = crate::processors::envelope_coeff(5.0, sr);
        self.release_c = crate::processors::envelope_coeff(50.0, sr);
    }
}

pub struct MultibandDynamicsProcessor {
    xover_low: f32,
    xover_high: f32,
    output_db: f32,
    bands: [BandCompressor; 3],
    lm_l: SvfFilter,
    lm_r: SvfFilter,
    mh_l: SvfFilter,
    mh_r: SvfFilter,
    sample_rate: f32,
}

impl MultibandDynamicsProcessor {
    pub fn new(sample_rate: f32) -> Self {
        let sr = sanitize_sample_rate(sample_rate);
        Self {
            xover_low: 200.0,
            xover_high: 3000.0,
            output_db: 0.0,
            bands: [
                BandCompressor::new(sr),
                BandCompressor::new(sr),
                BandCompressor::new(sr),
            ],
            lm_l: SvfFilter::lowpass(200.0, 0.0, sr as f64),
            lm_r: SvfFilter::lowpass(200.0, 0.0, sr as f64),
            mh_l: SvfFilter::lowpass(3000.0, 0.0, sr as f64),
            mh_r: SvfFilter::lowpass(3000.0, 0.0, sr as f64),
            sample_rate: sr,
        }
    }
}

impl DspProcessor for MultibandDynamicsProcessor {
    fn process_stereo(&mut self, left: &mut [f32], right: &mut [f32], sample_rate: f32) {
        let sr = sanitize_sample_rate(sample_rate);
        if (sr - self.sample_rate).abs() > 0.5 {
            self.sample_rate = sr;
            for b in &mut self.bands { b.update_coeffs(sr); }
            self.lm_l.set_parameters(self.xover_low as f64, 0.0, sr as f64);
            self.lm_r.set_parameters(self.xover_low as f64, 0.0, sr as f64);
            self.mh_l.set_parameters(self.xover_high as f64, 0.0, sr as f64);
            self.mh_r.set_parameters(self.xover_high as f64, 0.0, sr as f64);
        }

        let len = left.len().min(right.len());
        let out_g = db_to_linear(self.output_db);

        for i in 0..len {
            let in_l = left[i];
            let in_r = right[i];

            // Low-Mid crossover using SVF LR2 topology (Q=0.5 -> Resonance=0.0)
            // Low is LP, High is -HP. The sum LP - HP constitutes a perfect allpass.
            let (ll_lp, ll_hp, _) = self.lm_l.process_all(in_l);
            let (lr_lp, lr_hp, _) = self.lm_r.process_all(in_r);
            
            let mut bl = ll_lp;
            let mut br = lr_lp;
            let high_of_split1_l = -ll_hp;
            let high_of_split1_r = -lr_hp;

            // Mid-High crossover on the high-pass output of first split
            let (hl_lp, hl_hp, _) = self.mh_l.process_all(high_of_split1_l);
            let (hr_lp, hr_hp, _) = self.mh_r.process_all(high_of_split1_r);

            let mut ml = hl_lp;
            let mut mr = hr_lp;
            let mut high_l = -hl_hp;
            let mut high_r = -hr_hp;

            // Compress each band
            self.bands[0].process(&mut bl, &mut br);
            self.bands[1].process(&mut ml, &mut mr);
            self.bands[2].process(&mut high_l, &mut high_r);

            // Recombine
            left[i] = (bl + ml + high_l) * out_g;
            right[i] = (br + mr + high_r) * out_g;
        }
    }

    fn set_param(&mut self, index: u8, value: f32) {
        match index {
            0 => {
                self.xover_low = value.clamp(40.0, 1000.0);
                self.lm_l.set_parameters(self.xover_low as f64, 0.0, self.sample_rate as f64);
                self.lm_r.set_parameters(self.xover_low as f64, 0.0, self.sample_rate as f64);
            }
            1 => {
                self.xover_high = value.clamp(1000.0, 16000.0);
                self.mh_l.set_parameters(self.xover_high as f64, 0.0, self.sample_rate as f64);
                self.mh_r.set_parameters(self.xover_high as f64, 0.0, self.sample_rate as f64);
            }
            2 => self.bands[0].threshold_db = value.clamp(-40.0, 0.0),
            3 => self.bands[0].ratio = value.clamp(1.0, 20.0),
            4 => self.bands[0].gain_db = value.clamp(-12.0, 12.0),
            5 => self.bands[1].threshold_db = value.clamp(-40.0, 0.0),
            6 => self.bands[1].ratio = value.clamp(1.0, 20.0),
            7 => self.bands[1].gain_db = value.clamp(-12.0, 12.0),
            8 => self.bands[2].threshold_db = value.clamp(-40.0, 0.0),
            9 => self.bands[2].ratio = value.clamp(1.0, 20.0),
            10 => self.bands[2].gain_db = value.clamp(-12.0, 12.0),
            11 => self.output_db = value.clamp(-12.0, 12.0),
            _ => {}
        }
    }

    fn reset(&mut self) {
        self.lm_l.reset();
        self.lm_r.reset();
        self.mh_l.reset();
        self.mh_r.reset();
        for b in &mut self.bands {
            b.env_l = 0.0; b.env_r = 0.0;
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn multiband_passes_signal() {
        let mut proc = MultibandDynamicsProcessor::new(44100.0);
        let sr = 44100.0;
        let mut left: Vec<f32> = (0..4096)
            .map(|i| (std::f32::consts::TAU * 440.0 * i as f32 / sr).sin() * 0.5)
            .collect();
        let mut right = left.clone();
        proc.process_stereo(&mut left, &mut right, sr);
        let rms: f32 = (left[2048..].iter().map(|x| x * x).sum::<f32>() / 2048.0).sqrt();
        assert!(rms > 0.01, "Should pass signal: {rms}");
        assert!(left.iter().all(|x| x.is_finite()));
    }
}
