use std::any::Any;
use crate::flow_synth::graph::{FlowNode, FlowSignal};

/// Constant numeric value source.
///
/// Outputs a user-defined constant as `FlowSignal::Control(value)` every sample.
/// This is the most fundamental utility node — equivalent to a "knob" module
/// in hardware modular synths (Doepfer A-175, Make Noise Maths offset).
///
/// Use cases:
///   - Set a fixed frequency for an oscillator
///   - Provide a constant CV bias to a VCA
///   - Drive a pitch offset into the Pitch node
pub struct NumberNode {
    value: f32,
}

impl Default for NumberNode {
    fn default() -> Self {
        Self::new()
    }
}

impl NumberNode {
    pub fn new() -> Self {
        Self { value: 0.0 }
    }

    pub fn set_value(&mut self, v: f32) {
        self.value = v;
    }
}

impl FlowNode for NumberNode {
    fn process(&mut self, _inputs: &[FlowSignal], outputs: &mut [FlowSignal], _sample_rate: f64) {
        outputs[0] = FlowSignal::Control(self.value);
    }

    fn reset(&mut self) {}

    fn as_any_mut(&mut self) -> &mut dyn Any { self }
}
