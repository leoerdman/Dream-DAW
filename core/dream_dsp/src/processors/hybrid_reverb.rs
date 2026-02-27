// ═══════════════════════════════════════════════════════════════════════════
// Dream DAW — Hybrid Reverb Processor
// ═══════════════════════════════════════════════════════════════════════════
//
// Combines early reflections (geometric delay network) with an algorithmic
// late reverb tail (feedback delay network, FDN). Distinct from the
// existing Reverb which uses a Schroeder-style all-pass/comb network.
//
// Architecture:
//   - Early Reflections: 8 tapped delay lines with geometric spacing
//   - Late Reverb: 4-channel Feedback Delay Network (Hadamard matrix)
//   - Damping: per-delay-line LP for natural high-frequency decay
//   - Modulation: LFO-modulated delay times for chorus-like diffusion
//   - Pre-delay: adjustable gap before early reflections
//
// Parameters:
//   0: Size     (0–100%, default 50%)  — room size / FDN delay lengths
//   1: Decay    (0–100%, default 40%)  — feedback amount (RT60)
//   2: Damping  (0–100%, default 50%)  — HF damping
//   3: Early    (0–100%, default 60%)  — early reflections level
//   4: Late     (0–100%, default 50%)  — late reverb level
//   5: Pre-Delay (0–250 ms, default 10) — pre-delay time
//   6: Mod      (0–100%, default 20%)  — delay modulation depth
//   7: Mix      (0–100%, default 30%)
//   8: Width    (0–100%, default 80%)
//
// Real-Time Safety: Zero allocations. O(N) per buffer.
//
// ═══════════════════════════════════════════════════════════════════════════

use crate::dsp_processor::DspProcessor;
use crate::processors::smoothing::SmoothedValue;
use crate::processors::sanitize_sample_rate;

// Maximum buffer sizes
const MAX_PREDELAY: usize = 16384; // ~370ms at 44.1kHz
const PREDELAY_MASK: usize = MAX_PREDELAY - 1;
const ER_BUF_SIZE: usize = 8192;
const ER_MASK: usize = ER_BUF_SIZE - 1;
const FDN_BUF_SIZE: usize = 16384;
const FDN_MASK: usize = FDN_BUF_SIZE - 1;
const FDN_CHANNELS: usize = 4;
const ER_TAPS: usize = 8;

/// Prime-based delay lengths (in samples at 44100 Hz, scaled by size)
const ER_TAP_BASE: [f32; ER_TAPS] = [
    137.0, 281.0, 431.0, 593.0, 769.0, 947.0, 1151.0, 1399.0,
];
/// Tap gains (geometric falloff simulating reflection decay)
const ER_TAP_GAIN: [f32; ER_TAPS] = [
    0.85, 0.72, 0.62, 0.53, 0.45, 0.38, 0.32, 0.27,
];
/// FDN base delay lengths (mutually prime for maximal diffusion)
const FDN_DELAYS_BASE: [f32; FDN_CHANNELS] = [1553.0, 2039.0, 2677.0, 3371.0];

pub struct HybridReverbProcessor {
    size: f32,
    decay: f32,
    damping: f32,
    early_level: f32,
    late_level: f32,
    predelay_ms: f32,
    mod_depth: f32,
    mix: f32,
    width: f32,
    // Pre-delay buffer (heap-allocated)
    pd_buf_l: Vec<f32>,
    pd_buf_r: Vec<f32>,
    pd_pos: usize,
    // Early reflections buffer (heap-allocated)
    er_buf_l: Vec<f32>,
    er_buf_r: Vec<f32>,
    er_pos: usize,
    // FDN delay lines (heap-allocated)
    fdn_buf: Vec<Vec<f32>>,
    fdn_pos: [usize; FDN_CHANNELS],
    // FDN damping LP state
    fdn_lp: [f32; FDN_CHANNELS],
    // LFO phase for modulation
    lfo_phase: f64,
    // Smoothed
    size_sm: SmoothedValue,
    decay_sm: SmoothedValue,
    damp_sm: SmoothedValue,
    early_sm: SmoothedValue,
    late_sm: SmoothedValue,
    mod_sm: SmoothedValue,
    mix_sm: SmoothedValue,
    width_sm: SmoothedValue,
    sample_rate: f32,
}

