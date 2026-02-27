// ═══════════════════════════════════════════════════════════════════════════
// Dream DAW — Biquad Filter (IIR 2nd-Order Digital Filter)
// ═══════════════════════════════════════════════════════════════════════════
//
// Direct port of Swift `WaveformCache.swift` band-splitting filters.
//
// The biquad filter is the fundamental building block for:
//   - Parametric EQ (per-band processing)
//   - Waveform analysis (band-splitting for multi-band display)
//   - Crossover networks (multiband compression)
//   - Frequency shaping for metering (A-weighting, etc.)
//
// Uses the Audio EQ Cookbook formulas (Robert Bristow-Johnson).
// All filter types share the same Direct Form I structure,
// differing only in their coefficient computation.
//
// Real-Time Safety:
//   - Zero allocations after construction
//   - O(1) per-sample processing (5 multiplies + 4 adds)
//   - State stored inline (no heap pointers)
//
// ═══════════════════════════════════════════════════════════════════════════

use std::f64::consts::PI;

// ── Filter Type ────────────────────────────────────────────────────────────

/// Type of biquad filter to create.
#[derive(Debug, Clone, Copy, PartialEq)]
pub enum BiquadType {
    /// 2nd-order Butterworth lowpass (-12 dB/octave).
    Lowpass,
    /// 2nd-order Butterworth highpass (-12 dB/octave).
    Highpass,
    /// Constant-Q bandpass (peak at center frequency).
    Bandpass,
    /// Notch (band-reject) filter.
    Notch,
    /// Low-shelf EQ (boost/cut below the corner frequency).
    LowShelf,
    /// High-shelf EQ (boost/cut above the corner frequency).
    HighShelf,
    /// Parametric (peaking) EQ band.
    Peaking,
    /// Allpass filter (phase rotation without gain change).
    Allpass,
}

// ── Biquad Coefficients ────────────────────────────────────────────────────

/// Pre-computed biquad filter coefficients (Direct Form I).
///
/// Transfer function:
/// ```text
///         b0 + b1·z⁻¹ + b2·z⁻²
/// H(z) = ─────────────────────────
///         1  + a1·z⁻¹ + a2·z⁻²
/// ```
///
/// Note: `a0` is normalized out (all coefficients divided by `a0`).
#[derive(Debug, Clone, Copy)]
pub struct BiquadCoeffs {
    pub b0: f64,
    pub b1: f64,
    pub b2: f64,
    pub a1: f64,
    pub a2: f64,
}

