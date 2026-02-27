use crate::synth_types::Waveform;

// ── PolyBLEP Anti-Aliased Oscillators ──────────────────────────────────
//
// PolyBLEP (Polynomial Band-Limited Step) corrects waveform discontinuities
// by subtracting a 2nd-order polynomial residual near each transition point.
// This dramatically reduces aliasing for Saw, Square, and Triangle waveforms
// with negligible CPU overhead (~2 extra multiplies per sample).
//
// Reference: Välimäki & Franck, "Polynomial Transition Regions" (2012)

/// PolyBLEP residual — corrects the aliasing at waveform discontinuities.
///
/// `t` = distance from the discontinuity in phase units (0..1).
/// `dt` = phase increment per sample (normalized frequency).
///
/// Returns the correction value to subtract from the naive waveform.

#[inline]
fn poly_blep(t: f64, dt: f64) -> f64 {
    if dt <= 0.0 {
        return 0.0;
    }
    if t < dt {
        // t is just past the discontinuity (0..dt)
        let x = t / dt;
        // 2x - x² - 1
        2.0 * x - x * x - 1.0
    } else if t > 1.0 - dt {
        // t is just before the discontinuity ((1-dt)..1)
        let x = (t - 1.0) / dt;
        // x² + 2x + 1
        x * x + 2.0 * x + 1.0
    } else {
        0.0
    }
}

/// PolyBLEP-corrected oscillator sample with variable pulse width.
///
/// - **Sine**: Already band-limited, no correction needed.
/// - **Saw**: Naive saw minus PolyBLEP at the wrap discontinuity.
/// - **Square**: Variable duty cycle (pulse_width), PolyBLEP at both transitions.
/// - **Triangle**: Leaky-integrated PolyBLEP square (produces band-limited triangle).
#[inline]
pub(super) fn oscillator_sample_blep(
    waveform: Waveform,
    phase: f64,
    dt: f64,
    tri_state: &mut f64,
    pulse_width: f64,
) -> f32 {
    // BUG-020 FIX: When dt > 0.5 (frequency > Nyquist/2), PolyBLEP
    // corrections become invalid and produce aliasing artifacts.
    // Return silence for super-Nyquist frequencies.
    if dt >= 0.5 || dt <= 0.0 {
        return 0.0;
    }
    let p = phase.fract().max(0.0);
    match waveform {
        Waveform::Sine => (p * std::f64::consts::TAU).sin() as f32,
        Waveform::Saw => {
            let naive = 2.0 * p - 1.0;
            let corrected = naive - poly_blep(p, dt);
            corrected as f32
        }
        Waveform::Square => {
            let pw = pulse_width.clamp(0.05, 0.95);
            let naive: f64 = if p < pw { 1.0 } else { -1.0 };
            let blep_rise = poly_blep(p, dt);
            let blep_fall = poly_blep((p - pw + 1.0) % 1.0, dt);
            let corrected = naive + blep_rise - blep_fall;
            corrected as f32
        }
        Waveform::Triangle => {
            let naive_sq: f64 = if p < 0.5 { 1.0 } else { -1.0 };
            let blep1 = poly_blep(p, dt);
            let blep2 = poly_blep((p + 0.5) % 1.0, dt);
            let sq = naive_sq + blep1 - blep2;
            // BUG-021 FIX: Leak coefficient was hardcoded at 0.999 which is
            // sample-rate-dependent. At 96kHz it leaks too fast (DC offset),
            // at 22kHz too slow (bandwidth loss). Use `1.0 - 4*dt` for
            // rate-independent leaky integration. `dt` = freq/sr is already
            // normalized, so this adapts automatically.
            let leak = (1.0 - 4.0 * dt).clamp(0.99, 0.9999);
            *tri_state = leak * *tri_state + 4.0 * dt * sq;
            (*tri_state).clamp(-1.0, 1.0) as f32
        }
    }
}