impl HybridReverbProcessor {
    pub fn new(sample_rate: f32) -> Self {
        let sr = sanitize_sample_rate(sample_rate);
        Self {
            size: 0.5, decay: 0.4, damping: 0.5,
            early_level: 0.6, late_level: 0.5,
            predelay_ms: 10.0, mod_depth: 0.2,
            mix: 0.3, width: 0.8,
            pd_buf_l: vec![0.0; MAX_PREDELAY],
            pd_buf_r: vec![0.0; MAX_PREDELAY],
            pd_pos: 0,
            er_buf_l: vec![0.0; ER_BUF_SIZE],
            er_buf_r: vec![0.0; ER_BUF_SIZE],
            er_pos: 0,
            fdn_buf: (0..FDN_CHANNELS).map(|_| vec![0.0; FDN_BUF_SIZE]).collect(),
            fdn_pos: [0; FDN_CHANNELS],
            fdn_lp: [0.0; FDN_CHANNELS],
            lfo_phase: 0.0,
            size_sm: SmoothedValue::new(sr, 10.0, 0.5),
            decay_sm: SmoothedValue::new(sr, 10.0, 0.4),
            damp_sm: SmoothedValue::new(sr, 10.0, 0.5),
            early_sm: SmoothedValue::new(sr, 8.0, 0.6),
            late_sm: SmoothedValue::new(sr, 8.0, 0.5),
            mod_sm: SmoothedValue::new(sr, 10.0, 0.2),
            mix_sm: SmoothedValue::new(sr, 8.0, 0.3),
            width_sm: SmoothedValue::new(sr, 8.0, 0.8),
            sample_rate: sr,
        }
    }

    #[inline]
    fn read_interp(buf: &[f32], pos: usize, delay: f32, mask: usize) -> f32 {
        let d = delay.max(1.0);
        let idx = d as usize;
        let frac = d - idx as f32;
        let p1 = (pos + buf.len() - idx) & mask;
        let p2 = (pos + buf.len() - idx - 1) & mask;
        buf[p1] * (1.0 - frac) + buf[p2] * frac
    }
}

