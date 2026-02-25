// ═══════════════════════════════════════════════════════════════════════════
// Dream DAW — Roar Processor (Aggressive Saturation / Character Distortion)
// ═══════════════════════════════════════════════════════════════════════════
//
// Multi-character saturation engine. Where Overdrive is warm tube,
// Distortion is hard clip, and Pedal emulates stompboxes, Roar provides
// aggressive, character-heavy saturation for modern production.
//
// Characters:
//   0: Growl     — wavefolder saturation
//   1: Scream    — rectifier + resonant feedback
//   2: Crush     — bit-reduction + sample-rate reduction
//   3: Fire      — exponential saturation + harmonic exciter
//
// Parameters:
//   0: Character (0–3, default 0)
//   1: Intensity (0–100%, default 40%)
//   2: Color     (0–100%, default 50%)  — tonal shaping
//   3: Feedback  (0–80%, default 0%)    — resonant feedback
//   4: Output    (-24 to +6 dB, default -6)
//   5: Mix       (0–100%, default 100%)
//
// ═══════════════════════════════════════════════════════════════════════════

use crate::dsp_processor::DspProcessor;
use crate::processors::smoothing::SmoothedValue;
use crate::processors::{db_to_linear, sanitize_sample_rate};

pub struct RoarProcessor {
    character: u8,
    intensity: f32,
    color: f32,
    feedback: f32,
    output_db: f32,
    mix: f32,
    // Feedback state
    fb_l: f32, fb_r: f32,
    // Color filter
    color_z_l: f32, color_z_r: f32,
    // Crush state
    hold_l: f32, hold_r: f32,
    hold_counter: f32,
    // DC blocker
    dc_in_l: f32, dc_in_r: f32,
    dc_out_l: f32, dc_out_r: f32,
    dc_c: f32,
    // Smoothed
    intensity_sm: SmoothedValue,
    color_sm: SmoothedValue,
    fb_sm: SmoothedValue,
    output_sm: SmoothedValue,
    mix_sm: SmoothedValue,
    sample_rate: f32,
}

impl RoarProcessor {
    pub fn new(sample_rate: f32) -> Self {
        let sr = sanitize_sample_rate(sample_rate);
        Self {
            character: 0,
            intensity: 0.4, color: 0.5,
            feedback: 0.0, output_db: -6.0, mix: 1.0,
            fb_l: 0.0, fb_r: 0.0,
            color_z_l: 0.0, color_z_r: 0.0,
            hold_l: 0.0, hold_r: 0.0,
            hold_counter: 0.0,
            dc_in_l: 0.0, dc_in_r: 0.0,
            dc_out_l: 0.0, dc_out_r: 0.0,
            dc_c: 1.0 - (std::f32::consts::TAU * 20.0 / sr),
            intensity_sm: SmoothedValue::new(sr, 10.0, 0.4),
            color_sm: SmoothedValue::new(sr, 10.0, 0.5),
            fb_sm: SmoothedValue::new(sr, 10.0, 0.0),
            output_sm: SmoothedValue::new(sr, 8.0, db_to_linear(-6.0)),
            mix_sm: SmoothedValue::new(sr, 8.0, 1.0),
            sample_rate: sr,
        }
    }

    /// Wavefolder: sin(x * gain)
    #[inline]
    fn wavefold(x: f32, intensity: f32) -> f32 {
        let g = 1.0 + intensity * 8.0;
        (x * g * std::f32::consts::PI).sin()
    }

    /// Rectifier + resonance
    #[inline]
    fn rectify(x: f32, intensity: f32) -> f32 {
        let g = 1.0 + intensity * 10.0;
        let d = x * g;
        d.abs().min(2.0) * d.signum()
    }

    /// Bit reduction
    #[inline]
    fn bitcrush(x: f32, intensity: f32) -> f32 {
        let bits = (16.0 - intensity * 14.0).max(2.0);
        let steps = 2.0_f32.powf(bits);
        (x * steps).round() / steps
    }

    /// Exponential saturation
    #[inline]
    fn fire(x: f32, intensity: f32) -> f32 {
        let g = 1.0 + intensity * 20.0;
        let d = x * g;
        if d >= 0.0 {
            1.0 - (-d.min(10.0)).exp()
        } else {
            -(1.0 - (d.max(-10.0)).exp())
        }
    }
}

