// ═══════════════════════════════════════════════════════════════════════════
// Dream DAW — Grain Delay Processor
// ═══════════════════════════════════════════════════════════════════════════
//
// Granular delay that chops the delay buffer into small grains and
// pitch-shifts them independently. Distinct from simple Delay and
// Filter Delay.
//
// Architecture:
//   - Delay buffer with configurable time
//   - Grain engine: overlapping Hann-windowed grains
//   - Per-grain pitch shifting via playback rate modification
//   - Spray: randomized grain start position
//   - Feedback with optional pitch cascade
//
// Parameters:
//   0: Delay Time   (1–2000 ms, default 300)
//   1: Grain Size   (10–500 ms, default 80)
//   2: Pitch        (-24 to +24 semitones, default 0)
//   3: Spray        (0–100%, default 10%) — random grain position
//   4: Feedback     (0–95%, default 30%)
//   5: Mix          (0–100%, default 40%)
//   6: Density      (1–8, default 2) — grain overlap count
//
// ═══════════════════════════════════════════════════════════════════════════

use crate::dsp_processor::DspProcessor;
use crate::processors::smoothing::SmoothedValue;
use crate::processors::sanitize_sample_rate;

const GRAIN_BUF_SIZE: usize = 131072; // ~3 seconds at 44.1kHz
const GRAIN_BUF_MASK: usize = GRAIN_BUF_SIZE - 1;
const MAX_GRAINS: usize = 8;

struct Grain {
    active: bool,
    read_pos: f64,    // Fractional read position
    read_rate: f64,   // Playback rate (1.0 = normal, 2.0 = octave up)
    window_pos: f32,  // 0..1 (position within grain window)
    window_inc: f32,  // Per-sample window advance
    start_offset: usize, // Start position in buffer
}

impl Default for Grain {
    fn default() -> Self {
        Self {
            active: false,
            read_pos: 0.0,
            read_rate: 1.0,
            window_pos: 0.0,
            window_inc: 0.0,
            start_offset: 0,
        }
    }
}

pub struct GrainDelayProcessor {
    delay_ms: f32,
    grain_size_ms: f32,
    pitch_semi: f32,
    spray: f32,
    feedback: f32,
    mix: f32,
    density: u8,
    // Delay buffer (heap-allocated to avoid stack overflow)
    buf_l: Vec<f32>,
    buf_r: Vec<f32>,
    write_pos: usize,
    // Grain pool
    grains: [Grain; MAX_GRAINS],
    // Grain trigger counter
    grain_counter: f32,
    grain_interval: f32,
    next_grain_idx: usize,
    // RNG
    rng: u32,
    // Smoothed
    mix_sm: SmoothedValue,
    fb_sm: SmoothedValue,
    sample_rate: f32,
}

impl GrainDelayProcessor {
    pub fn new(sample_rate: f32) -> Self {
        let sr = sanitize_sample_rate(sample_rate);
        Self {
            delay_ms: 300.0,
            grain_size_ms: 80.0,
            pitch_semi: 0.0,
            spray: 0.1,
            feedback: 0.3,
            mix: 0.4,
            density: 2,
            buf_l: vec![0.0; GRAIN_BUF_SIZE],
            buf_r: vec![0.0; GRAIN_BUF_SIZE],
            write_pos: 0,
            grains: Default::default(),
            grain_counter: 0.0,
            grain_interval: 0.0,
            next_grain_idx: 0,
            rng: 0xDEADBEEF,
            mix_sm: SmoothedValue::new(sr, 8.0, 0.4),
            fb_sm: SmoothedValue::new(sr, 10.0, 0.3),
            sample_rate: sr,
        }
    }

    #[inline]
    fn rng_next(&mut self) -> f32 {
        let mut x = self.rng;
        x ^= x << 13;
        x ^= x >> 17;
        x ^= x << 5;
        self.rng = x;
        (x as f32) / (u32::MAX as f32)
    }

    #[inline]
    fn hann_window(pos: f32) -> f32 {
        // pos in [0, 1]
        0.5 * (1.0 - (std::f32::consts::TAU * pos).cos())
    }

    #[inline]
    fn read_buf(buf: &[f32], pos: f64) -> f32 {
        let idx = pos as usize & GRAIN_BUF_MASK;
        let frac = (pos - pos.floor()) as f32;
        let i1 = idx;
        let i2 = (idx + 1) & GRAIN_BUF_MASK;
        buf[i1] * (1.0 - frac) + buf[i2] * frac
    }
}

