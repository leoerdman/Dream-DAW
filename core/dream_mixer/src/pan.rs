// ═══════════════════════════════════════════════════════════════════════════
// Dream DAW — Stereo Panning
// ═══════════════════════════════════════════════════════════════════════════
//
// Implements constant-power pan law for stereo positioning.
//
// Pan law ensures that a center-panned signal has the same
// perceived loudness as a hard-panned signal. Without this,
// center panning sounds ~3dB louder.
//
// ═══════════════════════════════════════════════════════════════════════════

/// Pan law implementation.
///
/// Constant-power (equal-power) pan law is the industry standard
/// for professional DAWs. Uses sin/cos curves for smooth transitions.
#[derive(Debug, Clone, Copy, Default)]
pub enum PanLaw {
    /// Constant power (-3dB center). Industry standard.
    /// Center = -3dB per channel, hard pan = 0dB.
    #[default]
    ConstantPower,

    /// Linear (-6dB center). Simpler but less perceptually accurate.
    /// Center = -6dB per channel, hard pan = 0dB.
    Linear,
}

/// Left/right gain coefficients from a pan position.
#[derive(Debug, Clone, Copy)]
pub struct PanGains {
    pub left: f32,
    pub right: f32,
}

impl PanLaw {
    /// Computes left/right gains for a pan position.
    ///
    /// # Arguments
    /// - `pan`: -1.0 (hard left) to 1.0 (hard right), 0.0 = center.
    #[inline]
    pub fn gains(&self, pan: f32) -> PanGains {
        let pan = pan.clamp(-1.0, 1.0);

        match self {
            Self::ConstantPower => {
                // Map pan [-1, 1] → angle [0, π/2]
                let angle = (pan + 1.0) * 0.5 * std::f32::consts::FRAC_PI_2;
                PanGains {
                    left: angle.cos(),
                    right: angle.sin(),
                }
            }
            Self::Linear => PanGains {
                left: (1.0 - pan) * 0.5,
                right: (1.0 + pan) * 0.5,
            },
        }
    }
}

/// Applies panning to a stereo buffer pair in-place.
///
/// # Arguments
/// - `left`: Left channel buffer (modified in-place).
/// - `right`: Right channel buffer (modified in-place).
/// - `pan`: Pan position (-1.0 = hard left, 0.0 = center, 1.0 = hard right).
/// - `law`: Pan law to use.
///
/// # Real-Time Safety
/// Real-time safe — no allocations, bounded iteration.
#[inline]
pub fn apply_pan(left: &mut [f32], right: &mut [f32], pan: f32, law: PanLaw) {
    let gains = law.gains(pan);

    // Fast path: center panning (constant power center is ~0.707)
    for (l, r) in left.iter_mut().zip(right.iter_mut()) {
        *l *= gains.left;
        *r *= gains.right;
    }
}

/// Applies panning with per-sample smoothing for click-free pan changes.
///
/// BUG-011 FIX: Computes target gains ONCE and interpolates gain coefficients
/// linearly instead of calling cos/sin trig per sample (~80 cycles saved per sample).
///
/// # Real-Time Safety
/// Real-time safe — no allocations, bounded iteration, no trig in inner loop.
#[inline]
pub fn apply_pan_smoothed(
    left: &mut [f32],
    right: &mut [f32],
    target_pan: f32,
    current_pan: &mut f32,
    smoothing_coeff: f32,
    law: PanLaw,
) {
    // Pre-compute target gains (trig done ONCE, not per-sample)
    let target_gains = law.gains(target_pan);
    let start_gains = law.gains(*current_pan);
    let mut gl = start_gains.left;
    let mut gr = start_gains.right;

    for (l, r) in left.iter_mut().zip(right.iter_mut()) {
        // Smooth the gain coefficients directly (no trig)
        gl += (target_gains.left - gl) * smoothing_coeff;
        gr += (target_gains.right - gr) * smoothing_coeff;
        *l *= gl;
        *r *= gr;
    }

    // Update current_pan to match the smoothed position
    *current_pan += (target_pan - *current_pan) * (1.0 - (1.0 - smoothing_coeff).powi(left.len() as i32));
}

// ═══════════════════════════════════════════════════════════════════════════
// Tests
// ═══════════════════════════════════════════════════════════════════════════

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn constant_power_center_is_minus_3db() {
        let gains = PanLaw::ConstantPower.gains(0.0);
        // At center, both channels should be ~0.707 (-3dB)
        assert!((gains.left - 0.707).abs() < 0.01);
        assert!((gains.right - 0.707).abs() < 0.01);
    }

    #[test]
    fn constant_power_hard_left() {
        let gains = PanLaw::ConstantPower.gains(-1.0);
        assert!((gains.left - 1.0).abs() < 0.01);
        assert!(gains.right.abs() < 0.01);
    }

    #[test]
    fn constant_power_hard_right() {
        let gains = PanLaw::ConstantPower.gains(1.0);
        assert!(gains.left.abs() < 0.01);
        assert!((gains.right - 1.0).abs() < 0.01);
    }

    #[test]
    fn constant_power_preserves_energy() {
        // sum of squares should be ~1.0 at all positions
        for pan in [-1.0, -0.5, 0.0, 0.5, 1.0] {
            let gains = PanLaw::ConstantPower.gains(pan);
            let energy = gains.left * gains.left + gains.right * gains.right;
            assert!(
                (energy - 1.0).abs() < 0.01,
                "Energy not preserved at pan={pan}: {energy}"
            );
        }
    }

    #[test]
    fn linear_center_is_minus_6db() {
        let gains = PanLaw::Linear.gains(0.0);
        assert!((gains.left - 0.5).abs() < 0.01);
        assert!((gains.right - 0.5).abs() < 0.01);
    }

    #[test]
    fn linear_hard_left() {
        let gains = PanLaw::Linear.gains(-1.0);
        assert!((gains.left - 1.0).abs() < 0.01);
        assert!(gains.right.abs() < 0.01);
    }

    #[test]
    fn apply_pan_modifies_buffers() {
        let mut left = vec![1.0; 4];
        let mut right = vec![1.0; 4];

        apply_pan(&mut left, &mut right, -1.0, PanLaw::ConstantPower);

        // Hard left: left should be ~1.0, right should be ~0.0
        assert!((left[0] - 1.0).abs() < 0.01);
        assert!(right[0].abs() < 0.01);
    }

    #[test]
    fn pan_clamps_out_of_range() {
        let gains = PanLaw::ConstantPower.gains(5.0);
        let hard_right = PanLaw::ConstantPower.gains(1.0);
        assert!((gains.left - hard_right.left).abs() < 0.001);
        assert!((gains.right - hard_right.right).abs() < 0.001);
    }

    #[test]
    fn smoothed_pan_converges() {
        let mut left = vec![1.0; 1000];
        let mut right = vec![1.0; 1000];
        let mut current = 0.0;

        apply_pan_smoothed(
            &mut left,
            &mut right,
            1.0, // target: hard right
            &mut current,
            0.01,
            PanLaw::ConstantPower,
        );

        assert!(
            (current - 1.0).abs() < 0.001,
            "Smoothed pan didn't converge: {current}"
        );
    }
}
