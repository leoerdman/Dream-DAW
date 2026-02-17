// ═══════════════════════════════════════════════════════════════════════════
// Dream DAW — Compressor Processor (Enterprise)
// ═══════════════════════════════════════════════════════════════════════════
//
// Feed-forward dynamic range compressor with:
//   - Soft/hard knee
//   - Sidechain high-pass filter (rumble rejection)
//   - Auto make-up gain
//   - Gain reduction smoothing (attack/release)
//   - RMS or Peak detection modes
//   - Dry/wet (parallel compression)
//
// Parameters:
//   0: Threshold  (-60 to 0 dB, default -18)
//   1: Ratio      (1.0 to 20.0, default 4.0)
//   2: Attack     (0.1 to 100 ms, default 10)
//   3: Release    (10 to 1000 ms, default 100)
//   4: Knee       (0 to 24 dB, default 6) — soft knee width
//   5: Makeup     (-12 to +24 dB, default 0)
//   6: Mix        (0 to 100%, default 100%) — parallel blend
//   7: SC HPF     (20–500 Hz, default 20) — sidechain highpass
//   8: Auto Gain  (0 or 1, default 1)
//   9: RMS Mode   (0=Peak, 1=RMS, default 0)
//
// Real-Time Safety: Zero allocations. O(N) per buffer.
//
// ═══════════════════════════════════════════════════════════════════════════

use crate::dsp_processor::DspProcessor;

pub struct CompressorProcessor {
    threshold_db: f32,
    ratio: f32,
    attack_ms: f32,
    release_ms: f32,
    knee_db: f32,
    makeup_db: f32,
    makeup_lin: f32,
    mix: f32,
    sc_hpf_freq: f32,
    auto_gain: bool,
    rms_mode: bool,
    // State
    envelope_db: f32,
    rms_state: f32,
    // Sidechain HPF state
    sc_hp_state_l: f32,
    sc_hp_state_r: f32,
    sc_hp_coeff: f32,
    // Cached coefficients
    attack_coeff: f32,
    release_coeff: f32,
    sample_rate: f32,
}

impl CompressorProcessor {
    pub fn new(sample_rate: f32) -> Self {
        let mut proc = Self {
            threshold_db: -18.0,
            ratio: 4.0,
            attack_ms: 10.0,
            release_ms: 100.0,
            knee_db: 6.0,
            makeup_db: 0.0,
            makeup_lin: 1.0,
            mix: 1.0,
            sc_hpf_freq: 20.0,
            auto_gain: true,
            rms_mode: false,
            envelope_db: -96.0,
            rms_state: 0.0,
            sc_hp_state_l: 0.0,
            sc_hp_state_r: 0.0,
            sc_hp_coeff: 0.0,
            attack_coeff: 0.0,
            release_coeff: 0.0,
            sample_rate,
        };
        proc.update_coefficients();
        proc.update_sc_hpf();
        proc
    }

    fn update_coefficients(&mut self) {
        let sr = self.sample_rate;
        if sr > 0.0 {
            self.attack_coeff = (-1.0 / (self.attack_ms * 0.001 * sr)).exp();
            self.release_coeff = (-1.0 / (self.release_ms * 0.001 * sr)).exp();
        }
    }

    fn update_sc_hpf(&mut self) {
        self.sc_hp_coeff =
            1.0 / (1.0 + std::f32::consts::TAU * self.sc_hpf_freq / self.sample_rate);
    }

    fn compute_auto_makeup(&self) -> f32 {
        // Estimate makeup from threshold and ratio
        if self.auto_gain {
            let over = -self.threshold_db;
            if over > 0.0 {
                let reduction = over * (1.0 - 1.0 / self.ratio) * 0.5;
                Self::db_to_linear(reduction)
            } else {
                1.0
            }
        } else {
            self.makeup_lin
        }
    }

    #[inline]
    fn sync_sample_rate(&mut self, sample_rate: f32) {
        if sample_rate.is_finite()
            && sample_rate > 1000.0
            && (sample_rate - self.sample_rate).abs() > 0.5
        {
            self.sample_rate = sample_rate;
            self.update_coefficients();
            self.update_sc_hpf();
        }
    }

