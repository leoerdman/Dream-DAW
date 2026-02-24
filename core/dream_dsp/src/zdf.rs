// ═══════════════════════════════════════════════════════════════════════════
// Dream DAW — Zero-Delay Feedback (TPT) Filters
// ═══════════════════════════════════════════════════════════════════════════
//
// Enterprise DSP primitive for modulation-safe filter processing.
// Topology-preserving transform (TPT) state-variable filter:
//   - no coefficient zipper artifacts when modulating cutoff
//   - numerically stable near Nyquist (with safe clamping)
//   - no heap allocations on audio path
//
// ═══════════════════════════════════════════════════════════════════════════

use std::f32::consts::PI;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ZdfMode {
    Lowpass,
    Highpass,
    Bandpass,
    Notch,
}

#[derive(Debug, Clone, Copy)]
pub struct ZdfSvf {
    sample_rate: f32,
    cutoff_hz: f32,
    resonance: f32,
    mode: ZdfMode,
    // TPT internals
    g: f32,
    k: f32,
    a1: f32,
    a2: f32,
    a3: f32,
    ic1eq: f32,
    ic2eq: f32,
}

impl ZdfSvf {
    pub fn new(sample_rate: f32, cutoff_hz: f32, resonance: f32, mode: ZdfMode) -> Self {
        let sample_rate = sample_rate.clamp(1000.0, 384000.0);
        let mut s = Self {
            sample_rate,
            cutoff_hz: 1000.0,
            resonance: 0.25,
            mode,
            g: 0.0,
            k: 0.0,
            a1: 0.0,
            a2: 0.0,
            a3: 0.0,
            ic1eq: 0.0,
            ic2eq: 0.0,
        };
        s.set_params(cutoff_hz, resonance);
        s
    }

    #[inline]
    pub fn set_sample_rate(&mut self, sample_rate: f32) {
        let sr = sample_rate.clamp(1000.0, 384000.0);
        if (sr - self.sample_rate).abs() > 0.5 {
            self.sample_rate = sr;
            self.recompute_coeffs();
        }
    }

    #[inline]
    pub fn set_mode(&mut self, mode: ZdfMode) {
        self.mode = mode;
    }

    #[inline]
    pub fn set_params(&mut self, cutoff_hz: f32, resonance: f32) {
        // Safe range: 20Hz..0.49*Nyquist to keep tan() bounded.
        self.cutoff_hz = cutoff_hz.clamp(20.0, self.sample_rate * 0.49);
        // 0.0..0.999 to avoid singularities at exact self-oscillation.
        self.resonance = resonance.clamp(0.0, 0.999);
        self.recompute_coeffs();
    }

    #[inline]
    fn recompute_coeffs(&mut self) {
        self.g = (PI * self.cutoff_hz / self.sample_rate).tan();
        // k=2*(1-res) maps 0..1 -> 2..0, classic SVF damping mapping.
        self.k = 2.0 * (1.0 - self.resonance);
        self.a1 = 1.0 / (1.0 + self.g * (self.g + self.k));
        self.a2 = self.g * self.a1;
        self.a3 = self.g * self.a2;
    }

    #[inline(always)]
    pub fn process(&mut self, x: f32) -> f32 {
        let v3 = x - self.ic2eq;
        let v1 = self.a1 * self.ic1eq + self.a2 * v3;
        let v2 = self.ic2eq + self.a2 * self.ic1eq + self.a3 * v3;
        self.ic1eq = 2.0 * v1 - self.ic1eq;
        self.ic2eq = 2.0 * v2 - self.ic2eq;

        // Denormal guard
        if self.ic1eq.abs() < 1.0e-20 {
            self.ic1eq = 0.0;
        }
        if self.ic2eq.abs() < 1.0e-20 {
            self.ic2eq = 0.0;
        }

        let lp = v2;
        let bp = v1;
        let hp = x - self.k * v1 - v2;
        match self.mode {
            ZdfMode::Lowpass => lp,
            ZdfMode::Highpass => hp,
            ZdfMode::Bandpass => bp,
            ZdfMode::Notch => lp + hp,
        }
    }

    #[inline]
    pub fn reset(&mut self) {
        self.ic1eq = 0.0;
        self.ic2eq = 0.0;
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn zdf_coeffs_are_finite_at_extremes() {
        let mut f = ZdfSvf::new(44100.0, 20.0, 0.0, ZdfMode::Lowpass);
        f.set_params(20000.0, 0.999);
        assert!(f.g.is_finite());
        assert!(f.a1.is_finite());
        assert!(f.a2.is_finite());
        assert!(f.a3.is_finite());
    }

    #[test]
    fn zdf_lowpass_attenuates_high_frequency() {
        let mut f = ZdfSvf::new(44100.0, 300.0, 0.2, ZdfMode::Lowpass);
        let mut out_energy = 0.0f32;
        for i in 0..4096 {
            let x = (2.0 * PI * 8000.0 * i as f32 / 44100.0).sin();
            let y = f.process(x);
            if i > 1024 {
                out_energy += y * y;
            }
        }
        assert!(
            out_energy < 200.0,
            "LP should attenuate HF, got {out_energy}"
        );
    }

    #[test]
    fn zdf_modulation_stays_finite() {
        let mut f = ZdfSvf::new(44100.0, 1000.0, 0.6, ZdfMode::Bandpass);
        for i in 0..8192 {
            let m = (2.0 * PI * 5.0 * i as f32 / 44100.0).sin();
            let cutoff = 200.0 * 2.0f32.powf((m + 1.0) * 4.0); // ~200..6400
            f.set_params(cutoff, 0.7);
            let x = (2.0 * PI * 440.0 * i as f32 / 44100.0).sin() * 0.7;
            let y = f.process(x);
            assert!(y.is_finite(), "output is non-finite at sample {i}");
        }
    }
}