impl BiquadCoeffs {
    /// Computes coefficients for a given filter type.
    ///
    /// # Arguments
    /// - `filter_type`: Type of filter (lowpass, highpass, etc.)
    /// - `freq`: Center/corner frequency in Hz
    /// - `q`: Quality factor (bandwidth). For shelf/peaking: dB gain.
    /// - `sample_rate`: Sample rate in Hz
    /// - `gain_db`: Gain in dB (only used for shelf and peaking filters).
    pub fn new(filter_type: BiquadType, freq: f64, q: f64, sample_rate: f64, gain_db: f64) -> Self {
        // BUG-93 FIX: Clamp frequency to Nyquist to prevent unstable coefficients.
        let safe_freq = freq.clamp(10.0, sample_rate * 0.499);
        // Guard Q to prevent division by zero in alpha calculation.
        let safe_q = q.max(0.01);
        let omega = 2.0 * PI * safe_freq / sample_rate;
        let cos_w = omega.cos();
        let sin_w = omega.sin();
        let alpha = sin_w / (2.0 * safe_q);

        // For shelf and peaking filters
        let a_lin = 10.0_f64.powf(gain_db / 40.0); // sqrt of linear gain
        let two_sqrt_a_alpha = 2.0 * a_lin.sqrt() * alpha;

        let (b0, b1, b2, a0, a1, a2) = match filter_type {
            BiquadType::Lowpass => {
                let b1 = 1.0 - cos_w;
                let b0 = b1 / 2.0;
                let b2 = b0;
                let a0 = 1.0 + alpha;
                let a1 = -2.0 * cos_w;
                let a2 = 1.0 - alpha;
                (b0, b1, b2, a0, a1, a2)
            }
            BiquadType::Highpass => {
                let b1 = -(1.0 + cos_w);
                let b0 = (1.0 + cos_w) / 2.0;
                let b2 = b0;
                let a0 = 1.0 + alpha;
                let a1 = -2.0 * cos_w;
                let a2 = 1.0 - alpha;
                (b0, b1, b2, a0, a1, a2)
            }
            BiquadType::Bandpass => {
                let b0 = alpha;
                let b1 = 0.0;
                let b2 = -alpha;
                let a0 = 1.0 + alpha;
                let a1 = -2.0 * cos_w;
                let a2 = 1.0 - alpha;
                (b0, b1, b2, a0, a1, a2)
            }
            BiquadType::Notch => {
                let b0 = 1.0;
                let b1 = -2.0 * cos_w;
                let b2 = 1.0;
                let a0 = 1.0 + alpha;
                let a1 = -2.0 * cos_w;
                let a2 = 1.0 - alpha;
                (b0, b1, b2, a0, a1, a2)
            }
            BiquadType::LowShelf => {
                let b0 = a_lin * ((a_lin + 1.0) - (a_lin - 1.0) * cos_w + two_sqrt_a_alpha);
                let b1 = 2.0 * a_lin * ((a_lin - 1.0) - (a_lin + 1.0) * cos_w);
                let b2 = a_lin * ((a_lin + 1.0) - (a_lin - 1.0) * cos_w - two_sqrt_a_alpha);
                let a0 = (a_lin + 1.0) + (a_lin - 1.0) * cos_w + two_sqrt_a_alpha;
                let a1 = -2.0 * ((a_lin - 1.0) + (a_lin + 1.0) * cos_w);
                let a2 = (a_lin + 1.0) + (a_lin - 1.0) * cos_w - two_sqrt_a_alpha;
                (b0, b1, b2, a0, a1, a2)
            }
            BiquadType::HighShelf => {
                let b0 = a_lin * ((a_lin + 1.0) + (a_lin - 1.0) * cos_w + two_sqrt_a_alpha);
                let b1 = -2.0 * a_lin * ((a_lin - 1.0) + (a_lin + 1.0) * cos_w);
                let b2 = a_lin * ((a_lin + 1.0) + (a_lin - 1.0) * cos_w - two_sqrt_a_alpha);
                let a0 = (a_lin + 1.0) - (a_lin - 1.0) * cos_w + two_sqrt_a_alpha;
                let a1 = 2.0 * ((a_lin - 1.0) - (a_lin + 1.0) * cos_w);
                let a2 = (a_lin + 1.0) - (a_lin - 1.0) * cos_w - two_sqrt_a_alpha;
                (b0, b1, b2, a0, a1, a2)
            }
            BiquadType::Peaking => {
                let b0 = 1.0 + alpha * a_lin;
                let b1 = -2.0 * cos_w;
                let b2 = 1.0 - alpha * a_lin;
                let a0 = 1.0 + alpha / a_lin;
                let a1 = -2.0 * cos_w;
                let a2 = 1.0 - alpha / a_lin;
                (b0, b1, b2, a0, a1, a2)
            }
            BiquadType::Allpass => {
                let b0 = 1.0 - alpha;
                let b1 = -2.0 * cos_w;
                let b2 = 1.0 + alpha;
                let a0 = 1.0 + alpha;
                let a1 = -2.0 * cos_w;
                let a2 = 1.0 - alpha;
                (b0, b1, b2, a0, a1, a2)
            }
        };

        // Normalize: divide all coefficients by a0
        let inv_a0 = 1.0 / a0;
        Self {
            b0: b0 * inv_a0,
            b1: b1 * inv_a0,
            b2: b2 * inv_a0,
            a1: a1 * inv_a0,
            a2: a2 * inv_a0,
        }
    }