    #[inline]
    fn linear_to_db(x: f32) -> f32 {
        if x < 1e-10 {
            -96.0
        } else {
            20.0 * x.log10()
        }
    }

    #[inline]
    fn db_to_linear(db: f32) -> f32 {
        10.0_f32.powf(db / 20.0)
    }

    /// Soft-knee gain computation.
    #[inline]
    fn compute_gain_reduction(&self, input_db: f32) -> f32 {
        let threshold = self.threshold_db;
        let ratio = self.ratio;
        let knee = self.knee_db;
        let half_knee = knee * 0.5;

        if input_db < threshold - half_knee {
            // Below knee: no compression
            0.0
        } else if input_db > threshold + half_knee {
            // Above knee: full compression
            let over = input_db - threshold;
            -(over * (1.0 - 1.0 / ratio))
        } else {
            // In the knee zone: quadratic interpolation
            let x = input_db - threshold + half_knee;
            let slope = (1.0 - 1.0 / ratio) / (2.0 * knee);
            -(slope * x * x)
        }
    }
}

impl DspProcessor for CompressorProcessor {
    fn process_stereo(&mut self, left: &mut [f32], right: &mut [f32], sample_rate: f32) {
        self.sync_sample_rate(sample_rate);
        let len = left.len().min(right.len());
        let attack = self.attack_coeff;
        let release = self.release_coeff;
        let makeup = self.compute_auto_makeup();
        let mix = self.mix;
        let dry_mix = 1.0 - mix;
        let rms_coeff = if self.rms_mode { 0.001 } else { 0.0 };

        for i in 0..len {
            let dry_l = left[i];
            let dry_r = right[i];

            // Sidechain HPF
            let sc_l = if self.sc_hpf_freq > 25.0 {
                let prev = self.sc_hp_state_l;
                self.sc_hp_state_l = self.sc_hp_coeff * (prev + dry_l);
                dry_l - self.sc_hp_state_l + prev * self.sc_hp_coeff
            } else {
                dry_l
            };
            let sc_r = if self.sc_hpf_freq > 25.0 {
                let prev = self.sc_hp_state_r;
                self.sc_hp_state_r = self.sc_hp_coeff * (prev + dry_r);
                dry_r - self.sc_hp_state_r + prev * self.sc_hp_coeff
            } else {
                dry_r
            };

            // Detection
            let detection = if self.rms_mode {
                let sq = (sc_l * sc_l + sc_r * sc_r) * 0.5;
                self.rms_state += rms_coeff * (sq - self.rms_state);
                self.rms_state.max(0.0).sqrt()
            } else {
                sc_l.abs().max(sc_r.abs())
            };

            let input_db = Self::linear_to_db(detection);

            // Envelope
            let coeff = if input_db > self.envelope_db {
                attack
            } else {
                release
            };
            self.envelope_db = coeff * self.envelope_db + (1.0 - coeff) * input_db;

            // Gain computation (with soft knee)
            let gain_db = self.compute_gain_reduction(self.envelope_db);
            let gain = Self::db_to_linear(gain_db) * makeup;

            left[i] = dry_l * dry_mix + dry_l * gain * mix;
            right[i] = dry_r * dry_mix + dry_r * gain * mix;
        }
    }

