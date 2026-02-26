// ═══════════════════════════════════════════════════════════════════════════
// Dream DAW — Phaser-Flanger (Hybrid Modulation)
// ═══════════════════════════════════════════════════════════════════════════
//
// A hybrid effect combining phaser allpass stages with a short modulated delay
// line (flanger), crossfadeable between pure phaser and pure flanger.
//
// Parameters:
//   0: Rate      (0.01–20 Hz, default 0.5)  — LFO speed
//   1: Depth     (0–100%, default 70%)       — modulation depth
//   2: Feedback  (-100 to +100%, default 50%)
//   3: Blend     (0–100%, default 50%)  — 0%=phaser, 100%=flanger, mix in between
//   4: Stages    (2–12, default 6)      — phaser allpass stages
//   5: Mix       (0–100%, default 75%)
//   6: Stereo    (0–180°, default 90°)  — L/R LFO phase offset
//
// Real-Time Safety: Zero allocations. O(N) per buffer.
//
// ═══════════════════════════════════════════════════════════════════════════

use crate::dsp_processor::DspProcessor;
use crate::processors::smoothing::SmoothedValue;
use crate::processors::sanitize_sample_rate;

const MAX_PHASER_STAGES: usize = 12;
const MAX_FLANGER_SAMPLES: usize = 2048;
const FLANGER_MASK: usize = MAX_FLANGER_SAMPLES - 1;

pub struct PhaserFlangerProcessor {
    rate: f32,
    depth: f32,
    feedback: f32,
    blend: f32,       // 0=phaser, 1=flanger
    stages: usize,
    mix: f32,
    stereo_offset: f32, // 0..PI
    // LFO phase
    lfo_phase: f64,
    // Phaser allpass state
    ap_state_l: [f32; MAX_PHASER_STAGES],
    ap_state_r: [f32; MAX_PHASER_STAGES],
    // Flanger delay buffer
    fl_buf_l: [f32; MAX_FLANGER_SAMPLES],
    fl_buf_r: [f32; MAX_FLANGER_SAMPLES],
    fl_pos: usize,
    // Feedback state
    fb_l: f32,
    fb_r: f32,
    // Smoothed
    rate_sm: SmoothedValue,
    depth_sm: SmoothedValue,
    feedback_sm: SmoothedValue,
    blend_sm: SmoothedValue,
    mix_sm: SmoothedValue,
    sample_rate: f32,
}

impl PhaserFlangerProcessor {
    pub fn new(sample_rate: f32) -> Self {
        let sr = sanitize_sample_rate(sample_rate);
        Self {
            rate: 0.5,
            depth: 0.7,
            feedback: 0.5,
            blend: 0.5,
            stages: 6,
            mix: 0.75,
            stereo_offset: std::f32::consts::FRAC_PI_2,
            lfo_phase: 0.0,
            ap_state_l: [0.0; MAX_PHASER_STAGES],
            ap_state_r: [0.0; MAX_PHASER_STAGES],
            fl_buf_l: [0.0; MAX_FLANGER_SAMPLES],
            fl_buf_r: [0.0; MAX_FLANGER_SAMPLES],
            fl_pos: 0,
            fb_l: 0.0,
            fb_r: 0.0,
            rate_sm: SmoothedValue::new(sr, 10.0, 0.5),
            depth_sm: SmoothedValue::new(sr, 10.0, 0.7),
            feedback_sm: SmoothedValue::new(sr, 10.0, 0.5),
            blend_sm: SmoothedValue::new(sr, 10.0, 0.5),
            mix_sm: SmoothedValue::new(sr, 8.0, 0.75),
            sample_rate: sr,
        }
    }

    /// 1st-order allpass filter: y = -g*x + z; z = g*y + x
    #[inline]
    fn allpass(input: f32, state: &mut f32, g: f32) -> f32 {
        let y = -g * input + *state;
        *state = g * y + input;
        if state.abs() < 1e-20 {
            *state = 0.0;
        }
        y
    }
}

