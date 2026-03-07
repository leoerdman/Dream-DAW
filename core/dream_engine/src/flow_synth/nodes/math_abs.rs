use std::any::Any;
use crate::flow_synth::graph::{FlowNode, FlowSignal};

/// Full-wave rectifier (absolute value).
///
/// `output = |input|`
///
/// Essential for:
///   - Envelope followers (rectify audio → smooth → CV)
///   - Waveform shaping (fold negative half to positive)
///   - Converting bipolar signals to unipolar
pub struct MathAbsNode;

impl Default for MathAbsNode {
    fn default() -> Self {
        Self::new()
    }
}

impl MathAbsNode {
    pub fn new() -> Self {
        Self
    }
}

impl FlowNode for MathAbsNode {
    fn process(&mut self, inputs: &[FlowSignal], outputs: &mut [FlowSignal], _sample_rate: f64) {
        let val = inputs.first().and_then(|s| s.as_float()).unwrap_or(0.0);
        outputs[0] = FlowSignal::Audio(val.abs());
    }

    fn reset(&mut self) {}

    fn as_any_mut(&mut self) -> &mut dyn Any { self }
}
