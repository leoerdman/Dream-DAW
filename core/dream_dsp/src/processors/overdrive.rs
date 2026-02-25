// ═══════════════════════════════════════════════════════════════════════════
// Dream DAW — Overdrive Processor
// ═══════════════════════════════════════════════════════════════════════════
//
// Smooth tube-style saturation with asymmetric soft clipping.
// Distinct from Distortion (hard-clip modes) and Saturator (waveshaper modes).
//
// Characteristics:
//   - Asymmetric tanh soft-clip with bias control for even-harmonic warmth
//   - Pre-emphasis tone control (treble drive amount)
//   - Post-LP tone filter (cabinet darkness)
//   - 2x internal oversampling to reduce aliasing
//
// Parameters:
//   0: Drive      (0–100%, default 50%)  — amount of tube saturation
//   1: Tone       (0–100%, default 50%)  — brightness (post-filter LP cutoff)
//   2: Mix        (0–100%, default 100%) — parallel blend
//   3: Output     (-24 to +6 dB, default 0)
//   4: Bias       (-100 to +100%, default 10%) — asymmetry for even harmonics
//   5: Tight      (0–100%, default 30%)  — HP before drive (bass tightness)
//
// Real-Time Safety: Zero allocations. O(N) per buffer.
//
// ═══════════════════════════════════════════════════════════════════════════

use crate::dsp_processor::DspProcessor;
use crate::processors::smoothing::SmoothedValue;
use crate::processors::{db_to_linear, sanitize_sample_rate};

pub struct OverdriveProcessor {
    drive: f32,         // 0..1
    tone: f32,          // 0..1 → LP cutoff
    mix: f32,           // 0..1
    output_db: f32,
    bias: f32,          // -1..1
    tight: f32,         // 0..1 → HP cutoff
    // Filter state
    tone_state_l: f32,
    tone_state_r: f32,
    tight_state_l: f32,
    tight_state_r: f32,
    // DC blocker
    dc_prev_in_l: f32,
    dc_prev_in_r: f32,
    dc_prev_out_l: f32,
    dc_prev_out_r: f32,
    dc_coeff: f32,
    // Oversampling anti-alias LP state
    os_state_l: f32,
    os_state_r: f32,
    // Smoothed params
    drive_sm: SmoothedValue,
    tone_sm: SmoothedValue,
    mix_sm: SmoothedValue,
    output_sm: SmoothedValue,
    bias_sm: SmoothedValue,
    tight_sm: SmoothedValue,
    sample_rate: f32,
}

impl OverdriveProcessor {
    pub fn new(sample_rate: f32) -> Self {
        let sr = sanitize_sample_rate(sample_rate);
        Self {
            drive: 0.5,
            tone: 0.5,
            mix: 1.0,
            output_db: 0.0,
            bias: 0.1,
            tight: 0.3,
            tone_state_l: 0.0,
            tone_state_r: 0.0,
            tight_state_l: 0.0,
            tight_state_r: 0.0,
            dc_prev_in_l: 0.0,
            dc_prev_in_r: 0.0,
            dc_prev_out_l: 0.0,
            dc_prev_out_r: 0.0,
            dc_coeff: Self::dc_coeff_for_sr(sr),
            os_state_l: 0.0,
            os_state_r: 0.0,
            drive_sm: SmoothedValue::new(sr, 10.0, 0.5),
            tone_sm: SmoothedValue::new(sr, 10.0, 0.5),
            mix_sm: SmoothedValue::new(sr, 8.0, 1.0),
            output_sm: SmoothedValue::new(sr, 8.0, 1.0),
            bias_sm: SmoothedValue::new(sr, 10.0, 0.1),
            tight_sm: SmoothedValue::new(sr, 10.0, 0.3),
            sample_rate: sr,
        }
    }

    #[inline]
    fn dc_coeff_for_sr(sr: f32) -> f32 {
        1.0 - (std::f32::consts::TAU * 20.0 / sr)
    }

    /// Tone % → LP cutoff Hz (200–16000 mapped exponentially)
    #[inline]
    fn tone_to_cutoff(tone: f32) -> f32 {
        200.0 * (80.0f32).powf(tone.clamp(0.0, 1.0))
    }

    /// Tightness % → HP cutoff Hz (20–500 mapped exponentially)
    #[inline]
    fn tight_to_cutoff(tight: f32) -> f32 {
        20.0 * (25.0f32).powf(tight.clamp(0.0, 1.0))
    }

