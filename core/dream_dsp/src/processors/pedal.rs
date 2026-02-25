// ═══════════════════════════════════════════════════════════════════════════
// Dream DAW — Pedal Processor (Multi-Mode Guitar Pedal Emulation)
// ═══════════════════════════════════════════════════════════════════════════
//
// Models several classic stompbox circuits in a single switchable unit.
// Distinct from Amp (full amp model), Overdrive (tube-specific), and
// Distortion (hard-clip).
//
// Modes:
//   0: Fuzz       — asymmetric germanium-style clipping
//   1: Screamer   — mid-hump overdrive (TS-808 inspired)
//   2: Rat        — op-amp hard clip with variable filter
//   3: Muff       — cascaded soft clip stages (Big-Muff inspired)
//
// Parameters:
//   0: Mode    (0–3, default 0)
//   1: Drive   (0–100%, default 40%)
//   2: Tone    (0–100%, default 50%) — LP/HP blend
//   3: Level   (-24 to +6 dB, default -6)
//   4: Mix     (0–100%, default 100%)
//
// ═══════════════════════════════════════════════════════════════════════════

use crate::dsp_processor::DspProcessor;
use crate::processors::smoothing::SmoothedValue;
use crate::processors::{db_to_linear, sanitize_sample_rate};

pub struct PedalProcessor {
    mode: u8,
    drive: f32,
    tone: f32,
    level_db: f32,
    mix: f32,
    // Filter state
    lp_l: f32, lp_r: f32,
    hp_prev_l: f32, hp_out_l: f32,
    hp_prev_r: f32, hp_out_r: f32,
    // DC blocker
    dc_in_l: f32, dc_in_r: f32,
    dc_out_l: f32, dc_out_r: f32,
    dc_c: f32,
    // Smoothed
    drive_sm: SmoothedValue,
    tone_sm: SmoothedValue,
    level_sm: SmoothedValue,
    mix_sm: SmoothedValue,
    sample_rate: f32,
}

impl PedalProcessor {
    pub fn new(sample_rate: f32) -> Self {
        let sr = sanitize_sample_rate(sample_rate);
        Self {
            mode: 0,
            drive: 0.4, tone: 0.5,
            level_db: -6.0, mix: 1.0,
            lp_l: 0.0, lp_r: 0.0,
            hp_prev_l: 0.0, hp_out_l: 0.0,
            hp_prev_r: 0.0, hp_out_r: 0.0,
            dc_in_l: 0.0, dc_in_r: 0.0,
            dc_out_l: 0.0, dc_out_r: 0.0,
            dc_c: 1.0 - (std::f32::consts::TAU * 20.0 / sr),
            drive_sm: SmoothedValue::new(sr, 10.0, 0.4),
            tone_sm: SmoothedValue::new(sr, 10.0, 0.5),
            level_sm: SmoothedValue::new(sr, 8.0, db_to_linear(-6.0)),
            mix_sm: SmoothedValue::new(sr, 8.0, 1.0),
            sample_rate: sr,
        }
    }

    /// Germanium fuzz: asymmetric soft-clip
    #[inline]
    fn fuzz(x: f32, drive: f32) -> f32 {
        let g = 1.0 + drive * 50.0;
        let d = x * g;
        if d >= 0.0 {
            1.0 - (-d.min(10.0)).exp()
        } else {
            -(1.0 - (d.max(-10.0)).exp()) * 0.8
        }
    }

    /// TS-808 screamer: mid-hump soft clip
    #[inline]
    fn screamer(x: f32, drive: f32) -> f32 {
        let g = 1.0 + drive * 20.0;
        let d = (x * g).clamp(-4.0, 4.0);
        d / (1.0 + d.abs())
    }

    /// RAT-style: op-amp hard clip
    #[inline]
    fn rat(x: f32, drive: f32) -> f32 {
        let g = 1.0 + drive * 40.0;
        (x * g).clamp(-1.0, 1.0)
    }

    /// Big Muff: cascaded soft clip
    #[inline]
    fn muff(x: f32, drive: f32) -> f32 {
        let g1 = 1.0 + drive * 15.0;
        let s1 = (x * g1).tanh();
        let g2 = 1.0 + drive * 10.0;
        (s1 * g2).tanh()
    }
}

