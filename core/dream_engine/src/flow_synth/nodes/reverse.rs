use std::any::Any;
use super::super::graph::{FlowNode, FlowSignal};

/// A Reverse effect node.
/// Records incoming audio to a buffer and plays it back backwards.
///
/// ENTERPRISE: Uses a proper grain-based reverse with linear crossfade
/// at window boundaries to eliminate click artifacts.
pub struct ReverseNode {
    buffer: Vec<f32>,
    write_pos: usize,
    buffer_size: usize,
    window_ms: f32,
    feedback: f32,
    mix: f32,
    reverse_phase: usize,
    last_output: f32,
    // Crossfade between old and new grains at boundary
    crossfade_len: usize,
}

impl ReverseNode {
    /// ENTERPRISE: Pre-allocate for 2 seconds at the maximum supported sample rate (96kHz).
    /// This avoids audio-thread allocations when sample rate changes.
    const MAX_BUFFER_SIZE: usize = 96_000 * 2;

    pub fn new() -> Self {
        Self {
            buffer: vec![0.0; Self::MAX_BUFFER_SIZE],
            write_pos: 0,
            buffer_size: Self::MAX_BUFFER_SIZE,
            window_ms: 200.0,
            feedback: 0.0,
            mix: 1.0,
            reverse_phase: 0,
            last_output: 0.0,
            crossfade_len: 64,
        }
    }

    pub fn set_window_ms(&mut self, window_ms: f32) {
        self.window_ms = window_ms.clamp(20.0, 2000.0);
    }

    pub fn set_feedback(&mut self, feedback: f32) {
        self.feedback = feedback.clamp(0.0, 0.95);
    }

    pub fn set_mix(&mut self, mix: f32) {
        self.mix = mix.clamp(0.0, 1.0);
    }
}

impl Default for ReverseNode {
    fn default() -> Self {
        Self::new()
    }
}

impl FlowNode for ReverseNode {
    fn process(&mut self, inputs: &[FlowSignal], outputs: &mut [FlowSignal], sample_rate: f64) {
        let input = inputs.first().and_then(|s| s.as_float()).unwrap_or(0.0);
        let mix = inputs.get(1).and_then(|s| s.as_float()).unwrap_or(self.mix).clamp(0.0, 1.0);

        let window_samples = ((self.window_ms * 0.001 * sample_rate as f32) as usize)
            .clamp(64, self.buffer_size.saturating_sub(1));

        // ENTERPRISE BUG-20 FIX: Guard feedback path against NaN/denormal corruption.
        // Once last_output becomes NaN, it poisons all future samples via feedback.
        if !self.last_output.is_finite() { self.last_output = 0.0; }
        if self.last_output.abs() < 1e-15 { self.last_output = 0.0; }

        // Write dry + feedback tail.
        self.buffer[self.write_pos] = input + self.last_output * self.feedback;

        // Read current window in reverse order.
        let window_start = (self.write_pos + self.buffer_size + 1 - window_samples) % self.buffer_size;
        let reverse_idx = window_samples.saturating_sub(1 + (self.reverse_phase % window_samples));
        let read_pos = (window_start + reverse_idx) % self.buffer_size;
        let output_val = self.buffer[read_pos];

        // ENTERPRISE: Linear crossfade at window boundary to eliminate clicks.
        // When near the start or end of a grain window, blend with silence.
        let phase_in_window = self.reverse_phase % window_samples;
        let fade_len = self.crossfade_len.min(window_samples / 4);
        let fade_gain = if phase_in_window < fade_len {
            // Fade in at grain start
            phase_in_window as f32 / fade_len as f32
        } else if phase_in_window >= window_samples - fade_len {
            // Fade out at grain end
            (window_samples - 1 - phase_in_window) as f32 / fade_len as f32
        } else {
            1.0
        };

        let faded_output = output_val * fade_gain;

        self.reverse_phase = (self.reverse_phase + 1) % window_samples;
        self.write_pos = (self.write_pos + 1) % self.buffer_size;

        let mixed = input * (1.0 - mix) + faded_output * mix;
        self.last_output = mixed;
        outputs[0] = FlowSignal::Audio(mixed);
    }

    fn reset(&mut self) {
        self.buffer.fill(0.0);
        self.write_pos = 0;
        self.reverse_phase = 0;
        self.last_output = 0.0;
    }

    fn as_any_mut(&mut self) -> &mut dyn Any { self }
}