    /// Shorthand for Butterworth lowpass (Q = 1/√2 ≈ 0.7071).
    pub fn lowpass(freq: f64, sample_rate: f64) -> Self {
        Self::new(
            BiquadType::Lowpass,
            freq,
            std::f64::consts::FRAC_1_SQRT_2,
            sample_rate,
            0.0,
        )
    }

    /// Shorthand for Butterworth highpass (Q = 1/√2 ≈ 0.7071).
    pub fn highpass(freq: f64, sample_rate: f64) -> Self {
        Self::new(
            BiquadType::Highpass,
            freq,
            std::f64::consts::FRAC_1_SQRT_2,
            sample_rate,
            0.0,
        )
    }

    /// Shorthand for parametric peaking EQ band.
    pub fn peaking(freq: f64, q: f64, gain_db: f64, sample_rate: f64) -> Self {
        Self::new(BiquadType::Peaking, freq, q, sample_rate, gain_db)
    }
}

// ── Biquad Filter State ────────────────────────────────────────────────────

/// A biquad filter with pre-computed coefficients and per-channel state.
///
/// # Usage
/// ```text
/// let mut filter = BiquadFilter::new(BiquadCoeffs::lowpass(300.0, 44100.0));
/// for sample in buffer.iter_mut() {
///     *sample = filter.process(*sample as f64) as f32;
/// }
/// ```
///
/// # Real-Time Safety
/// - `process()` is O(1): 5 multiplies + 4 adds per sample.
/// - Zero allocations. All state is inline.
#[derive(Debug, Clone)]
pub struct BiquadFilter {
    coeffs: BiquadCoeffs,
    /// Input delay line: x[n-1], x[n-2]
    x1: f64,
    x2: f64,
    /// Output delay line: y[n-1], y[n-2]
    y1: f64,
    y2: f64,
}

impl BiquadFilter {
    /// Creates a new biquad filter with the given coefficients.
    pub fn new(coeffs: BiquadCoeffs) -> Self {
        Self {
            coeffs,
            x1: 0.0,
            x2: 0.0,
            y1: 0.0,
            y2: 0.0,
        }
    }

    /// Creates a Butterworth lowpass filter.
    pub fn lowpass(cutoff: f64, sample_rate: f64) -> Self {
        Self::new(BiquadCoeffs::lowpass(cutoff, sample_rate))
    }

    /// Creates a Butterworth highpass filter.
    pub fn highpass(cutoff: f64, sample_rate: f64) -> Self {
        Self::new(BiquadCoeffs::highpass(cutoff, sample_rate))
    }

    /// Creates a parametric peaking EQ band.
    pub fn peaking(freq: f64, q: f64, gain_db: f64, sample_rate: f64) -> Self {
        Self::new(BiquadCoeffs::peaking(freq, q, gain_db, sample_rate))
    }

    /// Processes a single sample through the filter (Direct Form I).
    ///
    /// # Real-Time Safety
    /// 5 multiplies, 4 additions. Zero allocations.
    #[inline(always)]
    pub fn process(&mut self, x: f64) -> f64 {
        let y = self.coeffs.b0 * x + self.coeffs.b1 * self.x1 + self.coeffs.b2 * self.x2
            - self.coeffs.a1 * self.y1
            - self.coeffs.a2 * self.y2;

        self.x2 = self.x1;
        self.x1 = x;
        self.y2 = self.y1;
        // BUG-85 FIX: Flush denormals in IIR feedback to prevent CPU spikes on x86.
        // BUG-008 FIX: Prevent silent loss of signal on infinity/NaN by isolating
        // the subnormal flush. is_normal() misses infinity. Using absolute value threshold.
        self.y1 = if y.is_finite() {
            if y.abs() < 1e-15 { 0.0 } else { y }
        } else {
            0.0 // flush extreme explosions
        };

        self.y1
    }

    /// Processes a single f32 sample (convenience for audio buffers).
    #[inline(always)]
    pub fn process_f32(&mut self, x: f32) -> f32 {
        self.process(x as f64) as f32
    }

    /// Processes an entire buffer in-place.
    ///
    /// # Real-Time Safety
    /// Zero allocations. Auto-vectorizable loop pattern.
    #[inline]
    pub fn process_buffer(&mut self, buffer: &mut [f32]) {
        for sample in buffer.iter_mut() {
            *sample = self.process_f32(*sample);
        }
    }

