// ═══════════════════════════════════════════════════════════════════════════
// Dream DAW — Bitcrusher (Redux) Processor (Enterprise)
// ═══════════════════════════════════════════════════════════════════════════
//
// Lo-fi / glitch effect with:
//   - Bit depth reduction (1–32 bits)
//   - Sample rate reduction (1–64x)
//   - Jitter (random timing offset on S&H)
//   - Pre-filter LP (anti-alias before downsample)
//   - Post-filter LP (smooth output)
//   - Stereo desync mode (independent L/R S&H)
//
// Parameters:
//   0: Bit Depth   (1–32, default 16)
//   1: Downsample  (1–64x, default 1)
//   2: Mix         (0–100%, default 100%)
//   3: Jitter      (0–100%, default 0%) — random S&H timing
//   4: Pre Filter  (200–20000 Hz, default 20000) — LP before crush
//   5: Post Filter (200–20000 Hz, default 20000) — LP after crush
//   6: Stereo Mode (0=linked, 1=independent, default 0)
//   7: Dither      (0–100%, default 0%) — triangular dither
//
// Real-Time Safety: Zero allocations. O(N) per buffer.
//
// ═══════════════════════════════════════════════════════════════════════════

use crate::dsp_processor::DspProcessor;

pub struct BitcrusherProcessor {
    bit_depth: f32,
    downsample: f32,
    mix: f32,
    jitter: f32,
    pre_freq: f32,
    post_freq: f32,
    stereo_mode: bool,
    dither: f32,
    // S&H state
    hold_l: f32,
    hold_r: f32,
    counter_l: f32,
    counter_r: f32,
    // Filter state
    pre_state_l: f32,
    pre_state_r: f32,
    post_state_l: f32,
    post_state_r: f32,
    pre_coeff: f32,
    post_coeff: f32,
    // Simple PRNG for jitter/dither
    rng_state: u64,
    sample_rate: f32,
}

impl BitcrusherProcessor {
    pub fn new(sample_rate: f32) -> Self {
        let mut proc = Self {
            bit_depth: 16.0,
            downsample: 1.0,
            mix: 1.0,
            jitter: 0.0,
            pre_freq: 20000.0,
            post_freq: 20000.0,
            stereo_mode: false,
            dither: 0.0,
            hold_l: 0.0,
            hold_r: 0.0,
            counter_l: 0.0,
            counter_r: 0.0,
            pre_state_l: 0.0,
            pre_state_r: 0.0,
            post_state_l: 0.0,
            post_state_r: 0.0,
            pre_coeff: 0.99,
            post_coeff: 0.99,
            rng_state: 0xBEEF_CAFE_1234_5678,
            sample_rate,
        };
        proc.update_filters();
        proc
    }

    fn update_filters(&mut self) {
        let sr = self.sample_rate;
        // Exact one-pole LP: α = 1 - e^(-2πfc/sr)
        self.pre_coeff =
            (1.0 - (-std::f32::consts::TAU * self.pre_freq / sr).exp()).clamp(0.0, 1.0);
        self.post_coeff =
            (1.0 - (-std::f32::consts::TAU * self.post_freq / sr).exp()).clamp(0.0, 1.0);
    }

    #[inline]
    fn next_random(&mut self) -> f32 {
        let mut x = self.rng_state;
        x ^= x << 13;
        x ^= x >> 7;
        x ^= x << 17;
        self.rng_state = x;
        (x as i64 as f64 / i64::MAX as f64) as f32
    }

    #[inline]
    fn quantize(sample: f32, levels: f32, dither: f32) -> f32 {
        ((sample + dither) * levels).round() / levels
    }
}

impl Default for BitcrusherProcessor {
    fn default() -> Self {
        Self::new(44100.0)
    }
}