impl DspProcessor for GrainDelayProcessor {
    fn process_stereo(&mut self, left: &mut [f32], right: &mut [f32], sample_rate: f32) {
        let sr = sanitize_sample_rate(sample_rate);
        if (sr - self.sample_rate).abs() > 0.5 {
            self.sample_rate = sr;
            self.mix_sm.set_sample_rate(sr);
            self.fb_sm.set_sample_rate(sr);
        }

        let len = left.len().min(right.len());
        self.mix_sm.set_target(self.mix);
        self.fb_sm.set_target(self.feedback);

        let delay_samples = (self.delay_ms * 0.001 * sr).clamp(1.0, (GRAIN_BUF_SIZE / 2) as f32);
        let grain_samples = (self.grain_size_ms * 0.001 * sr).max(64.0);
        let pitch_rate = 2.0_f64.powf(self.pitch_semi as f64 / 12.0);
        let density = (self.density as f32).max(1.0);
        self.grain_interval = grain_samples / density;

        for i in 0..len {
            let dry_l = left[i];
            let dry_r = right[i];
            let mix = self.mix_sm.next_value();
            let fb = self.fb_sm.next_value();

            // Write to delay buffer (with feedback)
            let fb_l = self.buf_l[self.write_pos];
            let fb_r = self.buf_r[self.write_pos];
            self.buf_l[self.write_pos] = dry_l + fb_l * fb;
            self.buf_r[self.write_pos] = dry_r + fb_r * fb;

            // Trigger new grains
            self.grain_counter += 1.0;
            if self.grain_counter >= self.grain_interval {
                self.grain_counter -= self.grain_interval;
                let spray_rng = self.rng_next();
                let spray_offset = (spray_rng * self.spray * delay_samples) as usize;
                let start = (self.write_pos + GRAIN_BUF_SIZE - delay_samples as usize - spray_offset) & GRAIN_BUF_MASK;
                let g = &mut self.grains[self.next_grain_idx % MAX_GRAINS];
                g.active = true;
                g.read_pos = start as f64;
                g.read_rate = pitch_rate;
                g.window_pos = 0.0;
                g.window_inc = 1.0 / grain_samples;
                g.start_offset = start;
                self.next_grain_idx = self.next_grain_idx.wrapping_add(1);
            }

            self.write_pos = (self.write_pos + 1) & GRAIN_BUF_MASK;

            // Sum active grains
            let mut wet_l = 0.0f32;
            let mut wet_r = 0.0f32;
            for g in &mut self.grains {
                if !g.active { continue; }
                let w = Self::hann_window(g.window_pos);
                wet_l += Self::read_buf(&self.buf_l, g.read_pos) * w;
                wet_r += Self::read_buf(&self.buf_r, g.read_pos) * w;
                g.read_pos += g.read_rate;
                // Wrap
                if g.read_pos >= GRAIN_BUF_SIZE as f64 { g.read_pos -= GRAIN_BUF_SIZE as f64; }
                if g.read_pos < 0.0 { g.read_pos += GRAIN_BUF_SIZE as f64; }
                g.window_pos += g.window_inc;
                if g.window_pos >= 1.0 {
                    g.active = false;
                }
            }

            // BUG-B18-002 FIX: Clamp output to prevent runaway feedback accumulation.
            left[i] = (dry_l * (1.0 - mix) + wet_l * mix).clamp(-8.0, 8.0);
            right[i] = (dry_r * (1.0 - mix) + wet_r * mix).clamp(-8.0, 8.0);
        }
    }

    fn set_param(&mut self, index: u8, value: f32) {
        match index {
            0 => self.delay_ms = value.clamp(1.0, 2000.0),
            1 => self.grain_size_ms = value.clamp(10.0, 500.0),
            2 => self.pitch_semi = value.clamp(-24.0, 24.0),
            3 => self.spray = (value / 100.0).clamp(0.0, 1.0),
            4 => self.feedback = (value / 100.0).clamp(0.0, 0.95),
            5 => self.mix = (value / 100.0).clamp(0.0, 1.0),
            6 => self.density = (value as u8).clamp(1, 8),
            _ => {}
        }
    }

    fn reset(&mut self) {
        self.buf_l.fill(0.0);
        self.buf_r.fill(0.0);
        self.write_pos = 0;
        for g in &mut self.grains { g.active = false; }
        self.grain_counter = 0.0;
        self.mix_sm.set_instant(self.mix);
        self.fb_sm.set_instant(self.feedback);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn grain_delay_produces_output() {
        let mut proc = GrainDelayProcessor::new(44100.0);
        proc.set_param(5, 100.0); // Full wet
        proc.set_param(0, 100.0); // 100ms delay
        let sr = 44100.0;
        let mut left = vec![0.0f32; 8192];
        let mut right = vec![0.0f32; 8192];
        // Impulse
        left[0] = 1.0; right[0] = 1.0;
        proc.process_stereo(&mut left, &mut right, sr);
        let tail_energy: f32 = left[2048..].iter().map(|x| x * x).sum::<f32>();
        assert!(tail_energy > 0.0001, "Should have granular output");
        assert!(left.iter().all(|x| x.is_finite()));
    }
}
