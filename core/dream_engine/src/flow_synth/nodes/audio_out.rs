use std::any::Any;
use crate::flow_synth::graph::{FlowNode, FlowSignal};

pub struct AudioOutNode {
    gain: f32,
    muted: bool,
}

impl AudioOutNode {
    pub fn new() -> Self {
        Self {
            gain: 1.0,
            muted: false,
        }
    }

    pub fn set_gain(&mut self, gain: f32) {
        self.gain = gain.clamp(0.0, 2.0);
    }

    pub fn set_muted(&mut self, muted: bool) {
        self.muted = muted;
    }
}

impl FlowNode for AudioOutNode {
    fn process(&mut self, inputs: &[FlowSignal], outputs: &mut [FlowSignal], _sample_rate: f64) {
        // Input 0: Audio Signal
        // Master summing happens in the engine, this node just marks the end of the chain.
        let sample = inputs
            .first()
            .and_then(FlowSignal::as_float)
            .unwrap_or(0.0);
        let out = if self.muted { 0.0 } else { sample * self.gain };
        outputs[0] = FlowSignal::Audio(out);
    }

    fn reset(&mut self) {}

    fn as_any_mut(&mut self) -> &mut dyn Any { self }
}
