// ═══════════════════════════════════════════════════════════════════════════
// Dream DAW — Amp Processor (Guitar Amp Simulator)
// ═══════════════════════════════════════════════════════════════════════════
//
// Multi-stage tube amplifier model with 3-band tone stack.
// Distinct from Overdrive (single-stage) and Distortion (hard-clip).
//
// Architecture:
//   - Input gain stage → pre-amp tube (asymmetric tanh)
//   - 3-band tone stack (Bass/Mid/Treble) using Baxandall EQ topology
//   - Power amp stage (softer saturation with sag)
//   - Presence control (high-freq boost post power amp)
//   - Master volume
//
// Parameters:
//   0: Gain       (0–100%, default 50%)  — pre-amp gain
//   1: Bass       (-12 to +12 dB, default 0)
//   2: Mid        (-12 to +12 dB, default 0)
//   3: Treble     (-12 to +12 dB, default 0)
//   4: Presence   (0–100%, default 40%)  — post-saturation brightness
//   5: Master     (-60 to +6 dB, default -6)
//   6: Sag        (0–100%, default 30%)  — power supply sag emulation
//   7: Mix        (0–100%, default 100%)
//
// Real-Time Safety: Zero allocations. O(N) per buffer.
//
// ═══════════════════════════════════════════════════════════════════════════

use crate::dsp_processor::DspProcessor;
use crate::processors::smoothing::SmoothedValue;
use crate::processors::{db_to_linear, sanitize_sample_rate};

pub struct AmpProcessor {
    gain: f32,
    bass_db: f32,
    mid_db: f32,
    treble_db: f32,
    presence: f32,
    master_db: f32,
    sag: f32,
    mix: f32,
    // Tone stack state (3 one-pole filters: LP, BP, HP)
    ts_lp_l: f32, ts_lp_r: f32,
    ts_bp_l: f32, ts_bp_r: f32,
    ts_hp_prev_l: f32, ts_hp_prev_r: f32,
    ts_hp_out_l: f32, ts_hp_out_r: f32,
    // Presence filter state
    pres_state_l: f32,
    pres_state_r: f32,
    // Power sag envelope
    sag_env: f32,
    // DC blocker
    dc_in_l: f32, dc_in_r: f32,
    dc_out_l: f32, dc_out_r: f32,
    dc_c: f32,
    // Smoothed
    gain_sm: SmoothedValue,
    bass_sm: SmoothedValue,
    mid_sm: SmoothedValue,
    treble_sm: SmoothedValue,
    pres_sm: SmoothedValue,
    master_sm: SmoothedValue,
    sag_sm: SmoothedValue,
    mix_sm: SmoothedValue,
    sample_rate: f32,
}

impl AmpProcessor {
    pub fn new(sample_rate: f32) -> Self {
        let sr = sanitize_sample_rate(sample_rate);
        Self {
            gain: 0.5, bass_db: 0.0, mid_db: 0.0, treble_db: 0.0,
            presence: 0.4, master_db: -6.0, sag: 0.3, mix: 1.0,
            ts_lp_l: 0.0, ts_lp_r: 0.0,
            ts_bp_l: 0.0, ts_bp_r: 0.0,
            ts_hp_prev_l: 0.0, ts_hp_prev_r: 0.0,
            ts_hp_out_l: 0.0, ts_hp_out_r: 0.0,
            pres_state_l: 0.0, pres_state_r: 0.0,
            sag_env: 1.0,
            dc_in_l: 0.0, dc_in_r: 0.0,
            dc_out_l: 0.0, dc_out_r: 0.0,
            dc_c: 1.0 - (std::f32::consts::TAU * 20.0 / sr),
            gain_sm: SmoothedValue::new(sr, 10.0, 0.5),
            bass_sm: SmoothedValue::new(sr, 10.0, 1.0),
            mid_sm: SmoothedValue::new(sr, 10.0, 1.0),
            treble_sm: SmoothedValue::new(sr, 10.0, 1.0),
            pres_sm: SmoothedValue::new(sr, 10.0, 0.4),
            master_sm: SmoothedValue::new(sr, 8.0, db_to_linear(-6.0)),
            sag_sm: SmoothedValue::new(sr, 10.0, 0.3),
            mix_sm: SmoothedValue::new(sr, 8.0, 1.0),
            sample_rate: sr,
        }
    }

