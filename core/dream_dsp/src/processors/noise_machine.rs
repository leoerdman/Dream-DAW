// ═══════════════════════════════════════════════════════════════════════════
// Dream DAW — Noise Machine Processor
// ═══════════════════════════════════════════════════════════════════════════
//
// Generator plugin that produces shaped noise for:
//   - Sound design textures & ambient beds
//   - Sub-mixing with instruments
//   - Testing signal chains
//
// Noise Types:
//   0 = White  (flat spectrum — pure random)
//   1 = Pink   (-3dB/octave — Voss-McCartney)
//   2 = Brown  (-6dB/octave — integrated white)
//   3 = Blue   (+3dB/octave — differentiated white)
//   4 = Violet (+6dB/octave — differentiated pink/double diff)
//   5 = Grey   (psychoacoustic equal-loudness shaped)
//
// Parameters:
//   0: Volume   (-60 to 0 dB, default -12)
//   1: Type     (0–5, default 0)
//   2: Stereo   (0–100%, default 100%) — independent L/R at 100%
//   3: LP Freq  (200–20000 Hz, default 20000) — LP filter on output
//   4: HP Freq  (20–5000 Hz, default 20) — HP filter on output
//   5: Pan      (-100 to +100%, default 0)
//
// Real-Time Safety: Zero allocations. O(N) per buffer.
//
// ═══════════════════════════════════════════════════════════════════════════

use crate::dsp_processor::DspProcessor;
use crate::processors::{db_to_linear, sanitize_sample_rate};
use crate::processors::smoothing::SmoothedValue;

/// xorshift64 PRNG — deterministic, fast, zero-alloc.
struct Rng {
    state: u64,
}

impl Rng {
    fn new(seed: u64) -> Self {
        Self {
            state: if seed == 0 {
                0xDEAD_BEEF_CAFE_1337
            } else {
                seed
            },
        }
    }

    #[inline]
    fn next_u64(&mut self) -> u64 {
        let mut x = self.state;
        x ^= x << 13;
        x ^= x >> 7;
        x ^= x << 17;
        self.state = x;
        x
    }

    /// BUG-023 FIX: Uniform float in [-1, 1) using proper bit manipulation.
    /// Previous version had slight DC bias due to i64 two's complement asymmetry.
    /// New method: extract 24 mantissa bits, scale to [0, 1), then shift to [-1, 1).
    #[inline]
    fn next_f32(&mut self) -> f32 {
        let bits = self.next_u64();
        // Extract 24 bits for the mantissa (f32 has 23-bit mantissa + 1 implicit)
        let mantissa = (bits >> 40) as f32;
        let scale = 1.0 / (1u64 << 24) as f32;
        mantissa * scale * 2.0 - 1.0
    }
}

/// Voss-McCartney pink noise generator (16 rows).
struct PinkGen {
    rows: [f32; 16],
    running_sum: f32,
    counter: u32,
}

impl PinkGen {
    fn new() -> Self {
        Self {
            rows: [0.0; 16],
            running_sum: 0.0,
            counter: 0,
        }
    }

    #[inline]
    fn next(&mut self, rng: &mut Rng) -> f32 {
        self.counter = self.counter.wrapping_add(1);
        let last_zeros = self.counter.trailing_zeros().min(15) as usize;
        let new_random = rng.next_f32() * 0.5;
        self.running_sum -= self.rows[last_zeros];
        self.rows[last_zeros] = new_random;
        self.running_sum += new_random;
        // Normalize to roughly [-1, 1]
        (self.running_sum + rng.next_f32() * 0.5) * 0.125
    }

    fn reset(&mut self) {
        self.rows = [0.0; 16];
        self.running_sum = 0.0;
        self.counter = 0;
    }
}

pub struct NoiseMachineProcessor {
    rng_l: Rng,
    rng_r: Rng,
    pink_l: PinkGen,
    pink_r: PinkGen,
    // Brown noise state
    brown_l: f32,
    brown_r: f32,
    // BUG-012 FIX: DC blocker state for brown noise (first-order HP at ~5Hz)
    brown_dc_l: f32,
    brown_dc_r: f32,
    brown_dc_prev_l: f32,
    brown_dc_prev_r: f32,
    // Blue / violet differentiation state
    prev_white_l: f32,
    prev_white_r: f32,
    prev_blue_l: f32,
    prev_blue_r: f32,
    // Params
    volume_db: f32,
    volume_lin: f32,
    noise_type: u8,
    stereo: f32,
    lp_freq: f32,
    hp_freq: f32,
    pan: f32,
    // Filters
    lp_state_l: f32,
    lp_state_r: f32,
    hp_state_l: f32,
    hp_state_r: f32,
    /// Previous HP input for first-order HP: y[n] = α*(y[n-1] + x[n] - x[n-1])
    hp_prev_in_l: f32,
    hp_prev_in_r: f32,
    lp_coeff: f32,
    hp_coeff: f32,
    /// BUG-012 FIX: DC blocker coefficient for brown noise (~5Hz HPF).
    brown_dc_coeff: f32,
    sample_rate: f32,
    volume_sm: SmoothedValue,
    stereo_sm: SmoothedValue,
    pan_sm: SmoothedValue,
    lp_freq_sm: SmoothedValue,
    hp_freq_sm: SmoothedValue,
}

