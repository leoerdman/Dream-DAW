use std::any::Any;
use crate::flow_synth::graph::{FlowNode, FlowSignal};

/// Add Node — Sum two input signals.
///
/// The modular synth equivalent of a mixer/summer. Essential for combining
/// modulation sources, layering oscillators, or offsetting control signals.
/// Preserves signal type of input A.
pub struct MathAddNode;

impl MathAddNode {
    pub fn new() -> Self { Self }
}

impl Default for MathAddNode {
    fn default() -> Self { Self::new() }
}

impl FlowNode for MathAddNode {
    fn process(&mut self, inputs: &[FlowSignal], outputs: &mut [FlowSignal], _sample_rate: f64) {
        let a = inputs.first().cloned().unwrap_or(FlowSignal::Control(0.0));
        let b = inputs.get(1).cloned().unwrap_or(FlowSignal::Control(0.0));

        let va = a.as_float().unwrap_or(0.0);
        let vb = b.as_float().unwrap_or(0.0);
        let sum = va + vb;

        // Preserve the signal type of input A
        outputs[0] = match a {
            FlowSignal::Audio(_) => FlowSignal::Audio(sum),
            _ => FlowSignal::Control(sum),
        };
    }

    fn reset(&mut self) {}

    fn as_any_mut(&mut self) -> &mut dyn Any { self }
}
