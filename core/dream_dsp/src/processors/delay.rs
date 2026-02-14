// ═══════════════════════════════════════════════════════════════════════════
// Dream DAW — Stereo Delay Processor
// ═══════════════════════════════════════════════════════════════════════════
//
// Simple stereo delay with:
//   - Delay time (ms)
//   - Feedback (%)
//   - Dry/Wet mix (%)
//
// Pre-allocated circular buffer for up to 2 seconds of delay.
//
// Parameters:
//   0: Time     (1 to 2000 ms, default 250)
//   1: Feedback (0 to 95 %, default 30)
//   2: Dry/Wet  (0 to 100 %, default 30)
//
// ═══════════════════════════════════════════════════════════════════════════

use crate::dsp_processor::DspProcessor;

/// Maximum delay time in seconds (pre-allocated buffer size).
const MAX_DELAY_SECONDS: f32 = 2.0;

/// Stereo delay processor with circular buffer.
pub struct DelayProcessor {
    /// Circular delay buffer — left channel
    buf_l: Vec<f32>,
    /// Circular delay buffer — right channel
    buf_r: Vec<f32>,
    /// Write position in buffer
    write_pos: usize,
    /// Delay time in samples
    delay_samples: usize,
    /// Feedback amount (0.0–0.95)
    feedback: f32,
    /// Dry/wet mix (0.0 = fully dry, 1.0 = fully wet)
    dry_wet: f32,
    /// Buffer capacity
    buf_size: usize,
    /// Cached sample rate
    sample_rate: f32,
    /// Delay time in ms (for recalculation)
    time_ms: f32,
}

impl DelayProcessor {
    pub fn new(sample_rate: f32) -> Self {
        let buf_size = (sample_rate * MAX_DELAY_SECONDS) as usize + 1;
        let time_ms = 250.0;
        let delay_samples = (time_ms * 0.001 * sample_rate) as usize;
        Self {
            buf_l: vec![0.0; buf_size],
            buf_r: vec![0.0; buf_size],
            write_pos: 0,
            delay_samples: delay_samples.min(buf_size - 1),
            feedback: 0.30,
            dry_wet: 0.30,
            buf_size,
            sample_rate,
            time_ms,
        }
    }
}

impl DspProcessor for DelayProcessor {
    fn process_stereo(&mut self, left: &mut [f32], right: &mut [f32], _sample_rate: f32) {
        let len = left.len().min(right.len());
        let bs = self.buf_size;
        let ds = self.delay_samples;
        let fb = self.feedback;
        let wet = self.dry_wet;
        let dry = 1.0 - wet;

        for i in 0..len {
            // Read from delay buffer
            let read_pos = (self.write_pos + bs - ds) % bs;
            let delayed_l = self.buf_l[read_pos];
            let delayed_r = self.buf_r[read_pos];

            let dry_l = left[i];
            let dry_r = right[i];

            // Write to delay buffer (input + feedback)
            self.buf_l[self.write_pos] = dry_l + delayed_l * fb;
            self.buf_r[self.write_pos] = dry_r + delayed_r * fb;

            // Mix dry/wet
            left[i] = dry_l * dry + delayed_l * wet;
            right[i] = dry_r * dry + delayed_r * wet;

            // Advance write position
            self.write_pos = (self.write_pos + 1) % bs;
        }
    }

    fn set_param(&mut self, index: u8, value: f32) {
        match index {
            0 => {
                // Time (ms)
                self.time_ms = value.clamp(1.0, 2000.0);
                self.delay_samples = ((self.time_ms * 0.001 * self.sample_rate) as usize)
                    .min(self.buf_size - 1);
            }
            1 => {
                // Feedback (%)
                self.feedback = (value / 100.0).clamp(0.0, 0.95);
            }
            2 => {
                // Dry/Wet (%)
                self.dry_wet = (value / 100.0).clamp(0.0, 1.0);
            }
            _ => {}
        }
    }

    fn reset(&mut self) {
        // Clear delay buffers
        self.buf_l.iter_mut().for_each(|s| *s = 0.0);
        self.buf_r.iter_mut().for_each(|s| *s = 0.0);
        self.write_pos = 0;
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn delay_0_wet_passthrough() {
        let mut proc = DelayProcessor::new(44100.0);
        proc.set_param(2, 0.0); // Fully dry
        let input = vec![0.5f32; 256];
        let mut left = input.clone();
        let mut right = input.clone();
        proc.process_stereo(&mut left, &mut right, 44100.0);
        for (i, s) in left.iter().enumerate() {
            assert!((s - input[i]).abs() < 0.001, "Dry pass failed");
        }
    }

    #[test]
    fn delay_produces_echo() {
        let mut proc = DelayProcessor::new(44100.0);
        proc.set_param(0, 100.0); // 100ms delay
        proc.set_param(1, 0.0);   // No feedback
        proc.set_param(2, 100.0); // Fully wet

        let delay_samples = (0.1 * 44100.0) as usize;
        let total = delay_samples + 100;

        // Impulse at sample 0
        let mut left = vec![0.0f32; total];
        let mut right = vec![0.0f32; total];
        left[0] = 1.0;
        right[0] = 1.0;

        proc.process_stereo(&mut left, &mut right, 44100.0);

        // Should see echo at delay_samples offset
        assert!(left[delay_samples].abs() > 0.5, "Echo not found at expected position");
        // Original impulse should be removed (fully wet)
        assert!(left[0].abs() < 0.01, "Dry signal should be gone at 100% wet");
    }
}
