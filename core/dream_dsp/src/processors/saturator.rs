// ═══════════════════════════════════════════════════════════════════════════
// Dream DAW — Saturator Processor (Enterprise)
// ═══════════════════════════════════════════════════════════════════════════
//
// Multi-mode saturation with 5 waveshaping curves:
//   0 = Analog (tanh soft clip — warm, musical)
//   1 = Tube (asymmetric triode emulation)
//   2 = Tape (magnetic hysteresis simulation)
//   3 = Digital (hard clip with subtle fold)
//   4 = Sine Fold (wavefolder — synth-style harmonics)
//
// Signal: Input → Pre-gain → DC block → Waveshaper → Tone LP → Mix
//
// Parameters:
//   0: Drive    (0–36 dB, default 6)
//   1: Tone     (0–100%, default 50%) — LP cutoff 1k–20kHz
//   2: Mix      (0–100%, default 50%)
//   3: Mode     (0–4, default 0)
//   4: Output   (-24 to +6 dB, default 0)
//   5: Color    (0–100%, default 50%) — pre-emphasis (treble drive)
//
// Real-Time Safety: Zero allocations. O(N) per buffer.
//
// ═══════════════════════════════════════════════════════════════════════════

use crate::dsp_processor::DspProcessor;

struct OnePole {
    state: f32,
    coeff: f32,
}

impl OnePole {
    fn new(cutoff: f32, sr: f32) -> Self {
        Self { state: 0.0, coeff: Self::calc(cutoff, sr) }
    }
    fn calc(cutoff: f32, sr: f32) -> f32 {
        (std::f32::consts::TAU * cutoff / sr).min(0.99)
    }
    #[inline]
    fn process(&mut self, input: f32) -> f32 {
        self.state += self.coeff * (input - self.state);
        self.state
    }
    fn set_cutoff(&mut self, cutoff: f32, sr: f32) {
        self.coeff = Self::calc(cutoff, sr);
    }
    fn reset(&mut self) { self.state = 0.0; }
}

pub struct SaturatorProcessor {
    drive_db: f32,
    drive_lin: f32,
    tone_pct: f32,
    mix: f32,
    mode: u8,
    output_db: f32,
    output_lin: f32,
    color: f32,
    tone_l: OnePole,
    tone_r: OnePole,
    // DC blocker state
    dc_x_l: f32, dc_y_l: f32,
    dc_x_r: f32, dc_y_r: f32,
    // Pre-emphasis filter
    pre_state_l: f32,
    pre_state_r: f32,
    sample_rate: f32,
}

impl SaturatorProcessor {
    pub fn new() -> Self {
        let sr = 44100.0;
        let cutoff = Self::tone_to_cutoff(50.0);
        Self {
            drive_db: 6.0,
            drive_lin: 10.0_f32.powf(6.0 / 20.0),
            tone_pct: 50.0,
            mix: 0.5,
            mode: 0,
            output_db: 0.0,
            output_lin: 1.0,
            color: 0.5,
            tone_l: OnePole::new(cutoff, sr),
            tone_r: OnePole::new(cutoff, sr),
            dc_x_l: 0.0, dc_y_l: 0.0,
            dc_x_r: 0.0, dc_y_r: 0.0,
            pre_state_l: 0.0,
            pre_state_r: 0.0,
            sample_rate: sr,
        }
    }

    fn tone_to_cutoff(pct: f32) -> f32 {
        1000.0 * (20000.0 / 1000.0_f32).powf(pct / 100.0)
    }

    /// DC blocker (removes DC offset introduced by asymmetric clipping).
    #[inline]
    fn dc_block(x: f32, prev_x: &mut f32, prev_y: &mut f32) -> f32 {
        let y = x - *prev_x + 0.9975 * *prev_y;
        *prev_x = x;
        *prev_y = y;
        y
    }

    /// Pre-emphasis: adds treble before saturation for "color".
    #[inline]
    fn pre_emphasis(sample: f32, state: &mut f32, amount: f32) -> f32 {
        let hp = sample - *state;
        *state += 0.3 * (sample - *state);
        sample + hp * amount * 2.0
    }

    /// Waveshaping function selected by mode.
    #[inline]
    fn waveshape(x: f32, mode: u8) -> f32 {
        match mode {
            0 => x.tanh(), // Analog
            1 => {
                // Tube: asymmetric triode
                if x >= 0.0 {
                    1.0 - (-x * 1.5).exp()
                } else {
                    -(1.0 - (x * 0.8).exp()) * 0.8
                }
            }
            2 => {
                // Tape: soft, warm, slightly compressing
                let ax = x.abs();
                let shaped = x.signum() * (ax / (1.0 + ax));
                // Add subtle 2nd harmonic
                shaped + 0.05 * x * x * x.signum()
            }
            3 => {
                // Digital: hard clip with subtle fold
                let clipped = x.clamp(-1.0, 1.0);
                let excess = (x - clipped).abs();
                clipped - excess * 0.2 * x.signum()
            }
            4 => {
                // Sine fold: wavefolder
                (x * std::f32::consts::FRAC_PI_2).sin()
            }
            _ => x.tanh(),
        }
    }
}