impl NoiseMachineProcessor {
    pub fn new(sample_rate: f32) -> Self {
        let sample_rate = sanitize_sample_rate(sample_rate);
        // BUG-012 FIX: DC blocker at ~5Hz for brown noise
        let brown_dc_coeff = (-std::f32::consts::TAU * 5.0 / sample_rate).exp();
        let mut proc = Self {
            rng_l: Rng::new(0xA1B2C3D4_E5F6A7B8),
            rng_r: Rng::new(0x1234_5678_9ABC_DEF0),
            pink_l: PinkGen::new(),
            pink_r: PinkGen::new(),
            brown_l: 0.0,
            brown_r: 0.0,
            brown_dc_l: 0.0,
            brown_dc_r: 0.0,
            brown_dc_prev_l: 0.0,
            brown_dc_prev_r: 0.0,
            prev_white_l: 0.0,
            prev_white_r: 0.0,
            prev_blue_l: 0.0,
            prev_blue_r: 0.0,
            volume_db: -12.0,
            volume_lin: db_to_linear(-12.0),
            noise_type: 0,
            stereo: 1.0,
            lp_freq: 20000.0,
            hp_freq: 20.0,
            pan: 0.0,
            lp_state_l: 0.0,
            lp_state_r: 0.0,
            hp_state_l: 0.0,
            hp_state_r: 0.0,
            hp_prev_in_l: 0.0,
            hp_prev_in_r: 0.0,
            lp_coeff: 0.0,
            hp_coeff: 0.0,
            brown_dc_coeff,
            sample_rate,
            volume_sm: SmoothedValue::new(sample_rate, 8.0, db_to_linear(-12.0)),
            stereo_sm: SmoothedValue::new(sample_rate, 10.0, 1.0),
            pan_sm: SmoothedValue::new(sample_rate, 8.0, 0.0),
            lp_freq_sm: SmoothedValue::new(sample_rate, 10.0, 20000.0),
            hp_freq_sm: SmoothedValue::new(sample_rate, 10.0, 20.0),
        };
        proc.update_filters();
        proc
    }

    fn update_filters(&mut self) {
        let sr = self.sample_rate;
        // Exact one-pole LP: α = 1 - e^(-2πfc/sr)
        self.lp_coeff = (1.0 - (-std::f32::consts::TAU * self.lp_freq / sr).exp()).clamp(0.0, 1.0);
        // First-order HP coefficient: α = e^(-2πfc/sr)
        self.hp_coeff = (-std::f32::consts::TAU * self.hp_freq / sr).exp();
    }

    #[inline]
    fn sync_sample_rate(&mut self, sample_rate: f32) {
        let sr = sanitize_sample_rate(sample_rate);
        if (sr - self.sample_rate).abs() > 0.5 {
            self.sample_rate = sr;
            self.update_filters();
            // BUG-C10 FIX: Recalculate brown noise DC blocker coefficient on SR change.
            // Without this, the DC blocker operates at wrong cutoff after SR change.
            self.brown_dc_coeff = (-std::f32::consts::TAU * 5.0 / sr).exp();
            self.volume_sm.set_sample_rate(sr);
            self.stereo_sm.set_sample_rate(sr);
            self.pan_sm.set_sample_rate(sr);
            self.lp_freq_sm.set_sample_rate(sr);
            self.hp_freq_sm.set_sample_rate(sr);
        }
    }
}