    /// Pre-amp tube stage: asymmetric tanh with grid bias
    #[inline]
    fn preamp_tube(x: f32, gain: f32) -> f32 {
        let g = 1.0 + gain * 30.0;
        let d = x * g;
        // Asymmetric: positive clips at ~0.7, negative at ~-1.0
        if d >= 0.0 {
            let d2 = d * d;
            d * 0.7 / (1.0 + d2 * 0.3)
        } else {
            d.max(-3.0).tanh()
        }
    }

    /// Power amp stage: softer saturation
    #[inline]
    fn power_amp(x: f32, sag_level: f32) -> f32 {
        let headroom = sag_level.clamp(0.3, 1.0);
        let d = x / headroom;
        if d.abs() < 1.0 { d * headroom } else { d.signum() * headroom }
    }
}

impl DspProcessor for AmpProcessor {
    fn process_stereo(&mut self, left: &mut [f32], right: &mut [f32], sample_rate: f32) {
        let sr = sanitize_sample_rate(sample_rate);
        if (sr - self.sample_rate).abs() > 0.5 {
            self.sample_rate = sr;
            self.dc_c = 1.0 - (std::f32::consts::TAU * 20.0 / sr);
            for sm in [&mut self.gain_sm, &mut self.bass_sm, &mut self.mid_sm,
                       &mut self.treble_sm, &mut self.pres_sm, &mut self.master_sm,
                       &mut self.sag_sm, &mut self.mix_sm] {
                sm.set_sample_rate(sr);
            }
        }

        let len = left.len().min(right.len());
        let master_lin = if self.master_db <= -60.0 { 0.0 } else { db_to_linear(self.master_db) };
        self.gain_sm.set_target(self.gain);
        self.bass_sm.set_target(db_to_linear(self.bass_db));
        self.mid_sm.set_target(db_to_linear(self.mid_db));
        self.treble_sm.set_target(db_to_linear(self.treble_db));
        self.pres_sm.set_target(self.presence);
        self.master_sm.set_target(master_lin);
        self.sag_sm.set_target(self.sag);
        self.mix_sm.set_target(self.mix);

        // Tone stack coefficients
        let lp_c = (1.0 - (-std::f32::consts::TAU * 300.0 / sr).exp()).clamp(0.0, 1.0);
        let bp_c = (1.0 - (-std::f32::consts::TAU * 1200.0 / sr).exp()).clamp(0.0, 1.0);
        let hp_c = (-std::f32::consts::TAU * 60.0 / sr).exp();
        let pres_c = (1.0 - (-std::f32::consts::TAU * 4000.0 / sr).exp()).clamp(0.0, 1.0);
        let dc = self.dc_c;
        let sag_atk = crate::processors::envelope_coeff(1.0, sr);
        let sag_rel = crate::processors::envelope_coeff(50.0, sr);

        for i in 0..len {
            let dry_l = left[i];
            let dry_r = right[i];
            let gain = self.gain_sm.next_value();
            let bass = self.bass_sm.next_value();
            let mid = self.mid_sm.next_value();
            let treble = self.treble_sm.next_value();
            let pres = self.pres_sm.next_value();
            let master = self.master_sm.next_value();
            let sag_amt = self.sag_sm.next_value();
            let mix = self.mix_sm.next_value();

            // 1. Pre-amp tube
            let pre_l = Self::preamp_tube(dry_l, gain);
            let pre_r = Self::preamp_tube(dry_r, gain);

            // 2. Tone stack (3-band Baxandall-style)
            // LP (bass)
            self.ts_lp_l += lp_c * (pre_l - self.ts_lp_l);
            self.ts_lp_r += lp_c * (pre_r - self.ts_lp_r);
            // BP (mid) — bandpass via differential LP
            self.ts_bp_l += bp_c * (pre_l - self.ts_bp_l);
            self.ts_bp_r += bp_c * (pre_r - self.ts_bp_r);
            let mid_l = self.ts_bp_l - self.ts_lp_l;
            let mid_r = self.ts_bp_r - self.ts_lp_r;
            // HP (treble)
            self.ts_hp_out_l = hp_c * (self.ts_hp_out_l + pre_l - self.ts_hp_prev_l);
            self.ts_hp_prev_l = pre_l;
            self.ts_hp_out_r = hp_c * (self.ts_hp_out_r + pre_r - self.ts_hp_prev_r);
            self.ts_hp_prev_r = pre_r;

            let tone_l = self.ts_lp_l * bass + mid_l * mid + self.ts_hp_out_l * treble;
            let tone_r = self.ts_lp_r * bass + mid_r * mid + self.ts_hp_out_r * treble;

            // 3. Power sag
            let abs_max = tone_l.abs().max(tone_r.abs());
            let sag_c = if abs_max > self.sag_env { sag_atk } else { sag_rel };
            self.sag_env = sag_c * self.sag_env + (1.0 - sag_c) * abs_max;
            let sag_level = 1.0 - sag_amt * self.sag_env.min(1.0) * 0.5;

            // 4. Power amp
            let pow_l = Self::power_amp(tone_l, sag_level);
            let pow_r = Self::power_amp(tone_r, sag_level);

            // 5. Presence (high-freq emphasis)
            self.pres_state_l += pres_c * (pow_l - self.pres_state_l);
            self.pres_state_r += pres_c * (pow_r - self.pres_state_r);
            let out_l = pow_l + (pow_l - self.pres_state_l) * pres;
            let out_r = pow_r + (pow_r - self.pres_state_r) * pres;

            // DC blocker
            let dcb_l = out_l - self.dc_in_l + dc * self.dc_out_l;
            self.dc_in_l = out_l; self.dc_out_l = dcb_l;
            let dcb_r = out_r - self.dc_in_r + dc * self.dc_out_r;
            self.dc_in_r = out_r; self.dc_out_r = dcb_r;

            // Denormals
            crate::processors::flush_denormal!(self.ts_lp_l);
            crate::processors::flush_denormal!(self.ts_lp_r);
            crate::processors::flush_denormal!(self.ts_bp_l);
            crate::processors::flush_denormal!(self.ts_bp_r);
            crate::processors::flush_denormal!(self.ts_hp_out_l);
            crate::processors::flush_denormal!(self.ts_hp_out_r);
            crate::processors::flush_denormal!(self.pres_state_l);
            crate::processors::flush_denormal!(self.pres_state_r);
            crate::processors::flush_denormal!(self.dc_out_l);
            crate::processors::flush_denormal!(self.dc_out_r);

            left[i] = (dry_l * (1.0 - mix) + dcb_l * mix) * master;
            right[i] = (dry_r * (1.0 - mix) + dcb_r * mix) * master;
        }
    }

