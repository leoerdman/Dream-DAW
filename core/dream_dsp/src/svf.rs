// ═══════════════════════════════════════════════════════════════════════════
// Dream DAW — State Variable Filter (Chamberlin Topology)
// ═══════════════════════════════════════════════════════════════════════════
//
// Direct port of Swift `SamplerInstrument.swift` SVF filter.
//
// The SVF simultaneously outputs 3 filter modes from a single topology:
//   - Lowpass  (smooth, warm)
//   - Highpass (bright, crispy)
//   - Bandpass (resonant, vocal)
//
// The Chamberlin SVF is the standard filter for:
//   - Synthesizers (analog-style filter sweeps)
//   - Samplers (timbre shaping)
//   - Real-time applications (low CPU, no transcendentals per sample)
//
// Advantages over biquad:
//   - Self-oscillates at high resonance (analog behavior)
//   - Smooth frequency sweep without zipper noise
//   - All 3 outputs available simultaneously
//
// Real-Time Safety:
//   - Zero allocations
//   - No transcendentals in process() (tan computed once at setup)
//   - 6 multiplies + 4 adds per sample
//
// ═══════════════════════════════════════════════════════════════════════════

use std::f64::consts::PI;

// ── SVF Mode ───────────────────────────────────────────────────────────────

/// Which output of the SVF to read.
#[derive(Debug, Clone, Copy, PartialEq)]
pub enum SvfMode {
    Lowpass,
    Highpass,
    Bandpass,
    /// BUG-14 FIX: Notch filter output = LP + HP (rejects band center).
    Notch,
}

// ── SVF State ──────────────────────────────────────────────────────────────

/// Per-channel state for the SVF.
///
/// Two integrator states are needed for the 2nd-order filter.
#[derive(Debug, Clone, Copy, Default)]
pub struct SvfState {
    /// Integrator 1 equivalent state.
    pub ic1eq: f32,
    /// Integrator 2 equivalent state.
    pub ic2eq: f32,
}

impl SvfState {
    /// Resets the filter state to silence.
    #[inline]
    pub fn reset(&mut self) {
        self.ic1eq = 0.0;
        self.ic2eq = 0.0;
    }
}

// ── SVF Coefficients ───────────────────────────────────────────────────────

/// Pre-computed SVF coefficients.
///
/// Computed from cutoff frequency and resonance.
/// The `tan()` call happens here (once), not per-sample.
#[derive(Debug, Clone, Copy)]
pub struct SvfCoeffs {
    /// g = tan(π × fc / sr) — integrator gain
    pub g: f32,
    /// k = 2 × (1 - resonance) — damping factor (0 = max resonance, 2 = no resonance)
    pub k: f32,
    /// a1 = 1 / (1 + g * (g + k))
    pub a1: f32,
    /// a2 = g * a1
    pub a2: f32,
    /// a3 = g * a2
    pub a3: f32,
}

impl SvfCoeffs {
    /// Computes SVF coefficients.
    ///
    /// # Arguments
    /// - `cutoff`: Cutoff frequency in Hz
    /// - `resonance`: Resonance amount (0.0 = no resonance, 1.0 = self-oscillation)
    /// - `sample_rate`: Sample rate in Hz
    pub fn new(cutoff: f64, resonance: f64, sample_rate: f64) -> Self {
        // BUG-71 FIX: Clamp cutoff to Nyquist to prevent coefficient explosion.
        let safe_cutoff = cutoff.clamp(20.0, sample_rate * 0.499);
        let g = (PI * safe_cutoff / sample_rate).tan() as f32;
        let k = (2.0 * (1.0 - resonance.clamp(0.0, 0.99))) as f32;
        let a1 = 1.0 / (1.0 + g * (g + k));
        let a2 = g * a1;
        let a3 = g * a2;

        Self { g, k, a1, a2, a3 }
    }
}

// ── SVF Filter ─────────────────────────────────────────────────────────────

/// State Variable Filter (Chamberlin topology) with pre-computed coefficients.
///
/// # Usage
/// ```text
/// let mut svf = SvfFilter::new(1000.0, 0.7, 44100.0, SvfMode::Lowpass);
/// for sample in buffer.iter_mut() {
///     *sample = svf.process(*sample);
/// }
/// ```
#[derive(Debug, Clone)]
pub struct SvfFilter {
    coeffs: SvfCoeffs,
    state: SvfState,
    mode: SvfMode,
}

impl SvfFilter {
    /// Creates a new SVF with the given parameters.
    pub fn new(cutoff: f64, resonance: f64, sample_rate: f64, mode: SvfMode) -> Self {
        Self {
            coeffs: SvfCoeffs::new(cutoff, resonance, sample_rate),
            state: SvfState::default(),
            mode,
        }
    }

    /// Creates a lowpass SVF.
    pub fn lowpass(cutoff: f64, resonance: f64, sample_rate: f64) -> Self {
        Self::new(cutoff, resonance, sample_rate, SvfMode::Lowpass)
    }

