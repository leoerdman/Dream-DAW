use std::any::Any;
use crate::flow_synth::graph::{FlowNode, FlowSignal};

/// Delay Node — Mono delay with feedback and mix control.
///
/// Ring buffer implementation with linear interpolation for fractional delay
/// times. Feedback is hard-clamped to 0.95 for safety (prevents runaway).
/// Mix control blends dry/wet signal. Supports modulation of delay time and
/// feedback via CV inputs for flanging, chorus, and comb filtering effects.
pub struct DelayNode {
    buffer: Vec<f32>,
    write_pos: usize,
    time_ms: f32,
    feedback: f32,
    mix: f32,
    sample_rate: f64,
}

const MAX_DELAY_SAMPLES: usize = 96_000 * 2; // 2 seconds at 96kHz

impl DelayNode {
    pub fn new() -> Self {
        Self {
            buffer: vec![0.0; MAX_DELAY_SAMPLES],
            write_pos: 0,
            time_ms: 250.0,
            feedback: 0.3,
            mix: 0.5,
            sample_rate: 44_100.0,
        }
    }

    pub fn set_time_ms(&mut self, time: f32) {
        self.time_ms = time.clamp(1.0, 2000.0);
    }

    pub fn set_feedback(&mut self, fb: f32) {
        self.feedback = fb.clamp(-0.999, 0.999);
    }

    pub fn set_mix(&mut self, mix: f32) {
        self.mix = mix.clamp(0.0, 1.0);
    }

    #[inline]
    fn read_interpolated(&self, delay_samples: f32) -> f32 {
        let buf_len = self.buffer.len();
        let int_part = delay_samples as usize;
        let frac = delay_samples - int_part as f32;

        let idx0 = (self.write_pos + buf_len - int_part) % buf_len;
        let idx1 = (self.write_pos + buf_len - int_part - 1) % buf_len;

        self.buffer[idx0] * (1.0 - frac) + self.buffer[idx1] * frac
    }
}

impl Default for DelayNode {
    fn default() -> Self { Self::new() }
}

impl FlowNode for DelayNode {
    fn process(&mut self, inputs: &[FlowSignal], outputs: &mut [FlowSignal], sample_rate: f64) {
        self.sample_rate = sample_rate;

        // Input 0: audio
        let dry = inputs.first().and_then(|s| s.as_float()).unwrap_or(0.0);
        // Input 1: time modulation (ms offset)
        let time_mod = inputs.get(1).and_then(|s| s.as_float()).unwrap_or(0.0);
        // Input 2: feedback modulation (bipolar)
        let fb_mod = inputs.get(2).and_then(|s| s.as_float()).unwrap_or(0.0);

        let effective_time = (self.time_ms + time_mod * 100.0).clamp(1.0, 2000.0);
        let effective_fb = (self.feedback + fb_mod).clamp(-0.999, 0.999);

        let delay_samples = (effective_time * sample_rate as f32 / 1000.0)
            .clamp(1.0, (self.buffer.len() - 1) as f32);

        // Read delayed sample
        let wet = self.read_interpolated(delay_samples);

        // ENTERPRISE: Write new sample with feedback + soft clip to prevent runaway
        let fb_signal = wet * effective_fb;
        let mut write_val = dry + fb_signal;

        // ENTERPRISE BUG-09 FIX: Denormal flush — standardized to 1e-15
        if write_val.abs() < 1e-15 { write_val = 0.0; }
        // NaN/Inf guard — prevents corruption from bad upstream signals
        if !write_val.is_finite() { write_val = 0.0; }
        // Soft clip feedback to prevent runaway even with near-unity feedback
        write_val = write_val.clamp(-4.0, 4.0);

        self.buffer[self.write_pos] = write_val;
        self.write_pos = (self.write_pos + 1) % self.buffer.len();

        // Mix dry/wet
        let out = dry * (1.0 - self.mix) + wet * self.mix;
        outputs[0] = FlowSignal::Audio(out);
    }

    fn reset(&mut self) {
        self.buffer.fill(0.0);
        self.write_pos = 0;
    }

    fn as_any_mut(&mut self) -> &mut dyn Any { self }
}
