// ═══════════════════════════════════════════════════════════════════════════
// Dream DAW — Distortion / Amp Processor (Enterprise)
// ═══════════════════════════════════════════════════════════════════════════
//
// Multi-mode guitar/synth distortion with cabinet simulation:
//   Mode 0: Overdrive (soft asymmetric clip — blues/country)
//   Mode 1: Crunch    (medium symmetric — rock rhythm)
//   Mode 2: Lead      (heavy harmonic saturation — solo)
//   Mode 3: Fuzz      (square wave clip — stoner/doom)
//   Mode 4: Rectifier (full-wave rectification — synth destruction)
//
// Signal: Input → HP DC → Pre-gain → Waveshaper → Tone EQ → Cab Sim → Mix
//
// Parameters:
//   0: Drive     (0–100%, default 50%)
//   1: Tone      (0–100%, default 50%) — tilt EQ
//   2: Mix       (0–100%, default 100%)
//   3: Mode      (0–4, default 0)
//   4: Output    (-24 to +6 dB, default 0)
//   5: Cab Sim   (0 or 1, default 1) — simple cabinet LP filter
//   6: Tightness (0–100%, default 50%) — HP freq before drive (bass tightness)
//   7: Bias      (-100 to 100%, default 0%) — waveshaper asymmetry
//
// Real-Time Safety: Zero allocations. O(N) per buffer.
//
// ═══════════════════════════════════════════════════════════════════════════

use crate::dsp_processor::DspProcessor;
use crate::processors::smoothing::SmoothedValue;
use crate::processors::{DEFAULT_SAMPLE_RATE, db_to_linear, sanitize_sample_rate};

pub struct DistortionProcessor {
    drive: f32,
    tone: f32,
    mix: f32,
    mode: u8,
    output_db: f32,
    output_lin: f32,
    cab_sim: bool,
    tightness: f32,
    bias: f32,
    // Filter states
    hp_state_l: f32,
    hp_state_r: f32,
    /// Previous HP input — required for first-order HP: y[n] = α*(y[n-1] + x[n] - x[n-1])
    hp_prev_in_l: f32,
    hp_prev_in_r: f32,
    tone_state_l: f32,
    tone_state_r: f32,
    cab_state_l: f32,
    cab_state_r: f32,
    sample_rate: f32,
    drive_sm: SmoothedValue,
    tone_sm: SmoothedValue,
    mix_sm: SmoothedValue,
    output_sm: SmoothedValue,
    tightness_sm: SmoothedValue,
    bias_sm: SmoothedValue,
    /// BUG-5 FIX: Cached filter coefficients to avoid per-sample exp() calls.
    cached_hp_c: f32,
    cached_tone_c: f32,
    cached_hp_freq: f32,
    cached_tone_freq: f32,
}

impl DistortionProcessor {
    pub fn new(sample_rate: f32) -> Self {
        let sample_rate = sanitize_sample_rate(sample_rate);
        Self {
            drive: 0.5,
            tone: 0.5,
            mix: 1.0,
            mode: 0,
            output_db: 0.0,
            output_lin: 1.0,
            cab_sim: true,
            tightness: 0.5,
            bias: 0.0,
            hp_state_l: 0.0,
            hp_state_r: 0.0,
            hp_prev_in_l: 0.0,
            hp_prev_in_r: 0.0,
            tone_state_l: 0.0,
            tone_state_r: 0.0,
            cab_state_l: 0.0,
            cab_state_r: 0.0,
            sample_rate,
            drive_sm: SmoothedValue::new(sample_rate, 8.0, 0.5),
            tone_sm: SmoothedValue::new(sample_rate, 8.0, 0.5),
            mix_sm: SmoothedValue::new(sample_rate, 8.0, 1.0),
            output_sm: SmoothedValue::new(sample_rate, 8.0, 1.0),
            tightness_sm: SmoothedValue::new(sample_rate, 10.0, 0.5),
            bias_sm: SmoothedValue::new(sample_rate, 10.0, 0.0),
            cached_hp_c: crate::processors::one_pole_hp_coeff(275.0, sample_rate),
            cached_tone_c: crate::processors::one_pole_lp_coeff(10500.0, sample_rate),
            cached_hp_freq: 275.0,
            cached_tone_freq: 10500.0,
        }
    }

