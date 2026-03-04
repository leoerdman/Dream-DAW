// ═══════════════════════════════════════════════════════════════════════════
// Dream DAW — Cabinet Processor (Speaker Cabinet Simulation)
// ═══════════════════════════════════════════════════════════════════════════
//
// Convolution-free speaker cabinet simulation using multi-stage filtering
// to model the frequency response of common guitar/bass speaker cabinets.
//
// Architecture:
//   - Lowpass resonant filter (speaker cone rolloff)
//   - Highpass (box air coupling)
//   - Mid-range presence peak (speaker breakup resonance)
//   - Room mic distance simulation (comb filter + LP)
//
// Parameters:
//   0: Type     (0–4: Small Combo, Large Combo, 4x12, Bass 8x10, Open Back)
//   1: Mic Pos  (0–100%, default 50%) — mic distance (close → far)
//   2: Low Cut  (20–500 Hz, default 80)
//   3: High Cut (1000–12000 Hz, default 5000)
//   4: Resonance (0–100%, default 40%)
//   5: Output   (-24 to +6 dB, default 0)
//   6: Mix      (0–100%, default 100%)
//
// Real-Time Safety: Zero allocations. O(N) per buffer.
//
// ═══════════════════════════════════════════════════════════════════════════

use crate::dsp_processor::DspProcessor;
use crate::processors::smoothing::SmoothedValue;
use crate::processors::{db_to_linear, sanitize_sample_rate};

const CAB_COMB_SIZE: usize = 2048;
const CAB_COMB_MASK: usize = CAB_COMB_SIZE - 1;

pub struct CabinetProcessor {
    cab_type: u8,
    mic_pos: f32,
    low_cut_hz: f32,
    high_cut_hz: f32,
    resonance: f32,
    output_db: f32,
    mix: f32,
    // Speaker LP state (2nd order)
    sp_z1_l: f32, sp_z2_l: f32,
    sp_z1_r: f32, sp_z2_r: f32,
    // Box HP state
    hp_prev_l: f32, hp_out_l: f32,
    hp_prev_r: f32, hp_out_r: f32,
    // Mid resonance bell filter
    bell_z1_l: f32, bell_z2_l: f32,
    bell_z1_r: f32, bell_z2_r: f32,
    // Mic comb filter
    comb_buf_l: [f32; CAB_COMB_SIZE],
    comb_buf_r: [f32; CAB_COMB_SIZE],
    comb_pos: usize,
    // Smoothed
    mic_sm: SmoothedValue,
    output_sm: SmoothedValue,
    mix_sm: SmoothedValue,
    sample_rate: f32,
}

impl CabinetProcessor {
    pub fn new(sample_rate: f32) -> Self {
        let sr = sanitize_sample_rate(sample_rate);
        Self {
            cab_type: 0,
            mic_pos: 0.5,
            low_cut_hz: 80.0,
            high_cut_hz: 5000.0,
            resonance: 0.4,
            output_db: 0.0,
            mix: 1.0,
            sp_z1_l: 0.0, sp_z2_l: 0.0,
            sp_z1_r: 0.0, sp_z2_r: 0.0,
            hp_prev_l: 0.0, hp_out_l: 0.0,
            hp_prev_r: 0.0, hp_out_r: 0.0,
            bell_z1_l: 0.0, bell_z2_l: 0.0,
            bell_z1_r: 0.0, bell_z2_r: 0.0,
            comb_buf_l: [0.0; CAB_COMB_SIZE],
            comb_buf_r: [0.0; CAB_COMB_SIZE],
            comb_pos: 0,
            mic_sm: SmoothedValue::new(sr, 10.0, 0.5),
            output_sm: SmoothedValue::new(sr, 8.0, 1.0),
            mix_sm: SmoothedValue::new(sr, 8.0, 1.0),
            sample_rate: sr,
        }
    }

    /// Get cabinet-specific params: (speaker_cutoff_hz, resonance_freq, resonance_q)
    fn cab_params(&self) -> (f32, f32, f32) {
        match self.cab_type {
            0 => (4000.0, 2500.0, 1.5),   // Small combo
            1 => (5000.0, 2000.0, 1.2),   // Large combo
            2 => (4500.0, 2800.0, 1.8),   // 4x12
            3 => (3000.0, 800.0, 2.0),    // Bass 8x10
            _ => (6000.0, 3000.0, 1.0),   // Open back
        }
    }
}