impl DspProcessor for HybridReverbProcessor {
    fn process_stereo(&mut self, left: &mut [f32], right: &mut [f32], sample_rate: f32) {
        let sr = sanitize_sample_rate(sample_rate);
        if (sr - self.sample_rate).abs() > 0.5 {
            self.sample_rate = sr;
            for sm in [&mut self.size_sm, &mut self.decay_sm, &mut self.damp_sm,
                       &mut self.early_sm, &mut self.late_sm, &mut self.mod_sm,
                       &mut self.mix_sm, &mut self.width_sm] {
                sm.set_sample_rate(sr);
            }
        }

        let len = left.len().min(right.len());
        self.size_sm.set_target(self.size);
        self.decay_sm.set_target(self.decay);
        self.damp_sm.set_target(self.damping);
        self.early_sm.set_target(self.early_level);
        self.late_sm.set_target(self.late_level);
        self.mod_sm.set_target(self.mod_depth);
        self.mix_sm.set_target(self.mix);
        self.width_sm.set_target(self.width);

        let sr_ratio = sr / 44100.0;
        let pd_samples = (self.predelay_ms * 0.001 * sr).clamp(1.0, (MAX_PREDELAY - 1) as f32);
        let lfo_rate = 0.7; // Hz

        for i in 0..len {
            let dry_l = left[i];
            let dry_r = right[i];
            let size = self.size_sm.next_value();
            let decay = self.decay_sm.next_value();
            let damp = self.damp_sm.next_value();
            let early_lev = self.early_sm.next_value();
            let late_lev = self.late_sm.next_value();
            let mod_d = self.mod_sm.next_value();
            let mix = self.mix_sm.next_value();
            let width = self.width_sm.next_value();

            let input_mono = (dry_l + dry_r) * 0.5;

            // ── Pre-delay ──
            self.pd_buf_l[self.pd_pos] = dry_l;
            self.pd_buf_r[self.pd_pos] = dry_r;
            let pd_l = Self::read_interp(&self.pd_buf_l, self.pd_pos, pd_samples, PREDELAY_MASK);
            let pd_r = Self::read_interp(&self.pd_buf_r, self.pd_pos, pd_samples, PREDELAY_MASK);
            self.pd_pos = (self.pd_pos + 1) & PREDELAY_MASK;

            // ── Early Reflections ──
            self.er_buf_l[self.er_pos] = pd_l;
            self.er_buf_r[self.er_pos] = pd_r;
            let mut er_l = 0.0f32;
            let mut er_r = 0.0f32;
            for t in 0..ER_TAPS {
                let delay = ER_TAP_BASE[t] * sr_ratio * (0.5 + size);
                let tap_l = Self::read_interp(&self.er_buf_l, self.er_pos, delay, ER_MASK);
                let tap_r = Self::read_interp(&self.er_buf_r, self.er_pos, delay, ER_MASK);
                let gain = ER_TAP_GAIN[t];
                // Alternate panning for spatial spread
                if t % 2 == 0 {
                    er_l += tap_l * gain;
                    er_r += tap_r * gain * 0.7;
                } else {
                    er_l += tap_l * gain * 0.7;
                    er_r += tap_r * gain;
                }
            }
            self.er_pos = (self.er_pos + 1) & ER_MASK;

            // ── FDN Late Reverb ──
            // LFO for delay modulation
            let lfo = (self.lfo_phase * std::f64::consts::TAU).sin() as f32;
            self.lfo_phase += lfo_rate / sr as f64;
            if self.lfo_phase >= 1.0 { self.lfo_phase -= 1.0; }

            // Read from FDN delay lines
            let mut fdn_out = [0.0f32; FDN_CHANNELS];
            for ch in 0..FDN_CHANNELS {
                let base_delay = FDN_DELAYS_BASE[ch] * sr_ratio * (0.3 + size * 0.7);
                let mod_offset = lfo * mod_d * 20.0 * (ch as f32 + 1.0) * 0.25;
                let delay = (base_delay + mod_offset).clamp(1.0, (FDN_BUF_SIZE - 2) as f32);
                fdn_out[ch] = Self::read_interp(
                    &self.fdn_buf[ch], self.fdn_pos[ch], delay, FDN_MASK,
                );
            }

            // Hadamard-like mixing matrix (normalized by 0.5)
            let mixed = [
                (fdn_out[0] + fdn_out[1] + fdn_out[2] + fdn_out[3]) * 0.5,
                (fdn_out[0] - fdn_out[1] + fdn_out[2] - fdn_out[3]) * 0.5,
                (fdn_out[0] + fdn_out[1] - fdn_out[2] - fdn_out[3]) * 0.5,
                (fdn_out[0] - fdn_out[1] - fdn_out[2] + fdn_out[3]) * 0.5,
            ];

            // Feedback with damping
            let damp_c = damp.clamp(0.01, 0.99);
            let fb = decay.clamp(0.0, 0.95);
            #[allow(clippy::needless_range_loop)]
            for ch in 0..FDN_CHANNELS {
                // LP damping
                self.fdn_lp[ch] = self.fdn_lp[ch] * damp_c + mixed[ch] * (1.0 - damp_c);
                // Write back with feedback + input injection
                let fb_sample = self.fdn_lp[ch] * fb + input_mono * 0.25;
                self.fdn_buf[ch][self.fdn_pos[ch]] = fb_sample;
                self.fdn_pos[ch] = (self.fdn_pos[ch] + 1) & FDN_MASK;
                // Denormal flush
                if self.fdn_lp[ch].abs() < 1e-20 { self.fdn_lp[ch] = 0.0; }
            }

            // Sum FDN outputs to stereo
            let late_l = (fdn_out[0] + fdn_out[2]) * 0.5;
            let late_r = (fdn_out[1] + fdn_out[3]) * 0.5;

            // Combine early + late
            let wet_l = er_l * early_lev + late_l * late_lev;
            let wet_r = er_r * early_lev + late_r * late_lev;

            // Width processing
            let mid = (wet_l + wet_r) * 0.5;
            let side = (wet_l - wet_r) * 0.5 * width;
            let final_l = mid + side;
            let final_r = mid - side;

            left[i] = dry_l * (1.0 - mix) + final_l * mix;
            right[i] = dry_r * (1.0 - mix) + final_r * mix;
        }
    }

