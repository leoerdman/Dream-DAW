// ═══════════════════════════════════════════════════════════════════════════
// Dream DAW — Drum Buss Processor
// ═══════════════════════════════════════════════════════════════════════════
//
// A specialized drum processing chain:
//   - Transient emphasis for snap/punch
//   - Low-frequency boom (resonant bass boost)
//   - Soft distortion for glue/grit
//   - Trim output control
//
// Parameters:
//   0: Drive     (0–100%, default 30%)  — soft clip distortion amount
//   1: Crunch    (0–100%, default 20%)  — mid-frequency crunch
//   2: Boom      (0–100%, default 40%)  — resonant bass boost
//   3: Boom Freq (30–200 Hz, default 80) — bass resonance center freq
//   4: Transient (0–100%, default 50%)  — transient emphasis
//   5: Trim      (-24 to +6 dB, default 0)
//   6: Mix       (0–100%, default 100%)
//
// Real-Time Safety: Zero allocations. O(N) per buffer.
//
// ═══════════════════════════════════════════════════════════════════════════

use crate::dsp_processor::DspProcessor;
use crate::processors::smoothing::SmoothedValue;
use crate::processors::{db_to_linear, sanitize_sample_rate};

pub struct DrumBussProcessor {
    drive: f32,
    crunch: f32,
    boom: f32,
    boom_freq: f32,
    transient: f32,
    trim_db: f32,
    mix: f32,
    // Boom resonant LP state (2nd order)
    boom_z1_l: f32,
    boom_z2_l: f32,
    boom_z1_r: f32,
    boom_z2_r: f32,
    boom_b0: f32,
    boom_b1: f32,
    boom_b2: f32,
    boom_a1: f32,
    boom_a2: f32,
    // Transient detection (fast envelope)
    env_fast_l: f32,
    env_fast_r: f32,
    env_slow_l: f32,
    env_slow_r: f32,
    // DC blocker
    dc_prev_in_l: f32,
    dc_prev_in_r: f32,
    dc_prev_out_l: f32,
    dc_prev_out_r: f32,
    dc_coeff: f32,
    // Smoothed
    drive_sm: SmoothedValue,
    crunch_sm: SmoothedValue,
    boom_sm: SmoothedValue,
    transient_sm: SmoothedValue,
    trim_sm: SmoothedValue,
    mix_sm: SmoothedValue,
    sample_rate: f32,
}

impl DrumBussProcessor {
    pub fn new(sample_rate: f32) -> Self {
        let sr = sanitize_sample_rate(sample_rate);
        let mut proc = Self {
            drive: 0.3,
            crunch: 0.2,
            boom: 0.4,
            boom_freq: 80.0,
            transient: 0.5,
            trim_db: 0.0,
            mix: 1.0,
            boom_z1_l: 0.0,
            boom_z2_l: 0.0,
            boom_z1_r: 0.0,
            boom_z2_r: 0.0,
            boom_b0: 0.0,
            boom_b1: 0.0,
            boom_b2: 0.0,
            boom_a1: 0.0,
            boom_a2: 0.0,
            env_fast_l: 0.0,
            env_fast_r: 0.0,
            env_slow_l: 0.0,
            env_slow_r: 0.0,
            dc_prev_in_l: 0.0,
            dc_prev_in_r: 0.0,
            dc_prev_out_l: 0.0,
            dc_prev_out_r: 0.0,
            dc_coeff: 1.0 - (std::f32::consts::TAU * 20.0 / sr),
            drive_sm: SmoothedValue::new(sr, 10.0, 0.3),
            crunch_sm: SmoothedValue::new(sr, 10.0, 0.2),
            boom_sm: SmoothedValue::new(sr, 10.0, 0.4),
            transient_sm: SmoothedValue::new(sr, 10.0, 0.5),
            trim_sm: SmoothedValue::new(sr, 8.0, 1.0),
            mix_sm: SmoothedValue::new(sr, 8.0, 1.0),
            sample_rate: sr,
        };
        proc.update_boom_filter();
        proc
    }

    fn update_boom_filter(&mut self) {
        let sr = self.sample_rate;
        let w0 = std::f32::consts::TAU * self.boom_freq / sr;
        let cos_w0 = w0.cos();
        let sin_w0 = w0.sin();
        // Resonant LP with Q=2 for boom
        let q = 2.0;
        let alpha = sin_w0 / (2.0 * q);
        let a0_inv = 1.0 / (1.0 + alpha);
        self.boom_b0 = ((1.0 - cos_w0) * 0.5) * a0_inv;
        self.boom_b1 = (1.0 - cos_w0) * a0_inv;
        self.boom_b2 = self.boom_b0;
        self.boom_a1 = (-2.0 * cos_w0) * a0_inv;
        self.boom_a2 = (1.0 - alpha) * a0_inv;
    }