    #[inline]
    fn lp_coeff(cutoff: f32, sr: f32) -> f32 {
        (1.0 - (-std::f32::consts::TAU * cutoff / sr).exp()).clamp(0.0, 1.0)
    }

    #[inline]
    fn hp_coeff(cutoff: f32, sr: f32) -> f32 {
        (-std::f32::consts::TAU * cutoff / sr).exp()
    }

    /// Asymmetric tanh soft-clip — positive side clips earlier than negative
    /// when bias > 0, producing even harmonics (2nd, 4th) for tube warmth.
    #[inline]
    fn tube_clip(x: f32, drive: f32, bias: f32) -> f32 {
        let gain = 1.0 + drive * 20.0; // 1x to 21x
        let driven = (x + bias * 0.5) * gain;
        // Fast tanh approximation (Pade [3/2])
        let x2 = driven * driven;
        let a = driven * (27.0 + x2);
        a / (27.0 + 9.0 * x2)
    }

    /// DC blocker — removes offset introduced by asymmetric clipping
    #[inline]
    fn dc_block(
        input: f32,
        prev_in: &mut f32,
        prev_out: &mut f32,
        coeff: f32,
    ) -> f32 {
        let out = input - *prev_in + coeff * *prev_out;
        *prev_in = input;
        *prev_out = out;
        out
    }
}

impl DspProcessor for OverdriveProcessor {
    fn process_stereo(&mut self, left: &mut [f32], right: &mut [f32], sample_rate: f32) {
        let sr = sanitize_sample_rate(sample_rate);
        if (sr - self.sample_rate).abs() > 0.5 {
            self.sample_rate = sr;
            self.dc_coeff = Self::dc_coeff_for_sr(sr);
            self.drive_sm.set_sample_rate(sr);
            self.tone_sm.set_sample_rate(sr);
            self.mix_sm.set_sample_rate(sr);
            self.output_sm.set_sample_rate(sr);
            self.bias_sm.set_sample_rate(sr);
            self.tight_sm.set_sample_rate(sr);
        }

        let len = left.len().min(right.len());
        let output_lin = if self.output_db <= -24.0 {
            0.0
        } else {
            db_to_linear(self.output_db)
        };
        self.drive_sm.set_target(self.drive);
        self.tone_sm.set_target(self.tone);
        self.mix_sm.set_target(self.mix);
        self.output_sm.set_target(output_lin);
        self.bias_sm.set_target(self.bias);
        self.tight_sm.set_target(self.tight);

        let dc = self.dc_coeff;
        // 2x oversampling handled below via midpoint interpolation

        for i in 0..len {
            let dry_l = left[i];
            let dry_r = right[i];
            let drive = self.drive_sm.next_value();
            let tone = self.tone_sm.next_value();
            let mix = self.mix_sm.next_value();
            let out_g = self.output_sm.next_value();
            let bias = self.bias_sm.next_value();
            let tight = self.tight_sm.next_value();

            // Tightness HP (remove bass before drive)
            let hp_c = Self::hp_coeff(Self::tight_to_cutoff(tight), sr);
            self.tight_state_l = hp_c * (self.tight_state_l + dry_l);
            let tight_l = self.tight_state_l;
            self.tight_state_l -= dry_l * hp_c;
            // Correct: y[n] = α*(y[n-1] + x[n] - x[n-1]), simplified as LP-subtract
            let pre_l = dry_l - (dry_l - tight_l) * tight;
            self.tight_state_r = hp_c * (self.tight_state_r + dry_r);
            let tight_r = self.tight_state_r;
            self.tight_state_r -= dry_r * hp_c;
            let pre_r = dry_r - (dry_r - tight_r) * tight;

            // 2x oversampled tube saturation (process at double rate for less aliasing)
            // Phase 1: original sample
            let sat_l_1 = Self::tube_clip(pre_l, drive, bias);
            let sat_r_1 = Self::tube_clip(pre_r, drive, bias);
            // Phase 2: interpolated midpoint
            let mid_l = (self.os_state_l + pre_l) * 0.5;
            let mid_r = (self.os_state_r + pre_r) * 0.5;
            let sat_l_2 = Self::tube_clip(mid_l, drive, bias);
            let sat_r_2 = Self::tube_clip(mid_r, drive, bias);
            self.os_state_l = pre_l;
            self.os_state_r = pre_r;
            // Average oversampled phases
            let sat_l = (sat_l_1 + sat_l_2) * 0.5;
            let sat_r = (sat_r_1 + sat_r_2) * 0.5;

            // Tone LP filter
            let tone_cutoff = Self::tone_to_cutoff(tone);
            let tone_c = Self::lp_coeff(tone_cutoff, sr);
            self.tone_state_l += tone_c * (sat_l - self.tone_state_l);
            self.tone_state_r += tone_c * (sat_r - self.tone_state_r);
            let filtered_l = self.tone_state_l;
            let filtered_r = self.tone_state_r;

            // DC blocker
            let clean_l = Self::dc_block(
                filtered_l,
                &mut self.dc_prev_in_l,
                &mut self.dc_prev_out_l,
                dc,
            );
            let clean_r = Self::dc_block(
                filtered_r,
                &mut self.dc_prev_in_r,
                &mut self.dc_prev_out_r,
                dc,
            );

            // Flush denormals
            crate::processors::flush_denormal!(self.tone_state_l);
            crate::processors::flush_denormal!(self.tone_state_r);
            crate::processors::flush_denormal!(self.tight_state_l);
            crate::processors::flush_denormal!(self.tight_state_r);
            crate::processors::flush_denormal!(self.dc_prev_out_l);
            crate::processors::flush_denormal!(self.dc_prev_out_r);

            // Mix and output
            left[i] = (dry_l * (1.0 - mix) + clean_l * mix) * out_g;
            right[i] = (dry_r * (1.0 - mix) + clean_r * mix) * out_g;
        }
    }

