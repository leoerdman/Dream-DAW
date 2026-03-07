use std::any::Any;
use crate::flow_synth::graph::{FlowNode, FlowSignal};

/// Frequency (Hz) → MIDI note number converter.
///
/// Standard tuning: 440 Hz = A4 (MIDI 69).
/// Formula: `note = 69 + 12 * log2(freq / 440)`
///
/// Returns fractional MIDI note values for sub-semitone precision.
/// Useful for pitch analysis, tuner displays, and feeding
/// MIDI-scale values into quantizers.
pub struct FreqToMidiNode;

impl Default for FreqToMidiNode {
    fn default() -> Self {
        Self::new()
    }
}

impl FreqToMidiNode {
    pub fn new() -> Self {
        Self
    }
}

impl FlowNode for FreqToMidiNode {
    fn process(&mut self, inputs: &[FlowSignal], outputs: &mut [FlowSignal], _sample_rate: f64) {
        let freq = inputs.first().and_then(|s| s.as_float()).unwrap_or(440.0) as f64;

        if freq <= 0.0 {
            outputs[0] = FlowSignal::Control(0.0);
            return;
        }

        let midi_note = 69.0 + 12.0 * (freq / 440.0).log2();
        // Clamp to valid MIDI range
        let safe_note = midi_note.clamp(0.0, 127.0) as f32;
        outputs[0] = FlowSignal::Control(safe_note);
    }

    fn reset(&mut self) {}

    fn as_any_mut(&mut self) -> &mut dyn Any { self }
}
