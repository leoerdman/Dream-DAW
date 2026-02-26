// ═══════════════════════════════════════════════════════════════════════════
// Dream DAW — Auto Filter Processor (Enterprise)
// ═══════════════════════════════════════════════════════════════════════════
//
// SVF-based auto filter with:
//   - 4 filter types: LP, HP, BP, Notch
//   - 6 LFO shapes: Sine, Triangle, Saw Up, Saw Down, Square, Random S&H
//   - Envelope follower with adjustable sensitivity
//   - Drive (pre-filter saturation)
//   - Resonance up to self-oscillation
//
// Parameters:
//   0: Cutoff      (20–20000 Hz, default 1000)
//   1: Resonance   (0–100%, default 25%)
//   2: LFO Rate    (0.01–20 Hz, default 1.0)
//   3: LFO Depth   (0–100%, default 50%)
//   4: Env Amount  (-100 to 100%, default 30%)
//   5: Filter Type (0=LP, 1=HP, 2=BP, 3=Notch, default 0)
//   6: Mix         (0–100%, default 100%)
//   7: LFO Shape   (0–5, default 0)
//   8: Drive       (0–24 dB, default 0)
//   9: Env Speed   (1–200 ms, default 20) — envelope follower speed
//
// Real-Time Safety: Zero allocations. O(N) per buffer.
//
// ═══════════════════════════════════════════════════════════════════════════

use crate::dsp_processor::DspProcessor;
use crate::processors::smoothing::SmoothedValue;
use crate::processors::{db_to_linear, sanitize_sample_rate};
use crate::zdf::{ZdfMode, ZdfSvf};

pub struct AutoFilterProcessor {
    cutoff_hz: f32,
    cutoff_target_hz: f32,
    cutoff_smooth_hz: f32,
    resonance: f32,
    lfo_rate: f32,
    lfo_depth: f32,
    env_amount: f32,
    filter_type: u8,
    mix: f32,
    lfo_shape: u8,
    drive_db: f32,
    drive_lin: f32,
    env_speed_ms: f32,
    cutoff_smooth_coeff: f32,
    // State
    lfo_phase: f64,
    env_follower: f32,
    env_coeff: f32,
    /// BUG-C04 FIX: Smoothed attack for envelope follower (~2ms).
    env_attack_coeff: f32,
    // ZDF filter state (per channel)
    zdf_l: ZdfSvf,
    zdf_r: ZdfSvf,
    // Random S&H state — xorshift32 PRNG for deterministic, high-quality randomness
    sh_value: f32,
    sh_phase: f32,
    sh_rng_state: u32,
    sample_rate: f32,
    resonance_sm: SmoothedValue,
    mix_sm: SmoothedValue,
    drive_sm: SmoothedValue,
    lfo_depth_sm: SmoothedValue,
    env_amount_sm: SmoothedValue,
    lfo_rate_sm: SmoothedValue,
}

impl AutoFilterProcessor {
    pub fn new(sample_rate: f32) -> Self {
        let sample_rate = sanitize_sample_rate(sample_rate);
        let env_coeff = crate::fast_math::fast_exp(-1.0 / (20.0 * 0.001 * sample_rate));
        // BUG-C04 FIX: Envelope attack coefficient — prevents instant cutoff slam on clicks.
        let env_attack_coeff = crate::fast_math::fast_exp(-1.0 / (2.0 * 0.001 * sample_rate)); // ~2ms attack
        Self {
            cutoff_hz: 1000.0,
            cutoff_target_hz: 1000.0,
            cutoff_smooth_hz: 1000.0,
            resonance: 0.25,
            lfo_rate: 1.0,
            lfo_depth: 0.5,
            env_amount: 0.3,
            filter_type: 0,
            mix: 1.0,
            lfo_shape: 0,
            drive_db: 0.0,
            drive_lin: 1.0,
            env_speed_ms: 20.0,
            cutoff_smooth_coeff: crate::fast_math::fast_exp(-1.0 / (0.003 * sample_rate)), // ~3ms anti-zipper
            lfo_phase: 0.0,
            env_follower: 0.0,
            env_coeff,
            env_attack_coeff,
            zdf_l: ZdfSvf::new(sample_rate, 1000.0, 0.25, ZdfMode::Lowpass),
            zdf_r: ZdfSvf::new(sample_rate, 1000.0, 0.25, ZdfMode::Lowpass),
            sh_value: 0.0,
            sh_phase: 0.0,
            sh_rng_state: 0xDEAD_BEEF,
            sample_rate,
            resonance_sm: SmoothedValue::new(sample_rate, 8.0, 0.25),
            mix_sm: SmoothedValue::new(sample_rate, 8.0, 1.0),
            drive_sm: SmoothedValue::new(sample_rate, 8.0, 1.0),
            lfo_depth_sm: SmoothedValue::new(sample_rate, 10.0, 0.5),
            env_amount_sm: SmoothedValue::new(sample_rate, 10.0, 0.3),
            lfo_rate_sm: SmoothedValue::new(sample_rate, 10.0, 1.0),
        }
    }