impl DspProcessor for PhaserFlangerProcessor {
    fn process_stereo(&mut self, left: &mut [f32], right: &mut [f32], sample_rate: f32) {
        let sr = sanitize_sample_rate(sample_rate);
        if (sr - self.sample_rate).abs() > 0.5 {
            self.sample_rate = sr;
            self.rate_sm.set_sample_rate(sr);
            self.depth_sm.set_sample_rate(sr);
            self.feedback_sm.set_sample_rate(sr);
            self.blend_sm.set_sample_rate(sr);
            self.mix_sm.set_sample_rate(sr);
        }

        let len = left.len().min(right.len());
        self.rate_sm.set_target(self.rate);
        self.depth_sm.set_target(self.depth);
        self.feedback_sm.set_target(self.feedback);
        self.blend_sm.set_target(self.blend);
        self.mix_sm.set_target(self.mix);

        let stereo_off = self.stereo_offset as f64;
        let stages = self.stages.min(MAX_PHASER_STAGES);

        for i in 0..len {
            let dry_l = left[i];
            let dry_r = right[i];
            let rate = self.rate_sm.next_value();
            let depth = self.depth_sm.next_value();
            let fb = self.feedback_sm.next_value().clamp(-0.95, 0.95);
            let blend = self.blend_sm.next_value();
            let mix = self.mix_sm.next_value();

            // LFO (sine)
            let phase = self.lfo_phase as f32;
            let phase_r_offset = (stereo_off as f32) / std::f32::consts::TAU;
            let lfo_l = crate::fast_math::fast_sin(phase);
            let lfo_r = crate::fast_math::fast_sin(phase + phase_r_offset);
            self.lfo_phase += rate as f64 / sr as f64;
            if self.lfo_phase >= 1.0 {
                self.lfo_phase -= 1.0;
            }

            let lfo_mod_l = (lfo_l * 0.5 + 0.5) * depth;
            let lfo_mod_r = (lfo_r * 0.5 + 0.5) * depth;

            // ── Phaser path ──
            let phaser_freq_l = 200.0 + lfo_mod_l * 4000.0; // 200–4200 Hz sweep
            let phaser_freq_r = 200.0 + lfo_mod_r * 4000.0;
            let g_l = (std::f32::consts::PI * phaser_freq_l / sr).tan();
            let g_l = (g_l - 1.0) / (g_l + 1.0);
            let g_r = (std::f32::consts::PI * phaser_freq_r / sr).tan();
            let g_r = (g_r - 1.0) / (g_r + 1.0);

            let in_l = dry_l + self.fb_l * fb;
            let in_r = dry_r + self.fb_r * fb;

            let mut phaser_l = in_l;
            let mut phaser_r = in_r;
            for s in 0..stages {
                phaser_l = Self::allpass(phaser_l, &mut self.ap_state_l[s], g_l);
                phaser_r = Self::allpass(phaser_r, &mut self.ap_state_r[s], g_r);
            }

            // ── Flanger path ──
            // Write to delay buffer
            self.fl_buf_l[self.fl_pos] = in_l;
            self.fl_buf_r[self.fl_pos] = in_r;

            // Modulated delay: 0.5–5ms
            let delay_l = (0.5 + lfo_mod_l * 4.5) * 0.001 * sr;
            let delay_r = (0.5 + lfo_mod_r * 4.5) * 0.001 * sr;
            let delay_l = delay_l.clamp(1.0, (MAX_FLANGER_SAMPLES - 1) as f32);
            let delay_r = delay_r.clamp(1.0, (MAX_FLANGER_SAMPLES - 1) as f32);

            // Linear interpolation for fractional delay
            let idx_l = delay_l as usize;
            let frac_l = delay_l - idx_l as f32;
            let p1_l = (self.fl_pos + MAX_FLANGER_SAMPLES - idx_l) & FLANGER_MASK;
            let p2_l = (self.fl_pos + MAX_FLANGER_SAMPLES - idx_l - 1) & FLANGER_MASK;
            let flanger_l = self.fl_buf_l[p1_l] * (1.0 - frac_l) + self.fl_buf_l[p2_l] * frac_l;

            let idx_r = delay_r as usize;
            let frac_r = delay_r - idx_r as f32;
            let p1_r = (self.fl_pos + MAX_FLANGER_SAMPLES - idx_r) & FLANGER_MASK;
            let p2_r = (self.fl_pos + MAX_FLANGER_SAMPLES - idx_r - 1) & FLANGER_MASK;
            let flanger_r = self.fl_buf_r[p1_r] * (1.0 - frac_r) + self.fl_buf_r[p2_r] * frac_r;

            self.fl_pos = (self.fl_pos + 1) & FLANGER_MASK;

            // ── Blend phaser and flanger ──
            let wet_l = phaser_l * (1.0 - blend) + flanger_l * blend;
            let wet_r = phaser_r * (1.0 - blend) + flanger_r * blend;
            self.fb_l = wet_l;
            self.fb_r = wet_r;

            left[i] = dry_l * (1.0 - mix) + wet_l * mix;
            right[i] = dry_r * (1.0 - mix) + wet_r * mix;
        }
    }

