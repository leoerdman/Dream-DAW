use std::any::Any;
use crate::flow_synth::graph::{FlowNode, FlowSignal};

pub struct AudioOutNode {
    gain: f32,
    muted: bool,
}

impl AudioOutNode {
    pub fn new() -> Self {
        Self { gain: 0.8, muted: false }
    }

    pub fn set_gain(&mut self, gain: f32) {
        self.gain = gain.clamp(0.0, 2.0);
    }

    pub fn set_muted(&mut self, muted: bool) {
        self.muted = muted;
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

        if self.muted {
            outputs[0] = FlowSignal::Audio(0.0);
            outputs[1] = FlowSignal::Audio(0.0);
        } else {
            let g = self.gain;
            let apply_gain = |s: FlowSignal| -> FlowSignal {
                match s {
                    FlowSignal::Audio(v) => FlowSignal::Audio(v * g),
                    FlowSignal::Control(v) => FlowSignal::Audio(v * g),
                    FlowSignal::Gate(on) => FlowSignal::Audio(if on { g } else { 0.0 }),
                    FlowSignal::Phase(p) => FlowSignal::Audio(p * g),
                    other => other,
                }
            };
            outputs[0] = apply_gain(left);
            outputs[1] = apply_gain(right);
        }
    }

    fn reset(&mut self) {}

    fn as_any_mut(&mut self) -> &mut dyn Any { self }
}