    /// Synchronize with the actual audio device sample rate.
    /// Recalculates all SR-dependent coefficients when the rate changes.
    #[inline]
    fn sync_sample_rate(&mut self, sample_rate: f32) {
        let sr = sanitize_sample_rate(sample_rate);
        if (sr - self.sample_rate).abs() > 0.5 {
            self.sample_rate = sr;
            self.update_env_coeff();
            self.env_attack_coeff = crate::fast_math::fast_exp(-1.0 / (2.0 * 0.001 * sr));
            self.cutoff_smooth_coeff = crate::fast_math::fast_exp(-1.0 / (0.003 * sr));
            self.zdf_l.set_sample_rate(sr);
            self.zdf_r.set_sample_rate(sr);
            self.resonance_sm.set_sample_rate(sr);
            self.mix_sm.set_sample_rate(sr);
            self.drive_sm.set_sample_rate(sr);
            self.lfo_depth_sm.set_sample_rate(sr);
            self.env_amount_sm.set_sample_rate(sr);
            self.lfo_rate_sm.set_sample_rate(sr);
        }
    }

    /// xorshift32 PRNG — deterministic, fast, zero-alloc.
    #[inline]
    fn next_sh_random(&mut self) -> f32 {
        let mut x = self.sh_rng_state;
        x ^= x << 13;
        x ^= x >> 17;
        x ^= x << 5;
        self.sh_rng_state = x;
        // Map to [-1, 1)
        (x as i32 as f64 / i32::MAX as f64) as f32
    }

    fn update_env_coeff(&mut self) {
        self.env_coeff = crate::fast_math::fast_exp(-1.0 / (self.env_speed_ms * 0.001 * self.sample_rate));
    }

    #[inline]
    fn lfo_value(&mut self, phase: f32) -> f32 {
        match self.lfo_shape {
            1 => 1.0 - 4.0 * (phase - 0.5).abs(), // Triangle
            2 => 2.0 * phase - 1.0,               // Saw Up
            3 => 1.0 - 2.0 * phase,               // Saw Down
            4 => {
                if phase < 0.5 {
                    1.0
                } else {
                    -1.0
                }
            } // Square
            5 => {
                // Random Sample & Hold — xorshift32 PRNG for high-quality randomness
                // BUG-C05 FIX: Use modular subtraction instead of unbounded accumulation.
                // Old code: `self.sh_phase += 1.0` — as f32, precision degrades after
                // ~16M calls (~6 min at 44.1kHz), causing S&H to freeze.
                let thresh = self.sample_rate / self.lfo_rate.max(0.01);
                self.sh_phase += 1.0;
                if self.sh_phase >= thresh {
                    self.sh_phase -= thresh;
                    self.sh_value = self.next_sh_random();
                }
                self.sh_value
            }
            _ => {
                // 0 (Sine) or any unknown: fast Bhaskara approximation
                crate::fast_math::fast_sin(phase)
            }
        }
    }

    #[inline(always)]
    fn zdf_mode(filter_type: u8) -> ZdfMode {
        match filter_type {
            1 => ZdfMode::Highpass,
            2 => ZdfMode::Bandpass,
            3 => ZdfMode::Notch,
            _ => ZdfMode::Lowpass,
        }
    }
}