    /// Resets the filter state to zero (silence).
    pub fn reset(&mut self) {
        self.x1 = 0.0;
        self.x2 = 0.0;
        self.y1 = 0.0;
        self.y2 = 0.0;
    }

    /// Updates the filter coefficients without resetting state.
    /// Enables smooth parameter transitions during playback.
    pub fn update_coefficients(&mut self, coeffs: BiquadCoeffs) {
        self.coeffs = coeffs;
    }
}

// ── Biquad Cascade (Multi-Band EQ) ─────────────────────────────────────────

/// A cascade of biquad filters, used for multi-band parametric EQ.
///
/// Each band is an independent biquad filter. Samples pass through
/// all bands in series: Band0 → Band1 → ... → BandN.
pub struct BiquadCascade {
    bands: Vec<BiquadFilter>,
}

impl BiquadCascade {
    /// Creates a cascade with the given number of bands, all flat (bypass).
    pub fn new(band_count: usize, sample_rate: f64) -> Self {
        let mut bands = Vec::with_capacity(band_count);
        for _ in 0..band_count {
            // Initialize as unity-gain allpass (effectively bypass)
            bands.push(BiquadFilter::new(BiquadCoeffs::new(
                BiquadType::Peaking,
                1000.0,
                1.0,
                sample_rate,
                0.0,
            )));
        }
        Self { bands }
    }

    /// Updates coefficients for a specific band.
    pub fn set_band(&mut self, index: usize, coeffs: BiquadCoeffs) {
        if let Some(band) = self.bands.get_mut(index) {
            band.update_coefficients(coeffs);
        }
    }

    /// Processes a single sample through all bands in series.
    #[inline(always)]
    pub fn process(&mut self, mut x: f64) -> f64 {
        for band in &mut self.bands {
            x = band.process(x);
        }
        x
    }

    /// Processes a buffer in-place through all bands.
    #[inline]
    pub fn process_buffer(&mut self, buffer: &mut [f32]) {
        for sample in buffer.iter_mut() {
            let mut x = *sample as f64;
            for band in &mut self.bands {
                x = band.process(x);
            }
            *sample = x as f32;
        }
    }

    /// Resets all band states.
    pub fn reset(&mut self) {
        for band in &mut self.bands {
            band.reset();
        }
    }
}

// ═══════════════════════════════════════════════════════════════════════════
// Tests
// ═══════════════════════════════════════════════════════════════════════════

#[cfg(test)]
mod tests {
    use super::*;

    const SR: f64 = 44100.0;

    #[test]
    fn lowpass_attenuates_high_frequency() {
        let mut filter = BiquadFilter::lowpass(300.0, SR);

        // Generate 1kHz sine (above cutoff) and 100Hz sine (below cutoff)
        let mut high: Vec<f32> = (0..4096)
            .map(|i| (2.0 * PI * 1000.0 * i as f64 / SR).sin() as f32)
            .collect();
        let mut low: Vec<f32> = (0..4096)
            .map(|i| (2.0 * PI * 100.0 * i as f64 / SR).sin() as f32)
            .collect();

        filter.process_buffer(&mut high);
        filter.reset();
        filter.process_buffer(&mut low);

        // Measure RMS of last 2048 samples (skip transients)
        let rms_high: f32 = (high[2048..].iter().map(|s| s * s).sum::<f32>() / 2048.0).sqrt();
        let rms_low: f32 = (low[2048..].iter().map(|s| s * s).sum::<f32>() / 2048.0).sqrt();

        // Low signal should pass through relatively unattenuated
        assert!(
            rms_low > 0.3,
            "100Hz should pass lowpass@300Hz, got rms={rms_low}"
        );
        // High signal should be significantly attenuated
        assert!(
            rms_high < 0.15,
            "1kHz should be attenuated by lowpass@300Hz, got rms={rms_high}"
        );
    }