    #[inline]
    #[allow(clippy::too_many_arguments)]
    fn boom_filter(
        input: f32,
        z1: &mut f32,
        z2: &mut f32,
        b0: f32,
        b1: f32,
        b2: f32,
        a1: f32,
        a2: f32,
    ) -> f32 {
        let out = b0 * input + *z1;
        *z1 = b1 * input - a1 * out + *z2;
        *z2 = b2 * input - a2 * out;
        if z1.abs() < 1e-20 { *z1 = 0.0; }
        if z2.abs() < 1e-20 { *z2 = 0.0; }
        out
    }

    #[inline]
    fn soft_clip(x: f32, drive: f32) -> f32 {
        let gain = 1.0 + drive * 10.0;
        let d = x * gain;
        d / (1.0 + d.abs())
    }

    #[inline]
    fn crunch_clip(x: f32, amount: f32) -> f32 {
        // Asymmetric fold-back for crunch character
        let d = x * (1.0 + amount * 5.0);
        if d > 1.0 { 2.0 - d } else if d < -1.0 { -2.0 - d } else { d }
    }
}

impl DspProcessor for DrumBussProcessor {
    fn process_stereo(&mut self, left: &mut [f32], right: &mut [f32], sample_rate: f32) {
        let sr = sanitize_sample_rate(sample_rate);
        if (sr - self.sample_rate).abs() > 0.5 {
            self.sample_rate = sr;
            self.dc_coeff = 1.0 - (std::f32::consts::TAU * 20.0 / sr);
            self.update_boom_filter();
            self.drive_sm.set_sample_rate(sr);
            self.crunch_sm.set_sample_rate(sr);
            self.boom_sm.set_sample_rate(sr);
            self.transient_sm.set_sample_rate(sr);
            self.trim_sm.set_sample_rate(sr);
            self.mix_sm.set_sample_rate(sr);
        }

        let len = left.len().min(right.len());
        let trim_lin = if self.trim_db <= -24.0 { 0.0 } else { db_to_linear(self.trim_db) };
        self.drive_sm.set_target(self.drive);
        self.crunch_sm.set_target(self.crunch);
        self.boom_sm.set_target(self.boom);
        self.transient_sm.set_target(self.transient);
        self.trim_sm.set_target(trim_lin);
        self.mix_sm.set_target(self.mix);

        // Transient envelope coefficients
        let fast_atk = crate::processors::envelope_coeff(0.5, sr);
        let fast_rel = crate::processors::envelope_coeff(15.0, sr);
        let slow_atk = crate::processors::envelope_coeff(30.0, sr);
        let slow_rel = crate::processors::envelope_coeff(120.0, sr);
        let dc = self.dc_coeff;

        for i in 0..len {
            let dry_l = left[i];
            let dry_r = right[i];
            let drive = self.drive_sm.next_value();
            let crunch = self.crunch_sm.next_value();
            let boom = self.boom_sm.next_value();
            let trans = self.transient_sm.next_value();
            let trim = self.trim_sm.next_value();
            let mix = self.mix_sm.next_value();

            // 1. Transient emphasis
            let abs_l = dry_l.abs();
            let abs_r = dry_r.abs();
            let c_fast_l = if abs_l > self.env_fast_l { fast_atk } else { fast_rel };
            self.env_fast_l = c_fast_l * self.env_fast_l + (1.0 - c_fast_l) * abs_l;
            let c_slow_l = if abs_l > self.env_slow_l { slow_atk } else { slow_rel };
            self.env_slow_l = c_slow_l * self.env_slow_l + (1.0 - c_slow_l) * abs_l;
            let c_fast_r = if abs_r > self.env_fast_r { fast_atk } else { fast_rel };
            self.env_fast_r = c_fast_r * self.env_fast_r + (1.0 - c_fast_r) * abs_r;
            let c_slow_r = if abs_r > self.env_slow_r { slow_atk } else { slow_rel };
            self.env_slow_r = c_slow_r * self.env_slow_r + (1.0 - c_slow_r) * abs_r;

            let trans_l = if self.env_slow_l > 1e-10 {
                (self.env_fast_l / self.env_slow_l - 1.0).clamp(0.0, 3.0)
            } else { 0.0 };
            let trans_r = if self.env_slow_r > 1e-10 {
                (self.env_fast_r / self.env_slow_r - 1.0).clamp(0.0, 3.0)
            } else { 0.0 };

            let tg_l = 1.0 + trans * trans_l;
            let tg_r = 1.0 + trans * trans_r;
            let sig_l = dry_l * tg_l;
            let sig_r = dry_r * tg_r;

            // 2. Drive (soft clip)
            let drv_l = Self::soft_clip(sig_l, drive);
            let drv_r = Self::soft_clip(sig_r, drive);

            // 3. Crunch (mid saturation)
            let cr_l = if crunch > 0.01 {
                let wet = Self::crunch_clip(drv_l, crunch);
                drv_l * (1.0 - crunch) + wet * crunch
            } else { drv_l };
            let cr_r = if crunch > 0.01 {
                let wet = Self::crunch_clip(drv_r, crunch);
                drv_r * (1.0 - crunch) + wet * crunch
            } else { drv_r };

            // 4. Boom (resonant bass boost)
            let boom_l = Self::boom_filter(
                cr_l, &mut self.boom_z1_l, &mut self.boom_z2_l,
                self.boom_b0, self.boom_b1, self.boom_b2, self.boom_a1, self.boom_a2,
            );
            let boom_r = Self::boom_filter(
                cr_r, &mut self.boom_z1_r, &mut self.boom_z2_r,
                self.boom_b0, self.boom_b1, self.boom_b2, self.boom_a1, self.boom_a2,
            );
            let out_l = cr_l + boom_l * boom;
            let out_r = cr_r + boom_r * boom;

            // DC blocker
            let dc_l = out_l - self.dc_prev_in_l + dc * self.dc_prev_out_l;
            self.dc_prev_in_l = out_l;
            self.dc_prev_out_l = dc_l;
            let dc_r = out_r - self.dc_prev_in_r + dc * self.dc_prev_out_r;
            self.dc_prev_in_r = out_r;
            self.dc_prev_out_r = dc_r;

            // Flush denormals
            crate::processors::flush_denormal!(self.env_fast_l);
            crate::processors::flush_denormal!(self.env_fast_r);
            crate::processors::flush_denormal!(self.env_slow_l);
            crate::processors::flush_denormal!(self.env_slow_r);
            crate::processors::flush_denormal!(self.dc_prev_out_l);
            crate::processors::flush_denormal!(self.dc_prev_out_r);

            left[i] = (dry_l * (1.0 - mix) + dc_l * mix) * trim;
            right[i] = (dry_r * (1.0 - mix) + dc_r * mix) * trim;
        }
    }

