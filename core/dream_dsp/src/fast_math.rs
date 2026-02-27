// ═══════════════════════════════════════════════════════════════════════════
// Dream DAW — Fast Math Approximations for DSP
// ═══════════════════════════════════════════════════════════════════════════
//
// Legitimate approximations for transcendental functions on the hot audio path.
// These avoid full polynomial overhead while maintaining acceptable DSP precision.
//
// NOTE: For exp/exp2, use the stdlib `.exp()` / `.exp2()` directly — the compiler
// already emits optimal machine intrinsics for those.

/// Fast Sine approximation using Bhaskara I's sine formula.
/// 
/// Maximum absolute error is ~0.0016, which is incredibly accurate for LFOs
/// and audio range oscillators while avoiding full polynomial overhead.
///
/// `phase` must be in the range [0.0, 1.0), representing a full cycle (0 to 2π).
#[inline(always)]
pub fn fast_sin(phase: f32) -> f32 {
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
/// For |x| > 3, returns ±1 (hard clip).
#[inline(always)]
pub fn fast_tanh(x: f32) -> f32 {
    let abs_x = x.abs();
    if abs_x >= 3.0 {
        return x.signum();
    }
    let x2 = x * x;
    x * (27.0 + x2) / (27.0 + 9.0 * x2)
}

/// Thin wrapper around `f32::exp2()` for API consistency across all DSP fast math.
///
/// The stdlib `exp2` already compiles to an optimal hardware intrinsic on x86/ARM.
/// Kept as a named entry point so DSP code imports everything from one module.
#[inline(always)]
pub fn fast_exp2(x: f32) -> f32 {
    x.exp2()
}

/// Thin wrapper around `e^x` for API consistency.
///
/// Equivalent to `(x * LOG2_E).exp2()`.
#[inline(always)]
pub fn fast_exp(x: f32) -> f32 {
    (x * std::f32::consts::LOG2_E).exp2()
}