    #[inline]
    fn waveshape(x: f32, mode: u8, bias: f32) -> f32 {
        let biased = x + bias * 0.3;
        match mode {
            0 => {
                // Overdrive: asymmetric soft clip
                if biased >= 0.0 {
                    (biased * 2.0).tanh() * 0.8
                } else {
                    (biased * 1.5).tanh() * 0.9
                }
            }
            1 => {
                // Crunch: harder symmetric
                (biased * 3.0).tanh() * 0.7
            }
            2 => {
                // Lead: aggressive, harmonic-rich
                let x2 = biased * 4.0;
                x2 / (1.0 + x2.abs()) * 0.9
            }
            3 => {
                // Fuzz: near-square clip
                biased.clamp(-0.6, 0.6) * (1.0 / 0.6)
            }
            4 => {
                // Rectifier: full-wave rectification
                (biased * 2.0).abs().tanh()
            }
            _ => biased.tanh(),
        }
    }
}

impl Default for DistortionProcessor {
    fn default() -> Self {
        Self::new(DEFAULT_SAMPLE_RATE)
    }
}

impl DspProcessor for DistortionProcessor {
    fn process_stereo(&mut self, left: &mut [f32], right: &mut [f32], sample_rate: f32) {
        // Sync sample rate if changed
        let sr = sanitize_sample_rate(sample_rate);
        if (sr - self.sample_rate).abs() > 0.5 {
            self.sample_rate = sr;
            self.drive_sm.set_sample_rate(sr);
            self.tone_sm.set_sample_rate(sr);
            self.mix_sm.set_sample_rate(sr);
            self.output_sm.set_sample_rate(sr);
            self.tightness_sm.set_sample_rate(sr);
            self.bias_sm.set_sample_rate(sr);
        }
        let len = left.len().min(right.len());
        let mode = self.mode;
        // Cabinet simulation LP (~4.5kHz) — exact one-pole coefficient.
        let cab_c = if self.cab_sim {
            (1.0 - (-std::f32::consts::TAU * 4500.0 / self.sample_rate).exp()).clamp(0.0, 1.0)
        } else {
            1.0 // passthrough
        };
        self.drive_sm.set_target(self.drive.clamp(0.0, 1.0));
        self.tone_sm.set_target(self.tone.clamp(0.0, 1.0));
        self.mix_sm.set_target(self.mix.clamp(0.0, 1.0));
        self.output_sm.set_target(self.output_lin.max(0.0));
        self.tightness_sm.set_target(self.tightness.clamp(0.0, 1.0));
        self.bias_sm.set_target(self.bias.clamp(-1.0, 1.0));

        for i in 0..len {
            let dry_l = left[i];
            let dry_r = right[i];
            let drive = self.drive_sm.next_value();
            let tone = self.tone_sm.next_value();
            let mix = self.mix_sm.next_value();
            let out = self.output_sm.next_value();
            let tightness = self.tightness_sm.next_value();
            let bias = self.bias_sm.next_value();

            // BUG-5 FIX: Only recalculate coefficients when smoothed freq
            // moves by >1 Hz. Eliminates 2× exp() per sample.
            let gain = 1.0 + drive * 30.0; // up to 31x
            let hp_freq = 50.0 + tightness * 450.0;
            if (hp_freq - self.cached_hp_freq).abs() > 1.0 {
                self.cached_hp_c = crate::processors::one_pole_hp_coeff(hp_freq, self.sample_rate);
                self.cached_hp_freq = hp_freq;
            }
            let tone_freq = 1000.0 + tone * 19000.0;
            if (tone_freq - self.cached_tone_freq).abs() > 1.0 {
                self.cached_tone_c =
                    crate::processors::one_pole_lp_coeff(tone_freq, self.sample_rate);
                self.cached_tone_freq = tone_freq;
            }
            let hp_c = self.cached_hp_c;
            let tone_c = self.cached_tone_c;

            // BUG-4 FIX: Correct first-order HP filter for bass tightness.
            // Standard form: y[n] = α * (y[n-1] + x[n] - x[n-1])
            // This properly blocks DC and sub-bass before the drive stage.
            self.hp_state_l = hp_c * (self.hp_state_l + dry_l - self.hp_prev_in_l);
            self.hp_state_r = hp_c * (self.hp_state_r + dry_r - self.hp_prev_in_r);
            self.hp_prev_in_l = dry_l;
            self.hp_prev_in_r = dry_r;
            let hp_l = self.hp_state_l;
            let hp_r = self.hp_state_r;

            // Drive + waveshape
            let shaped_l = Self::waveshape(hp_l * gain, mode, bias);
            let shaped_r = Self::waveshape(hp_r * gain, mode, bias);

            // Tone (LP)
            self.tone_state_l += tone_c * (shaped_l - self.tone_state_l);
            self.tone_state_r += tone_c * (shaped_r - self.tone_state_r);

            // Cab sim (LP)
            let mut wet_l = self.tone_state_l;
            let mut wet_r = self.tone_state_r;
            if self.cab_sim {
                self.cab_state_l += cab_c * (wet_l - self.cab_state_l);
                self.cab_state_r += cab_c * (wet_r - self.cab_state_r);
                wet_l = self.cab_state_l;
                wet_r = self.cab_state_r;
            }

            // BUG-5 FIX: Output gain + mix with safety clamp
            left[i] = (dry_l * (1.0 - mix) + wet_l * out * mix).clamp(-8.0, 8.0);
            right[i] = (dry_r * (1.0 - mix) + wet_r * out * mix).clamp(-8.0, 8.0);

            // SSOT: Use flush_denormal! macro for all filter states.
            crate::processors::flush_denormal!(self.hp_state_l);
            crate::processors::flush_denormal!(self.hp_state_r);
            // BUG-H27 FIX: hp_prev_in states could inherit denormals from dry input.
            crate::processors::flush_denormal!(self.hp_prev_in_l);
            crate::processors::flush_denormal!(self.hp_prev_in_r);
            crate::processors::flush_denormal!(self.tone_state_l);
            crate::processors::flush_denormal!(self.tone_state_r);
            crate::processors::flush_denormal!(self.cab_state_l);
            crate::processors::flush_denormal!(self.cab_state_r);
        }
    }

