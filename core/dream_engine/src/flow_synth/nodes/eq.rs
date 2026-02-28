use std::any::Any;
use super::super::graph::{FlowNode, FlowSignal};

/// A high-quality parametric EQ node.
/// For now, this implements a single peak filter, but is designed to be expandable.
pub struct EqNode {
    // Coefficients for a biquad filter
    a1: f32,
    a2: f32,
    b0: f32,
    b1: f32,
    b2: f32,
    
    // State memory
    x1: f32,
    x2: f32,
    y1: f32,
    y2: f32,
    
    last_freq: f32,
    last_gain_db: f32,
    last_q: f32,
}

impl EqNode {
    pub fn new() -> Self {
        Self {
            a1: 0.0, a2: 0.0, b0: 1.0, b1: 0.0, b2: 0.0,
            x1: 0.0, x2: 0.0, y1: 0.0, y2: 0.0,
            last_freq: -1.0,
            last_gain_db: -1.0,
            last_q: -1.0,
        }
    }

    fn update_coefficients(&mut self, freq: f32, gain_db: f32, q: f32, sample_rate: f64) {
        if (freq - self.last_freq).abs() < 0.001 
            && (gain_db - self.last_gain_db).abs() < 0.001 
            && (q - self.last_q).abs() < 0.001 {
            return;
        }

        let w0 = 2.0 * std::f32::consts::PI * freq / sample_rate as f32;
        let alpha = w0.sin() / (2.0 * q);
        let a = 10.0f32.powf(gain_db / 40.0);

        // Peaking EQ coefficients
        let b0 = 1.0 + alpha * a;
        let b1 = -2.0 * w0.cos();
        let b2 = 1.0 - alpha * a;
        let a0 = 1.0 + alpha / a;
        let a1 = -2.0 * w0.cos();
        let a2 = 1.0 - alpha / a;

        self.b0 = b0 / a0;
        self.b1 = b1 / a0;
        self.b2 = b2 / a0;
        self.a1 = a1 / a0;
        self.a2 = a2 / a0;

        self.last_freq = freq;
        self.last_gain_db = gain_db;
        self.last_q = q;
    }
}

impl FlowNode for EqNode {
    fn process(&mut self, inputs: &[FlowSignal], outputs: &mut [FlowSignal], sample_rate: f64) {
        let input = inputs.first().cloned().unwrap_or(FlowSignal::Audio(0.0));
        let freq = inputs.get(1).and_then(|s| s.as_float()).unwrap_or(1000.0).clamp(20.0, 20000.0);
        let gain_db = inputs.get(2).and_then(|s| s.as_float()).unwrap_or(0.0).clamp(-24.0, 24.0);
        let q = inputs.get(3).and_then(|s| s.as_float()).unwrap_or(0.707).clamp(0.1, 10.0);

        self.update_coefficients(freq, gain_db, q, sample_rate);

        let x = match input {
            FlowSignal::Audio(v) => v,
            FlowSignal::Control(v) => v,
            _ => 0.0,
        };

        // Biquad Difference Equation (Direct Form I)
        let y = self.b0 * x + self.b1 * self.x1 + self.b2 * self.x2 
                - self.a1 * self.y1 - self.a2 * self.y2;

        self.x2 = self.x1;
        self.x1 = x;
        self.y2 = self.y1;
        self.y1 = y;

        outputs[0] = FlowSignal::Audio(y);
    }

    fn reset(&mut self) {
        self.x1 = 0.0;
        self.x2 = 0.0;
        self.y1 = 0.0;
        self.y2 = 0.0;
    }

    fn as_any_mut(&mut self) -> &mut dyn Any { self }
}