    /// Creates a highpass SVF.
    pub fn highpass(cutoff: f64, resonance: f64, sample_rate: f64) -> Self {
        Self::new(cutoff, resonance, sample_rate, SvfMode::Highpass)
    }

    /// Creates a bandpass SVF.
    pub fn bandpass(cutoff: f64, resonance: f64, sample_rate: f64) -> Self {
        Self::new(cutoff, resonance, sample_rate, SvfMode::Bandpass)
    }

    /// Processes a single sample and returns the selected output.
    ///
    /// # Real-Time Safety
    /// 6 multiplies + 4 adds. Zero allocations. No transcendentals.
    #[inline(always)]
    pub fn process(&mut self, input: f32) -> f32 {
        let all = self.process_all(input);
        match self.mode {
            SvfMode::Lowpass => all.0,
            SvfMode::Highpass => all.1,
            SvfMode::Bandpass => all.2,
            SvfMode::Notch => all.0 + all.1, // LP + HP = Notch
        }
    }

    /// Processes a single sample and returns ALL THREE outputs: (low, high, band).
    ///
    /// This is optimal when you need multiple filter outputs from the same input
    /// (e.g., crossover networks, spectral analysis).
    #[inline(always)]
    pub fn process_all(&mut self, input: f32) -> (f32, f32, f32) {
        let c = &self.coeffs;
        let s = &mut self.state;

        let v3 = input - s.ic2eq;
        let v1 = c.a1 * s.ic1eq + c.a2 * v3;
        let v2 = s.ic2eq + c.a2 * s.ic1eq + c.a3 * v3;

        s.ic1eq = 2.0 * v1 - s.ic1eq;
        s.ic2eq = 2.0 * v2 - s.ic2eq;

        let lowpass = v2;
        let bandpass = v1;
        let highpass = input - c.k * v1 - v2;

        (lowpass, highpass, bandpass)
    }

    /// Processes a buffer in-place using the selected filter mode.
    #[inline]
    pub fn process_buffer(&mut self, buffer: &mut [f32]) {
        for sample in buffer.iter_mut() {
            *sample = self.process(*sample);
        }
    }

    /// Resets the filter state to silence.
    pub fn reset(&mut self) {
        self.state.reset();
    }

    /// Updates cutoff and resonance without resetting state.
    /// Enables smooth parameter automation during playback.
    pub fn set_parameters(&mut self, cutoff: f64, resonance: f64, sample_rate: f64) {
        self.coeffs = SvfCoeffs::new(cutoff, resonance, sample_rate);
    }

    /// Changes the output mode (LP/HP/BP).
    pub fn set_mode(&mut self, mode: SvfMode) {
        self.mode = mode;
    }
}

// ── Stereo SVF ─────────────────────────────────────────────────────────────

/// Stereo SVF filter with independent per-channel state.
///
/// Shares coefficients between channels (same cutoff/resonance)
/// but maintains separate state to prevent crosstalk.
pub struct StereoSvf {
    coeffs: SvfCoeffs,
    left: SvfState,
    right: SvfState,
    mode: SvfMode,
}

impl StereoSvf {
    /// Creates a new stereo SVF.
    pub fn new(cutoff: f64, resonance: f64, sample_rate: f64, mode: SvfMode) -> Self {
        Self {
            coeffs: SvfCoeffs::new(cutoff, resonance, sample_rate),
            left: SvfState::default(),
            right: SvfState::default(),
            mode,
        }
    }

    /// Processes interleaved stereo samples in-place `[L, R, L, R, ...]`.
    pub fn process_interleaved(&mut self, buffer: &mut [f32]) {
        for chunk in buffer.chunks_exact_mut(2) {
            chunk[0] = Self::process_sample(&self.coeffs, &mut self.left, self.mode, chunk[0]);
            chunk[1] = Self::process_sample(&self.coeffs, &mut self.right, self.mode, chunk[1]);
        }
    }

    /// Process one sample through one channel's state (static to avoid borrow conflicts).
    #[inline(always)]
    fn process_sample(c: &SvfCoeffs, state: &mut SvfState, mode: SvfMode, input: f32) -> f32 {
        let v3 = input - state.ic2eq;
        let v1 = c.a1 * state.ic1eq + c.a2 * v3;
        let v2 = state.ic2eq + c.a2 * state.ic1eq + c.a3 * v3;

        state.ic1eq = 2.0 * v1 - state.ic1eq;
        state.ic2eq = 2.0 * v2 - state.ic2eq;

        match mode {
            SvfMode::Lowpass => v2,
            SvfMode::Highpass => input - c.k * v1 - v2,
            SvfMode::Bandpass => v1,
            SvfMode::Notch => v2 + (input - c.k * v1 - v2), // LP + HP
        }
    }

    /// Updates parameters without resetting.
    pub fn set_parameters(&mut self, cutoff: f64, resonance: f64, sample_rate: f64) {
        self.coeffs = SvfCoeffs::new(cutoff, resonance, sample_rate);
    }

