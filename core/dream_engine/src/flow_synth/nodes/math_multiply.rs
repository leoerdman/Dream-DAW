use std::any::Any;
use crate::flow_synth::graph::{FlowNode, FlowSignal};

/// Multiply Node — Multiply two signals with optional scale factor.
///
/// The modular swiss-army knife: VCA behavior (audio × CV), ring modulation
/// (audio × audio), attenuverting (signal × negative scale), and simple
/// amplitude scaling. Core module in every Bitwig Grid patch.
pub struct MathMultiplyNode {
    scale: f32,
}

impl MathMultiplyNode {
    pub fn new() -> Self {
        Self { scale: 1.0 }
    }

    pub fn set_scale(&mut self, scale: f32) {
        self.scale = scale.clamp(-2.0, 2.0);
    }
}

impl Default for MathMultiplyNode {
    fn default() -> Self { Self::new() }
}

impl FlowNode for MathMultiplyNode {
    fn process(&mut self, inputs: &[FlowSignal], outputs: &mut [FlowSignal], _sample_rate: f64) {
        let a = inputs.first().cloned().unwrap_or(FlowSignal::Control(0.0));
        let b = inputs.get(1).cloned().unwrap_or(FlowSignal::Control(1.0));

        let va = a.as_float().unwrap_or(0.0);
        let vb = b.as_float().unwrap_or(1.0);
        let product = va * vb * self.scale;

        // If either input is audio, output is audio (ring mod behavior)
        outputs[0] = match a {
            FlowSignal::Audio(_) => FlowSignal::Audio(product),
            _ => match b {
                FlowSignal::Audio(_) => FlowSignal::Audio(product),
                _ => FlowSignal::Control(product),
            },
        };
    }

    fn reset(&mut self) {}

    fn as_any_mut(&mut self) -> &mut dyn Any { self }
}
