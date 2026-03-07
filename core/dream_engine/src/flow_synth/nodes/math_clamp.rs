use std::any::Any;
use crate::flow_synth::graph::{FlowNode, FlowSignal};

/// Hard limiter (clamp).
///
/// `output = input.clamp(min, max)`
///
/// Essential for:
///   - Preventing signal overflow before output
///   - Creating hard-clipped distortion when min=-0.5, max=0.5
///   - Constraining CV to safe operating range
pub struct MathClampNode {
    min: f32,
    max: f32,
}

impl Default for MathClampNode {
    fn default() -> Self {
        Self::new()
    }
}

impl MathClampNode {
    pub fn new() -> Self {
        Self {
            min: -1.0,
            max: 1.0,
        }
    }

    pub fn set_min(&mut self, v: f32) {
        self.min = v;
    }

    pub fn set_max(&mut self, v: f32) {
        self.max = v;
    }
}

impl FlowNode for MathClampNode {
    fn process(&mut self, inputs: &[FlowSignal], outputs: &mut [FlowSignal], _sample_rate: f64) {
        let val = inputs.first().and_then(|s| s.as_float()).unwrap_or(0.0);
        let min = inputs.get(1).and_then(|s| s.as_float()).unwrap_or(self.min);
        let max = inputs.get(2).and_then(|s| s.as_float()).unwrap_or(self.max);

        outputs[0] = FlowSignal::Audio(val.clamp(min, max));
    }

    fn reset(&mut self) {}

    fn as_any_mut(&mut self) -> &mut dyn Any { self }
}