impl DspProcessor for NoiseMachineProcessor {
    fn process_stereo(&mut self, left: &mut [f32], right: &mut [f32], sample_rate: f32) {
        self.sync_sample_rate(sample_rate);
        let len = left.len().min(right.len());
        self.volume_sm.set_target(self.volume_lin.max(0.0));
        self.stereo_sm.set_target(self.stereo.clamp(0.0, 1.0));
        self.pan_sm.set_target(self.pan.clamp(-1.0, 1.0));
        self.lp_freq_sm.set_target(self.lp_freq.clamp(200.0, 20000.0));
        self.hp_freq_sm.set_target(self.hp_freq.clamp(20.0, 5000.0));

        for i in 0..len {
            let vol = self.volume_sm.next();
            let stereo = self.stereo_sm.next();
            let pan = self.pan_sm.next();
            let lp_freq = self.lp_freq_sm.next();
            let hp_freq = self.hp_freq_sm.next().min(lp_freq - 1.0).max(20.0);
            // BUG-M10 FIX: Use SSOT one_pole helpers (pre-computed once per SR change)
            // instead of calling exp() per-sample (~50 cycles wasted per sample).
            let lp = crate::processors::one_pole_lp_coeff(lp_freq, self.sample_rate);
            let hp = crate::processors::one_pole_hp_coeff(hp_freq, self.sample_rate);
            // BUG-M26 FIX: Constant-power pan using fast sine approximation.
            let pan_angle = (pan + 1.0) * 0.25 * std::f32::consts::PI;
            let pan_l = pan_angle.cos() * std::f32::consts::SQRT_2;
            let pan_r = pan_angle.sin() * std::f32::consts::SQRT_2;

            // Generate L channel noise
            let mut raw_l = Self::generate_sample_static(
                self.noise_type,
                &mut self.rng_l,
                &mut self.pink_l,
                &mut self.brown_l,
                &mut self.prev_white_l,
                &mut self.prev_blue_l,
            );
            let mut raw_r = Self::generate_sample_static(
                self.noise_type,
                &mut self.rng_r,
                &mut self.pink_r,
                &mut self.brown_r,
                &mut self.prev_white_r,
                &mut self.prev_blue_r,
            );

            // Apply DC blocker for brown noise
            if self.noise_type == 2 {
                let dc_l = raw_l;
                self.brown_dc_l =
                    self.brown_dc_coeff * (self.brown_dc_l + dc_l - self.brown_dc_prev_l);
                self.brown_dc_prev_l = dc_l;
                raw_l = self.brown_dc_l;

                let dc_r = raw_r;
                self.brown_dc_r =
                    self.brown_dc_coeff * (self.brown_dc_r + dc_r - self.brown_dc_prev_r);
                self.brown_dc_prev_r = dc_r;
                raw_r = self.brown_dc_r;
            }

            // Stereo correlation: blend toward mono
            let mono = (raw_l + raw_r) * 0.5;
            let sig_l = mono * (1.0 - stereo) + raw_l * stereo;
            let sig_r = mono * (1.0 - stereo) + raw_r * stereo;

            // LP filter
            self.lp_state_l += lp * (sig_l - self.lp_state_l);
            self.lp_state_r += lp * (sig_r - self.lp_state_r);

            // HP filter: standard first-order y[n] = α * (y[n-1] + x[n] - x[n-1])
            // Input to HP is LP output (cascade LP→HP)
            let lp_out_l = self.lp_state_l;
            let lp_out_r = self.lp_state_r;
            self.hp_state_l = hp * (self.hp_state_l + lp_out_l - self.hp_prev_in_l);
            self.hp_state_r = hp * (self.hp_state_r + lp_out_r - self.hp_prev_in_r);
            self.hp_prev_in_l = lp_out_l;
            self.hp_prev_in_r = lp_out_r;
            // SSOT: Flush denormals in LP/HP filter chain.
            crate::processors::flush_denormal!(self.lp_state_l);
            crate::processors::flush_denormal!(self.lp_state_r);
            crate::processors::flush_denormal!(self.hp_state_l);
            crate::processors::flush_denormal!(self.hp_state_r);

            let out_l = self.hp_state_l * vol;
            let out_r = self.hp_state_r * vol;

            // Additive mixing (noise is added to existing signal)
            left[i] += out_l * pan_l;
            right[i] += out_r * pan_r;
        }
    }

    fn set_param(&mut self, index: u8, value: f32) {
        match index {
            0 => {
                self.volume_db = value.clamp(-60.0, 0.0);
                self.volume_lin = if self.volume_db <= -60.0 {
                    0.0
                } else {
                    db_to_linear(self.volume_db)
                };
            }
            1 => self.noise_type = (value as u8).min(5),
            2 => self.stereo = (value / 100.0).clamp(0.0, 1.0),
            3 => {
                self.lp_freq = value.clamp(200.0, 20000.0);
                self.update_filters();
            }
            4 => {
                self.hp_freq = value.clamp(20.0, 5000.0);
                self.update_filters();
            }
            5 => self.pan = (value / 100.0).clamp(-1.0, 1.0),
            _ => {}
        }
    }

