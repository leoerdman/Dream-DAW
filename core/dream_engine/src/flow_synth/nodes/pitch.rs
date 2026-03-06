use std::any::Any;
use super::super::graph::{FlowNode, FlowSignal};

/// A Pitch node that transposes frequency by octave offset.
///
/// Input 0: Frequency in Hz (audio or control signal)
/// Input 1: Octave offset (control signal, e.g. -2 to +2)
///
/// Output 0: Transposed frequency in Hz
///
/// Formula: output_freq = input_freq * 2^octave_offset
///
/// ENTERPRISE: Zero-latency, zero-allocation pitch transposition.
/// When octave_offset = 0, output = input (unity pass-through).
pub struct PitchNode {
    octave_offset: f32,
}

impl PitchNode {
    pub fn new() -> Self {
        Self { octave_offset: 0.0 }
    }

    pub fn set_octave_offset(&mut self, offset: f32) {
        self.octave_offset = offset.clamp(-4.0, 4.0);
    }
}

impl Default for PitchNode {
    fn default() -> Self {
        Self::new()
    }
}

impl FlowNode for PitchNode {
    fn process(&mut self, inputs: &[FlowSignal], outputs: &mut [FlowSignal], _sample_rate: f64) {
        // Input 0: Frequency in Hz
        let freq = inputs.first().and_then(|s| s.as_float()).unwrap_or(440.0);

        // Input 1: External octave offset modulation
        let ext_octave = inputs.get(1).and_then(|s| s.as_float()).unwrap_or(0.0);

        // ENTERPRISE BUG-11 FIX: Clamp octave range to prevent Infinity from 2^extreme
        let total_octave = (self.octave_offset + ext_octave).clamp(-10.0, 10.0);

        // Transpose: freq * 2^octave
        let transposed = freq * (2.0_f32).powf(total_octave);

        outputs[0] = FlowSignal::Control(transposed.clamp(0.0, 100_000.0));
    }

    fn reset(&mut self) {}

    fn as_any_mut(&mut self) -> &mut dyn Any { self }
}