    fn set_param(&mut self, index: u8, value: f32) {
        match index {
            0 => self.rate = value.clamp(0.01, 20.0),
            1 => self.depth = (value / 100.0).clamp(0.0, 1.0),
            2 => self.feedback = (value / 100.0).clamp(-1.0, 1.0),
            3 => self.blend = (value / 100.0).clamp(0.0, 1.0),
            4 => self.stages = (value as usize).clamp(2, MAX_PHASER_STAGES),
            5 => self.mix = (value / 100.0).clamp(0.0, 1.0),
            6 => {
                self.stereo_offset =
                    (value / 180.0).clamp(0.0, 1.0) * std::f32::consts::PI;
            }
            _ => {}
        }
    }

    fn reset(&mut self) {
        self.lfo_phase = 0.0;
        self.ap_state_l = [0.0; MAX_PHASER_STAGES];
        self.ap_state_r = [0.0; MAX_PHASER_STAGES];
        self.fl_buf_l.fill(0.0);
        self.fl_buf_r.fill(0.0);
        self.fl_pos = 0;
        self.fb_l = 0.0;
        self.fb_r = 0.0;
        self.rate_sm.set_instant(self.rate);
        self.depth_sm.set_instant(self.depth);
        self.feedback_sm.set_instant(self.feedback);
        self.blend_sm.set_instant(self.blend);
        self.mix_sm.set_instant(self.mix);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn phaser_flanger_produces_output() {
        let mut proc = PhaserFlangerProcessor::new(44100.0);
        let sr = 44100.0;
        let mut left: Vec<f32> = (0..4096)
            .map(|i| (std::f32::consts::TAU * 440.0 * i as f32 / sr).sin() * 0.5)
            .collect();
        let mut right = left.clone();
        proc.process_stereo(&mut left, &mut right, sr);
        let rms: f32 = (left[2048..].iter().map(|x| x * x).sum::<f32>() / 2048.0).sqrt();
        assert!(rms > 0.01, "Should produce output: {rms}");
        assert!(left.iter().all(|x| x.is_finite()));
    }

    #[test]
    fn phaser_flanger_blend_extremes() {
        let sr = 44100.0;
        let input: Vec<f32> = (0..4096)
            .map(|i| (std::f32::consts::TAU * 440.0 * i as f32 / sr).sin() * 0.5)
            .collect();

        // Pure phaser
        let mut p = PhaserFlangerProcessor::new(sr);
        p.set_param(3, 0.0);
        let mut l1 = input.clone();
        let mut r1 = input.clone();
        p.process_stereo(&mut l1, &mut r1, sr);

        // Pure flanger
        let mut f = PhaserFlangerProcessor::new(sr);
        f.set_param(3, 100.0);
        let mut l2 = input.clone();
        let mut r2 = input.clone();
        f.process_stereo(&mut l2, &mut r2, sr);

        // They should not be identical (different algorithms)
        let diff: f32 = l1[2048..]
            .iter()
            .zip(l2[2048..].iter())
            .map(|(a, b)| (a - b).abs())
            .sum::<f32>()
            / 2048.0;
        assert!(diff > 0.001, "Phaser and flanger should differ: {diff}");
    }
}
