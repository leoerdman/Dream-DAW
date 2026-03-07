use std::any::Any;
use crate::flow_synth::graph::{FlowNode, FlowSignal};

/// Signal inverter (negate).
///
/// `output = -input`
///
/// Essential for:
///   - Phase inversion (180° flip)
///   - Subtracting signals via Add(A, Negate(B))
///   - Inverting modulation depth
pub struct MathNegateNode;

impl Default for MathNegateNode {
    fn default() -> Self {
        Self::new()
    }
}

impl MathNegateNode {
    pub fn new() -> Self {
        Self
    }
}

impl FlowNode for MathNegateNode {
    fn process(&mut self, inputs: &[FlowSignal], outputs: &mut [FlowSignal], _sample_rate: f64) {
        let val = inputs.first().and_then(|s| s.as_float()).unwrap_or(0.0);
        outputs[0] = FlowSignal::Audio(-val);
    }

    fn reset(&mut self) {}

    fn as_any_mut(&mut self) -> &mut dyn Any { self }
}
