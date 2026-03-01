use std::any::Any;
use super::super::graph::{FlowNode, FlowSignal};

/// An Audio Input node.
/// This node doesn't have internal state, but it acts as a placeholder
/// for the engine to inject external track audio into the graph.
pub struct AudioInNode {
    input_sample: f32,
}

impl AudioInNode {
    pub fn new() -> Self {
        Self { input_sample: 0.0 }
    }

    pub fn set_input_sample(&mut self, sample: f32) {
        self.input_sample = sample;
    }
}

impl Default for AudioInNode {
    fn default() -> Self {
        Self::new()
    }
}

impl FlowNode for AudioInNode {
    fn process(&mut self, inputs: &[FlowSignal], outputs: &mut [FlowSignal], _sample_rate: f64) {
        let _ = inputs;
        outputs[0] = FlowSignal::Audio(self.input_sample);
    }

    fn reset(&mut self) {
        self.input_sample = 0.0;
    }

    fn as_any_mut(&mut self) -> &mut dyn Any { self }
}
