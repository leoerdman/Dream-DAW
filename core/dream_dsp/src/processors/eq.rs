// ═══════════════════════════════════════════════════════════════════════════
// Dream DAW — 3-Band EQ Processor
// ═══════════════════════════════════════════════════════════════════════════
//
// Classic 3-band parametric EQ using the crate's BiquadFilter:
//   - Low shelf (200 Hz)
//   - Mid peaking (1 kHz, Q = 0.71)
//   - High shelf (5 kHz)
//
// Parameters:
//   0: Low  gain  (-24 to +24 dB, default 0)
//   1: Mid  gain  (-24 to +24 dB, default 0)
//   2: High gain  (-24 to +24 dB, default 0)
//
// Real-Time Safety: Zero allocations. O(N) per buffer.
//
// ═══════════════════════════════════════════════════════════════════════════

use crate::biquad::{BiquadCoeffs, BiquadFilter, BiquadType};
use crate::dsp_processor::DspProcessor;

/// Fixed EQ band center frequencies (Hz).
const LOW_FREQ: f64 = 200.0;
const MID_FREQ: f64 = 1000.0;
const HIGH_FREQ: f64 = 5000.0;
const MID_Q: f64 = 0.71;

/// 3-band parametric EQ processor.
pub struct EqProcessor {
    // Stereo pair for each band (L/R channels)
    low_l: BiquadFilter,
    low_r: BiquadFilter,
    mid_l: BiquadFilter,
    mid_r: BiquadFilter,
    high_l: BiquadFilter,
    high_r: BiquadFilter,
    // Current gain values
    low_db: f32,
    mid_db: f32,
    high_db: f32,
    // Cached sample rate
    sample_rate: f64,
}

impl EqProcessor {
    pub fn new(sample_rate: f64) -> Self {
        let flat = BiquadCoeffs::new(BiquadType::LowShelf, LOW_FREQ, 0.71, sample_rate, 0.0);
        Self {
            low_l: BiquadFilter::new(flat),
            low_r: BiquadFilter::new(flat),
            mid_l: BiquadFilter::new(BiquadCoeffs::new(BiquadType::Peaking, MID_FREQ, MID_Q, sample_rate, 0.0)),
            mid_r: BiquadFilter::new(BiquadCoeffs::new(BiquadType::Peaking, MID_FREQ, MID_Q, sample_rate, 0.0)),
            high_l: BiquadFilter::new(BiquadCoeffs::new(BiquadType::HighShelf, HIGH_FREQ, 0.71, sample_rate, 0.0)),
            high_r: BiquadFilter::new(BiquadCoeffs::new(BiquadType::HighShelf, HIGH_FREQ, 0.71, sample_rate, 0.0)),
            low_db: 0.0,
            mid_db: 0.0,
            high_db: 0.0,
            sample_rate,
        }
    }

    fn update_low(&mut self) {
        let c = BiquadCoeffs::new(BiquadType::LowShelf, LOW_FREQ, 0.71, self.sample_rate, self.low_db as f64);
        self.low_l.update_coefficients(c);
        self.low_r.update_coefficients(c);
    }

    fn update_mid(&mut self) {
        let c = BiquadCoeffs::new(BiquadType::Peaking, MID_FREQ, MID_Q, self.sample_rate, self.mid_db as f64);
        self.mid_l.update_coefficients(c);
        self.mid_r.update_coefficients(c);
    }

    fn update_high(&mut self) {
        let c = BiquadCoeffs::new(BiquadType::HighShelf, HIGH_FREQ, 0.71, self.sample_rate, self.high_db as f64);
        self.high_l.update_coefficients(c);
        self.high_r.update_coefficients(c);
    }
}

impl DspProcessor for EqProcessor {
    fn process_stereo(&mut self, left: &mut [f32], right: &mut [f32], _sample_rate: f32) {
        // Process each band in series
        self.low_l.process_buffer(left);
        self.low_r.process_buffer(right);
        self.mid_l.process_buffer(left);
        self.mid_r.process_buffer(right);
        self.high_l.process_buffer(left);
        self.high_r.process_buffer(right);
    }

    fn set_param(&mut self, index: u8, value: f32) {
        let clamped = value.clamp(-24.0, 24.0);
        match index {
            0 => {
                self.low_db = clamped;
                self.update_low();
            }
            1 => {
                self.mid_db = clamped;
                self.update_mid();
            }
            2 => {
                self.high_db = clamped;
                self.update_high();
            }
            _ => {}
        }
    }

    fn reset(&mut self) {
        self.low_l.reset();
        self.low_r.reset();
        self.mid_l.reset();
        self.mid_r.reset();
        self.high_l.reset();
        self.high_r.reset();
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn eq_flat_passthrough() {
        let mut proc = EqProcessor::new(44100.0);
        let input = vec![0.5f32; 256];
        let mut left = input.clone();
        let mut right = input.clone();
        proc.process_stereo(&mut left, &mut right, 44100.0);
        // Flat EQ should approximately pass through DC signal
        for s in &left {
            assert!((s - 0.5).abs() < 0.1, "EQ flat pass failed: {s}");
        }
    }

    #[test]
    fn eq_boost_changes_signal() {
        let mut proc = EqProcessor::new(44100.0);
        proc.set_param(1, 12.0); // Boost mid by 12dB
        let mut left = vec![0.1f32; 1024];
        let mut right = vec![0.1f32; 1024];
        proc.process_stereo(&mut left, &mut right, 44100.0);
        // After boosting, some samples should differ from original
        let changed = left.iter().any(|s| (s - 0.1).abs() > 0.001);
        assert!(changed, "EQ boost should change signal");
    }
}
