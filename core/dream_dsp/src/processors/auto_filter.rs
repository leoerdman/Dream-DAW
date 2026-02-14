// ═══════════════════════════════════════════════════════════════════════════
// Dream DAW — Auto Filter Processor
// ═══════════════════════════════════════════════════════════════════════════
//
// Resonant state-variable filter with LFO + envelope follower modulation.
//
// Filter types: LP (0), HP (1), BP (2), Notch (3)
//
// The cutoff is modulated by:
//   1. An internal LFO (sine, triangle, saw, square)
//   2. An envelope follower on the input signal
//
// Parameters:
//   0: Cutoff       (20–20000 Hz, default 1000)
//   1: Resonance    (0–1, default 0.3)
//   2: LFO Rate     (0.01–20 Hz, default 1.0)
//   3: LFO Depth    (0–1, default 0.5)
//   4: Env Amount   (-1 to 1, default 0.0) — envelope follower mod depth
//   5: Filter Type  (0=LP, 1=HP, 2=BP, 3=Notch, default 0)
//   6: Mix          (0–1, default 1.0)
//
// Real-Time Safety: Zero allocations. O(N) per buffer.
//
// ═══════════════════════════════════════════════════════════════════════════

use crate::dsp_processor::DspProcessor;

/// SVF filter state for one channel.
#[derive(Clone, Copy)]
struct SvfState {
    ic1eq: f32,
    ic2eq: f32,
}

impl SvfState {
    fn new() -> Self {
        Self { ic1eq: 0.0, ic2eq: 0.0 }
    }

    fn reset(&mut self) {
        self.ic1eq = 0.0;
        self.ic2eq = 0.0;
    }
}

pub struct AutoFilterProcessor {
    cutoff_hz: f32,
    resonance: f32,
    lfo_rate: f32,
    lfo_depth: f32,
    env_amount: f32,
    filter_type: u8, // 0=LP, 1=HP, 2=BP, 3=Notch
    mix: f32,
    // Internal state
    svf_l: SvfState,
    svf_r: SvfState,
    lfo_phase: f64,
    env_follower: f32,
    sample_rate: f32,
}

impl AutoFilterProcessor {
    pub fn new(sample_rate: f32) -> Self {
        Self {
            cutoff_hz: 1000.0,
            resonance: 0.3,
            lfo_rate: 1.0,
            lfo_depth: 0.5,
            env_amount: 0.0,
            filter_type: 0,
            mix: 1.0,
            svf_l: SvfState::new(),
            svf_r: SvfState::new(),
            lfo_phase: 0.0,
            env_follower: 0.0,
            sample_rate,
        }
    }

    /// Compute SVF coefficients for given cutoff and Q.
    #[inline]
    fn svf_coeffs(cutoff: f32, resonance: f32, sr: f32) -> (f32, f32, f32) {
        let freq = cutoff.clamp(20.0, sr * 0.49);
        let g = (std::f32::consts::PI * freq / sr).tan();
        let k = 2.0 - 2.0 * resonance.clamp(0.0, 0.99);
        let a1 = 1.0 / (1.0 + g * (g + k));
        (g, k, a1)
    }

    /// Process one sample through SVF, returns (lp, hp, bp, notch).
    #[inline]
    fn svf_tick(state: &mut SvfState, input: f32, g: f32, k: f32, a1: f32) -> (f32, f32, f32, f32) {
        let a2 = g * a1;
        let a3 = g * a2;
        let v3 = input - state.ic2eq;
        let v1 = a1 * state.ic1eq + a2 * v3;
        let v2 = state.ic2eq + a2 * state.ic1eq + a3 * v3;
        state.ic1eq = 2.0 * v1 - state.ic1eq;
        state.ic2eq = 2.0 * v2 - state.ic2eq;
        let lp = v2;
        let bp = v1;
        let hp = input - k * v1 - v2;
        let notch = lp + hp;
        (lp, hp, bp, notch)
    }

    #[inline]
    fn lfo_sample(&self) -> f32 {
        let phase = self.lfo_phase as f32;
        // Sine LFO
        (phase * std::f32::consts::TAU).sin()
    }
}