impl DspProcessor for RoarProcessor {
    fn process_stereo(&mut self, left: &mut [f32], right: &mut [f32], sample_rate: f32) {
        let sr = sanitize_sample_rate(sample_rate);
        if (sr - self.sample_rate).abs() > 0.5 {
            self.sample_rate = sr;
            self.dc_c = 1.0 - (std::f32::consts::TAU * 20.0 / sr);
            for sm in [&mut self.intensity_sm, &mut self.color_sm,
                       &mut self.fb_sm, &mut self.output_sm, &mut self.mix_sm] {
                sm.set_sample_rate(sr);
            }
        }

        let len = left.len().min(right.len());
        let out_lin = if self.output_db <= -24.0 { 0.0 } else { db_to_linear(self.output_db) };
        self.intensity_sm.set_target(self.intensity);
        self.color_sm.set_target(self.color);
        self.fb_sm.set_target(self.feedback);
        self.output_sm.set_target(out_lin);
        self.mix_sm.set_target(self.mix);

        let dc = self.dc_c;

        for i in 0..len {
            let dry_l = left[i];
            let dry_r = right[i];
            let intensity = self.intensity_sm.next_value();
            let color = self.color_sm.next_value();
            let fb = self.fb_sm.next_value();
            let output = self.output_sm.next_value();
            let mix = self.mix_sm.next_value();

            // Add feedback
            let in_l = dry_l + self.fb_l * fb;
            let in_r = dry_r + self.fb_r * fb;

            // Apply character
            let (sat_l, sat_r) = match self.character {
                0 => (Self::wavefold(in_l, intensity), Self::wavefold(in_r, intensity)),
                1 => (Self::rectify(in_l, intensity), Self::rectify(in_r, intensity)),
                2 => {
                    // Sample rate reduction for crush
                    let sr_div = 1.0 + intensity * 30.0;
                    self.hold_counter += 1.0;
                    if self.hold_counter >= sr_div {
                        self.hold_counter -= sr_div;
                        self.hold_l = Self::bitcrush(in_l, intensity);
                        self.hold_r = Self::bitcrush(in_r, intensity);
                    }
                    (self.hold_l, self.hold_r)
                }
                _ => (Self::fire(in_l, intensity), Self::fire(in_r, intensity)),
            };

            // Color filter (variable LP)
            let c = (1.0 - (-std::f32::consts::TAU * (500.0 + color * 10000.0) / sr).exp()).clamp(0.0, 1.0);
            self.color_z_l += c * (sat_l - self.color_z_l);
            self.color_z_r += c * (sat_r - self.color_z_r);

            // Store feedback (pre-filter for character)
            self.fb_l = self.color_z_l.clamp(-1.0, 1.0);
            self.fb_r = self.color_z_r.clamp(-1.0, 1.0);

            // DC blocker
            let dcb_l = self.color_z_l - self.dc_in_l + dc * self.dc_out_l;
            self.dc_in_l = self.color_z_l; self.dc_out_l = dcb_l;
            let dcb_r = self.color_z_r - self.dc_in_r + dc * self.dc_out_r;
            self.dc_in_r = self.color_z_r; self.dc_out_r = dcb_r;

            crate::processors::flush_denormal!(self.color_z_l);
            crate::processors::flush_denormal!(self.color_z_r);
            crate::processors::flush_denormal!(self.dc_out_l);
            crate::processors::flush_denormal!(self.dc_out_r);
            crate::processors::flush_denormal!(self.fb_l);
            crate::processors::flush_denormal!(self.fb_r);

            left[i] = (dry_l * (1.0 - mix) + dcb_l * mix) * output;
            right[i] = (dry_r * (1.0 - mix) + dcb_r * mix) * output;
        }
    }

    fn set_param(&mut self, index: u8, value: f32) {
        match index {
            0 => self.character = (value as u8).min(3),
            1 => self.intensity = (value / 100.0).clamp(0.0, 1.0),
            2 => self.color = (value / 100.0).clamp(0.0, 1.0),
            3 => self.feedback = (value / 100.0).clamp(0.0, 0.8),
            4 => self.output_db = value.clamp(-24.0, 6.0),
            5 => self.mix = (value / 100.0).clamp(0.0, 1.0),
            _ => {}
        }
    }

    fn reset(&mut self) {
        self.fb_l = 0.0; self.fb_r = 0.0;
        self.color_z_l = 0.0; self.color_z_r = 0.0;
        self.hold_l = 0.0; self.hold_r = 0.0;
        self.hold_counter = 0.0;
        self.dc_in_l = 0.0; self.dc_in_r = 0.0;
        self.dc_out_l = 0.0; self.dc_out_r = 0.0;
        self.intensity_sm.set_instant(self.intensity);
        self.color_sm.set_instant(self.color);
        self.fb_sm.set_instant(self.feedback);
        let o = if self.output_db <= -24.0 { 0.0 } else { db_to_linear(self.output_db) };
        self.output_sm.set_instant(o);
        self.mix_sm.set_instant(self.mix);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn roar_all_characters() {
        let sr = 44100.0;
        for ch in 0..4u8 {
            let mut proc = RoarProcessor::new(sr);
            proc.set_param(0, ch as f32);
            proc.set_param(1, 60.0); // Moderate intensity
            let mut left: Vec<f32> = (0..4096)
                .map(|i| (std::f32::consts::TAU * 200.0 * i as f32 / sr).sin() * 0.3)
                .collect();
            let mut right = left.clone();
            proc.process_stereo(&mut left, &mut right, sr);
            assert!(left.iter().all(|x| x.is_finite()), "char {ch} NaN");
        }
    }
}
