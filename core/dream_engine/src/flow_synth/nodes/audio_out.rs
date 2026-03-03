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
        let left = inputs.first().cloned().unwrap_or(FlowSignal::Audio(0.0));
        let right_raw = inputs.get(1).cloned().unwrap_or(FlowSignal::None);
        // ENTERPRISE FIX (#9): Mono→Stereo fallback.
        // If only the left input is connected (right is None), duplicate left to both channels.
        // This prevents silent right channel when users connect a single cable.
        let right = match right_raw {
            FlowSignal::None => left,
            other => other,
        };
        outputs[0] = left;
        outputs[1] = right;
    }

    fn reset(&mut self) {}

    fn as_any_mut(&mut self) -> &mut dyn Any { self }
}
