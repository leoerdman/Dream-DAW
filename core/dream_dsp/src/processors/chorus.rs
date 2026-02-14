// ═══════════════════════════════════════════════════════════════════════════
// Dream DAW — Chorus Processor
// ═══════════════════════════════════════════════════════════════════════════
//
// Classic chorus effect with LFO-modulated delay line:
//   - Sine LFO modulates delay time around a base value
//   - Stereo: L and R use phase-offset LFOs for width
//
// Parameters:
//   0: Rate  (0.1 to 10.0 Hz, default 1.5)
//   1: Depth (0 to 100 %, default 50)
//   2: Mix   (0 to 100 %, default 50)
//
// ═══════════════════════════════════════════════════════════════════════════

use crate::dsp_processor::DspProcessor;

/// Base delay in seconds (7ms — typical chorus center delay).
const BASE_DELAY_SEC: f32 = 0.007;

/// Maximum modulation excursion in seconds (3ms).
const MAX_MOD_SEC: f32 = 0.003;

/// Maximum buffer size (base + max modulation, with safety margin).
const MAX_DELAY_SAMPLES: usize = 2048;

pub struct ChorusProcessor {
    buf_l: [f32; MAX_DELAY_SAMPLES],
    buf_r: [f32; MAX_DELAY_SAMPLES],
    write_pos: usize,
    // LFO state
    lfo_phase: f32,
    rate_hz: f32,
    depth: f32,       // 0..1
    mix: f32,         // 0..1
    sample_rate: f32,
}

impl ChorusProcessor {
    pub fn new(sample_rate: f32) -> Self {
        Self {
            buf_l: [0.0; MAX_DELAY_SAMPLES],
            buf_r: [0.0; MAX_DELAY_SAMPLES],
            write_pos: 0,
            lfo_phase: 0.0,
            rate_hz: 1.5,
            depth: 0.5,
            mix: 0.5,
            sample_rate,
        }
    }

    /// Linear interpolation for fractional delay reads.
    #[inline]
    fn read_delay(buf: &[f32; MAX_DELAY_SAMPLES], write_pos: usize, delay_samples: f32) -> f32 {
        let int_delay = delay_samples as usize;
        let frac = delay_samples - int_delay as f32;
        let idx0 = (write_pos + MAX_DELAY_SAMPLES - int_delay) % MAX_DELAY_SAMPLES;
        let idx1 = (write_pos + MAX_DELAY_SAMPLES - int_delay - 1) % MAX_DELAY_SAMPLES;
        buf[idx0] * (1.0 - frac) + buf[idx1] * frac
    }
}

impl DspProcessor for ChorusProcessor {
    fn process_stereo(&mut self, left: &mut [f32], right: &mut [f32], _sample_rate: f32) {
        let len = left.len().min(right.len());
        let sr = self.sample_rate;
        let phase_inc = self.rate_hz / sr;
        let base_delay = BASE_DELAY_SEC * sr;
        let mod_depth = MAX_MOD_SEC * sr * self.depth;
        let wet = self.mix;
        let dry = 1.0 - wet;

        for i in 0..len {
            // Write dry signal into buffer
            self.buf_l[self.write_pos] = left[i];
            self.buf_r[self.write_pos] = right[i];

            // LFO: sine wave, R channel 90° out of phase
            let lfo_l = (self.lfo_phase * std::f32::consts::TAU).sin();
            let lfo_r = ((self.lfo_phase + 0.25) * std::f32::consts::TAU).sin();

            // Modulated delay time
            let delay_l = (base_delay + lfo_l * mod_depth).clamp(1.0, (MAX_DELAY_SAMPLES - 2) as f32);
            let delay_r = (base_delay + lfo_r * mod_depth).clamp(1.0, (MAX_DELAY_SAMPLES - 2) as f32);

            // Read from delay line with interpolation
            let wet_l = Self::read_delay(&self.buf_l, self.write_pos, delay_l);
            let wet_r = Self::read_delay(&self.buf_r, self.write_pos, delay_r);

            // Mix
            left[i] = left[i] * dry + wet_l * wet;
            right[i] = right[i] * dry + wet_r * wet;

            // Advance LFO
            self.lfo_phase += phase_inc;
            if self.lfo_phase >= 1.0 {
                self.lfo_phase -= 1.0;
            }

            // Advance write position
            self.write_pos = (self.write_pos + 1) % MAX_DELAY_SAMPLES;
        }
    }

    fn set_param(&mut self, index: u8, value: f32) {
        match index {
            0 => {
                // Rate (Hz)
                self.rate_hz = value.clamp(0.1, 10.0);
            }
            1 => {
                // Depth (%)
                self.depth = (value / 100.0).clamp(0.0, 1.0);
            }
            2 => {
                // Mix (%)
                self.mix = (value / 100.0).clamp(0.0, 1.0);
            }
            _ => {}
        }
    }

    fn reset(&mut self) {
        self.buf_l = [0.0; MAX_DELAY_SAMPLES];
        self.buf_r = [0.0; MAX_DELAY_SAMPLES];
        self.write_pos = 0;
        self.lfo_phase = 0.0;
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn chorus_processes_without_panic() {
        let mut proc = ChorusProcessor::new(44100.0);
        let mut left = vec![0.5f32; 512];
        let mut right = vec![0.5f32; 512];
        proc.process_stereo(&mut left, &mut right, 44100.0);
    }

    #[test]
    fn chorus_modulates_signal() {
        let mut proc = ChorusProcessor::new(44100.0);
        proc.set_param(0, 5.0);   // 5Hz rate
        proc.set_param(1, 100.0); // Full depth
        proc.set_param(2, 100.0); // Fully wet

        // Constant signal — chorus should create variation
        let mut left = vec![0.5f32; 4096];
        let mut right = vec![0.5f32; 4096];
        proc.process_stereo(&mut left, &mut right, 44100.0);

        // Check that L and R differ (stereo spread)
        let diffs: f32 = left.iter().zip(right.iter())
            .map(|(l, r)| (l - r).abs())
            .sum();
        assert!(diffs > 0.1, "Chorus should create stereo difference, total diff: {diffs}");
    }
}
