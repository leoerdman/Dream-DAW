// ═══════════════════════════════════════════════════════════════════════════
// Dream DAW — Glue Compressor Processor
// ═══════════════════════════════════════════════════════════════════════════
//
// Bus/glue compressor modeled after the SSL G-series bus compressor.
// Distinct from the standard Compressor which is a clean VCA-style
// compressor. Glue adds coloration, soft-knee, and range control.
//
// Parameters:
//   0: Threshold (-40 to 0 dB, default -15)
//   1: Ratio     (2, 4, 10 mapped from 0–2, default 1=4:1)
//   2: Attack    (0.1–30 ms, default 1)
//   3: Release   (0.1–1200 ms, default 100)
//   4: Makeup    (-6 to +18 dB, default 0)
//   5: Range     (-40 to 0 dB, default -40) — max GR
//   6: Mix       (0–100%, default 100%)
//   7: Soft Clip (0–100%, default 30%) — output soft clip amount
//
// ═══════════════════════════════════════════════════════════════════════════

use crate::dsp_processor::DspProcessor;
use crate::processors::smoothing::SmoothedValue;
use crate::processors::{db_to_linear, sanitize_sample_rate};

pub struct GlueCompressorProcessor {
    threshold_db: f32,
    ratio_idx: u8,
    attack_ms: f32,
    release_ms: f32,
    makeup_db: f32,
    range_db: f32,
    mix: f32,
    soft_clip: f32,
    env: f32,
    current_gain_reduction: f32,
    // Smoothed
    makeup_sm: SmoothedValue,
    mix_sm: SmoothedValue,
    sample_rate: f32,
}

const GLUE_RATIOS: [f32; 3] = [2.0, 4.0, 10.0];

impl GlueCompressorProcessor {
    pub fn new(sample_rate: f32) -> Self {
        let sr = sanitize_sample_rate(sample_rate);
        Self {
            threshold_db: -15.0,
            ratio_idx: 1,
            attack_ms: 1.0,
            release_ms: 100.0,
            makeup_db: 0.0,
            range_db: -40.0,
            mix: 1.0,
            soft_clip: 0.3,
            env: 0.0,
            current_gain_reduction: 0.0,
            makeup_sm: SmoothedValue::new(sr, 8.0, 1.0),
            mix_sm: SmoothedValue::new(sr, 8.0, 1.0),
            sample_rate: sr,
        }
    }
}

impl DspProcessor for GlueCompressorProcessor {
    fn process_stereo(&mut self, left: &mut [f32], right: &mut [f32], sample_rate: f32) {
        let sr = sanitize_sample_rate(sample_rate);
        if (sr - self.sample_rate).abs() > 0.5 {
            self.sample_rate = sr;
            self.makeup_sm.set_sample_rate(sr);
            self.mix_sm.set_sample_rate(sr);
        }

        let len = left.len().min(right.len());
        let ratio = GLUE_RATIOS[self.ratio_idx.min(2) as usize];
        let attack_c = crate::processors::envelope_coeff(self.attack_ms, sr);
        let release_c = crate::processors::envelope_coeff(self.release_ms, sr);
        let makeup_lin = db_to_linear(self.makeup_db);
        self.makeup_sm.set_target(makeup_lin);
        self.mix_sm.set_target(self.mix);

        for i in 0..len {
            let dry_l = left[i];
            let dry_r = right[i];
            let makeup = self.makeup_sm.next_value();
            let mix = self.mix_sm.next_value();

            // Peak detection (link both channels)
            let peak = dry_l.abs().max(dry_r.abs());
            let c = if peak > self.env { attack_c } else { release_c };
            self.env = c * self.env + (1.0 - c) * peak;
            if self.env.abs() < 1e-20 { self.env = 0.0; }

            // Gain computation in dB
            let env_db = if self.env > 1e-10 {
                20.0 * self.env.log10()
            } else {
                -200.0
            };

            let gain_reduction_db = if env_db > self.threshold_db {
                let over = env_db - self.threshold_db;
                let compressed = over / ratio;
                let gr = -(over - compressed);
                gr.max(self.range_db) // Range limits max GR
            } else {
                0.0
            };

            let gain = db_to_linear(gain_reduction_db) * makeup;
            let mut out_l = dry_l * gain;
            let mut out_r = dry_r * gain;

            // Soft clip on output (SSL-style saturation)
            if self.soft_clip > 0.01 {
                let sc = self.soft_clip;
                out_l = out_l * (1.0 - sc) + out_l.tanh() * sc;
                out_r = out_r * (1.0 - sc) + out_r.tanh() * sc;
            }

            left[i] = dry_l * (1.0 - mix) + out_l * mix;
            right[i] = dry_r * (1.0 - mix) + out_r * mix;

            if i == len - 1 {
                self.current_gain_reduction = gain_reduction_db;
            }
        }
    }

    fn set_param(&mut self, index: u8, value: f32) {
        match index {
            0 => self.threshold_db = value.clamp(-40.0, 0.0),
            1 => self.ratio_idx = (value as u8).min(2),
            2 => self.attack_ms = value.clamp(0.1, 30.0),
            3 => self.release_ms = value.clamp(0.1, 1200.0),
            4 => self.makeup_db = value.clamp(-6.0, 18.0),
            5 => self.range_db = value.clamp(-40.0, 0.0),
            6 => self.mix = (value / 100.0).clamp(0.0, 1.0),
            7 => self.soft_clip = (value / 100.0).clamp(0.0, 1.0),
            _ => {}
        }
    }

    fn reset(&mut self) {
        self.env = 0.0;
        self.current_gain_reduction = 0.0;
        self.makeup_sm.set_instant(db_to_linear(self.makeup_db));
        self.mix_sm.set_instant(self.mix);
    }

    fn get_metric_f32(&self) -> f32 {
        self.current_gain_reduction
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn glue_compresses() {
        let mut proc = GlueCompressorProcessor::new(44100.0);
        proc.set_param(0, -20.0); // Low threshold
        proc.set_param(1, 2.0);   // 10:1 ratio
        let sr = 44100.0;
        let mut left: Vec<f32> = (0..4096)
            .map(|i| (std::f32::consts::TAU * 440.0 * i as f32 / sr).sin() * 0.8)
            .collect();
        let orig_rms: f32 = (left[2048..].iter().map(|x| x * x).sum::<f32>() / 2048.0).sqrt();
        let mut right = left.clone();
        proc.process_stereo(&mut left, &mut right, sr);
        let comp_rms: f32 = (left[2048..].iter().map(|x| x * x).sum::<f32>() / 2048.0).sqrt();
        assert!(comp_rms < orig_rms, "Glue should reduce: {comp_rms} < {orig_rms}");
        assert!(left.iter().all(|x| x.is_finite()));
    }
}