impl DspProcessor for AutoFilterProcessor {
    fn process_stereo(&mut self, left: &mut [f32], right: &mut [f32], _sample_rate: f32) {
        let len = left.len().min(right.len());
        let sr = self.sample_rate;
        let lfo_inc = self.lfo_rate as f64 / sr as f64;
        let env_attack = (-1.0 / (0.005 * sr).max(1.0)).exp();
        let env_release = (-1.0 / (0.050 * sr).max(1.0)).exp();

        for i in 0..len {
            // LFO
            let lfo_val = self.lfo_sample();
            self.lfo_phase += lfo_inc;
            if self.lfo_phase >= 1.0 {
                self.lfo_phase -= 1.0;
            }

            // Envelope follower
            let peak = left[i].abs().max(right[i].abs());
            let coeff = if peak > self.env_follower { env_attack } else { env_release };
            self.env_follower = coeff * self.env_follower + (1.0 - coeff) * peak;

            // Modulated cutoff (in octaves from base)
            let lfo_mod = lfo_val * self.lfo_depth * 4.0; // ±4 octaves
            let env_mod = self.env_follower * self.env_amount * 4.0;
            let mod_cutoff = self.cutoff_hz * 2.0_f32.powf(lfo_mod + env_mod);

            let (g, k, a1) = Self::svf_coeffs(mod_cutoff, self.resonance, sr);

            // Process both channels
            let dry_l = left[i];
            let dry_r = right[i];
            let (lp_l, hp_l, bp_l, notch_l) = Self::svf_tick(&mut self.svf_l, dry_l, g, k, a1);
            let (lp_r, hp_r, bp_r, notch_r) = Self::svf_tick(&mut self.svf_r, dry_r, g, k, a1);

            let wet_l = match self.filter_type {
                0 => lp_l,
                1 => hp_l,
                2 => bp_l,
                _ => notch_l,
            };
            let wet_r = match self.filter_type {
                0 => lp_r,
                1 => hp_r,
                2 => bp_r,
                _ => notch_r,
            };

            left[i] = dry_l * (1.0 - self.mix) + wet_l * self.mix;
            right[i] = dry_r * (1.0 - self.mix) + wet_r * self.mix;
        }
    }

    fn set_param(&mut self, index: u8, value: f32) {
        match index {
            0 => self.cutoff_hz = value.clamp(20.0, 20000.0),
            1 => self.resonance = value.clamp(0.0, 1.0),
            2 => self.lfo_rate = value.clamp(0.01, 20.0),
            3 => self.lfo_depth = value.clamp(0.0, 1.0),
            4 => self.env_amount = value.clamp(-1.0, 1.0),
            5 => self.filter_type = (value as u8).min(3),
            6 => self.mix = value.clamp(0.0, 1.0),
            _ => {}
        }
    }

    fn reset(&mut self) {
        self.svf_l.reset();
        self.svf_r.reset();
        self.lfo_phase = 0.0;
        self.env_follower = 0.0;
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn auto_filter_processes_without_panic() {
        let mut proc = AutoFilterProcessor::new(44100.0);
        let mut left = vec![0.5f32; 512];
        let mut right = vec![0.5f32; 512];
        proc.process_stereo(&mut left, &mut right, 44100.0);
    }

    #[test]
    fn auto_filter_lp_attenuates_high_freq() {
        let mut proc = AutoFilterProcessor::new(44100.0);
        proc.set_param(0, 200.0);  // low cutoff
        proc.set_param(1, 0.0);    // no resonance
        proc.set_param(3, 0.0);    // no LFO
        proc.set_param(6, 1.0);    // full wet
        // Generate 5 kHz sine
        let sr = 44100.0;
        let freq = 5000.0;
        let mut left: Vec<f32> = (0..4096)
            .map(|i| (2.0 * std::f32::consts::PI * freq * i as f32 / sr).sin())
            .collect();
        let mut right = left.clone();
        proc.process_stereo(&mut left, &mut right, sr);
        // After filtering, high frequency should be significantly attenuated
        let rms: f32 = (left[1024..].iter().map(|s| s * s).sum::<f32>() / 3072.0).sqrt();
        assert!(rms < 0.3, "LP filter should attenuate 5kHz, RMS: {rms}");
    }
}
