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
}

impl DistortionProcessor {
    pub fn new(sample_rate: f32) -> Self {
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
        Self::new(44100.0)
    }
}

impl DspProcessor for DistortionProcessor {
    fn process_stereo(&mut self, left: &mut [f32], right: &mut [f32], sample_rate: f32) {
        // Sync sample rate if changed
        if sample_rate.is_finite()
            && sample_rate > 1000.0
            && (sample_rate - self.sample_rate).abs() > 0.5
        {
            self.sample_rate = sample_rate;
        }
        let len = left.len().min(right.len());
        let gain = 1.0 + self.drive * 30.0; // up to 31x
        let mode = self.mode;
        let bias = self.bias;
        let out = self.output_lin;
        let mix = self.mix;

        // HP coefficient for tightness (50–500Hz based on tightness)
        // BUG-4 FIX: Use exact exponential coefficient for first-order HP:
        //   α = e^(-2πf/sr)  →  y[n] = α * (y[n-1] + x[n] - x[n-1])
        let hp_freq = 50.0 + self.tightness * 450.0;
        let hp_c = (-std::f32::consts::TAU * hp_freq / self.sample_rate).exp();

        // Tone: tilt EQ (LP amount) — exact one-pole coefficient
        let tone_c =
            (1.0 - (-std::f32::consts::TAU * (1000.0 + self.tone * 19000.0) / self.sample_rate).exp()).clamp(0.0, 1.0);

        // Cabinet simulation LP (~4.5kHz) — exact one-pole coefficient
        let cab_c = if self.cab_sim {
            (1.0 - (-std::f32::consts::TAU * 4500.0 / self.sample_rate).exp()).clamp(0.0, 1.0)
        } else {
            1.0 // passthrough
        };

        for i in 0..len {
            let dry_l = left[i];
            let dry_r = right[i];

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

            // BUG-AUD-108 FIX: Flush denormals in HP/tone/cab filter states
            // to prevent CPU stalls on x86 during prolonged silence.
            if self.hp_state_l.abs() < 1.0e-20 {
                self.hp_state_l = 0.0;
            }
            if self.hp_state_r.abs() < 1.0e-20 {
                self.hp_state_r = 0.0;
            }
            if self.tone_state_l.abs() < 1.0e-20 {
                self.tone_state_l = 0.0;
            }
            if self.tone_state_r.abs() < 1.0e-20 {
                self.tone_state_r = 0.0;
            }
            // AUDIT-S3-01 FIX: BUG-AUD-108 missed cab_state flush.
            // The comment says "HP/tone/cab" but only flushed HP + tone.
            // cab_state one-pole LP has the same denormal risk during silence.
            if self.cab_state_l.abs() < 1.0e-20 {
                self.cab_state_l = 0.0;
            }
            if self.cab_state_r.abs() < 1.0e-20 {
                self.cab_state_r = 0.0;
            }
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
                self.output_lin = 10.0_f32.powf(self.output_db / 20.0);
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