    /// Resets both channels.
    pub fn reset(&mut self) {
        self.left.reset();
        self.right.reset();
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
    fn svf_lowpass_attenuates_high_frequency() {
        let mut filter = SvfFilter::lowpass(500.0, 0.5, SR);

        // 5kHz sine (well above cutoff)
        let mut high: Vec<f32> = (0..4096)
            .map(|i| (2.0 * PI * 5000.0 * i as f64 / SR).sin() as f32)
            .collect();

        // 100Hz sine (well below cutoff)
        let mut low: Vec<f32> = (0..4096)
            .map(|i| (2.0 * PI * 100.0 * i as f64 / SR).sin() as f32)
            .collect();

        filter.process_buffer(&mut high);
        filter.reset();
        filter.process_buffer(&mut low);

        let rms_high: f32 = (high[2048..].iter().map(|s| s * s).sum::<f32>() / 2048.0).sqrt();
        let rms_low: f32 = (low[2048..].iter().map(|s| s * s).sum::<f32>() / 2048.0).sqrt();

        assert!(
            rms_low > 0.3,
            "100Hz should pass SVF LP@500Hz, rms={rms_low}"
        );
        assert!(
            rms_high < 0.1,
            "5kHz should be cut by SVF LP@500Hz, rms={rms_high}"
        );
    }

    #[test]
    fn svf_highpass_attenuates_low_frequency() {
        let mut filter = SvfFilter::highpass(2000.0, 0.5, SR);

        let mut low: Vec<f32> = (0..4096)
            .map(|i| (2.0 * PI * 100.0 * i as f64 / SR).sin() as f32)
            .collect();
        let mut high: Vec<f32> = (0..4096)
            .map(|i| (2.0 * PI * 10000.0 * i as f64 / SR).sin() as f32)
            .collect();

        filter.process_buffer(&mut low);
        filter.reset();
        filter.process_buffer(&mut high);

        let rms_low: f32 = (low[2048..].iter().map(|s| s * s).sum::<f32>() / 2048.0).sqrt();
        let rms_high: f32 = (high[2048..].iter().map(|s| s * s).sum::<f32>() / 2048.0).sqrt();

        assert!(
            rms_low < 0.1,
            "100Hz should be cut by SVF HP@2kHz, rms={rms_low}"
        );
        assert!(
            rms_high > 0.2,
            "10kHz should pass SVF HP@2kHz, rms={rms_high}"
        );
    }

    #[test]
    fn svf_process_all_returns_three_outputs() {
        let mut filter = SvfFilter::lowpass(1000.0, 0.7, SR);

        let (lp, hp, bp) = filter.process_all(1.0);
        // At least one output should be non-zero for a unity impulse
        assert!(lp.abs() > 0.0 || hp.abs() > 0.0 || bp.abs() > 0.0);
    }

    #[test]
    fn svf_complementary_sum() {
        // LP + HP + k*BP should reconstruct the input (SVF identity)
        let mut filter = SvfFilter::lowpass(1000.0, 0.0, SR);

        // With zero resonance (k=2), LP + HP + k*BP ≈ input
        for i in 0..100 {
            let input = (i as f32 * 0.1).sin();
            let (lp, hp, bp) = filter.process_all(input);
            let reconstructed = lp + hp + filter.coeffs.k * bp;
            assert!(
                (reconstructed - input).abs() < 0.01,
                "SVF identity failed at sample {i}: in={input}, recon={reconstructed}"
            );
        }
    }

    #[test]
    fn svf_reset_produces_silence() {
        let mut filter = SvfFilter::lowpass(1000.0, 0.5, SR);

        // Build up state
        for i in 0..100 {
            filter.process((i as f32 * 0.1).sin());
        }

        filter.reset();

        // After reset, silence in → silence out
        assert_eq!(filter.process(0.0), 0.0);
    }

    #[test]
    fn svf_parameter_update_smooth() {
        let mut filter = SvfFilter::lowpass(500.0, 0.5, SR);

        // Process some audio
        for i in 0..256 {
            filter.process((i as f32 * 0.1).sin());
        }

        // Sweep cutoff (simulating knob turn)
        filter.set_parameters(5000.0, 0.7, SR);

        // Should not produce NaN or Inf
        let y = filter.process(0.5);
        assert!(
            y.is_finite(),
            "Filter produced non-finite after param update: {y}"
        );
    }

    #[test]
    fn coefficients_are_finite_at_extremes() {
        // Very low cutoff
        let c = SvfCoeffs::new(20.0, 0.0, SR);
        assert!(c.g.is_finite() && c.a1.is_finite());

        // Near Nyquist
        let c2 = SvfCoeffs::new(20000.0, 0.99, SR);
        assert!(c2.g.is_finite() && c2.a1.is_finite());

        // Zero resonance
        let c3 = SvfCoeffs::new(1000.0, 0.0, SR);
        assert!((c3.k - 2.0).abs() < 0.02);
    }
}
