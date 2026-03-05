use std::any::Any;
use crate::flow_synth::graph::{FlowNode, FlowSignal};

/// Mixer Node — 4-channel audio mixer with individual gain controls.
///
/// Bitwig Grid equivalent: Mixer module. Sums up to 4 input signals with
/// per-channel gain. Essential for combining multiple sources before routing
/// to filters, effects, or the output node.
pub struct MixerNode {
    gains: [f32; 4],
}

impl MixerNode {
    pub fn new() -> Self {
        Self { gains: [1.0; 4] }
    }

    pub fn set_gain(&mut self, channel: usize, gain: f32) {
        if channel < 4 {
            self.gains[channel] = gain.clamp(0.0, 2.0);
        }
    }
}

impl Default for MixerNode {
    fn default() -> Self { Self::new() }
}

impl FlowNode for MixerNode {
    fn process(&mut self, inputs: &[FlowSignal], outputs: &mut [FlowSignal], _sample_rate: f64) {
        let mut sum = 0.0_f32;
        for i in 0..4 {
            let val = inputs.get(i).and_then(|s| s.as_float()).unwrap_or(0.0);
            sum += val * self.gains[i];
        }
        outputs[0] = FlowSignal::Audio(sum);
    }

    fn reset(&mut self) {}

    fn as_any_mut(&mut self) -> &mut dyn Any { self }
}
