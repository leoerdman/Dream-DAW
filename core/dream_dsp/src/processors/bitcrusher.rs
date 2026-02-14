// ═══════════════════════════════════════════════════════════════════════════
// Dream DAW — Bitcrusher (Redux) Processor
// ═══════════════════════════════════════════════════════════════════════════
//
// Sample rate reduction + bit depth reduction for lo-fi / glitch effects.
//
// Params: 0=BitDepth(1–32, default 16), 1=Downsample(1–64, default 1), 2=Mix(0–1)
//
// ═══════════════════════════════════════════════════════════════════════════

use crate::dsp_processor::DspProcessor;

pub struct BitcrusherProcessor {
    bit_depth: f32,
    downsample: f32,
    mix: f32,
    // Sample-and-hold state
    hold_l: f32,
    hold_r: f32,
    hold_counter: f32,
}

impl BitcrusherProcessor {
    pub fn new() -> Self {
        Self {
            bit_depth: 16.0,
            downsample: 1.0,
            mix: 1.0,
            hold_l: 0.0,
            hold_r: 0.0,
            hold_counter: 0.0,
        }
    }

    /// Quantize a sample to the given bit depth.
    #[inline]
    fn quantize(sample: f32, levels: f32) -> f32 {
        (sample * levels).round() / levels
    }
}

impl DspProcessor for BitcrusherProcessor {
    fn process_stereo(&mut self, left: &mut [f32], right: &mut [f32], _sample_rate: f32) {
        let len = left.len().min(right.len());
        let levels = 2.0_f32.powf(self.bit_depth - 1.0);
        let step = self.downsample.max(1.0);

        for i in 0..len {
            let dry_l = left[i];
            let dry_r = right[i];

            // Sample-and-hold (downsample)
            self.hold_counter += 1.0;
            if self.hold_counter >= step {
                self.hold_counter -= step;
                // Bit-depth quantization
                self.hold_l = Self::quantize(dry_l, levels);
                self.hold_r = Self::quantize(dry_r, levels);
            }

            left[i] = dry_l * (1.0 - self.mix) + self.hold_l * self.mix;
            right[i] = dry_r * (1.0 - self.mix) + self.hold_r * self.mix;
        }
    }

    fn set_param(&mut self, index: u8, value: f32) {
        match index {
            0 => self.bit_depth = value.clamp(1.0, 32.0),
            1 => self.downsample = value.clamp(1.0, 64.0),
            2 => self.mix = value.clamp(0.0, 1.0),
            _ => {}
        }
    }

    fn reset(&mut self) {
        self.hold_l = 0.0;
        self.hold_r = 0.0;
        self.hold_counter = 0.0;
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn bitcrusher_quantizes_signal() {
        let mut proc = BitcrusherProcessor::new();
        proc.set_param(0, 4.0); // very low bit depth
        proc.set_param(2, 1.0); // full wet
        let sr = 44100.0;
        let mut left: Vec<f32> = (0..1024)
            .map(|i| (2.0 * std::f32::consts::PI * 440.0 * i as f32 / sr).sin())
            .collect();
        let mut right = left.clone();
        proc.process_stereo(&mut left, &mut right, sr);
        // With 4-bit depth, samples should be visibly stepped
        let unique_vals: std::collections::HashSet<u32> =
            left.iter().map(|s| s.to_bits()).collect();
        assert!(unique_vals.len() < 100, "4-bit should have few unique values, got: {}", unique_vals.len());
    }

    #[test]
    fn bitcrusher_downsample() {
        let mut proc = BitcrusherProcessor::new();
        proc.set_param(0, 32.0); // full bit depth
        proc.set_param(1, 8.0);  // heavy downsample
        proc.set_param(2, 1.0);
        let mut left: Vec<f32> = (0..512).map(|i| i as f32 / 512.0).collect();
        let mut right = left.clone();
        proc.process_stereo(&mut left, &mut right, 44100.0);
        // With 8x downsample, consecutive samples should be held
        let mut runs = 0;
        for w in left.windows(2) {
            if w[0] == w[1] { runs += 1; }
        }
        assert!(runs > 200, "Downsample should create runs, got: {runs}");
    }
}