impl DspProcessor for PedalProcessor {
    fn process_stereo(&mut self, left: &mut [f32], right: &mut [f32], sample_rate: f32) {
        let sr = sanitize_sample_rate(sample_rate);
        if (sr - self.sample_rate).abs() > 0.5 {
            self.sample_rate = sr;
            self.dc_c = 1.0 - (std::f32::consts::TAU * 20.0 / sr);
            for sm in [&mut self.drive_sm, &mut self.tone_sm,
                       &mut self.level_sm, &mut self.mix_sm] {
                sm.set_sample_rate(sr);
            }
        }

        let len = left.len().min(right.len());
        let level_lin = if self.level_db <= -24.0 { 0.0 } else { db_to_linear(self.level_db) };
        self.drive_sm.set_target(self.drive);
        self.tone_sm.set_target(self.tone);
        self.level_sm.set_target(level_lin);
        self.mix_sm.set_target(self.mix);

        let dc = self.dc_c;

        for i in 0..len {
            let dry_l = left[i];
            let dry_r = right[i];
            let drive = self.drive_sm.next_value();
            let tone = self.tone_sm.next_value();
            let level = self.level_sm.next_value();
            let mix = self.mix_sm.next_value();

            // Apply clipping based on mode
            let (clip_l, clip_r) = match self.mode {
                0 => (Self::fuzz(dry_l, drive), Self::fuzz(dry_r, drive)),
                1 => (Self::screamer(dry_l, drive), Self::screamer(dry_r, drive)),
                2 => (Self::rat(dry_l, drive), Self::rat(dry_r, drive)),
                _ => (Self::muff(dry_l, drive), Self::muff(dry_r, drive)),
            };

            // Tone control: blend LP and HP
            let lp_c = (1.0 - (-std::f32::consts::TAU * (500.0 + tone * 4000.0) / sr).exp()).clamp(0.0, 1.0);
            let hp_c = (-std::f32::consts::TAU * (100.0 + (1.0 - tone) * 200.0) / sr).exp();
            self.lp_l += lp_c * (clip_l - self.lp_l);
            self.lp_r += lp_c * (clip_r - self.lp_r);
            self.hp_out_l = hp_c * (self.hp_out_l + clip_l - self.hp_prev_l);
            self.hp_prev_l = clip_l;
            self.hp_out_r = hp_c * (self.hp_out_r + clip_r - self.hp_prev_r);
            self.hp_prev_r = clip_r;

            let tone_l = self.lp_l * (1.0 - tone) + self.hp_out_l * tone;
            let tone_r = self.lp_r * (1.0 - tone) + self.hp_out_r * tone;

            // DC blocker
            let dcb_l = tone_l - self.dc_in_l + dc * self.dc_out_l;
            self.dc_in_l = tone_l; self.dc_out_l = dcb_l;
            let dcb_r = tone_r - self.dc_in_r + dc * self.dc_out_r;
            self.dc_in_r = tone_r; self.dc_out_r = dcb_r;

            crate::processors::flush_denormal!(self.lp_l);
            crate::processors::flush_denormal!(self.lp_r);
            crate::processors::flush_denormal!(self.hp_out_l);
            crate::processors::flush_denormal!(self.hp_out_r);
            crate::processors::flush_denormal!(self.dc_out_l);
            crate::processors::flush_denormal!(self.dc_out_r);

            left[i] = (dry_l * (1.0 - mix) + dcb_l * mix) * level;
            right[i] = (dry_r * (1.0 - mix) + dcb_r * mix) * level;
        }
    }

    fn set_param(&mut self, index: u8, value: f32) {
        match index {
            0 => self.mode = (value as u8).min(3),
            1 => self.drive = (value / 100.0).clamp(0.0, 1.0),
            2 => self.tone = (value / 100.0).clamp(0.0, 1.0),
            3 => self.level_db = value.clamp(-24.0, 6.0),
            4 => self.mix = (value / 100.0).clamp(0.0, 1.0),
            _ => {}
        }
    }

    fn reset(&mut self) {
        self.lp_l = 0.0; self.lp_r = 0.0;
        self.hp_prev_l = 0.0; self.hp_out_l = 0.0;
        self.hp_prev_r = 0.0; self.hp_out_r = 0.0;
        self.dc_in_l = 0.0; self.dc_in_r = 0.0;
        self.dc_out_l = 0.0; self.dc_out_r = 0.0;
        self.drive_sm.set_instant(self.drive);
        self.tone_sm.set_instant(self.tone);
        let l = if self.level_db <= -24.0 { 0.0 } else { db_to_linear(self.level_db) };
        self.level_sm.set_instant(l);
        self.mix_sm.set_instant(self.mix);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn pedal_modes_all_produce_output() {
        let sr = 44100.0;
        for mode in 0..4u8 {
            let mut proc = PedalProcessor::new(sr);
            proc.set_param(0, mode as f32);
            proc.set_param(1, 70.0); // High drive
            let mut left: Vec<f32> = (0..4096)
                .map(|i| (std::f32::consts::TAU * 200.0 * i as f32 / sr).sin() * 0.3)
                .collect();
            let mut right = left.clone();
            proc.process_stereo(&mut left, &mut right, sr);
            assert!(left.iter().all(|x| x.is_finite()), "mode {mode} NaN");
            let rms: f32 = (left[2048..].iter().map(|x| x * x).sum::<f32>() / 2048.0).sqrt();
            assert!(rms > 0.001, "mode {mode} silent: {rms}");
        }
    }
}
