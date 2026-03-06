use std::any::Any;
use crate::flow_synth::graph::{FlowNode, FlowSignal};

/// LFO Node — Free-running low-frequency oscillator with multiple shapes.
///
/// Enterprise architecture inspired by Bitwig Grid LFO: sine/triangle/saw/
/// square/random shapes, rate modulation input, gate-triggered phase reset,
/// and both CV and phase outputs.
pub struct LfoNode {
    phase: f64,
    rate: f64,
    shape: LfoShape,
    bipolar: bool,
    phase_offset: f64,
    prev_trigger: f32,
    /// Simple PRNG state for random shape
    rng_state: u32,
    held_random: f32,
}

#[derive(Debug, Clone, Copy, PartialEq)]
pub enum LfoShape {
    Sine,
    Triangle,
    Saw,
    Square,
    Random,
}

impl LfoNode {
    pub fn new() -> Self {
        Self {
            phase: 0.0,
            rate: 1.0,
            shape: LfoShape::Sine,
            bipolar: true,
            phase_offset: 0.0,
            prev_trigger: 0.0,
            rng_state: 0xDEAD_BEEF,
            held_random: 0.0,
        }
    }

    pub fn set_rate(&mut self, rate: f64) {
        self.rate = rate.clamp(0.01, 40.0);
    }

    pub fn set_shape_by_float(&mut self, val: f32) {
        self.shape = match val as i32 {
            1 => LfoShape::Triangle,
            2 => LfoShape::Square,
            3 | 4 => LfoShape::Saw, // map both up and down to Saw for now
            5 => LfoShape::Random,
            _ => LfoShape::Sine,
        };
    }

    pub fn set_bipolar(&mut self, bipolar: bool) {
        self.bipolar = bipolar;
    }

    pub fn set_phase_offset(&mut self, offset: f64) {
        self.phase_offset = offset.rem_euclid(1.0);
    }

    fn xorshift(&mut self) -> f32 {
        let mut x = self.rng_state;
        x ^= x << 13;
        x ^= x >> 17;
        x ^= x << 5;
        self.rng_state = x;
        // Map to 0..1
        (x as f32) / (u32::MAX as f32)
    }
}

impl Default for LfoNode {
    fn default() -> Self { Self::new() }
}

impl FlowNode for LfoNode {
    fn process(&mut self, inputs: &[FlowSignal], outputs: &mut [FlowSignal], sample_rate: f64) {
        // Input 0: rate modulation (control) — additive Hz offset
        let rate_mod = inputs.first().and_then(|s| s.as_float()).unwrap_or(0.0) as f64;
        // Input 1: reset trigger (gate)
        let trigger_val = inputs.get(1).and_then(|s| s.as_float()).unwrap_or(0.0);

        // Detect rising edge for phase reset
        if trigger_val >= 0.5 && self.prev_trigger < 0.5 {
            self.phase = 0.0;
            // On random shape, sample new random value on each trigger
            if self.shape == LfoShape::Random {
                self.held_random = self.xorshift();
            }
        }
        self.prev_trigger = trigger_val;

        // Advance phase — clamp effective_rate to prevent negative/infinite phase
        let effective_rate = (self.rate + rate_mod).clamp(0.001, 100.0);
        self.phase += effective_rate / sample_rate;

        // ENTERPRISE: Denormal flush — prevents CPU spikes after long silence
        if self.phase.abs() < 1e-18 { self.phase = 0.0; }
        // Detect cycle wrap for random S&H
        if self.phase >= 1.0 {
            self.phase -= self.phase.floor();
            if self.shape == LfoShape::Random {
                self.held_random = self.xorshift();
            }
        }

        let p = (self.phase + self.phase_offset).rem_euclid(1.0);

        // Generate shape (unipolar 0..1)
        let unipolar = match self.shape {
            LfoShape::Sine => {
                (0.5 + 0.5 * (p * std::f64::consts::TAU).sin()) as f32
            }
            LfoShape::Triangle => {
                let t = p as f32;
                if t < 0.5 { t * 2.0 } else { 2.0 - t * 2.0 }
            }
            LfoShape::Saw => p as f32,
            LfoShape::Square => {
                if p < 0.5 { 1.0 } else { 0.0 }
            }
            LfoShape::Random => self.held_random,
        };

        // Convert to bipolar if needed
        let value = if self.bipolar {
            unipolar * 2.0 - 1.0
        } else {
            unipolar
        };

        // Output 0: CV signal
        outputs[0] = FlowSignal::Control(value);
        // Output 1: Phase signal (always unipolar 0..1)
        outputs[1] = FlowSignal::Phase(p as f32);
    }

    fn reset(&mut self) {
        self.phase = 0.0;
        self.prev_trigger = 0.0;
    }

    fn as_any_mut(&mut self) -> &mut dyn Any { self }
}
