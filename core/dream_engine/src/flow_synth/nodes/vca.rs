use std::any::Any;
use crate::flow_synth::graph::{FlowNode, FlowSignal};

/// VCA Node — Voltage-Controlled Amplifier.
///
/// Multiplies audio input by a control voltage, with an optional bias.
/// This is the canonical way to shape amplitude in a modular patch:
/// connect an envelope's CV output to the VCA's CV input to create
/// amplitude envelopes. Bias defaults to 1.0 (unity gain when CV = 1.0).
///
/// Bitwig Grid equivalent: Attenuate / AM module.
pub struct VcaNode {
    bias: f32,
}

impl VcaNode {
    pub fn new() -> Self {
        Self { bias: 1.0 }
    }

    pub fn set_bias(&mut self, bias: f32) {
        self.bias = bias.clamp(0.0, 2.0);
    }
}

impl Default for VcaNode {
    fn default() -> Self { Self::new() }
}

impl FlowNode for VcaNode {
    fn process(&mut self, inputs: &[FlowSignal], outputs: &mut [FlowSignal], _sample_rate: f64) {
        // Input 0: audio signal
        let audio = inputs.first().and_then(|s| s.as_float()).unwrap_or(0.0);
        // Input 1: CV control (0..1 typical, from envelope or LFO)
        let cv = inputs.get(1).and_then(|s| s.as_float()).unwrap_or(1.0);

        outputs[0] = FlowSignal::Audio(audio * cv * self.bias);
    }

    fn reset(&mut self) {}

    fn as_any_mut(&mut self) -> &mut dyn Any { self }
}
