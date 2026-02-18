// ═══════════════════════════════════════════════════════════════════════════
// Dream DAW — 8-Band Parametric EQ Processor (Enterprise)
// ═══════════════════════════════════════════════════════════════════════════
//
// Full 8-band parametric EQ with per-band filter type selection:
//   Band 0: Low Cut (HP 12/24 dB/oct)
//   Band 1: Low Shelf
//   Bands 2–5: Peaking (parametric bell)
//   Band 6: High Shelf
//   Band 7: High Cut (LP 12/24 dB/oct)
//
// Each band has: Frequency, Gain, Q, Enable, Type
//
// Parameters (8 bands × 4 params = 32 param slots):
//   band * 4 + 0: Frequency (20–20000 Hz)
//   band * 4 + 1: Gain (-24 to +24 dB)
//   band * 4 + 2: Q (0.1 to 18.0)
//   band * 4 + 3: Enable (0 or 1)
//
// Real-Time Safety: Zero allocations. O(N × active_bands) per buffer.
//
// ═══════════════════════════════════════════════════════════════════════════

use crate::biquad::{BiquadCoeffs, BiquadFilter, BiquadType};
use crate::dsp_processor::DspProcessor;

const NUM_BANDS: usize = 8;

/// Default frequencies for 8 bands (log-spaced).
const DEFAULT_FREQS: [f64; NUM_BANDS] =
    [30.0, 100.0, 250.0, 800.0, 2500.0, 6000.0, 12000.0, 18000.0];

/// Default filter types per band.
const DEFAULT_TYPES: [BiquadType; NUM_BANDS] = [
    BiquadType::Highpass,  // Band 0: Low cut
    BiquadType::LowShelf,  // Band 1: Low shelf
    BiquadType::Peaking,   // Band 2: Bell
    BiquadType::Peaking,   // Band 3: Bell
    BiquadType::Peaking,   // Band 4: Bell
    BiquadType::Peaking,   // Band 5: Bell
    BiquadType::HighShelf, // Band 6: High shelf
    BiquadType::Lowpass,   // Band 7: High cut
];

/// Per-band state.
struct EqBand {
    filter_l: BiquadFilter,
    filter_r: BiquadFilter,
    freq: f64,
    gain_db: f64,
    q: f64,
    enabled: bool,
    filter_type: BiquadType,
}

impl EqBand {
    fn new(freq: f64, gain_db: f64, q: f64, filter_type: BiquadType, sr: f64) -> Self {
        let coeffs = BiquadCoeffs::new(filter_type, freq, q, sr, gain_db);
        Self {
            filter_l: BiquadFilter::new(coeffs),
            filter_r: BiquadFilter::new(coeffs),
            freq,
            gain_db,
            q,
            enabled: !matches!(filter_type, BiquadType::Highpass | BiquadType::Lowpass),
            filter_type,
        }
    }

    fn update(&mut self, sr: f64) {
        let coeffs = BiquadCoeffs::new(self.filter_type, self.freq, self.q, sr, self.gain_db);
        self.filter_l.update_coefficients(coeffs);
        self.filter_r.update_coefficients(coeffs);
    }

    fn reset(&mut self) {
        self.filter_l.reset();
        self.filter_r.reset();
    }
}

/// 8-band parametric EQ processor.
pub struct EqProcessor {
    bands: [EqBand; NUM_BANDS],
    sample_rate: f64,
    /// Output gain in dB (-24 to +24)
    output_gain_db: f32,
    output_gain_lin: f32,
}

impl EqProcessor {
    pub fn new(sample_rate: f64) -> Self {
        let bands = std::array::from_fn(|i| {
            let gain = 0.0;
            EqBand::new(DEFAULT_FREQS[i], gain, 0.71, DEFAULT_TYPES[i], sample_rate)
        });
        Self {
            bands,
            sample_rate,
            output_gain_db: 0.0,
            output_gain_lin: 1.0,
        }
    }