impl Default for SaturatorProcessor {
    fn default() -> Self { Self::new() }
}

impl DspProcessor for SaturatorProcessor {
    fn process_stereo(&mut self, left: &mut [f32], right: &mut [f32], sample_rate: f32) {
        if (sample_rate - self.sample_rate).abs() > 1.0 {
            self.sample_rate = sample_rate;
            let cutoff = Self::tone_to_cutoff(self.tone_pct);
            self.tone_l.set_cutoff(cutoff, sample_rate);
            self.tone_r.set_cutoff(cutoff, sample_rate);
        }

        let len = left.len().min(right.len());
        let drive = self.drive_lin;
        let out = self.output_lin;
        let mode = self.mode;
        let color = self.color;

        for i in 0..len {
            let dry_l = left[i];
            let dry_r = right[i];

            // Pre-emphasis (color)
            let pre_l = Self::pre_emphasis(dry_l, &mut self.pre_state_l, color);
            let pre_r = Self::pre_emphasis(dry_r, &mut self.pre_state_r, color);

            // Drive
            let driven_l = pre_l * drive;
            let driven_r = pre_r * drive;

            // Waveshape
            let shaped_l = Self::waveshape(driven_l, mode);
            let shaped_r = Self::waveshape(driven_r, mode);

            // DC block
            let dc_l = Self::dc_block(shaped_l, &mut self.dc_x_l, &mut self.dc_y_l);
            let dc_r = Self::dc_block(shaped_r, &mut self.dc_x_r, &mut self.dc_y_r);

            // Tone filter
            let toned_l = self.tone_l.process(dc_l);
            let toned_r = self.tone_r.process(dc_r);

            // Output gain + mix
            let wet_l = toned_l * out;
            let wet_r = toned_r * out;
            left[i] = dry_l * (1.0 - self.mix) + wet_l * self.mix;
            right[i] = dry_r * (1.0 - self.mix) + wet_r * self.mix;
        }
    }

    fn set_param(&mut self, index: u8, value: f32) {
        match index {
            0 => { self.drive_db = value.clamp(0.0, 36.0); self.drive_lin = 10.0_f32.powf(self.drive_db / 20.0); }
            1 => {
                self.tone_pct = value.clamp(0.0, 100.0);
                let cutoff = Self::tone_to_cutoff(self.tone_pct);
                self.tone_l.set_cutoff(cutoff, self.sample_rate);
                self.tone_r.set_cutoff(cutoff, self.sample_rate);
            }
            2 => self.mix = (value / 100.0).clamp(0.0, 1.0),
            3 => self.mode = (value as u8).min(4),
            4 => { self.output_db = value.clamp(-24.0, 6.0); self.output_lin = 10.0_f32.powf(self.output_db / 20.0); }
            5 => self.color = (value / 100.0).clamp(0.0, 1.0),
            _ => {}
        }
    }

    fn reset(&mut self) {
        self.tone_l.reset();
        self.tone_r.reset();
        self.dc_x_l = 0.0; self.dc_y_l = 0.0;
        self.dc_x_r = 0.0; self.dc_y_r = 0.0;
        self.pre_state_l = 0.0;
        self.pre_state_r = 0.0;
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn saturator_clips_loud_signal() {
        let mut proc = SaturatorProcessor::new();
        proc.set_param(0, 24.0);
        proc.set_param(2, 100.0);
        let mut l = vec![1.0f32; 256];
        let mut r = vec![1.0f32; 256];
        proc.process_stereo(&mut l, &mut r, 44100.0);
        for s in &l { assert!(s.abs() <= 1.5, "Sat too hot: {s}"); }
    }

    #[test]
    fn saturator_zero_drive_passthrough() {
        let mut proc = SaturatorProcessor::new();
        proc.set_param(0, 0.0);
        proc.set_param(1, 100.0);
        proc.set_param(2, 100.0);
        proc.set_param(5, 0.0); // no color
        let mut l = vec![0.3f32; 1024];
        let mut r = vec![0.3f32; 1024];
        proc.process_stereo(&mut l, &mut r, 44100.0);
        let tail_avg: f32 = l[512..].iter().sum::<f32>() / 512.0;
        assert!((tail_avg - 0.291).abs() < 0.08, "Expected ~0.29, got: {tail_avg}");
    }

    #[test]
    fn all_modes_work() {
        for m in 0..=4u8 {
            let mut proc = SaturatorProcessor::new();
            proc.set_param(3, m as f32);
            proc.set_param(0, 12.0);
            let mut l = vec![0.5f32; 512];
            let mut r = vec![0.5f32; 512];
            proc.process_stereo(&mut l, &mut r, 44100.0);
        }
    }
}
