// ═══════════════════════════════════════════════════════════════════════════
// Dream DAW — Dynamic Tube Processor
// ═══════════════════════════════════════════════════════════════════════════
//
// Bias-modulated tube saturation with envelope-following dynamics.
// The tube bias point shifts with the input envelope, producing
// signal-dependent harmonic content — louder signals get more saturated.
//
// Parameters:
//   0: Drive    (0–100%, default 40%)  — overall tube gain
//   1: Bias     (-100 to +100%, default 20%) — static DC bias offset
//   2: Envelope (0–100%, default 50%)  — how much input level modulates bias
//   3: Tone     (0–100%, default 60%)  — post-LP brightness
//   4: Mix      (0–100%, default 100%)
//   5: Output   (-24 to +6 dB, default 0)
//
// Real-Time Safety: Zero allocations. O(N) per buffer.
//
// ═══════════════════════════════════════════════════════════════════════════

use crate::dsp_processor::DspProcessor;
use crate::processors::smoothing::SmoothedValue;
use crate::processors::{db_to_linear, sanitize_sample_rate};

pub struct DynamicTubeProcessor {
    drive: f32,
    bias: f32,
    envelope_amt: f32,
    tone: f32,
    mix: f32,
    output_db: f32,
    // Envelope follower
    env_l: f32,
    env_r: f32,
    // Tone LP state
    tone_state_l: f32,
    tone_state_r: f32,
    // DC blocker
    dc_prev_in_l: f32,
    dc_prev_in_r: f32,
    dc_prev_out_l: f32,
    dc_prev_out_r: f32,
    dc_coeff: f32,
    // Cached tone
    cached_tone_c: f32,
    cached_tone_freq: f32,
    // BUG-DSP-101: 2x oversampling for tube waveshaping anti-aliasing
    os_l: crate::processors::oversampling::Oversampler2x,
    os_r: crate::processors::oversampling::Oversampler2x,
    // Smoothed
    drive_sm: SmoothedValue,
    bias_sm: SmoothedValue,
    env_amt_sm: SmoothedValue,
    tone_sm: SmoothedValue,
    mix_sm: SmoothedValue,
    output_sm: SmoothedValue,
    sample_rate: f32,
}

impl DynamicTubeProcessor {
    pub fn new(sample_rate: f32) -> Self {
        let sr = sanitize_sample_rate(sample_rate);
        Self {
            drive: 0.4,
            bias: 0.2,
            envelope_amt: 0.5,
            tone: 0.6,
            mix: 1.0,
            output_db: 0.0,
            env_l: 0.0,
            env_r: 0.0,
            tone_state_l: 0.0,
            tone_state_r: 0.0,
            dc_prev_in_l: 0.0,
            dc_prev_in_r: 0.0,
            dc_prev_out_l: 0.0,
            dc_prev_out_r: 0.0,
            dc_coeff: 1.0 - (std::f32::consts::TAU * 15.0 / sr),
            cached_tone_c: (1.0 - crate::fast_math::fast_exp(-std::f32::consts::TAU * 200.0 * crate::fast_math::fast_exp2(0.6 * 6.321928) / sr)).clamp(0.0, 1.0),
            cached_tone_freq: 200.0 * crate::fast_math::fast_exp2(0.6 * 6.321928),
            os_l: crate::processors::oversampling::Oversampler2x::new(sr),
            os_r: crate::processors::oversampling::Oversampler2x::new(sr),
            drive_sm: SmoothedValue::new(sr, 10.0, 0.4),
            bias_sm: SmoothedValue::new(sr, 10.0, 0.2),
            env_amt_sm: SmoothedValue::new(sr, 10.0, 0.5),
            tone_sm: SmoothedValue::new(sr, 10.0, 0.6),
            mix_sm: SmoothedValue::new(sr, 8.0, 1.0),
            output_sm: SmoothedValue::new(sr, 8.0, 1.0),
            sample_rate: sr,
        }
    }