impl DspProcessor for AutoFilterProcessor {
    fn process_stereo(&mut self, left: &mut [f32], right: &mut [f32], sample_rate: f32) {
        // BUG-1 FIX: Sync sample rate from the audio driver — recalculates
        // env_coeff and ensures SVF cutoff uses the correct SR.
        self.sync_sample_rate(sample_rate);

        let len = left.len().min(right.len());
        let sr = self.sample_rate;
        let lfo_stereo_phase_offset = 0.20f32;
        let zdf_mode = Self::zdf_mode(self.filter_type);
        self.resonance_sm.set_target(self.resonance.clamp(0.0, 1.0));
        self.mix_sm.set_target(self.mix.clamp(0.0, 1.0));
        self.drive_sm.set_target(self.drive_lin.max(0.0));
        self.lfo_depth_sm.set_target(self.lfo_depth.clamp(0.0, 1.0));
        self.env_amount_sm
            .set_target(self.env_amount.clamp(-1.0, 1.0));
        self.lfo_rate_sm.set_target(self.lfo_rate.clamp(0.01, 20.0));

        let max_range = (20000.0_f32 / 20.0).log2(); // ≈ 9.97

        for i in 0..len {
            let dry_l = left[i];
            let dry_r = right[i];
            let zdf_res = (self.resonance_sm.next_value() * 0.98).clamp(0.0, 0.98);
            let mix = self.mix_sm.next_value();
            let drive = self.drive_sm.next_value();
            let lfo_depth = self.lfo_depth_sm.next_value();
            let env_amount = self.env_amount_sm.next_value();
            let lfo_rate = self.lfo_rate_sm.next_value();

            // Envelope follower
            // BUG-C04 FIX: Attack path now uses smoothed attack coefficient instead
            // of instant jump. Prevents cutoff slam on single loud clicks/pops.
            let peak = dry_l.abs().max(dry_r.abs());
            if peak > self.env_follower {
                self.env_follower = self.env_attack_coeff * self.env_follower
                    + (1.0 - self.env_attack_coeff) * peak;
            } else {
                self.env_follower =
                    self.env_coeff * self.env_follower + (1.0 - self.env_coeff) * peak;
            }

            // LFO
            let phase = (self.lfo_phase as f32).fract();
            let lfo_l = self.lfo_value(phase);
            // For random S&H keep L/R tied (same held value) to avoid noisey jumps.
            let lfo_r = if self.lfo_shape == 5 {
                lfo_l
            } else {
                self.lfo_value((phase + lfo_stereo_phase_offset).fract())
            };
            self.lfo_phase += lfo_rate as f64 / sr as f64;
            self.lfo_phase = self.lfo_phase.fract();

            // Smooth cutoff target per sample to avoid zipper artifacts during automation.
            self.cutoff_smooth_hz = self.cutoff_smooth_coeff * self.cutoff_smooth_hz
                + (1.0 - self.cutoff_smooth_coeff) * self.cutoff_target_hz;

            // Modulated cutoff (log scale).
            let base_log_cutoff = (self.cutoff_smooth_hz / 20.0).max(1.0).log2();
            let mod_offset_l =
                lfo_l * lfo_depth * max_range * 0.5 + self.env_follower * env_amount * max_range;
            let mod_offset_r =
                lfo_r * lfo_depth * max_range * 0.5 + self.env_follower * env_amount * max_range;
            let nyq_safe_max = (sr * 0.45).max(40.0);
            let mod_cutoff_l = (20.0
                * crate::fast_math::fast_exp2((base_log_cutoff + mod_offset_l).clamp(0.0, max_range)))
            .clamp(20.0, nyq_safe_max);
            let mod_cutoff_r = (20.0
                * crate::fast_math::fast_exp2((base_log_cutoff + mod_offset_r).clamp(0.0, max_range)))
            .clamp(20.0, nyq_safe_max);

            // Drive
            let driven_l = crate::fast_math::fast_tanh(dry_l * drive);
            let driven_r = crate::fast_math::fast_tanh(dry_r * drive);

            // ZDF/TPT filter core
            self.zdf_l.set_mode(zdf_mode);
            self.zdf_r.set_mode(zdf_mode);
            self.zdf_l.set_params(mod_cutoff_l, zdf_res);
            self.zdf_r.set_params(mod_cutoff_r, zdf_res);
            let wet_l = self.zdf_l.process(driven_l);
            let wet_r = self.zdf_r.process(driven_r);

            // BUG-3 FIX: Clamp output to prevent runaway levels from
            // high resonance + drive combinations (self-oscillation guard).
            left[i] = (dry_l * (1.0 - mix) + wet_l * mix).clamp(-8.0, 8.0);
            right[i] = (dry_r * (1.0 - mix) + wet_r * mix).clamp(-8.0, 8.0);

            // Flush denormals in envelope follower state.
            if self.env_follower < 1.0e-20 {
                self.env_follower = 0.0;
            }
        }
    }