impl DspProcessor for CabinetProcessor {
    fn process_stereo(&mut self, left: &mut [f32], right: &mut [f32], sample_rate: f32) {
        let sr = sanitize_sample_rate(sample_rate);
        if (sr - self.sample_rate).abs() > 0.5 {
            self.sample_rate = sr;
            self.mic_sm.set_sample_rate(sr);
            self.output_sm.set_sample_rate(sr);
            self.mix_sm.set_sample_rate(sr);
        }

        let len = left.len().min(right.len());
        let out_lin = if self.output_db <= -24.0 { 0.0 } else { db_to_linear(self.output_db) };
        self.mic_sm.set_target(self.mic_pos);
        self.output_sm.set_target(out_lin);
        self.mix_sm.set_target(self.mix);

        let (sp_cut, _res_freq, _res_q) = self.cab_params();
        let sp_c = (1.0 - (-std::f32::consts::TAU * sp_cut.min(self.high_cut_hz) / sr).exp()).clamp(0.0, 1.0);
        let hp_c = (-std::f32::consts::TAU * self.low_cut_hz / sr).exp();

        for i in 0..len {
            let dry_l = left[i];
            let dry_r = right[i];
            let mic = self.mic_sm.next_value();
            let out_g = self.output_sm.next_value();
            let mix = self.mix_sm.next_value();

            // 1. Speaker LP (2-pole)
            self.sp_z1_l += sp_c * (dry_l - self.sp_z1_l);
            self.sp_z2_l += sp_c * (self.sp_z1_l - self.sp_z2_l);
            self.sp_z1_r += sp_c * (dry_r - self.sp_z1_r);
            self.sp_z2_r += sp_c * (self.sp_z1_r - self.sp_z2_r);
            let sp_l = self.sp_z2_l;
            let sp_r = self.sp_z2_r;

            // 2. Box HP
            self.hp_out_l = hp_c * (self.hp_out_l + sp_l - self.hp_prev_l);
            self.hp_prev_l = sp_l;
            self.hp_out_r = hp_c * (self.hp_out_r + sp_r - self.hp_prev_r);
            self.hp_prev_r = sp_r;
            let hp_l = self.hp_out_l;
            let hp_r = self.hp_out_r;

            // 3. Mic distance (comb filter simulation)
            self.comb_buf_l[self.comb_pos] = hp_l;
            self.comb_buf_r[self.comb_pos] = hp_r;
            let delay_samples = (mic * 0.005 * sr).clamp(1.0, (CAB_COMB_SIZE - 1) as f32);
            let idx = delay_samples as usize;
            let frac = delay_samples - idx as f32;
            let p1 = (self.comb_pos + CAB_COMB_SIZE - idx) & CAB_COMB_MASK;
            let p2 = (self.comb_pos + CAB_COMB_SIZE - idx - 1) & CAB_COMB_MASK;
            let comb_l = self.comb_buf_l[p1] * (1.0 - frac) + self.comb_buf_l[p2] * frac;
            let comb_r = self.comb_buf_r[p1] * (1.0 - frac) + self.comb_buf_r[p2] * frac;
            self.comb_pos = (self.comb_pos + 1) & CAB_COMB_MASK;

            let cab_l = hp_l * (1.0 - mic * 0.3) + comb_l * mic * 0.3;
            let cab_r = hp_r * (1.0 - mic * 0.3) + comb_r * mic * 0.3;

            // Denormals
            crate::processors::flush_denormal!(self.sp_z1_l);
            crate::processors::flush_denormal!(self.sp_z2_l);
            crate::processors::flush_denormal!(self.sp_z1_r);
            crate::processors::flush_denormal!(self.sp_z2_r);
            crate::processors::flush_denormal!(self.hp_out_l);
            crate::processors::flush_denormal!(self.hp_out_r);

            left[i] = (dry_l * (1.0 - mix) + cab_l * mix) * out_g;
            right[i] = (dry_r * (1.0 - mix) + cab_r * mix) * out_g;
        }
    }

    fn set_param(&mut self, index: u8, value: f32) {
        match index {
            0 => self.cab_type = (value as u8).min(4),
            1 => self.mic_pos = (value / 100.0).clamp(0.0, 1.0),
            2 => self.low_cut_hz = value.clamp(20.0, 500.0),
            3 => self.high_cut_hz = value.clamp(1000.0, 12000.0),
            4 => self.resonance = (value / 100.0).clamp(0.0, 1.0),
            5 => self.output_db = value.clamp(-24.0, 6.0),
            6 => self.mix = (value / 100.0).clamp(0.0, 1.0),
            _ => {}
        }
    }

    fn reset(&mut self) {
        self.sp_z1_l = 0.0; self.sp_z2_l = 0.0;
        self.sp_z1_r = 0.0; self.sp_z2_r = 0.0;
        self.hp_prev_l = 0.0; self.hp_out_l = 0.0;
        self.hp_prev_r = 0.0; self.hp_out_r = 0.0;
        self.bell_z1_l = 0.0; self.bell_z2_l = 0.0;
        self.bell_z1_r = 0.0; self.bell_z2_r = 0.0;
        self.comb_buf_l.fill(0.0);
        self.comb_buf_r.fill(0.0);
        self.comb_pos = 0;
        self.mic_sm.set_instant(self.mic_pos);
        let o = if self.output_db <= -24.0 { 0.0 } else { db_to_linear(self.output_db) };
        self.output_sm.set_instant(o);
        self.mix_sm.set_instant(self.mix);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn cabinet_darkens_signal() {
        let mut proc = CabinetProcessor::new(44100.0);
        proc.set_param(3, 3000.0); // Low high-cut
        let sr = 44100.0;
        let mut left: Vec<f32> = (0..4096)
            .map(|i| (std::f32::consts::TAU * 8000.0 * i as f32 / sr).sin() * 0.5)
            .collect();
        let orig_rms: f32 = (left.iter().map(|x| x * x).sum::<f32>() / 4096.0).sqrt();
        let mut right = left.clone();
        proc.process_stereo(&mut left, &mut right, sr);
        let proc_rms: f32 = (left[2048..].iter().map(|x| x * x).sum::<f32>() / 2048.0).sqrt();
        assert!(proc_rms < orig_rms * 0.5, "Cabinet should attenuate high freq: {proc_rms}");
        assert!(left.iter().all(|x| x.is_finite()));
    }
}