    /// Tube transfer function: biased tanh with asymmetric response.
    /// Models the grid-voltage characteristic of a vacuum tube.
    #[inline]
    fn tube_stage(x: f32, drive: f32, bias: f32) -> f32 {
        let gain = 1.0 + drive * 15.0;
        let biased = x * gain + bias;
        // Asymmetric: positive side clips softer (plate saturation),
        // negative side clips harder (grid cutoff).
        if biased >= 0.0 {
            let b2 = biased * biased;
            biased / (1.0 + b2 * 0.25)
        } else {
            let b2 = biased * biased;
            biased / (1.0 + b2 * 0.5)
        }
    }
}

impl DspProcessor for DynamicTubeProcessor {
    fn process_stereo(&mut self, left: &mut [f32], right: &mut [f32], sample_rate: f32) {
        let sr = sanitize_sample_rate(sample_rate);
        if (sr - self.sample_rate).abs() > 0.5 {
            self.sample_rate = sr;
            self.dc_coeff = 1.0 - (std::f32::consts::TAU * 15.0 / sr);
            self.drive_sm.set_sample_rate(sr);
            self.bias_sm.set_sample_rate(sr);
            self.env_amt_sm.set_sample_rate(sr);
            self.tone_sm.set_sample_rate(sr);
            self.mix_sm.set_sample_rate(sr);
            self.output_sm.set_sample_rate(sr);
            self.cached_tone_c = (1.0 - crate::fast_math::fast_exp(-std::f32::consts::TAU * self.cached_tone_freq / sr)).clamp(0.0, 1.0);
            self.os_l.set_sample_rate(sr);
            self.os_r.set_sample_rate(sr);
        }

        let len = left.len().min(right.len());
        let out_lin = if self.output_db <= -24.0 { 0.0 } else { db_to_linear(self.output_db) };
        self.drive_sm.set_target(self.drive);
        self.bias_sm.set_target(self.bias);
        self.env_amt_sm.set_target(self.envelope_amt);
        self.tone_sm.set_target(self.tone);
        self.mix_sm.set_target(self.mix);
        self.output_sm.set_target(out_lin);

        // Envelope follower coefficients (~5ms attack, ~50ms release)
        let env_atk = crate::processors::envelope_coeff(5.0, sr);
        let env_rel = crate::processors::envelope_coeff(50.0, sr);
        let dc = self.dc_coeff;

        for i in 0..len {
            let dry_l = left[i];
            let dry_r = right[i];
            let drive = self.drive_sm.next_value();
            let static_bias = self.bias_sm.next_value();
            let env_amt = self.env_amt_sm.next_value();
            let tone = self.tone_sm.next_value();
            let mix = self.mix_sm.next_value();
            let out_g = self.output_sm.next_value();

            // Envelope follower for dynamic bias modulation
            let abs_l = dry_l.abs();
            let abs_r = dry_r.abs();
            let c_l = if abs_l > self.env_l { env_atk } else { env_rel };
            self.env_l = c_l * self.env_l + (1.0 - c_l) * abs_l;
            let c_r = if abs_r > self.env_r { env_atk } else { env_rel };
            self.env_r = c_r * self.env_r + (1.0 - c_r) * abs_r;

            // Dynamic bias = static + envelope * amount
            let dyn_bias_l = static_bias + self.env_l * env_amt;
            let dyn_bias_r = static_bias + self.env_r * env_amt;

            // BUG-DSP-101 FIX: 2x oversampled tube saturation with dynamic bias
            let sat_l = self.os_l.process(dry_l, |s| Self::tube_stage(s, drive, dyn_bias_l));
            let sat_r = self.os_r.process(dry_r, |s| Self::tube_stage(s, drive, dyn_bias_r));

            // Tone LP filter
            // log2(80) ≈ 6.32192809
            let tone_cutoff = 200.0 * crate::fast_math::fast_exp2(tone.clamp(0.0, 1.0) * 6.321928);
            if (tone_cutoff - self.cached_tone_freq).abs() > 1.0 {
                self.cached_tone_c = (1.0 - crate::fast_math::fast_exp(-std::f32::consts::TAU * tone_cutoff / sr)).clamp(0.0, 1.0);
                self.cached_tone_freq = tone_cutoff;
            }
            let tc = self.cached_tone_c;
            self.tone_state_l += tc * (sat_l - self.tone_state_l);
            self.tone_state_r += tc * (sat_r - self.tone_state_r);
            let toned_l = self.tone_state_l;
            let toned_r = self.tone_state_r;

            // DC blocker
            let dc_l = toned_l - self.dc_prev_in_l + dc * self.dc_prev_out_l;
            self.dc_prev_in_l = toned_l;
            self.dc_prev_out_l = dc_l;
            let dc_r = toned_r - self.dc_prev_in_r + dc * self.dc_prev_out_r;
            self.dc_prev_in_r = toned_r;
            self.dc_prev_out_r = dc_r;

            // Flush denormals
            crate::processors::flush_denormal!(self.env_l);
            crate::processors::flush_denormal!(self.env_r);
            crate::processors::flush_denormal!(self.tone_state_l);
            crate::processors::flush_denormal!(self.tone_state_r);
            crate::processors::flush_denormal!(self.dc_prev_out_l);
            crate::processors::flush_denormal!(self.dc_prev_out_r);

            left[i] = (dry_l * (1.0 - mix) + dc_l * mix) * out_g;
            right[i] = (dry_r * (1.0 - mix) + dc_r * mix) * out_g;
        }
    }