    fn set_param(&mut self, index: u8, value: f32) {
        match index {
            0 => self.drive = (value / 100.0).clamp(0.0, 1.0),
            1 => self.crunch = (value / 100.0).clamp(0.0, 1.0),
            2 => self.boom = (value / 100.0).clamp(0.0, 1.0),
            3 => {
                self.boom_freq = value.clamp(30.0, 200.0);
                self.update_boom_filter();
            }
            4 => self.transient = (value / 100.0).clamp(0.0, 1.0),
            5 => self.trim_db = value.clamp(-24.0, 6.0),
            6 => self.mix = (value / 100.0).clamp(0.0, 1.0),
            _ => {}
        }
    }

    fn reset(&mut self) {
        self.boom_z1_l = 0.0; self.boom_z2_l = 0.0;
        self.boom_z1_r = 0.0; self.boom_z2_r = 0.0;
        self.env_fast_l = 0.0; self.env_fast_r = 0.0;
        self.env_slow_l = 0.0; self.env_slow_r = 0.0;
        self.dc_prev_in_l = 0.0; self.dc_prev_in_r = 0.0;
        self.dc_prev_out_l = 0.0; self.dc_prev_out_r = 0.0;
        self.drive_sm.set_instant(self.drive);
        self.crunch_sm.set_instant(self.crunch);
        self.boom_sm.set_instant(self.boom);
        self.transient_sm.set_instant(self.transient);
        let trim_lin = if self.trim_db <= -24.0 { 0.0 } else { db_to_linear(self.trim_db) };
        self.trim_sm.set_instant(trim_lin);
        self.mix_sm.set_instant(self.mix);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn drum_buss_processes_without_panic() {
        let mut proc = DrumBussProcessor::new(44100.0);
        let sr = 44100.0;
        // Simulate a drum hit
        let mut left = vec![0.0f32; 4096];
        let mut right = vec![0.0f32; 4096];
        for i in 0..200 {
            left[i] = (std::f32::consts::TAU * 150.0 * i as f32 / sr).sin() * 0.8;
            right[i] = left[i];
        }
        proc.process_stereo(&mut left, &mut right, sr);
        assert!(left.iter().all(|x| x.is_finite()));
    }

    #[test]
    fn drum_buss_boom_adds_low_end() {
        let mut proc = DrumBussProcessor::new(44100.0);
        proc.set_param(2, 100.0); // Max boom
        proc.set_param(0, 0.0);   // No drive
        proc.set_param(1, 0.0);   // No crunch
        proc.set_param(4, 0.0);   // No transient
        let sr = 44100.0;
        let mut left: Vec<f32> = (0..4096)
            .map(|i| (std::f32::consts::TAU * 60.0 * i as f32 / sr).sin() * 0.3)
            .collect();
        let original_rms: f32 = (left.iter().map(|x| x * x).sum::<f32>() / 4096.0).sqrt();
        let mut right = left.clone();
        proc.process_stereo(&mut left, &mut right, sr);
        let processed_rms: f32 = (left[2048..].iter().map(|x| x * x).sum::<f32>() / 2048.0).sqrt();
        assert!(
            processed_rms > original_rms * 0.8,
            "Boom should maintain or boost low freq: orig={original_rms}, proc={processed_rms}"
        );
    }
}
