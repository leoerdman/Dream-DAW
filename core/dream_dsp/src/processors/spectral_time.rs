// ═══════════════════════════════════════════════════════════════════════════
// Dream DAW — Spectral Time Processor (Freeze + Spectral Delay)
// ═══════════════════════════════════════════════════════════════════════════
//
// Time-domain spectral manipulation using overlapping analysis/resynthesis.
// Provides freeze (spectral hold) and spectral delay with band-specific
// delay times.
//
// Architecture:
//   - Circular input buffer with Hann windowing
//   - Spectral freeze: holds the current spectrum indefinitely
//   - Band-specific delay via per-band circular buffers
//   - Time stretch via playback rate modification
//
// NOTE: This is a simplified, FFT-free implementation using filter banks
// to avoid libfft dependencies (RT-safe, zero-alloc).
//
// Parameters:
//   0: Mode     (0–2: Freeze, Delay, Stretch)
//   1: Amount   (0–100%, default 50%)
//   2: Decay    (0–100%, default 50%) — fade rate in freeze mode
//   3: Tilt     (-100 to +100%, default 0) — spectral tilt 
//   4: Mix      (0–100%, default 50%)
//
// ═══════════════════════════════════════════════════════════════════════════

use crate::dsp_processor::DspProcessor;
use crate::processors::smoothing::SmoothedValue;
use crate::processors::sanitize_sample_rate;

const SPEC_BUF_SIZE: usize = 8192;
const SPEC_BUF_MASK: usize = SPEC_BUF_SIZE - 1;
const NUM_BANDS: usize = 4;

struct SpectralBand {
    // Bandpass filter state (2-pole)
    bp_z1: f32,
    bp_z2: f32,
    // Delay buffer for this band
    delay_buf: [f32; SPEC_BUF_SIZE],
    delay_pos: usize,
    // Freeze hold value
    hold: f32,
    hold_env: f32,
}

impl SpectralBand {
    fn new() -> Self {
        Self {
            bp_z1: 0.0,
            bp_z2: 0.0,
            delay_buf: [0.0; SPEC_BUF_SIZE],
            delay_pos: 0,
            hold: 0.0,
            hold_env: 0.0,
        }
    }

    fn reset(&mut self) {
        self.bp_z1 = 0.0;
        self.bp_z2 = 0.0;
        self.delay_buf.fill(0.0);
        self.delay_pos = 0;
        self.hold = 0.0;
        self.hold_env = 0.0;
    }
}

pub struct SpectralTimeProcessor {
    mode: u8,
    amount: f32,
    decay: f32,
    tilt: f32,
    mix: f32,
    bands_l: [SpectralBand; NUM_BANDS],
    bands_r: [SpectralBand; NUM_BANDS],
    mix_sm: SmoothedValue,
    amount_sm: SmoothedValue,
    decay_sm: SmoothedValue,
    sample_rate: f32,
}

/// Band center frequencies (Hz)
const BAND_FREQS: [f32; NUM_BANDS] = [200.0, 800.0, 3200.0, 10000.0];
/// Band delay multipliers
const BAND_DELAY_MULT: [f32; NUM_BANDS] = [4.0, 2.0, 1.0, 0.5];

impl SpectralTimeProcessor {
    pub fn new(sample_rate: f32) -> Self {
        let sr = sanitize_sample_rate(sample_rate);
        Self {
            mode: 0,
            amount: 0.5,
            decay: 0.5,
            tilt: 0.0,
            mix: 0.5,
            bands_l: std::array::from_fn(|_| SpectralBand::new()),
            bands_r: std::array::from_fn(|_| SpectralBand::new()),
            mix_sm: SmoothedValue::new(sr, 8.0, 0.5),
            amount_sm: SmoothedValue::new(sr, 10.0, 0.5),
            decay_sm: SmoothedValue::new(sr, 10.0, 0.5),
            sample_rate: sr,
        }
    }
}

