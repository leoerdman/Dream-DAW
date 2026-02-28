use std::any::Any;
use super::super::graph::{FlowNode, FlowSignal};

/// A Reverse effect node.
/// Records incoming audio to a buffer and plays it back backwards.
pub struct ReverseNode {
    buffer: Vec<f32>,
    write_pos: usize,
    read_pos: usize,
    buffer_size: usize,
}

impl ReverseNode {
    pub fn new() -> Self {
        let buffer_size = 44100 * 2; // 2 seconds at 44.1k
        Self {
            buffer: vec![0.0; buffer_size],
            write_pos: 0,
            read_pos: 0,
            buffer_size,
        }
    }
}

impl FlowNode for ReverseNode {
    fn process(&mut self, inputs: &[FlowSignal], outputs: &mut [FlowSignal], _sample_rate: f64) {
        let input = inputs.first().and_then(|s| s.as_float()).unwrap_or(0.0);
        let mix = inputs.get(1).and_then(|s| s.as_float()).unwrap_or(1.0).clamp(0.0, 1.0);

        // Record to buffer
        self.buffer[self.write_pos] = input;
        
        // Playback backwards (read position advances in opposite direction of write)
        // Simple implementation: read is some distance behind write, but moving backwards
        let output_val = self.buffer[self.read_pos];

        // Increment write position
        self.write_pos = (self.write_pos + 1) % self.buffer_size;
        
        // Decrement read position for "reverse" effect
        if self.read_pos == 0 {
            self.read_pos = self.buffer_size - 1;
        } else {
            self.read_pos -= 1;
        }

        let mixed = input * (1.0 - mix) + output_val * mix;
        outputs[0] = FlowSignal::Audio(mixed);
    }

    fn reset(&mut self) {
        self.buffer.fill(0.0);
        self.write_pos = 0;
        self.read_pos = 0;
    }

    fn as_any_mut(&mut self) -> &mut dyn Any { self }
}