/// Fallback for contexts where we don't track per-osc triangle state
/// (e.g. sub oscillator which is always square).
#[allow(dead_code)]
#[inline]
pub(super) fn oscillator_sample_blep_stateless(waveform: Waveform, phase: f64, dt: f64) -> f32 {
    let mut dummy = 0.0;
    oscillator_sample_blep(waveform, phase, dt, &mut dummy, 0.5)
}

// ── Parameter Smoothing ────────────────────────────────────────────────

/// A single-pole IIR lowpass filter for smoothing parameter changes
/// (e.g., volume, cutoff, resonance) to prevent audible zipper noise.
#[derive(Debug, Clone)]
pub struct ParameterSmoother {
    value: f32,
    target: f32,
    a: f32,
    b: f32,
}

impl ParameterSmoother {
    pub fn new(initial: f32, sample_rate: f64, time_constant_ms: f32) -> Self {
        let mut s = Self {
            value: initial,
            target: initial,
            a: 0.0,
            b: 0.0,
        };
        s.set_time_constant(sample_rate, time_constant_ms);
        s
    }

    pub fn set_time_constant(&mut self, sample_rate: f64, time_constant_ms: f32) {
        // BUG-C003 FIX: Guard against division by zero when sample_rate or
        // time_constant_ms is 0. powf(-1.0 / 0.0) produces NaN which
        // propagates through the entire smoother chain, corrupting output.
        let time_samples = time_constant_ms * 0.001 * sample_rate as f32;
        if time_samples > 0.0 {
            self.a = 1.0 - std::f32::consts::E.powf(-1.0 / time_samples);
            self.b = 1.0 - self.a;
        } else {
            // Instant smoothing: next() returns target immediately.
            self.a = 1.0;
            self.b = 0.0;
        }
    }

    #[inline]
    pub fn set_target(&mut self, target: f32) {
        self.target = target;
    }

    #[inline]
    pub fn next(&mut self) -> f32 {
        self.value = self.target * self.a + self.value * self.b;
        self.value
    }
    
    #[inline]
    pub fn get(&self) -> f32 {
        self.value
    }

    #[inline]
    pub fn snap(&mut self) {
        self.value = self.target;
    }
}

/// A single-pole IIR lowpass filter for smoothing high-precision parameter
/// changes (e.g., phase increment, pitch) to prevent audible zipper noise.
/// BUG-081 FIX: Removed `#[allow(dead_code)]` — this type IS used by
/// EssenceSynthEngine for high-precision pitch smoothing. Suppressing the
/// warning hid legitimate unused code detection in other modules.
#[derive(Debug, Clone)]
pub struct ParameterSmootherF64 {
    value: f64,
    target: f64,
    a: f64,
    b: f64,
}

#[allow(dead_code)]
impl ParameterSmootherF64 {
    pub fn new(initial: f64, sample_rate: f64, time_constant_ms: f64) -> Self {
        let mut s = Self {
            value: initial,
            target: initial,
            a: 0.0,
            b: 0.0,
        };
        s.set_time_constant(sample_rate, time_constant_ms);
        s
    }

    pub fn set_time_constant(&mut self, sample_rate: f64, time_constant_ms: f64) {
        // BUG-001 FIX: Guard against division by zero when sample_rate or
        // time_constant_ms is 0. powf(-1.0 / 0.0) produces NaN which
        // propagates through the entire smoother chain, corrupting output.
        // Mirrors the identical guard in ParameterSmoother (f32 version).
        let time_samples = time_constant_ms * 0.001 * sample_rate;
        if time_samples > 0.0 {
            self.a = 1.0 - std::f64::consts::E.powf(-1.0 / time_samples);
            self.b = 1.0 - self.a;
        } else {
            // Instant smoothing: next() returns target immediately.
            self.a = 1.0;
            self.b = 0.0;
        }
    }

    #[inline]
    pub fn set_target(&mut self, target: f64) {
        self.target = target;
    }

    #[inline]
    pub fn next(&mut self) -> f64 {
        self.value = self.target * self.a + self.value * self.b;
        self.value
    }

    #[inline]
    pub fn get(&self) -> f64 {
        self.value
    }

    #[inline]
    pub fn snap(&mut self) {
        self.value = self.target;
    }
}