    #[inline]
    fn sync_sample_rate(&mut self, sample_rate: f32) {
        let sr = sample_rate as f64;
        if sr.is_finite()
            && sr > 1000.0
            && (sr - self.sample_rate).abs() > 0.5
        {
            self.sample_rate = sr;
            for band in &mut self.bands {
                band.update(sr);
            }
        }
    }
}

impl DspProcessor for EqProcessor {
    fn process_stereo(&mut self, left: &mut [f32], right: &mut [f32], sample_rate: f32) {
        self.sync_sample_rate(sample_rate);
        // Process each enabled band in series
        for band in &mut self.bands {
            if !band.enabled {
                continue;
            }
            band.filter_l.process_buffer(left);
            band.filter_r.process_buffer(right);
        }
        // Output gain
        if (self.output_gain_lin - 1.0).abs() > 0.0001 {
            let g = self.output_gain_lin;
            for i in 0..left.len().min(right.len()) {
                left[i] *= g;
                right[i] *= g;
            }
        }
        // Soft-clip to prevent cascaded filter boosts from going unbounded
        // tanh(x/6)*6 preserves linearity up to ~±4 and soft-clips beyond
        for i in 0..left.len().min(right.len()) {
            left[i] = (left[i] / 6.0).tanh() * 6.0;
            right[i] = (right[i] / 6.0).tanh() * 6.0;
        }
    }

    fn set_param(&mut self, index: u8, value: f32) {
        let idx = index as usize;

        // Param 32 = output gain
        if idx == 32 {
            self.output_gain_db = value.clamp(-24.0, 24.0);
            self.output_gain_lin = 10.0_f32.powf(self.output_gain_db / 20.0);
            return;
        }

        let band_idx = idx / 4;
        let param_idx = idx % 4;
        if band_idx >= NUM_BANDS {
            return;
        }
        let sr = self.sample_rate;
        let band = &mut self.bands[band_idx];

        match param_idx {
            0 => {
                band.freq = (value as f64).clamp(20.0, 20000.0);
                band.update(sr);
            }
            1 => {
                band.gain_db = (value as f64).clamp(-24.0, 24.0);
                band.update(sr);
            }
            2 => {
                band.q = (value as f64).clamp(0.1, 18.0);
                band.update(sr);
            }
            3 => {
                band.enabled = value > 0.5;
            }
            _ => {}
        }
    }

    fn reset(&mut self) {
        for band in &mut self.bands {
            band.reset();
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn eq_flat_passthrough() {
        let mut proc = EqProcessor::new(44100.0);
        // Disable cut bands so signal passes flat
        proc.set_param(3, 0.0); // disable band 0 (HP)
        proc.set_param(7 * 4 + 3, 0.0); // disable band 7 (LP)
        let input = vec![0.5f32; 256];
        let mut left = input.clone();
        let mut right = input.clone();
        proc.process_stereo(&mut left, &mut right, 44100.0);
        for s in &left {
            assert!((s - 0.5).abs() < 0.15, "EQ flat pass failed: {s}");
        }
    }

    #[test]
    fn eq_boost_changes_signal() {
        let mut proc = EqProcessor::new(44100.0);
        proc.set_param(3 * 4 + 1, 12.0); // Boost band 3 by 12dB
        let mut left = vec![0.1f32; 1024];
        let mut right = vec![0.1f32; 1024];
        proc.process_stereo(&mut left, &mut right, 44100.0);
        let changed = left.iter().any(|s| (s - 0.1).abs() > 0.001);
        assert!(changed, "EQ boost should change signal");
    }

    #[test]
    fn eq_output_gain() {
        let mut proc = EqProcessor::new(44100.0);
        // Disable all bands
        for b in 0..NUM_BANDS {
            proc.set_param((b * 4 + 3) as u8, 0.0);
        }
        proc.set_param(32, 6.0); // +6 dB output gain
        let mut left = vec![0.25f32; 256];
        let mut right = vec![0.25f32; 256];
        proc.process_stereo(&mut left, &mut right, 44100.0);
        let expected = 0.25 * 10.0_f32.powf(6.0 / 20.0);
        assert!(
            (left[100] - expected).abs() < 0.05,
            "Output gain failed: got {} expected {}",
            left[100],
            expected
        );
    }
}