impl DspProcessor for SpectralTimeProcessor {
    fn process_stereo(&mut self, left: &mut [f32], right: &mut [f32], sample_rate: f32) {
        let sr = sanitize_sample_rate(sample_rate);
        if (sr - self.sample_rate).abs() > 0.5 {
            self.sample_rate = sr;
            self.mix_sm.set_sample_rate(sr);
            self.amount_sm.set_sample_rate(sr);
            self.decay_sm.set_sample_rate(sr);
        }

        let len = left.len().min(right.len());
        self.mix_sm.set_target(self.mix);
        self.amount_sm.set_target(self.amount);
        self.decay_sm.set_target(self.decay);

        // Compute BP filter coefficients for each band
        let mut bp_coeffs: [(f32, f32); NUM_BANDS] = [(0.0, 0.0); NUM_BANDS];
        for b in 0..NUM_BANDS {
            let f = BAND_FREQS[b];
            let c = (1.0 - (-std::f32::consts::TAU * f / sr).exp()).clamp(0.0, 1.0);
            let bw = 1.5; // Bandwidth in octaves approximation
            let q_c = (1.0 - (-std::f32::consts::TAU * (f / bw) / sr).exp()).clamp(0.0, 1.0);
            bp_coeffs[b] = (c, q_c);
        }

        for i in 0..len {
            let dry_l = left[i];
            let dry_r = right[i];
            let mix = self.mix_sm.next_value();
            let amount = self.amount_sm.next_value();
            let decay = self.decay_sm.next_value();

            let mut wet_l = 0.0f32;
            let mut wet_r = 0.0f32;

            for b in 0..NUM_BANDS {
                let (c, q) = bp_coeffs[b];
                // Tilt: adjust band gain
                let tilt_gain = 1.0 + self.tilt * 0.01 * (b as f32 - 1.5);

                // Bandpass extraction (L)
                let bl = &mut self.bands_l[b];
                bl.bp_z1 += c * (dry_l - bl.bp_z1);
                bl.bp_z2 += q * (bl.bp_z1 - bl.bp_z2);
                let band_l = bl.bp_z1 - bl.bp_z2;

                let br = &mut self.bands_r[b];
                br.bp_z1 += c * (dry_r - br.bp_z1);
                br.bp_z2 += q * (br.bp_z1 - br.bp_z2);
                let band_r = br.bp_z1 - br.bp_z2;

                match self.mode {
                    0 => {
                        // Freeze mode
                        let decay_c = 1.0 - (1.0 - decay) * 0.01;
                        bl.hold = bl.hold * decay_c + band_l * (1.0 - amount) + band_l * amount * (1.0 - decay_c);
                        br.hold = br.hold * decay_c + band_r * (1.0 - amount) + band_r * amount * (1.0 - decay_c);
                        wet_l += bl.hold * tilt_gain;
                        wet_r += br.hold * tilt_gain;
                    }
                    1 => {
                        // Spectral delay mode
                        let delay = (amount * BAND_DELAY_MULT[b] * sr * 0.5).clamp(1.0, (SPEC_BUF_SIZE - 2) as f32);
                        bl.delay_buf[bl.delay_pos] = band_l;
                        let d_idx = delay as usize;
                        let frac = delay - d_idx as f32;
                        let p1 = (bl.delay_pos + SPEC_BUF_SIZE - d_idx) & SPEC_BUF_MASK;
                        let p2 = (p1 + SPEC_BUF_SIZE - 1) & SPEC_BUF_MASK;
                        let delayed_l = bl.delay_buf[p1] * (1.0 - frac) + bl.delay_buf[p2] * frac;
                        bl.delay_pos = (bl.delay_pos + 1) & SPEC_BUF_MASK;

                        br.delay_buf[br.delay_pos] = band_r;
                        let p1r = (br.delay_pos + SPEC_BUF_SIZE - d_idx) & SPEC_BUF_MASK;
                        let p2r = (p1r + SPEC_BUF_SIZE - 1) & SPEC_BUF_MASK;
                        let delayed_r = br.delay_buf[p1r] * (1.0 - frac) + br.delay_buf[p2r] * frac;
                        br.delay_pos = (br.delay_pos + 1) & SPEC_BUF_MASK;

                        wet_l += delayed_l * tilt_gain;
                        wet_r += delayed_r * tilt_gain;
                    }
                    _ => {
                        // Stretch — simple crossfade with delayed version
                        let delay = (amount * 2000.0 * BAND_DELAY_MULT[b]).clamp(1.0, (SPEC_BUF_SIZE - 2) as f32);
                        bl.delay_buf[bl.delay_pos] = band_l;
                        let d_idx = delay as usize;
                        let p1 = (bl.delay_pos + SPEC_BUF_SIZE - d_idx) & SPEC_BUF_MASK;
                        let stretched_l = bl.delay_buf[p1] * decay + band_l * (1.0 - decay);
                        bl.delay_pos = (bl.delay_pos + 1) & SPEC_BUF_MASK;

                        br.delay_buf[br.delay_pos] = band_r;
                        let p1r = (br.delay_pos + SPEC_BUF_SIZE - d_idx) & SPEC_BUF_MASK;
                        let stretched_r = br.delay_buf[p1r] * decay + band_r * (1.0 - decay);
                        br.delay_pos = (br.delay_pos + 1) & SPEC_BUF_MASK;

                        wet_l += stretched_l * tilt_gain;
                        wet_r += stretched_r * tilt_gain;
                    }
                }

                // Denormals
                if bl.bp_z1.abs() < 1e-20 { bl.bp_z1 = 0.0; }
                if bl.bp_z2.abs() < 1e-20 { bl.bp_z2 = 0.0; }
                if bl.hold.abs() < 1e-20 { bl.hold = 0.0; }
                if br.bp_z1.abs() < 1e-20 { br.bp_z1 = 0.0; }
                if br.bp_z2.abs() < 1e-20 { br.bp_z2 = 0.0; }
                if br.hold.abs() < 1e-20 { br.hold = 0.0; }
            }

            left[i] = dry_l * (1.0 - mix) + wet_l * mix;
            right[i] = dry_r * (1.0 - mix) + wet_r * mix;
        }
    }

    fn set_param(&mut self, index: u8, value: f32) {
        match index {
            0 => self.mode = (value as u8).min(2),
            1 => self.amount = (value / 100.0).clamp(0.0, 1.0),
            2 => self.decay = (value / 100.0).clamp(0.0, 1.0),
            3 => self.tilt = value.clamp(-100.0, 100.0),
            4 => self.mix = (value / 100.0).clamp(0.0, 1.0),
            _ => {}
        }
    }

    fn reset(&mut self) {
        for b in &mut self.bands_l { b.reset(); }
        for b in &mut self.bands_r { b.reset(); }
        self.mix_sm.set_instant(self.mix);
        self.amount_sm.set_instant(self.amount);
        self.decay_sm.set_instant(self.decay);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn spectral_time_processes() {
        let sr = 44100.0;
        for mode in 0..3u8 {
            let mut proc = SpectralTimeProcessor::new(sr);
            proc.set_param(0, mode as f32);
            proc.set_param(4, 80.0); // High mix
            let mut left: Vec<f32> = (0..4096)
                .map(|i| (std::f32::consts::TAU * 440.0 * i as f32 / sr).sin() * 0.5)
                .collect();
            let mut right = left.clone();
            proc.process_stereo(&mut left, &mut right, sr);
            assert!(left.iter().all(|x| x.is_finite()), "mode {mode} NaN");
        }
    }
}
