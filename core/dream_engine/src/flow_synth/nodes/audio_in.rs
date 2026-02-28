use std::any::Any;
use super::super::graph::{FlowNode, FlowSignal};

/// An Audio Input node.
/// This node doesn't have internal state, but it acts as a placeholder
/// for the engine to inject external track audio into the graph.
pub struct AudioInNode {
    // No state needed, just a marker
}

impl AudioInNode {
    pub fn new() -> Self {
        Self {}
    }
}

impl FlowNode for AudioInNode {
    fn process(&mut self, inputs: &[FlowSignal], outputs: &mut [FlowSignal], _sample_rate: f64) {
        // In modular context, the input 0 of this node is expected to be
        // pre-filled by the FlowSynthEngine before the graph is processed.
        // If nothing is connected, it defaults to silence.
        outputs[0] = inputs.first().cloned().unwrap_or(FlowSignal::Audio(0.0));
    }

    fn reset(&mut self) {
        // No-op
    }

    fn as_any_mut(&mut self) -> &mut dyn Any { self }
}