    fn set_param(&mut self, index: u8, value: f32) {
        match index {
            0 => self.size = (value / 100.0).clamp(0.0, 1.0),
            1 => self.decay = (value / 100.0).clamp(0.0, 1.0),
            2 => self.damping = (value / 100.0).clamp(0.0, 1.0),
            3 => self.early_level = (value / 100.0).clamp(0.0, 1.0),
            4 => self.late_level = (value / 100.0).clamp(0.0, 1.0),
            5 => self.predelay_ms = value.clamp(0.0, 250.0),
            6 => self.mod_depth = (value / 100.0).clamp(0.0, 1.0),
            7 => self.mix = (value / 100.0).clamp(0.0, 1.0),
            8 => self.width = (value / 100.0).clamp(0.0, 1.0),
            _ => {}
        }
    }

    fn reset(&mut self) {
        self.pd_buf_l.fill(0.0);
        self.pd_buf_r.fill(0.0);
        self.pd_pos = 0;
        self.er_buf_l.fill(0.0);
        self.er_buf_r.fill(0.0);
        self.er_pos = 0;
        for ch in 0..FDN_CHANNELS {
            self.fdn_buf[ch].fill(0.0);
            self.fdn_pos[ch] = 0;
            self.fdn_lp[ch] = 0.0;
        }
        self.lfo_phase = 0.0;
        self.size_sm.set_instant(self.size);
        self.decay_sm.set_instant(self.decay);
        self.damp_sm.set_instant(self.damping);
        self.early_sm.set_instant(self.early_level);
        self.late_sm.set_instant(self.late_level);
        self.mod_sm.set_instant(self.mod_depth);
        self.mix_sm.set_instant(self.mix);
        self.width_sm.set_instant(self.width);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn hybrid_reverb_produces_tail() {
        let mut proc = HybridReverbProcessor::new(44100.0);
        proc.set_param(7, 100.0); // Full wet
        proc.set_param(1, 50.0);  // Medium decay
        let sr = 44100.0;
        // Impulse: one loud sample then silence
        let mut left = vec![0.0f32; 8192];
        let mut right = vec![0.0f32; 8192];
        left[0] = 1.0;
        right[0] = 1.0;
        proc.process_stereo(&mut left, &mut right, sr);
        // Should have tail after 4096 samples
        let tail_rms: f32 = (left[4096..].iter().map(|x| x * x).sum::<f32>() / 4096.0).sqrt();
        assert!(tail_rms > 0.0001, "Should produce reverb tail: {tail_rms}");
        assert!(left.iter().all(|x| x.is_finite()));
    }

    #[test]
    fn hybrid_reverb_dry_at_zero_mix() {
        let mut proc = HybridReverbProcessor::new(44100.0);
        proc.set_param(7, 0.0); // Dry only
        let sr = 44100.0;
        let mut left: Vec<f32> = (0..4096)
            .map(|i| (std::f32::consts::TAU * 440.0 * i as f32 / sr).sin() * 0.5)
            .collect();
        let orig = left.clone();
        let mut right = left.clone();
        proc.process_stereo(&mut left, &mut right, sr);
        let diff: f32 = left[2048..].iter().zip(orig[2048..].iter())
            .map(|(a, b)| (a - b).abs()).sum::<f32>() / 2048.0;
        assert!(diff < 0.01, "Zero mix should be passthrough: {diff}");
    }
}
