use std::any::Any;
use crate::flow_synth::graph::{FlowNode, FlowSignal};

pub struct MidiInNode {
    pub note: u8,
    pub velocity: u8,
    pub gate: bool,
}

impl MidiInNode {
    pub fn new() -> Self {
        Self {
            note: 69,
            velocity: 0,
            gate: false,
        }
    }
}

impl FlowNode for MidiInNode {
    fn process(&mut self, _inputs: &[FlowSignal], outputs: &mut [FlowSignal], _sample_rate: f64) {
        // Output 0: Frequency in Hz (Audio-rate CV)
        // Output 1: Velocity (0..1, Control)
        // Output 2: Gate (0 or 1, Control)

        let freq_hz = 440.0 * 2.0_f32.powf((self.note as f32 - 69.0) / 12.0);
        outputs[0] = FlowSignal::Audio(freq_hz);
        outputs[1] = FlowSignal::Control(self.velocity as f32 / 127.0);
        outputs[2] = FlowSignal::Control(if self.gate { 1.0 } else { 0.0 });
    }

    fn reset(&mut self) {
        // Don't reset state here — it's driven by the engine
    }

    fn as_any_mut(&mut self) -> &mut dyn Any { self }
}
