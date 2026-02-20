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

pub struct AutoFilterProcessor {
    cutoff_hz: f32,
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
    // State
    lfo_phase: f64,
    env_follower: f32,
    env_coeff: f32,
    // SVF filter state (per channel)
    ic1eq_l: f32,
    ic2eq_l: f32,
    ic1eq_r: f32,
    ic2eq_r: f32,
    // Random S&H state — xorshift32 PRNG for deterministic, high-quality randomness
    sh_value: f32,
    sh_phase: f32,
    sh_rng_state: u32,
    sample_rate: f32,
}

impl AutoFilterProcessor {
    pub fn new(sample_rate: f32) -> Self {
        let env_coeff = (-1.0 / (20.0 * 0.001 * sample_rate)).exp();
        Self {
            cutoff_hz: 1000.0,
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
            lfo_phase: 0.0,
            env_follower: 0.0,
            env_coeff,
            ic1eq_l: 0.0,
            ic2eq_l: 0.0,
            ic1eq_r: 0.0,
            ic2eq_r: 0.0,
            sh_value: 0.0,
            sh_phase: 0.0,
            sh_rng_state: 0xDEAD_BEEF,
            sample_rate,
        }
    }

    /// Synchronize with the actual audio device sample rate.
    /// Recalculates all SR-dependent coefficients when the rate changes.
    #[inline]
    fn sync_sample_rate(&mut self, sample_rate: f32) {
        if sample_rate.is_finite()
            && sample_rate > 1000.0
            && (sample_rate - self.sample_rate).abs() > 0.5
        {
            self.sample_rate = sample_rate;
            self.update_env_coeff();
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
        self.env_coeff = (-1.0 / (self.env_speed_ms * 0.001 * self.sample_rate)).exp();
    }

    #[inline]
    fn lfo_value(&mut self, phase: f32) -> f32 {
        match self.lfo_shape {
            0 => (phase * std::f32::consts::TAU).sin(), // Sine
            1 => 1.0 - 4.0 * (phase - 0.5).abs(),       // Triangle
            2 => 2.0 * phase - 1.0,                     // Saw Up
            3 => 1.0 - 2.0 * phase,                     // Saw Down
            4 => {
                if phase < 0.5 {
                    1.0
                } else {
                    -1.0
                }
            } // Square
            5 => {
                // Random Sample & Hold — xorshift32 PRNG for high-quality randomness
                self.sh_phase += 1.0;
                if self.sh_phase >= self.sample_rate / self.lfo_rate.max(0.01) {
                    self.sh_phase = 0.0;
                    self.sh_value = self.next_sh_random();
                }
                self.sh_value
            }
            _ => (phase * std::f32::consts::TAU).sin(),
        }
    }

    /// SVF process (Cytomic/Andy Simper topology).
    #[inline]
    fn svf_process(
        signal: f32,
        cutoff: f32,
        q: f32,
        sr: f32,
        ic1eq: &mut f32,
        ic2eq: &mut f32,
        filter_type: u8,
    ) -> f32 {
        let g = (std::f32::consts::PI * cutoff / sr).tan();
        let k = 1.0 / q;
        let a1 = 1.0 / (1.0 + g * (g + k));
        let a2 = g * a1;
        let a3 = g * a2;

        let v3 = signal - *ic2eq;
        let v1 = a1 * *ic1eq + a2 * v3;
        let v2 = *ic2eq + a2 * *ic1eq + a3 * v3;

        *ic1eq = 2.0 * v1 - *ic1eq;
        *ic2eq = 2.0 * v2 - *ic2eq;

        match filter_type {
            0 => v2,                   // LP
            1 => signal - k * v1 - v2, // HP
            2 => v1,                   // BP
            3 => signal - k * v1,      // Notch
            _ => v2,
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
        let lfo_inc = self.lfo_rate as f64 / sr as f64;
        let ft = self.filter_type;
        let q = 0.5 + self.resonance * 15.0; // 0.5 to ~15
        let mix = self.mix;

        // BUG-034 FIX: Pre-compute base log2(cutoff) outside the loop.
        // Avoids log2() + powf() per sample (~100ns → ~10ns savings per sample).
        let base_log_cutoff = (self.cutoff_hz / 20.0).max(1.0).log2();
        let max_range = (20000.0_f32 / 20.0).log2(); // ≈ 9.97

        for i in 0..len {
            let dry_l = left[i];
            let dry_r = right[i];

            // Envelope follower
            let peak = dry_l.abs().max(dry_r.abs());
            if peak > self.env_follower {
                self.env_follower = peak;
            } else {
                self.env_follower =
                    self.env_coeff * self.env_follower + (1.0 - self.env_coeff) * peak;
            }

            // LFO
            let phase = (self.lfo_phase as f32).fract();
            let lfo = self.lfo_value(phase);
            self.lfo_phase += lfo_inc;
            if self.lfo_phase >= 1.0 {
                self.lfo_phase -= 1.0;
            }

            // Modulated cutoff (log scale) — BUG-034 FIX: base_log_cutoff pre-computed
            let mod_offset = lfo * self.lfo_depth * max_range * 0.5
                + self.env_follower * self.env_amount * max_range;
            let mod_cutoff = (20.0 * 2.0_f32.powf((base_log_cutoff + mod_offset).clamp(0.0, max_range)))
                .clamp(20.0, 20000.0);

            // Drive
            let driven_l = (dry_l * self.drive_lin).tanh();
            let driven_r = (dry_r * self.drive_lin).tanh();

            // SVF
            let wet_l = Self::svf_process(
                driven_l,
                mod_cutoff,
                q,
                sr,
                &mut self.ic1eq_l,
                &mut self.ic2eq_l,
                ft,
            );
            let wet_r = Self::svf_process(
                driven_r,
                mod_cutoff,
                q,
                sr,
                &mut self.ic1eq_r,
                &mut self.ic2eq_r,
                ft,
            );

            // BUG-3 FIX: Clamp output to prevent runaway levels from
            // high resonance + drive combinations (self-oscillation guard).
            left[i] = (dry_l * (1.0 - mix) + wet_l * mix).clamp(-8.0, 8.0);
            right[i] = (dry_r * (1.0 - mix) + wet_r * mix).clamp(-8.0, 8.0);

            // BUG-AUD-107 FIX: Flush denormals in SVF integrator and envelope
            // follower states to prevent CPU stalls during silence.
            if self.ic1eq_l.abs() < 1.0e-20 {
                self.ic1eq_l = 0.0;
            }
            if self.ic2eq_l.abs() < 1.0e-20 {
                self.ic2eq_l = 0.0;
            }
            if self.ic1eq_r.abs() < 1.0e-20 {
                self.ic1eq_r = 0.0;
            }
            if self.ic2eq_r.abs() < 1.0e-20 {
                self.ic2eq_r = 0.0;
            }
            if self.env_follower < 1.0e-20 {
                self.env_follower = 0.0;
            }
        }
    }

    fn set_param(&mut self, index: u8, value: f32) {
        match index {
            0 => self.cutoff_hz = value.clamp(20.0, 20000.0),
            1 => self.resonance = (value / 100.0).clamp(0.0, 1.0),
            2 => self.lfo_rate = value.clamp(0.01, 20.0),
            3 => self.lfo_depth = (value / 100.0).clamp(0.0, 1.0),
            4 => self.env_amount = (value / 100.0).clamp(-1.0, 1.0),
            5 => self.filter_type = (value as u8).min(3),
            6 => self.mix = (value / 100.0).clamp(0.0, 1.0),
            7 => self.lfo_shape = (value as u8).min(5),
            8 => {
                self.drive_db = value.clamp(0.0, 24.0);
                self.drive_lin = 10.0_f32.powf(self.drive_db / 20.0);
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
        self.ic1eq_l = 0.0;
        self.ic2eq_l = 0.0;
        self.ic1eq_r = 0.0;
        self.ic2eq_r = 0.0;
        self.sh_value = 0.0;
        self.sh_phase = 0.0;
        self.sh_rng_state = 0xDEAD_BEEF;
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
}