impl DspProcessor for BitcrusherProcessor {
    fn process_stereo(&mut self, left: &mut [f32], right: &mut [f32], sample_rate: f32) {
        // Sync sample rate if changed
        if sample_rate.is_finite()
            && sample_rate > 1000.0
            && (sample_rate - self.sample_rate).abs() > 0.5
        {
            self.sample_rate = sample_rate;
            self.update_filters();
        }
        let len = left.len().min(right.len());
        let levels = 2.0_f32.powf(self.bit_depth - 1.0);
        let step = self.downsample.max(1.0);
        let jitter_range = self.jitter * step;
        let dither_amt = self.dither / levels;

        for i in 0..len {
            let dry_l = left[i];
            let dry_r = right[i];

            // Pre-filter
            self.pre_state_l += self.pre_coeff * (dry_l - self.pre_state_l);
            self.pre_state_r += self.pre_coeff * (dry_r - self.pre_state_r);
            let pre_l = self.pre_state_l;
            let pre_r = self.pre_state_r;

            // Jitter offset
            let jitter_offset = if self.jitter > 0.001 {
                self.next_random() * jitter_range
            } else {
                0.0
            };

            // S&H (left channel)
            self.counter_l += 1.0;
            if self.counter_l >= step + jitter_offset {
                self.counter_l = 0.0;
                let d = if dither_amt > 0.0001 {
                    self.next_random() * dither_amt
                } else {
                    0.0
                };
                self.hold_l = Self::quantize(pre_l, levels, d);
            }

            // S&H (right channel — linked or independent)
            if self.stereo_mode {
                self.counter_r += 1.0;
                let j2 = if self.jitter > 0.001 {
                    self.next_random() * jitter_range
                } else {
                    0.0
                };
                if self.counter_r >= step + j2 {
                    self.counter_r = 0.0;
                    let d = if dither_amt > 0.0001 {
                        self.next_random() * dither_amt
                    } else {
                        0.0
                    };
                    self.hold_r = Self::quantize(pre_r, levels, d);
                }
            } else {
                // Linked: same timing as L
                if self.counter_l == 0.0 {
                    let d = if dither_amt > 0.0001 {
                        self.next_random() * dither_amt
                    } else {
                        0.0
                    };
                    self.hold_r = Self::quantize(pre_r, levels, d);
                }
            }

            // Post-filter
            self.post_state_l += self.post_coeff * (self.hold_l - self.post_state_l);
            self.post_state_r += self.post_coeff * (self.hold_r - self.post_state_r);

            left[i] = dry_l * (1.0 - self.mix) + self.post_state_l * self.mix;
            right[i] = dry_r * (1.0 - self.mix) + self.post_state_r * self.mix;

            // AUD-132 FIX: Flush denormals in pre/post LP filter states.
            if self.pre_state_l.abs() < 1e-20 {
                self.pre_state_l = 0.0;
            }
            if self.pre_state_r.abs() < 1e-20 {
                self.pre_state_r = 0.0;
            }
            if self.post_state_l.abs() < 1e-20 {
                self.post_state_l = 0.0;
            }
            if self.post_state_r.abs() < 1e-20 {
                self.post_state_r = 0.0;
            }
        }
    }

    fn set_param(&mut self, index: u8, value: f32) {
        match index {
            0 => self.bit_depth = value.clamp(1.0, 32.0),
            1 => self.downsample = value.clamp(1.0, 64.0),
            2 => self.mix = (value / 100.0).clamp(0.0, 1.0),
            3 => self.jitter = (value / 100.0).clamp(0.0, 1.0),
            4 => {
                self.pre_freq = value.clamp(200.0, 20000.0);
                self.update_filters();
            }
            5 => {
                self.post_freq = value.clamp(200.0, 20000.0);
                self.update_filters();
            }
            6 => self.stereo_mode = value > 0.5,
            7 => self.dither = (value / 100.0).clamp(0.0, 1.0),
            _ => {}
        }
    }

    fn reset(&mut self) {
        self.hold_l = 0.0;
        self.hold_r = 0.0;
        self.counter_l = 0.0;
        self.counter_r = 0.0;
        self.pre_state_l = 0.0;
        self.pre_state_r = 0.0;
        self.post_state_l = 0.0;
        self.post_state_r = 0.0;
        self.rng_state = 0xBEEF_CAFE_1234_5678;
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn bitcrusher_quantizes_signal() {
        let mut proc = BitcrusherProcessor::new(44100.0);
        proc.set_param(0, 4.0); // 4-bit
        proc.set_param(2, 100.0);
        let sr = 44100.0;
        let mut left: Vec<f32> = (0..1024)
            .map(|i| (2.0 * std::f32::consts::PI * 440.0 * i as f32 / sr).sin())
            .collect();
        let mut right = left.clone();
        proc.process_stereo(&mut left, &mut right, sr);
        let unique: std::collections::HashSet<u32> = left.iter().map(|s| s.to_bits()).collect();
        assert!(
            unique.len() < 200,
            "4-bit should step: got {}",
            unique.len()
        );
    }

    #[test]
    fn bitcrusher_downsample() {
        let mut proc = BitcrusherProcessor::new(44100.0);
        proc.set_param(0, 32.0);
        proc.set_param(1, 8.0);
        proc.set_param(2, 100.0);
        let mut left: Vec<f32> = (0..512).map(|i| i as f32 / 512.0).collect();
        let mut right = left.clone();
        proc.process_stereo(&mut left, &mut right, 44100.0);
        let mut runs = 0;
        for w in left.windows(2) {
            if w[0] == w[1] {
                runs += 1;
            }
        }
        assert!(runs > 150, "Runs: {runs}");
    }

    #[test]
    fn bitcrusher_jitter() {
        let mut proc = BitcrusherProcessor::new(44100.0);
        proc.set_param(3, 50.0); // jitter
        proc.set_param(1, 4.0);
        let mut l = vec![0.5f32; 2048];
        let mut r = vec![0.5f32; 2048];
        proc.process_stereo(&mut l, &mut r, 44100.0);
    }
}