    #[test]
    fn highpass_attenuates_low_frequency() {
        let mut filter = BiquadFilter::highpass(1000.0, SR);

        let mut low: Vec<f32> = (0..4096)
            .map(|i| (2.0 * PI * 100.0 * i as f64 / SR).sin() as f32)
            .collect();
        let mut high: Vec<f32> = (0..4096)
            .map(|i| (2.0 * PI * 5000.0 * i as f64 / SR).sin() as f32)
            .collect();

        filter.process_buffer(&mut low);
        filter.reset();
        filter.process_buffer(&mut high);

        let rms_low: f32 = (low[2048..].iter().map(|s| s * s).sum::<f32>() / 2048.0).sqrt();
        let rms_high: f32 = (high[2048..].iter().map(|s| s * s).sum::<f32>() / 2048.0).sqrt();

        assert!(
            rms_low < 0.2,
            "100Hz should be attenuated by highpass@1kHz, got rms={rms_low}"
        );
        assert!(
            rms_high > 0.3,
            "5kHz should pass highpass@1kHz, got rms={rms_high}"
        );
    }

    #[test]
    fn unity_signal_through_flat_eq() {
        // A peaking filter with 0dB gain should pass through unchanged
        let mut filter = BiquadFilter::peaking(1000.0, 1.0, 0.0, SR);

        let input: Vec<f32> = (0..1024)
            .map(|i| (2.0 * PI * 440.0 * i as f64 / SR).sin() as f32)
            .collect();
        let mut output = input.clone();

        // Skip first 256 samples (transient settling)
        filter.process_buffer(&mut output);

        // After settling, output should match input closely
        let max_diff: f32 = input[256..]
            .iter()
            .zip(output[256..].iter())
            .map(|(a, b)| (a - b).abs())
            .fold(0.0_f32, f32::max);

        assert!(
            max_diff < 0.01,
            "Flat EQ should pass through, max_diff={max_diff}"
        );
    }

    #[test]
    fn reset_clears_state() {
        let mut filter = BiquadFilter::lowpass(1000.0, SR);

        // Process some samples
        for i in 0..100 {
            filter.process((i as f64 * 0.01).sin());
        }

        filter.reset();

        // After reset, processing silence should produce silence
        assert_eq!(filter.process(0.0), 0.0);
        assert_eq!(filter.process(0.0), 0.0);
    }

    #[test]
    fn cascade_processes_all_bands() {
        let mut cascade = BiquadCascade::new(8, SR);

        // Set band 0 to a low shelf boost
        cascade.set_band(
            0,
            BiquadCoeffs::new(BiquadType::LowShelf, 100.0, 0.707, SR, 6.0),
        );

        // Process a buffer — should not crash
        let mut buffer: Vec<f32> = (0..512)
            .map(|i| (2.0 * PI * 440.0 * i as f64 / SR).sin() as f32)
            .collect();
        cascade.process_buffer(&mut buffer);

        // Output should not be silent
        let rms: f32 = (buffer.iter().map(|s| s * s).sum::<f32>() / buffer.len() as f32).sqrt();
        assert!(
            rms > 0.01,
            "Cascade output should not be silent after boost"
        );
    }

    #[test]
    fn coefficients_are_finite() {
        // Edge case: very low frequency
        let c = BiquadCoeffs::lowpass(20.0, SR);
        assert!(c.b0.is_finite());
        assert!(c.a1.is_finite());

        // Edge case: near Nyquist
        let c2 = BiquadCoeffs::highpass(20000.0, SR);
        assert!(c2.b0.is_finite());
        assert!(c2.a2.is_finite());
    }

    #[test]
    fn update_coefficients_preserves_state() {
        let mut filter = BiquadFilter::lowpass(1000.0, SR);

        // Build up some state
        for i in 0..50 {
            filter.process((i as f64 * 0.1).sin());
        }

        // Update to different coefficients
        filter.update_coefficients(BiquadCoeffs::highpass(2000.0, SR));

        // State should still be non-zero (not reset)
        let y = filter.process(0.0);
        assert!(
            y.abs() > 1e-10,
            "State should persist after coefficient update"
        );
    }
}
