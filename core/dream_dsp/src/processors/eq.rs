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
use crate::processors::smoothing::SmoothedValue;
use crate::processors::{db_to_linear, sanitize_sample_rate};

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
    output_gain_sm: SmoothedValue,
}

impl EqProcessor {
    pub fn new(sample_rate: f64) -> Self {
        let safe_sr = sanitize_sample_rate(sample_rate as f32) as f64;
        let bands = std::array::from_fn(|i| {
            let gain = 0.0;
            EqBand::new(DEFAULT_FREQS[i], gain, 0.71, DEFAULT_TYPES[i], safe_sr)
        });
        Self {
            bands,
            sample_rate: safe_sr,
            output_gain_db: 0.0,
            output_gain_lin: 1.0,
            output_gain_sm: SmoothedValue::new(safe_sr as f32, 8.0, 1.0),
        }
    }

    #[inline]
    fn sync_sample_rate(&mut self, sample_rate: f32) {
        let sr = sanitize_sample_rate(sample_rate) as f64;
        if sr.is_finite() && sr > 1000.0 && (sr - self.sample_rate).abs() > 0.5 {
            self.sample_rate = sr;
            self.output_gain_sm.set_sample_rate(sr as f32);
            for band in &mut self.bands {
                band.update(sr);
            }
        }
    }
}

impl DspProcessor for EqProcessor {
    fn process_stereo(&mut self, left: &mut [f32], right: &mut [f32], sample_rate: f32) {
        self.sync_sample_rate(sample_rate);
        let len = left.len().min(right.len());
        let left_buf = &mut left[..len];
        let right_buf = &mut right[..len];
        // Process each enabled band in series
        for band in &mut self.bands {
            if !band.enabled {
                continue;
            }
            band.filter_l.process_buffer(left_buf);
            band.filter_r.process_buffer(right_buf);
            // BUG-C08 FIX: Per-band output clamp to prevent cascaded extreme gain
            // from producing values exceeding ±1000 before the runaway guard.
            // 8 bands × +18dB = +144dB theoretical — intermediate clamp at ±30.0
            // prevents inter-band accumulation while remaining transparent in normal use.
            for s in left_buf.iter_mut() {
                *s = s.clamp(-30.0, 30.0);
            }
            for s in right_buf.iter_mut() {
                *s = s.clamp(-30.0, 30.0);
            }
        }
        // Output gain
        self.output_gain_sm
            .set_target(self.output_gain_lin.max(0.0));
        for i in 0..len {
            let g = self.output_gain_sm.next_value();
            left_buf[i] *= g;
            right_buf[i] *= g;
        }
        // Numeric runaway guard only for extreme boost stacks / pathological automation.
        // Transparent in normal operating range and bounded in stress scenarios.
        #[inline(always)]
        fn runaway_guard(x: f32) -> f32 {
            let ax = x.abs();
            if ax <= 24.0 {
                x
            } else {
                let tail = (ax - 24.0) / (1.0 + (ax - 24.0));
                x.signum() * (24.0 + 6.0 * tail)
            }
        }

        for i in 0..len {
            left_buf[i] = runaway_guard(left_buf[i]);
            right_buf[i] = runaway_guard(right_buf[i]);
        }
    }

    fn set_param(&mut self, index: u8, value: f32) {
        let idx = index as usize;

        // Param 32 = output gain
        if idx == 32 {
            self.output_gain_db = value.clamp(-24.0, 24.0);
            self.output_gain_lin = db_to_linear(self.output_gain_db);
            return;
        }

        // Params 33–40 = filter type for bands 0–7
        // Values: 0=Highpass, 1=Lowpass, 2=LowShelf, 3=HighShelf, 4=Peaking, 5=Notch
        if (33..=40).contains(&idx) {
            let band_idx = idx - 33;
            if band_idx < NUM_BANDS {
                let new_type = match value as u8 {
                    0 => BiquadType::Highpass,
                    1 => BiquadType::Lowpass,
                    2 => BiquadType::LowShelf,
                    3 => BiquadType::HighShelf,
                    4 => BiquadType::Peaking,
                    5 => BiquadType::Notch,
                    _ => return,
                };
                let sr = self.sample_rate;
                let band = &mut self.bands[band_idx];
                if band.filter_type != new_type {
                    band.filter_type = new_type;
                    band.update(sr);
                }
            }
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
        self.output_gain_sm
            .set_instant(self.output_gain_lin.max(0.0));
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
        let mut left = vec![0.25f32; 2048];
        let mut right = vec![0.25f32; 2048];
        proc.process_stereo(&mut left, &mut right, 44100.0);
        let expected = 0.25 * 10.0_f32.powf(6.0 / 20.0);
        let tail_avg: f32 = left[1536..].iter().sum::<f32>() / (left.len() - 1536) as f32;
        assert!(
            (tail_avg - expected).abs() < 0.05,
            "Output gain failed: got {} expected {}",
            tail_avg,
            expected
        );
    }
}