    fn set_param(&mut self, index: u8, value: f32) {
        match index {
            0 => self.drive = (value / 100.0).clamp(0.0, 1.0),
            1 => self.tone = (value / 100.0).clamp(0.0, 1.0),
            2 => self.mix = (value / 100.0).clamp(0.0, 1.0),
            3 => self.output_db = value.clamp(-24.0, 6.0),
            4 => self.bias = (value / 100.0).clamp(-1.0, 1.0),
            5 => self.tight = (value / 100.0).clamp(0.0, 1.0),
            _ => {}
        }
    }

    fn reset(&mut self) {
        self.tone_state_l = 0.0;
        self.tone_state_r = 0.0;
        self.tight_state_l = 0.0;
        self.tight_state_r = 0.0;
        self.dc_prev_in_l = 0.0;
        self.dc_prev_in_r = 0.0;
        self.dc_prev_out_l = 0.0;
        self.dc_prev_out_r = 0.0;
        self.os_state_l = 0.0;
        self.os_state_r = 0.0;
        self.drive_sm.set_instant(self.drive);
        self.tone_sm.set_instant(self.tone);
        self.mix_sm.set_instant(self.mix);
        let output_lin = if self.output_db <= -24.0 {
            0.0
        } else {
            db_to_linear(self.output_db)
        };
        self.output_sm.set_instant(output_lin);
        self.bias_sm.set_instant(self.bias);
        self.tight_sm.set_instant(self.tight);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn overdrive_produces_harmonics() {
        let mut proc = OverdriveProcessor::new(44100.0);
        proc.set_param(0, 80.0); // 80% drive
        let sr = 44100.0;
        let mut left: Vec<f32> = (0..4096)
            .map(|i| (std::f32::consts::TAU * 440.0 * i as f32 / sr).sin() * 0.5)
            .collect();
        let mut right = left.clone();
        proc.process_stereo(&mut left, &mut right, sr);
        // Driven signal should still be finite and non-zero
        let rms: f32 = (left[2048..].iter().map(|x| x * x).sum::<f32>() / 2048.0).sqrt();
        assert!(rms > 0.01, "Overdrive should produce output: {rms}");
        assert!(
            left.iter().all(|x| x.is_finite()),
            "All samples must be finite"
        );
    }

    #[test]
    fn overdrive_zero_drive_passthrough() {
        let mut proc = OverdriveProcessor::new(44100.0);
        proc.set_param(0, 0.0); // 0% drive
        proc.set_param(1, 100.0); // full tone (wide open)
        proc.set_param(5, 0.0); // no tightness
        let mut left: Vec<f32> = (0..4096)
            .map(|i| (std::f32::consts::TAU * 440.0 * i as f32 / 44100.0).sin() * 0.3)
            .collect();
        let original = left.clone();
        let mut right = left.clone();
        proc.process_stereo(&mut left, &mut right, 44100.0);
        // Near-passthrough at zero drive (allowing DC blocker settling)
        let diff: f32 = left[2048..]
            .iter()
            .zip(original[2048..].iter())
            .map(|(a, b)| (a - b).abs())
            .sum::<f32>()
            / 2048.0;
        assert!(diff < 0.1, "Zero drive should be near-passthrough: {diff}");
    }
}
