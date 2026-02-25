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
            *tri_state = 0.999 * *tri_state + 4.0 * dt * sq;
            (*tri_state).clamp(-1.0, 1.0) as f32
        }
    }
}

/// Fallback for contexts where we don't track per-osc triangle state
/// (e.g. sub oscillator which is always square).
#[inline]
pub(super) fn oscillator_sample_blep_stateless(waveform: Waveform, phase: f64, dt: f64) -> f32 {
    let mut dummy = 0.0;
    oscillator_sample_blep(waveform, phase, dt, &mut dummy, 0.5)
}
