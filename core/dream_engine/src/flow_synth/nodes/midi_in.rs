use std::any::Any;
use crate::flow_synth::graph::{FlowNode, FlowSignal};

pub struct MidiInNode {
    pub note: u8,
    pub velocity: u8,
    pub gate: bool,
    /// Transpose offset in semitones. Applied to the note before frequency conversion.
    transpose: i8,
}

impl MidiInNode {
    pub fn new() -> Self {
        Self {
            note: 69,
            velocity: 0,
            gate: false,
            transpose: 0,
        }
    }
}

impl Default for MidiInNode {
    fn default() -> Self {
        Self::new()
    }
}

impl FlowNode for MidiInNode {
    fn process(&mut self, _inputs: &[FlowSignal], outputs: &mut [FlowSignal], _sample_rate: f64) {
        // Output 0: Frequency in Hz (Audio-rate CV)
        // Output 1: Velocity (0..1, Control)
        // Output 2: Gate (0 or 1, Control)

        let effective_note = (self.note as i16 + self.transpose as i16).clamp(0, 127) as f32;
        let freq_hz = 440.0 * 2.0_f32.powf((effective_note - 69.0) / 12.0);
        outputs[0] = FlowSignal::Control(freq_hz);
        outputs[1] = FlowSignal::Control(self.velocity as f32 / 127.0);
        outputs[2] = FlowSignal::Gate(self.gate);
    }

    fn reset(&mut self) {
        // Don't reset state here — it's driven by the engine
    }

    fn as_any_mut(&mut self) -> &mut dyn Any { self }
}

impl MidiInNode {
    /// Set transpose offset in semitones. Clamped to [-48, 48] (±4 octaves).
    pub fn set_transpose(&mut self, semitones: f32) {
        self.transpose = (semitones as i8).clamp(-48, 48);
    }
}
