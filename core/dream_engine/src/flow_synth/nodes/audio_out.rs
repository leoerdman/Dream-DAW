use crate::flow_synth::graph::{FlowNode, FlowSignal};

pub struct AudioOutNode {}

impl AudioOutNode {
    pub fn new() -> Self {
        Self {}
    }
}

impl FlowNode for AudioOutNode {
    fn process(&mut self, inputs: &[FlowSignal], outputs: &mut [FlowSignal], _sample_rate: f64) {
        // Input 0: Audio Signal
        // Master summing happens in the engine, this node just marks the end of the chain.
        outputs[0] = inputs[0];
    }

    fn reset(&mut self) {}
}
