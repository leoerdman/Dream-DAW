// ═══════════════════════════════════════════════════════════════════════════
// Dream DAW — Built-in DSP Processors Module (SSOT)
// ═══════════════════════════════════════════════════════════════════════════
//
// Single Source of Truth for all shared DSP constants, utilities, and macros.
// Every processor imports from here — no duplicated helpers.
//
// ═══════════════════════════════════════════════════════════════════════════

pub(crate) const DEFAULT_SAMPLE_RATE: f32 = 44_100.0;
pub(crate) const MIN_VALID_SAMPLE_RATE: f32 = 1_000.0;
pub(crate) const LN10_OVER_20: f32 = 0.115_129_25;
/// Denormal threshold — values below this magnitude are flushed to zero.
/// Chosen to be well below audible range but above IEEE 754 denormal boundary.
pub(crate) const DENORMAL_THRESHOLD: f32 = 1.0e-20;
/// f64 denormal threshold for analyzer/metering biquads.
pub(crate) const DENORMAL_THRESHOLD_F64: f64 = 1.0e-300;

/// SSOT: Flush a single f32 state variable to zero if it's in the denormal range.
/// Prevents 50-100x CPU slowdown on x86 CPUs during silent/quiet passages.
macro_rules! flush_denormal {
    ($x:expr) => {
        if $x.abs() < $crate::processors::DENORMAL_THRESHOLD {
            $x = 0.0;
        }
    };
}
pub(crate) use flush_denormal;

#[inline]
pub(crate) fn sanitize_sample_rate(sample_rate: f32) -> f32 {
    if sample_rate.is_finite() && sample_rate > MIN_VALID_SAMPLE_RATE {
        sample_rate
    } else {
        DEFAULT_SAMPLE_RATE
    }
}

#[inline]
pub(crate) fn db_to_linear(db: f32) -> f32 {
    (db * LN10_OVER_20).exp()
}

/// SSOT: Bhaskara fast sine approximation for phase in [0, 1).
/// Maps phase [0, 0.5) → positive half, [0.5, 1.0) → negative half.
/// Max error ~0.1% vs std sin. Zero-alloc, no transcendentals.
#[inline(always)]
pub(crate) fn fast_sin_phase(phase: f32) -> f32 {
    let p = phase.fract();
    let (t, sign) = if p < 0.5 {
        (p * 2.0, 1.0f32)
    } else {
        ((p - 0.5) * 2.0, -1.0)
    };
    let t2 = t * (1.0 - t);
    sign * (16.0 * t2) / (5.0 - 4.0 * t2)
}

/// SSOT: Exact one-pole LP coefficient: α = 1 - e^(-2πfc/sr).
/// Clamped to [0, 1] for safety.
#[inline]
pub(crate) fn one_pole_lp_coeff(cutoff_hz: f32, sample_rate: f32) -> f32 {
    (1.0 - (-std::f32::consts::TAU * cutoff_hz / sample_rate).exp()).clamp(0.0, 1.0)
}

/// SSOT: First-order HP coefficient: α = e^(-2πfc/sr).
#[inline]
pub(crate) fn one_pole_hp_coeff(cutoff_hz: f32, sample_rate: f32) -> f32 {
    (-std::f32::consts::TAU * cutoff_hz / sample_rate).exp()
}

/// AUD-228 FIX: SSOT envelope coefficient for attack/release ballistics.
///
/// Used by compressor, limiter, and gate processors for consistent
/// 10dB/τ (−2.2) envelope timing. Equivalent to:
///   `(-2.2 / (time_ms * 0.001 * sample_rate)).exp()`
///
/// # Arguments
/// - `time_ms`: Attack or release time in milliseconds (must be > 0).
/// - `sample_rate`: Audio sample rate in Hz.
///
/// # Returns
/// Per-sample smoothing coefficient in (0, 1).
#[inline]
pub(crate) fn envelope_coeff(time_ms: f32, sample_rate: f32) -> f32 {
    let time_samples = time_ms * 0.001 * sample_rate;
    if time_samples > 0.0 {
        (-2.2 / time_samples).exp()
    } else {
        0.0 // instant attack/release
    }
}

pub mod chorus;
pub mod compressor;
pub mod delay;
pub mod eq;
pub mod reverb;
pub mod saturator;
pub mod smoothing;
pub mod utility;
// Wave 1 — Essential Effects
pub mod analyzer;
pub mod auto_filter;
pub mod auto_pan;
pub mod bitcrusher;
pub mod distortion;
pub mod flanger;
pub mod gate;
pub mod limiter;
pub mod noise_machine;
pub mod phaser;
