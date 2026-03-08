use std::any::Any;
use super::super::graph::{FlowNode, FlowSignal};

/// A Utility node for common audio processing tasks.
///
/// Input 0: Audio signal
/// Input 1: Gain (control signal, default 1.0)
/// Input 2: Pan (control signal, -1.0 to +1.0, default 0.0)
///
/// Output 0: Audio output (processed)
///
/// Features:
/// - Gain control (linear, 0.0 to 2.0)
/// - Pan (constant-power panning)
/// - Phase invert
/// - DC offset removal (single-pole high-pass at ~5Hz)
///
/// ENTERPRISE: Zero-latency utility chain, same as any DAW channel strip utility.
pub struct UtilityNode {
    gain: f32,
    pan: f32,
    phase_invert: bool,
    // DC blocker state
    dc_x_prev: f32,
    dc_y_prev: f32,
    dc_coeff: f32,
}

impl UtilityNode {
    pub fn new() -> Self {
        Self {
            gain: 1.0,
            pan: 0.0,
            phase_invert: false,
            dc_x_prev: 0.0,
            dc_y_prev: 0.0,
            dc_coeff: 0.9995, // ~5Hz HPF at 44.1kHz (recalculated on set_sample_rate)
        }
    }

    pub fn set_gain(&mut self, g: f32) {
        self.gain = g.clamp(0.0, 4.0);
    }

    pub fn set_pan(&mut self, p: f32) {
        self.pan = p.clamp(-1.0, 1.0);
    }

    pub fn set_phase_invert(&mut self, invert: bool) {
        self.phase_invert = invert;
    }

    pub fn set_sample_rate(&mut self, sr: f64) {
        // DC blocker: y[n] = x[n] - x[n-1] + R * y[n-1], R = 1 - (2π * fc / sr)
        let fc = 5.0; // 5Hz cutoff
        self.dc_coeff = (1.0 - (2.0 * std::f64::consts::PI * fc / sr)) as f32;
        self.dc_coeff = self.dc_coeff.clamp(0.99, 0.9999);
    }
}

impl Default for UtilityNode {
    fn default() -> Self {
        Self::new()
    }
}

impl FlowNode for UtilityNode {
    fn process(&mut self, inputs: &[FlowSignal], outputs: &mut [FlowSignal], _sample_rate: f64) {
        // Input 0: Audio
        let audio = inputs.first().and_then(|s| s.as_float()).unwrap_or(0.0);

        // Input 1: Gain modulation (control signal)
        let gain_mod = inputs.get(1).and_then(|s| s.as_float()).unwrap_or(1.0);

        // Input 2: Pan modulation (control signal)
        let pan_mod = inputs.get(2).and_then(|s| s.as_float()).unwrap_or(0.0);

        // Apply gain
        let total_gain = self.gain * gain_mod;
        let mut sample = audio * total_gain;

        // Apply phase invert
        if self.phase_invert {
            sample = -sample;
        }

        // DC blocker (removes DC offset from accumulated processing)
        let mut dc_out = sample - self.dc_x_prev + self.dc_coeff * self.dc_y_prev;
        // ENTERPRISE BUG-06 FIX: Guard DC blocker state against NaN corruption
        if !dc_out.is_finite() {
            dc_out = 0.0;
            self.dc_x_prev = 0.0;
            self.dc_y_prev = 0.0;
        } else {
            // Denormal flush — standardized to 1e-15
            if dc_out.abs() < 1e-15 { dc_out = 0.0; }
            self.dc_x_prev = sample;
            self.dc_y_prev = dc_out;
        }
        sample = dc_out;

        // Pan (constant-power): for mono output, apply pan as attenuation
        // Pan value: -1 = full left, 0 = center, +1 = full right
        // For mono: pan affects level (attenuate toward silent side)
        let pan_total = (self.pan + pan_mod).clamp(-1.0, 1.0);
        // Simple equal-power pan law for mono: cos(π/4 * (pan+1))
        let pan_gain = ((std::f32::consts::FRAC_PI_4) * (pan_total + 1.0)).cos().clamp(0.0, 1.0);
        // At center (pan=0): pan_gain ≈ 0.707 (equal power), we compensate
        // so center = unity: divide by cos(π/4) = 0.707
        let compensated = sample * (pan_gain / std::f32::consts::FRAC_1_SQRT_2);

        // Clamp output
        let out = if compensated.is_finite() { compensated } else { 0.0 };
        outputs[0] = FlowSignal::Audio(out);
    }

    fn reset(&mut self) {
        self.dc_x_prev = 0.0;
        self.dc_y_prev = 0.0;
    }

    fn as_any_mut(&mut self) -> &mut dyn Any { self }
}
