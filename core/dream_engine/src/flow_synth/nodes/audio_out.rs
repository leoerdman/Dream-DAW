use std::any::Any;
use crate::flow_synth::graph::{FlowNode, FlowSignal};

pub struct AudioOutNode {}

impl AudioOutNode {
    pub fn new() -> Self {
        Self {}
    }
}

impl Default for AudioOutNode {
    fn default() -> Self {
        Self::new()
    }
}

impl FlowNode for AudioOutNode {
    fn process(&mut self, inputs: &[FlowSignal], outputs: &mut [FlowSignal], _sample_rate: f64) {
        // Input 0: Left Audio Signal
        // Input 1: Right Audio Signal
        outputs[0] = inputs.get(0).cloned().unwrap_or(FlowSignal::Audio(0.0));
        outputs[1] = inputs.get(1).cloned().unwrap_or(FlowSignal::Audio(0.0));
    }

    fn reset(&mut self) {}

    fn as_any_mut(&mut self) -> &mut dyn Any { self }
}
