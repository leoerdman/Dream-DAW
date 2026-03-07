use std::any::Any;
use crate::flow_synth::graph::{FlowNode, FlowSignal};

/// Range remapper.
///
/// Maps an input value from range [min_in..max_in] to [0..1].
/// Formula: `output = (input - min_in) / (max_in - min_in)`
/// Output is clamped to [0..1].
///
/// If min_in == max_in (zero-width range), outputs 0.0 to prevent division by zero.
///
/// Essential for:
///   - Scaling LFO output to control-voltage range
///   - Normalizing sensor/knob values
///   - Converting bipolar (-1..1) to unipolar (0..1)
pub struct MathMapNode {
    min_in: f32,
    max_in: f32,
}

impl Default for MathMapNode {
    fn default() -> Self {
        Self::new()
    }
}

impl MathMapNode {
    pub fn new() -> Self {
        Self {
            min_in: 0.0,
            max_in: 1.0,
        }
    }

    pub fn set_min_in(&mut self, v: f32) {
        self.min_in = v;
    }

    pub fn set_max_in(&mut self, v: f32) {
        self.max_in = v;
    }
}

impl FlowNode for MathMapNode {
    fn process(&mut self, inputs: &[FlowSignal], outputs: &mut [FlowSignal], _sample_rate: f64) {
        let val = inputs.first().and_then(|s| s.as_float()).unwrap_or(0.0);
        let min_in = inputs.get(1).and_then(|s| s.as_float()).unwrap_or(self.min_in);
        let max_in = inputs.get(2).and_then(|s| s.as_float()).unwrap_or(self.max_in);

        let range = max_in - min_in;
        let mapped = if range.abs() < 1e-10 {
            0.0
        } else {
            ((val - min_in) / range).clamp(0.0, 1.0)
        };

        outputs[0] = FlowSignal::Control(mapped);
    }

    fn reset(&mut self) {}

    fn as_any_mut(&mut self) -> &mut dyn Any { self }
}
