// ═══════════════════════════════════════════════════════════════════════════
// Dream DAW — Erosion Processor (Noise-Modulated Frequency Shifting)
// ═══════════════════════════════════════════════════════════════════════════
//
// Uses white noise or sine to modulate the frequency content of the signal,
// creating aliasing/digital degradation effects. Inspired by Ableton Erosion.
//
// Architecture:
//   - Noise generator (xorshift) or sine oscillator
//   - Ring modulation with adjustable frequency
//   - Amplitude modulation mode
//   - Width control for stereo decorrelation
//
// Parameters:
//   0: Mode      (0–2: Noise, Sine, Wide Noise)
//   1: Frequency (20–20000 Hz, default 2000) — modulator frequency
//   2: Amount    (0–100%, default 30%)
//   3: Width     (0–100%, default 50%) — stereo decorrelation
//   4: Mix       (0–100%, default 100%)
//
// ═══════════════════════════════════════════════════════════════════════════

use crate::dsp_processor::DspProcessor;
use crate::processors::smoothing::SmoothedValue;
use crate::processors::sanitize_sample_rate;

pub struct ErosionProcessor {
    mode: u8,
    frequency: f32,
    amount: f32,
    width: f32,
    mix: f32,
    // Noise state (xorshift)
    noise_state_l: u32,
    noise_state_r: u32,
    // Sine oscillator phase
    sine_phase_l: f64,
    sine_phase_r: f64,
    // Smoothed
    freq_sm: SmoothedValue,
    amount_sm: SmoothedValue,
    mix_sm: SmoothedValue,
    sample_rate: f32,
}

impl ErosionProcessor {
    pub fn new(sample_rate: f32) -> Self {
        let sr = sanitize_sample_rate(sample_rate);
        Self {
            mode: 0,
            frequency: 2000.0,
            amount: 0.3,
            width: 0.5,
            mix: 1.0,
            noise_state_l: 0x12345678,
            noise_state_r: 0x87654321,
            sine_phase_l: 0.0,
            sine_phase_r: 0.0,
            freq_sm: SmoothedValue::new(sr, 10.0, 2000.0),
            amount_sm: SmoothedValue::new(sr, 10.0, 0.3),
            mix_sm: SmoothedValue::new(sr, 8.0, 1.0),
            sample_rate: sr,
        }
    }

    #[inline]
    fn xorshift(state: &mut u32) -> f32 {
        let mut x = *state;
        x ^= x << 13;
        x ^= x >> 17;
        x ^= x << 5;
        *state = x;
        (x as f32) / (u32::MAX as f32) * 2.0 - 1.0
    }
}

impl DspProcessor for ErosionProcessor {
    fn process_stereo(&mut self, left: &mut [f32], right: &mut [f32], sample_rate: f32) {
        let sr = sanitize_sample_rate(sample_rate);
        if (sr - self.sample_rate).abs() > 0.5 {
            self.sample_rate = sr;
            self.freq_sm.set_sample_rate(sr);
            self.amount_sm.set_sample_rate(sr);
            self.mix_sm.set_sample_rate(sr);
        }

        let len = left.len().min(right.len());
        self.freq_sm.set_target(self.frequency);
        self.amount_sm.set_target(self.amount);
        self.mix_sm.set_target(self.mix);

        let sr_f64 = sr as f64;

        for i in 0..len {
            let dry_l = left[i];
            let dry_r = right[i];
            let freq = self.freq_sm.next_value();
            let amount = self.amount_sm.next_value();
            let mix = self.mix_sm.next_value();

            let (mod_l, mod_r) = match self.mode {
                0 => {
                    // Noise mode — bandpass-ish noise around frequency
                    let n_l = Self::xorshift(&mut self.noise_state_l);
                    let n_r = Self::xorshift(&mut self.noise_state_r);
                    // Simple ring mod with noise
                    let phase_inc = freq as f64 / sr_f64;
                    self.sine_phase_l += phase_inc;
                    if self.sine_phase_l >= 1.0 { self.sine_phase_l -= 1.0; }
                    self.sine_phase_r += phase_inc * (1.0 + self.width as f64 * 0.01);
                    if self.sine_phase_r >= 1.0 { self.sine_phase_r -= 1.0; }
                    let s_l = (self.sine_phase_l * std::f64::consts::TAU).sin() as f32;
                    let s_r = (self.sine_phase_r * std::f64::consts::TAU).sin() as f32;
                    (n_l * s_l, n_r * s_r)
                }
                1 => {
                    // Sine mode — classic ring modulation
                    let phase_inc = freq as f64 / sr_f64;
                    self.sine_phase_l += phase_inc;
                    if self.sine_phase_l >= 1.0 { self.sine_phase_l -= 1.0; }
                    self.sine_phase_r += phase_inc;
                    if self.sine_phase_r >= 1.0 { self.sine_phase_r -= 1.0; }
                    let s_l = (self.sine_phase_l * std::f64::consts::TAU).sin() as f32;
                    let s_r = (self.sine_phase_r * std::f64::consts::TAU).sin() as f32;
                    (s_l, s_r)
                }
                _ => {
                    // Wide noise — decorrelated per channel
                    let n_l = Self::xorshift(&mut self.noise_state_l);
                    let n_r = Self::xorshift(&mut self.noise_state_r);
                    (n_l, n_r)
                }
            };

            let eroded_l = dry_l * (1.0 - amount) + dry_l * mod_l * amount;
            let eroded_r = dry_r * (1.0 - amount) + dry_r * mod_r * amount;

            left[i] = dry_l * (1.0 - mix) + eroded_l * mix;
            right[i] = dry_r * (1.0 - mix) + eroded_r * mix;
        }
    }

    fn set_param(&mut self, index: u8, value: f32) {
        match index {
            0 => self.mode = (value as u8).min(2),
            1 => self.frequency = value.clamp(20.0, 20000.0),
            2 => self.amount = (value / 100.0).clamp(0.0, 1.0),
            3 => self.width = (value / 100.0).clamp(0.0, 1.0),
            4 => self.mix = (value / 100.0).clamp(0.0, 1.0),
            _ => {}
        }
    }

    fn reset(&mut self) {
        self.noise_state_l = 0x12345678;
        self.noise_state_r = 0x87654321;
        self.sine_phase_l = 0.0;
        self.sine_phase_r = 0.0;
        self.freq_sm.set_instant(self.frequency);
        self.amount_sm.set_instant(self.amount);
        self.mix_sm.set_instant(self.mix);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn erosion_modifies_signal() {
        let mut proc = ErosionProcessor::new(44100.0);
        proc.set_param(2, 80.0); // High amount
        let sr = 44100.0;
        let mut left: Vec<f32> = (0..4096)
            .map(|i| (std::f32::consts::TAU * 440.0 * i as f32 / sr).sin() * 0.5)
            .collect();
        let orig = left.clone();
        let mut right = left.clone();
        proc.process_stereo(&mut left, &mut right, sr);
        let diff: f32 = left.iter().zip(orig.iter())
            .map(|(a, b)| (a - b).abs()).sum::<f32>() / 4096.0;
        assert!(diff > 0.01, "Erosion should modify the signal: {diff}");
    }
}