    fn set_param(&mut self, index: u8, value: f32) {
        match index {
            0 => self.gain = (value / 100.0).clamp(0.0, 1.0),
            1 => self.bass_db = value.clamp(-12.0, 12.0),
            2 => self.mid_db = value.clamp(-12.0, 12.0),
            3 => self.treble_db = value.clamp(-12.0, 12.0),
            4 => self.presence = (value / 100.0).clamp(0.0, 1.0),
            5 => self.master_db = value.clamp(-60.0, 6.0),
            6 => self.sag = (value / 100.0).clamp(0.0, 1.0),
            7 => self.mix = (value / 100.0).clamp(0.0, 1.0),
            _ => {}
        }
    }

    fn reset(&mut self) {
        self.ts_lp_l = 0.0; self.ts_lp_r = 0.0;
        self.ts_bp_l = 0.0; self.ts_bp_r = 0.0;
        self.ts_hp_prev_l = 0.0; self.ts_hp_prev_r = 0.0;
        self.ts_hp_out_l = 0.0; self.ts_hp_out_r = 0.0;
        self.pres_state_l = 0.0; self.pres_state_r = 0.0;
        self.sag_env = 1.0;
        self.dc_in_l = 0.0; self.dc_in_r = 0.0;
        self.dc_out_l = 0.0; self.dc_out_r = 0.0;
        self.gain_sm.set_instant(self.gain);
        self.bass_sm.set_instant(db_to_linear(self.bass_db));
        self.mid_sm.set_instant(db_to_linear(self.mid_db));
        self.treble_sm.set_instant(db_to_linear(self.treble_db));
        self.pres_sm.set_instant(self.presence);
        let m = if self.master_db <= -60.0 { 0.0 } else { db_to_linear(self.master_db) };
        self.master_sm.set_instant(m);
        self.sag_sm.set_instant(self.sag);
        self.mix_sm.set_instant(self.mix);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn amp_produces_output() {
        let mut proc = AmpProcessor::new(44100.0);
        let sr = 44100.0;
        let mut left: Vec<f32> = (0..4096)
            .map(|i| (std::f32::consts::TAU * 200.0 * i as f32 / sr).sin() * 0.3)
            .collect();
        let mut right = left.clone();
        proc.process_stereo(&mut left, &mut right, sr);
        assert!(left.iter().all(|x| x.is_finite()));
        let rms: f32 = (left[2048..].iter().map(|x| x * x).sum::<f32>() / 2048.0).sqrt();
        assert!(rms > 0.001, "Amp should produce output: {rms}");
    }
}