    fn set_param(&mut self, index: u8, value: f32) {
        match index {
            0 => {
                let cutoff = value.clamp(20.0, 20000.0);
                self.cutoff_hz = cutoff;
                self.cutoff_target_hz = cutoff;
            }
            1 => self.resonance = (value / 100.0).clamp(0.0, 1.0),
            2 => self.lfo_rate = value.clamp(0.01, 20.0),
            3 => self.lfo_depth = (value / 100.0).clamp(0.0, 1.0),
            4 => self.env_amount = (value / 100.0).clamp(-1.0, 1.0),
            5 => self.filter_type = (value as u8).min(3),
            6 => self.mix = (value / 100.0).clamp(0.0, 1.0),
            7 => self.lfo_shape = (value as u8).min(5),
            8 => {
                self.drive_db = value.clamp(0.0, 24.0);
                self.drive_lin = db_to_linear(self.drive_db);
            }
            9 => {
                self.env_speed_ms = value.clamp(1.0, 200.0);
                self.update_env_coeff();
            }
            _ => {}
        }
    }

    fn reset(&mut self) {
        self.lfo_phase = 0.0;
        self.env_follower = 0.0;
        self.zdf_l.reset();
        self.zdf_r.reset();
        self.sh_value = 0.0;
        self.sh_phase = 0.0;
        self.sh_rng_state = 0xDEAD_BEEF;
        // BUG-H19 FIX: Reset cutoff smoother to prevent old-value artifact on re-start.
        self.cutoff_smooth_hz = self.cutoff_target_hz;
        self.resonance_sm
            .set_instant(self.resonance.clamp(0.0, 1.0));
        self.mix_sm.set_instant(self.mix.clamp(0.0, 1.0));
        self.drive_sm.set_instant(self.drive_lin.max(0.0));
        self.lfo_depth_sm
            .set_instant(self.lfo_depth.clamp(0.0, 1.0));
        self.env_amount_sm
            .set_instant(self.env_amount.clamp(-1.0, 1.0));
        self.lfo_rate_sm
            .set_instant(self.lfo_rate.clamp(0.01, 20.0));
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn auto_filter_processes_without_panic() {
        let mut proc = AutoFilterProcessor::new(44100.0);
        let mut l = vec![0.5f32; 512];
        let mut r = vec![0.5f32; 512];
        proc.process_stereo(&mut l, &mut r, 44100.0);
    }

    #[test]
    fn auto_filter_lp_attenuates_high_freq() {
        let mut proc = AutoFilterProcessor::new(44100.0);
        proc.set_param(0, 200.0); // Low cutoff
        proc.set_param(3, 0.0); // No LFO
        proc.set_param(4, 0.0); // No envelope
        proc.set_param(6, 100.0); // Full wet
        let sr = 44100.0;
        let mut l: Vec<f32> = (0..4096)
            .map(|i| (2.0 * std::f32::consts::PI * 10000.0 * i as f32 / sr).sin())
            .collect();
        let mut r = l.clone();
        proc.process_stereo(&mut l, &mut r, sr);
        let energy: f32 = l[1024..].iter().map(|s| s * s).sum();
        assert!(
            energy < 100.0,
            "10kHz should be attenuated with 200Hz LP: {energy}"
        );
    }

    #[test]
    fn auto_filter_all_lfo_shapes() {
        for shape in 0..=5u8 {
            let mut proc = AutoFilterProcessor::new(44100.0);
            proc.set_param(7, shape as f32);
            let mut l = vec![0.3f32; 2048];
            let mut r = vec![0.3f32; 2048];
            proc.process_stereo(&mut l, &mut r, 44100.0);
        }
    }

    #[test]
    fn auto_filter_stereo_lfo_decorrelates_channels() {
        let mut proc = AutoFilterProcessor::new(44100.0);
        proc.set_param(5, 0.0); // LP
        proc.set_param(2, 2.5); // LFO rate
        proc.set_param(3, 80.0); // LFO depth
        proc.set_param(4, 0.0); // no envelope
        proc.set_param(7, 0.0); // sine
        proc.set_param(6, 100.0); // wet

        let mut l = vec![0.2f32; 4096];
        let mut r = vec![0.2f32; 4096];
        proc.process_stereo(&mut l, &mut r, 44100.0);

        let diff_energy: f32 = l
            .iter()
            .zip(r.iter())
            .map(|(a, b)| {
                let d = a - b;
                d * d
            })
            .sum();
        assert!(
            diff_energy > 1.0e-6,
            "Stereo LFO should decorrelate channels"
        );
    }
}