    fn set_param(&mut self, index: u8, value: f32) {
        match index {
            0 => self.drive = (value / 100.0).clamp(0.0, 1.0),
            1 => self.tone = (value / 100.0).clamp(0.0, 1.0),
            2 => self.mix = (value / 100.0).clamp(0.0, 1.0),
            3 => self.mode = (value as u8).min(4),
            4 => {
                self.output_db = value.clamp(-24.0, 6.0);
                self.output_lin = db_to_linear(self.output_db);
            }
            5 => self.cab_sim = value > 0.5,
            6 => self.tightness = (value / 100.0).clamp(0.0, 1.0),
            7 => self.bias = (value / 100.0).clamp(-1.0, 1.0),
            _ => {}
        }
    }

    fn reset(&mut self) {
        self.hp_state_l = 0.0;
        self.hp_state_r = 0.0;
        self.hp_prev_in_l = 0.0;
        self.hp_prev_in_r = 0.0;
        self.tone_state_l = 0.0;
        self.tone_state_r = 0.0;
        self.cab_state_l = 0.0;
        self.cab_state_r = 0.0;
        self.drive_sm.set_instant(self.drive.clamp(0.0, 1.0));
        self.tone_sm.set_instant(self.tone.clamp(0.0, 1.0));
        self.mix_sm.set_instant(self.mix.clamp(0.0, 1.0));
        self.output_sm.set_instant(self.output_lin.max(0.0));
        self.tightness_sm
            .set_instant(self.tightness.clamp(0.0, 1.0));
        self.bias_sm.set_instant(self.bias.clamp(-1.0, 1.0));
        let hp_freq = 50.0 + self.tightness * 450.0;
        self.cached_hp_c = crate::processors::one_pole_hp_coeff(hp_freq, self.sample_rate);
        self.cached_hp_freq = hp_freq;
        let tone_freq = 1000.0 + self.tone * 19000.0;
        self.cached_tone_c = crate::processors::one_pole_lp_coeff(tone_freq, self.sample_rate);
        self.cached_tone_freq = tone_freq;
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn distortion_clips_loud_signal() {
        let mut proc = DistortionProcessor::new(44100.0);
        proc.set_param(0, 100.0);
        proc.set_param(2, 100.0);
        let mut l = vec![0.5f32; 512];
        let mut r = vec![0.5f32; 512];
        proc.process_stereo(&mut l, &mut r, 44100.0);
        for s in &l {
            assert!(s.abs() <= 1.5, "Too hot: {s}");
        }
    }

    #[test]
    fn all_modes_work() {
        for m in 0..=4u8 {
            let mut proc = DistortionProcessor::new(44100.0);
            proc.set_param(3, m as f32);
            proc.set_param(0, 75.0);
            let mut l = vec![0.3f32; 512];
            let mut r = vec![0.3f32; 512];
            proc.process_stereo(&mut l, &mut r, 44100.0);
        }
    }
}