    fn set_param(&mut self, index: u8, value: f32) {
        match index {
            0 => self.drive = (value / 100.0).clamp(0.0, 1.0),
            1 => self.bias = (value / 100.0).clamp(-1.0, 1.0),
            2 => self.envelope_amt = (value / 100.0).clamp(0.0, 1.0),
            3 => self.tone = (value / 100.0).clamp(0.0, 1.0),
            4 => self.mix = (value / 100.0).clamp(0.0, 1.0),
            5 => self.output_db = value.clamp(-24.0, 6.0),
            _ => {}
        }
    }

    fn reset(&mut self) {
        self.env_l = 0.0;
        self.env_r = 0.0;
        self.tone_state_l = 0.0;
        self.tone_state_r = 0.0;
        self.dc_prev_in_l = 0.0;
        self.dc_prev_in_r = 0.0;
        self.dc_prev_out_l = 0.0;
        self.dc_prev_out_r = 0.0;
        self.drive_sm.set_instant(self.drive);
        self.bias_sm.set_instant(self.bias);
        self.env_amt_sm.set_instant(self.envelope_amt);
        self.tone_sm.set_instant(self.tone);
        self.mix_sm.set_instant(self.mix);
        let out_lin = if self.output_db <= -24.0 { 0.0 } else { db_to_linear(self.output_db) };
        self.output_sm.set_instant(out_lin);
        
        let tone_cutoff = 200.0 * crate::fast_math::fast_exp2(self.tone.clamp(0.0, 1.0) * 6.321928);
        self.cached_tone_c = (1.0 - crate::fast_math::fast_exp(-std::f32::consts::TAU * tone_cutoff / self.sample_rate)).clamp(0.0, 1.0);
        self.cached_tone_freq = tone_cutoff;
        self.os_l.reset();
        self.os_r.reset();
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn dynamic_tube_produces_output() {
        let mut proc = DynamicTubeProcessor::new(44100.0);
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
    fn dynamic_tube_envelope_modulation() {
        let mut proc = DynamicTubeProcessor::new(44100.0);
        proc.set_param(2, 100.0); // Max envelope modulation
        proc.set_param(0, 70.0);  // High drive
        let sr = 44100.0;
        // Loud signal should get more saturation
        let mut left: Vec<f32> = (0..4096)
            .map(|i| (std::f32::consts::TAU * 200.0 * i as f32 / sr).sin() * 0.8)
            .collect();
        let mut right = left.clone();
        proc.process_stereo(&mut left, &mut right, sr);
        assert!(left.iter().all(|x| x.is_finite()));
    }
}
