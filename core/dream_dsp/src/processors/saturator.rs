// ═══════════════════════════════════════════════════════════════════════════
// Dream DAW — Saturator Processor
// ═══════════════════════════════════════════════════════════════════════════
//
// Analog-modeled saturation with selectable waveshaping curves. Distinct
// from Overdrive (tube-focused), Distortion (hard clip), and Pedal
// (stompbox models).
//
// Curves:
//   0: Analog Clip — variable knee soft-clip
//   1: Tape — hysteresis-inspired saturation
//   2: Tube — triode transfer function
//   3: Diode — asymmetric diode clipper
//   4: Sinefold — sinusoidal wavefolder
//
// Parameters:
//   0: Curve    (0–4, default 0)
//   1: Drive    (0–100%, default 30%)
//   2: Output   (-24 to +6 dB, default 0)
//   3: Colour   (0–100%, default 50%) — pre-saturation tilt
//   4: Mix      (0–100%, default 100%)
//
// ═══════════════════════════════════════════════════════════════════════════

use crate::dsp_processor::DspProcessor;
use crate::processors::smoothing::SmoothedValue;
use crate::processors::{db_to_linear, sanitize_sample_rate};

pub struct SaturatorProcessor {
    curve: u8,
    drive: f32,
    output_db: f32,
    colour: f32,
    mix: f32,
    // DC blocker
    dc_in_l: f32, dc_in_r: f32,
    dc_out_l: f32, dc_out_r: f32,
    dc_c: f32,
    // Colour tilt filter
    tilt_z_l: f32, tilt_z_r: f32,
    // Smoothed
    drive_sm: SmoothedValue,
    output_sm: SmoothedValue,
    colour_sm: SmoothedValue,
    mix_sm: SmoothedValue,
    sample_rate: f32,
}

impl SaturatorProcessor {
    pub fn new(sample_rate: f32) -> Self {
        let sr = sanitize_sample_rate(sample_rate);
        Self {
            curve: 0, drive: 0.3, output_db: 0.0, colour: 0.5, mix: 1.0,
            dc_in_l: 0.0, dc_in_r: 0.0, dc_out_l: 0.0, dc_out_r: 0.0,
            dc_c: 1.0 - (std::f32::consts::TAU * 20.0 / sr),
            tilt_z_l: 0.0, tilt_z_r: 0.0,
            drive_sm: SmoothedValue::new(sr, 10.0, 0.3),
            output_sm: SmoothedValue::new(sr, 8.0, 1.0),
            colour_sm: SmoothedValue::new(sr, 10.0, 0.5),
            mix_sm: SmoothedValue::new(sr, 8.0, 1.0),
            sample_rate: sr,
        }
    }

    #[inline]
    fn analog_clip(x: f32, drive: f32) -> f32 {
        let g = 1.0 + drive * 20.0;
        let d = x * g;
        let knee = 1.0 - drive * 0.5;
        d / (1.0 + (d / knee.max(0.1)).abs()).powf(knee.max(0.1))
    }

    #[inline]
    fn tape(x: f32, drive: f32) -> f32 {
        let g = 1.0 + drive * 15.0;
        let d = x * g;
        let pos = d.max(0.0).tanh();
        let neg = -((-d).max(0.0) * 0.85).tanh();
        if d >= 0.0 { pos } else { neg }
    }

    #[inline]
    fn tube_curve(x: f32, drive: f32) -> f32 {
        let g = 1.0 + drive * 25.0;
        let d = x * g;
        if d >= 0.0 {
            d / (1.0 + d * 0.5)
        } else {
            d.max(-3.0).tanh()
        }
    }

    #[inline]
    fn diode(x: f32, drive: f32) -> f32 {
        let g = 1.0 + drive * 30.0;
        let d = x * g;
        if d > 0.6 { 0.6 + (d - 0.6) / (1.0 + (d - 0.6) * 3.0) }
        else if d < -0.3 { -0.3 + (d + 0.3) / (1.0 + (-d - 0.3) * 5.0) }
        else { d }
    }

    #[inline]
    fn sinefold(x: f32, drive: f32) -> f32 {
        let g = 1.0 + drive * 6.0;
        (x * g * std::f32::consts::FRAC_PI_2).sin()
    }
}