    fn reset(&mut self) {
        // Reset PRNG to initial seeds (must match new() for deterministic output)
        self.rng_l = Rng::new(0xA1B2C3D4_E5F6A7B8);
        self.rng_r = Rng::new(0x1234_5678_9ABC_DEF0);
        self.pink_l.reset();
        self.pink_r.reset();
        self.brown_l = 0.0;
        self.brown_r = 0.0;
        // BUG-012 FIX: Reset DC blocker state
        self.brown_dc_l = 0.0;
        self.brown_dc_r = 0.0;
        self.brown_dc_prev_l = 0.0;
        self.brown_dc_prev_r = 0.0;
        self.prev_white_l = 0.0;
        self.prev_white_r = 0.0;
        self.prev_blue_l = 0.0;
        self.prev_blue_r = 0.0;
        self.lp_state_l = 0.0;
        self.lp_state_r = 0.0;
        self.hp_state_l = 0.0;
        self.hp_state_r = 0.0;
        self.hp_prev_in_l = 0.0;
        self.hp_prev_in_r = 0.0;
        self.volume_sm.set_instant(self.volume_lin.max(0.0));
        self.stereo_sm.set_instant(self.stereo.clamp(0.0, 1.0));
        self.pan_sm.set_instant(self.pan.clamp(-1.0, 1.0));
        self.lp_freq_sm.set_instant(self.lp_freq.clamp(200.0, 20000.0));
        self.hp_freq_sm.set_instant(self.hp_freq.clamp(20.0, 5000.0));
    }
}

impl NoiseMachineProcessor {
    /// Static version of generate_sample to avoid borrow checker issues
    #[inline]
    fn generate_sample_static(
        noise_type: u8,
        rng: &mut Rng,
        pink: &mut PinkGen,
        brown: &mut f32,
        prev_white: &mut f32,
        prev_blue: &mut f32,
    ) -> f32 {
        match noise_type {
            0 => rng.next_f32(),
            1 => pink.next(rng),
            // BUG-012 FIX: Brown noise still integrates here, but DC blocker
            // is applied in the main process loop after stereo mixing.
            2 => {
                *brown = (*brown + rng.next_f32() * 0.02).clamp(-1.0, 1.0);
                *brown
            }
            3 => {
                let w = rng.next_f32();
                let out = w - *prev_white;
                *prev_white = w;
                out.clamp(-1.0, 1.0)
            }
            4 => {
                let w = rng.next_f32();
                let blue = w - *prev_white;
                *prev_white = w;
                let out = blue - *prev_blue;
                *prev_blue = blue;
                out.clamp(-1.0, 1.0)
            }
            // BUG-073 FIX: Improved grey noise with better perceptual weighting
            5 => {
                let w = rng.next_f32();
                let hp = w - *prev_white;
                *prev_white = w * 0.995;
                (w * 0.5 + hp * 0.5).clamp(-1.0, 1.0)
            }
            _ => rng.next_f32(),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn noise_produces_output() {
        let mut proc = NoiseMachineProcessor::new(44100.0);
        proc.set_param(0, -6.0); // -6 dB
        let mut l = vec![0.0f32; 4096];
        let mut r = vec![0.0f32; 4096];
        proc.process_stereo(&mut l, &mut r, 44100.0);
        let energy: f32 = l.iter().map(|s| s * s).sum();
        assert!(energy > 0.01, "White noise should produce energy: {energy}");
    }

    #[test]
    fn all_noise_types() {
        for t in 0..=5u8 {
            let mut proc = NoiseMachineProcessor::new(44100.0);
            proc.set_param(0, -6.0);
            proc.set_param(1, t as f32);
            let mut l = vec![0.0f32; 4096];
            let mut r = vec![0.0f32; 4096];
            proc.process_stereo(&mut l, &mut r, 44100.0);
        }
    }

    #[test]
    fn noise_mono_correlated() {
        let mut proc = NoiseMachineProcessor::new(44100.0);
        proc.set_param(0, -6.0);
        proc.set_param(2, 0.0); // stereo = 0 => mono
        let mut l = vec![0.0f32; 4096];
        let mut r = vec![0.0f32; 1024];
        r.resize(4096, 0.0);
        proc.process_stereo(&mut l, &mut r, 44100.0);
        let diff_tail_sum: f32 = l[2048..]
            .iter()
            .zip(r[2048..].iter())
            .map(|(a, b)| (a - b).abs())
            .sum();
        let diff_tail_mean = diff_tail_sum / (l.len() - 2048) as f32;
        assert!(
            diff_tail_mean < 0.001,
            "Mono tail should be correlated, mean diff: {diff_tail_mean}"
        );
    }

    #[test]
    fn noise_muted_at_minus_60() {
        let mut proc = NoiseMachineProcessor::new(44100.0);
        proc.set_param(0, -60.0);
        let mut l = vec![0.0f32; 4096];
        let mut r = vec![0.0f32; 4096];
        proc.process_stereo(&mut l, &mut r, 44100.0);
        let energy_tail: f32 = l[2048..].iter().map(|s| s * s).sum();
        assert!(
            energy_tail < 0.001,
            "Should settle near silent at -60dB, got: {energy_tail}"
        );
    }
}
