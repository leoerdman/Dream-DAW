// ═══════════════════════════════════════════════════════════════════════════
// Dream DAW — Fast Math Approximations for DSP
// ═══════════════════════════════════════════════════════════════════════════
//
// These functions provide enterprise-grade, lock-free, zero-allocation
// approximations for transcendental functions on the hot audio path.
// They prioritize speed (cycle counts) while maintaining acceptable
// precision for audio DSP.

/// Fast Sine approximation using Bhaskara I's sine formula.
/// 
/// Maximum absolute error is ~0.0016, which is incredibly accurate for LFOs
/// and audio range oscillators while avoiding full polynomial overhead.
///
/// `phase` must be in the range [0.0, 1.0), representing a full cycle (0 to 2π).
#[inline(always)]
pub fn fast_sin(phase: f32) -> f32 {
    // Wrap to [0.0, 1.0] if necessary, but usually the caller maintains this.
    let p = phase - phase.floor();
    let (t, sign) = if p < 0.5 {
        (p * 2.0, 1.0)
    } else {
        ((p - 0.5) * 2.0, -1.0)
    };
    let t2 = t * (1.0 - t);
    sign * (16.0 * t2) / (5.0 - 4.0 * t2)
}

/// Fast Tanh approximation for distortion/saturation.
///
/// Uses Padé approximant `x * (27 + x^2) / (27 + 9x^2)` for x in [-3, 3].
/// For |x| > 3, we simply hardclip or clamp.
#[inline(always)]
pub fn fast_tanh(x: f32) -> f32 {
    let abs_x = x.abs();
    if abs_x >= 3.0 {
        return x.signum();
    }
    let x2 = x * x;
    x * (27.0 + x2) / (27.0 + 9.0 * x2)
}

/// Replaces `2.0_f32.powf(x)` with Native `exp2(x)`,
/// which typically compiles to a highly optimized intrinsic.
#[inline(always)]
pub fn fast_exp2(x: f32) -> f32 {
    x.exp2()
}

/// Approximate Exponential (e^x) for very fast envelope decay calculations.
///
/// Useful where high precision is not required (e.g. envelope followers).
/// Based on a floating-point bit-hack.
#[inline(always)]
pub fn fast_exp(x: f32) -> f32 {
    // 2^(x / ln(2)) -> compute exp2(x * 1.442695)
    (x * std::f32::consts::LOG2_E).exp2()
}