    fn process_stereo_with_sidechain(
        &mut self,
        left: &mut [f32],
        right: &mut [f32],
        sidechain_left: Option<&[f32]>,
        sidechain_right: Option<&[f32]>,
        sample_rate: f32,
    ) {
        self.sync_sample_rate(sample_rate);
        let len = left.len().min(right.len());
        let attack = self.attack_coeff;
        let release = self.release_coeff;
        let makeup = self.compute_auto_makeup();
        let mix = self.mix;
        let dry_mix = 1.0 - mix;
        let rms_coeff = if self.rms_mode { 0.001 } else { 0.0 };

        for i in 0..len {
            let dry_l = left[i];
            let dry_r = right[i];

            let sc_src_l = sidechain_left
                .and_then(|sc| sc.get(i).copied())
                .unwrap_or(dry_l);
            let sc_src_r = sidechain_right
                .and_then(|sc| sc.get(i).copied())
                .unwrap_or(dry_r);

            let sc_l = if self.sc_hpf_freq > 25.0 {
                let prev = self.sc_hp_state_l;
                self.sc_hp_state_l = self.sc_hp_coeff * (prev + sc_src_l);
                sc_src_l - self.sc_hp_state_l + prev * self.sc_hp_coeff
            } else {
                sc_src_l
            };
            let sc_r = if self.sc_hpf_freq > 25.0 {
                let prev = self.sc_hp_state_r;
                self.sc_hp_state_r = self.sc_hp_coeff * (prev + sc_src_r);
                sc_src_r - self.sc_hp_state_r + prev * self.sc_hp_coeff
            } else {
                sc_src_r
            };

            let detection = if self.rms_mode {
                let sq = (sc_l * sc_l + sc_r * sc_r) * 0.5;
                self.rms_state += rms_coeff * (sq - self.rms_state);
                self.rms_state.max(0.0).sqrt()
            } else {
                sc_l.abs().max(sc_r.abs())
            };

            let input_db = Self::linear_to_db(detection);
            let coeff = if input_db > self.envelope_db {
                attack
            } else {
                release
            };
            self.envelope_db = coeff * self.envelope_db + (1.0 - coeff) * input_db;
            let gain_db = self.compute_gain_reduction(self.envelope_db);
            let gain = Self::db_to_linear(gain_db) * makeup;

            left[i] = dry_l * dry_mix + dry_l * gain * mix;
            right[i] = dry_r * dry_mix + dry_r * gain * mix;
        }
    }

    fn set_param(&mut self, index: u8, value: f32) {
        match index {
            0 => self.threshold_db = value.clamp(-60.0, 0.0),
            1 => self.ratio = value.clamp(1.0, 20.0),
            2 => {
                self.attack_ms = value.clamp(0.1, 100.0);
                self.update_coefficients();
            }
            3 => {
                self.release_ms = value.clamp(10.0, 1000.0);
                self.update_coefficients();
            }
            4 => self.knee_db = value.clamp(0.0, 24.0),
            5 => {
                self.makeup_db = value.clamp(-12.0, 24.0);
                self.makeup_lin = Self::db_to_linear(self.makeup_db);
            }
            6 => self.mix = (value / 100.0).clamp(0.0, 1.0),
            7 => {
                self.sc_hpf_freq = value.clamp(20.0, 500.0);
                self.update_sc_hpf();
            }
            8 => self.auto_gain = value > 0.5,
            9 => self.rms_mode = value > 0.5,
            _ => {}
        }
    }

    fn reset(&mut self) {
        self.envelope_db = -96.0;
        self.rms_state = 0.0;
        self.sc_hp_state_l = 0.0;
        self.sc_hp_state_r = 0.0;
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn compressor_passes_quiet_signal() {
        let mut proc = CompressorProcessor::new(44100.0);
        let mut left = vec![0.01f32; 256];
        let mut right = vec![0.01f32; 256];
        let original = left.clone();
        proc.process_stereo(&mut left, &mut right, 44100.0);
        for (i, s) in left.iter().enumerate() {
            assert!((s - original[i]).abs() < 0.05, "Quiet signal changed: {s}");
        }
    }

    #[test]
    fn compressor_reduces_loud_signal() {
        let mut proc = CompressorProcessor::new(44100.0);
        proc.set_param(0, -20.0);
        proc.set_param(1, 10.0);
        proc.set_param(2, 0.1);
        proc.set_param(8, 0.0); // manual gain
        proc.set_param(5, 0.0); // 0 dB makeup
        let mut left = vec![1.0f32; 4096];
        let mut right = vec![1.0f32; 4096];
        proc.process_stereo(&mut left, &mut right, 44100.0);
        let tail_avg: f32 = left[2048..].iter().sum::<f32>() / 2048.0;
        assert!(
            tail_avg < 0.5,
            "Loud signal should be compressed, got: {tail_avg}"
        );
    }

    #[test]
    fn compressor_soft_knee() {
        let mut proc = CompressorProcessor::new(44100.0);
        proc.set_param(4, 12.0); // 12dB soft knee
        proc.set_param(0, -12.0);
        // Just test it doesn't panic
        let mut l = vec![0.3f32; 1024];
        let mut r = vec![0.3f32; 1024];
        proc.process_stereo(&mut l, &mut r, 44100.0);
    }
}