impl DspProcessor for SaturatorProcessor {
    fn process_stereo(&mut self, left: &mut [f32], right: &mut [f32], sample_rate: f32) {
        let sr = sanitize_sample_rate(sample_rate);
        if (sr - self.sample_rate).abs() > 0.5 {
            self.sample_rate = sr;
            self.dc_c = 1.0 - (std::f32::consts::TAU * 20.0 / sr);
            for sm in [&mut self.drive_sm, &mut self.output_sm,
                       &mut self.colour_sm, &mut self.mix_sm] {
                sm.set_sample_rate(sr);
            }
        }

        let len = left.len().min(right.len());
        let out_lin = if self.output_db <= -24.0 { 0.0 } else { db_to_linear(self.output_db) };
        self.drive_sm.set_target(self.drive);
        self.output_sm.set_target(out_lin);
        self.colour_sm.set_target(self.colour);
        self.mix_sm.set_target(self.mix);
        let dc = self.dc_c;

        for i in 0..len {
            let dry_l = left[i];
            let dry_r = right[i];
            let drive = self.drive_sm.next_value();
            let output = self.output_sm.next_value();
            let colour = self.colour_sm.next_value();
            let mix = self.mix_sm.next_value();

            // Pre-saturation tilt (colour)
            // BUG-B18-003 FIX: Use fast_exp instead of per-sample std exp() for tilt coeff.
            let tilt_c = (1.0 - crate::fast_math::fast_exp(-std::f32::consts::TAU * (200.0 + colour * 8000.0) / sr)).clamp(0.0, 1.0);
            self.tilt_z_l += tilt_c * (dry_l - self.tilt_z_l);
            self.tilt_z_r += tilt_c * (dry_r - self.tilt_z_r);
            let tilted_l = self.tilt_z_l * (1.0 - colour) + dry_l * colour;
            let tilted_r = self.tilt_z_r * (1.0 - colour) + dry_r * colour;

            let (sat_l, sat_r) = match self.curve {
                0 => (Self::analog_clip(tilted_l, drive), Self::analog_clip(tilted_r, drive)),
                1 => (Self::tape(tilted_l, drive), Self::tape(tilted_r, drive)),
                2 => (Self::tube_curve(tilted_l, drive), Self::tube_curve(tilted_r, drive)),
                3 => (Self::diode(tilted_l, drive), Self::diode(tilted_r, drive)),
                _ => (Self::sinefold(tilted_l, drive), Self::sinefold(tilted_r, drive)),
            };

            // DC blocker
            let dcb_l = sat_l - self.dc_in_l + dc * self.dc_out_l;
            self.dc_in_l = sat_l; self.dc_out_l = dcb_l;
            let dcb_r = sat_r - self.dc_in_r + dc * self.dc_out_r;
            self.dc_in_r = sat_r; self.dc_out_r = dcb_r;

            crate::processors::flush_denormal!(self.tilt_z_l);
            crate::processors::flush_denormal!(self.tilt_z_r);
            crate::processors::flush_denormal!(self.dc_out_l);
            crate::processors::flush_denormal!(self.dc_out_r);

            left[i] = (dry_l * (1.0 - mix) + dcb_l * mix) * output;
            right[i] = (dry_r * (1.0 - mix) + dcb_r * mix) * output;
        }
    }

    fn set_param(&mut self, index: u8, value: f32) {
        match index {
            0 => self.curve = (value as u8).min(4),
            1 => self.drive = (value / 100.0).clamp(0.0, 1.0),
            2 => self.output_db = value.clamp(-24.0, 6.0),
            3 => self.colour = (value / 100.0).clamp(0.0, 1.0),
            4 => self.mix = (value / 100.0).clamp(0.0, 1.0),
            _ => {}
        }
    }

    fn reset(&mut self) {
        self.dc_in_l = 0.0; self.dc_in_r = 0.0;
        self.dc_out_l = 0.0; self.dc_out_r = 0.0;
        self.tilt_z_l = 0.0; self.tilt_z_r = 0.0;
        self.drive_sm.set_instant(self.drive);
        let o = if self.output_db <= -24.0 { 0.0 } else { db_to_linear(self.output_db) };
        self.output_sm.set_instant(o);
        self.colour_sm.set_instant(self.colour);
        self.mix_sm.set_instant(self.mix);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn saturator_all_curves() {
        let sr = 44100.0;
        for c in 0..5u8 {
            let mut proc = SaturatorProcessor::new(sr);
            proc.set_param(0, c as f32);
            proc.set_param(1, 70.0);
            let mut left: Vec<f32> = (0..4096)
                .map(|i| (std::f32::consts::TAU * 200.0 * i as f32 / sr).sin() * 0.3)
                .collect();
            let mut right = left.clone();
            proc.process_stereo(&mut left, &mut right, sr);
            assert!(left.iter().all(|x| x.is_finite()), "curve {c} NaN");
            let rms: f32 = (left[2048..].iter().map(|x| x * x).sum::<f32>() / 2048.0).sqrt();
            assert!(rms > 0.001, "curve {c} silent: {rms}");
        }
    }
}
