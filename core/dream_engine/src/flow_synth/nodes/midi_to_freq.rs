use std::any::Any;
use crate::flow_synth::graph::{FlowNode, FlowSignal};

/// MIDI note number → frequency (Hz) converter.
///
/// Standard tuning: A4 (MIDI 69) = 440 Hz.
/// Formula: `freq = 440 * 2^((note - 69) / 12)`
///
/// Accepts fractional MIDI note values for micro-tuning.
/// Essential for patches that generate MIDI-scale control values
/// and need to drive oscillators expecting Hz input.
pub struct MidiToFreqNode;

impl Default for MidiToFreqNode {
    fn default() -> Self {
        Self::new()
    }
}

impl MidiToFreqNode {
    pub fn new() -> Self {
        Self
    }
}

impl FlowNode for MidiToFreqNode {
    fn process(&mut self, inputs: &[FlowSignal], outputs: &mut [FlowSignal], _sample_rate: f64) {
        let midi_note = inputs.first().and_then(|s| s.as_float()).unwrap_or(69.0) as f64;
        let freq = 440.0 * 2.0_f64.powf((midi_note - 69.0) / 12.0);
        // Clamp to audible range to prevent NaN/Inf from extreme inputs
        let safe_freq = freq.clamp(0.0, 100_000.0) as f32;
        outputs[0] = FlowSignal::Control(safe_freq);
    }

    fn reset(&mut self) {}

    fn as_any_mut(&mut self) -> &mut dyn Any { self }
}
