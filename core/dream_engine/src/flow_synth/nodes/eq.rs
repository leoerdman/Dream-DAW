use std::any::Any;
use super::super::graph::{FlowNode, FlowSignal};

/// A 3-band parametric EQ node (Low 200Hz / Mid 1kHz / High 5kHz).
/// Each band is a biquad peaking filter processed in series.
pub struct EqNode {
    bands: [BiquadBand; 3],
}

struct BiquadBand {
    // Coefficients
    a1: f32,
    a2: f32,
    b0: f32,
    b1: f32,
    b2: f32,
    // State
    x1: f32,
    x2: f32,
    y1: f32,
    y2: f32,
    // Cached params
    freq: f32,
    gain_db: f32,
    q: f32,
    dirty: bool,
    last_sr: f64,
}

impl BiquadBand {
    fn new(freq: f32, gain_db: f32, q: f32) -> Self {
        Self {
            a1: 0.0, a2: 0.0, b0: 1.0, b1: 0.0, b2: 0.0,
            x1: 0.0, x2: 0.0, y1: 0.0, y2: 0.0,
            freq, gain_db, q, dirty: true, last_sr: -1.0,
        }
    }

    fn update_coefficients(&mut self, sample_rate: f64) {
        // ENTERPRISE: Only compute trigonometric math if parameters changed OR sample rate shifted.
        if !self.dirty && (self.last_sr - sample_rate).abs() < 0.01 {
            return;
        }
        self.dirty = false;
        self.last_sr = sample_rate;

        if self.gain_db.abs() < 0.05 {
            // Unity pass-through — skip computation
            self.b0 = 1.0;
            self.b1 = 0.0;
            self.b2 = 0.0;
            self.a1 = 0.0;
            self.a2 = 0.0;
            return;
        }

        // ENT-EQ-001: Guard against zero/non-finite sample_rate to prevent
        // Infinity propagation into biquad coefficients.
        if sample_rate <= 0.0 || !sample_rate.is_finite() {
            return;
        }
        let w0 = 2.0 * std::f32::consts::PI * self.freq / sample_rate as f32;
        // ENT-EQ-002: Clamp Q to minimum 0.01 to prevent / 0 in alpha.
        let safe_q = self.q.max(0.01);
        let alpha = w0.sin() / (2.0 * safe_q);
        let a = 10.0f32.powf(self.gain_db / 40.0);

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
    }

    fn process_sample(&mut self, x: f32) -> f32 {
        let y = self.b0 * x + self.b1 * self.x1 + self.b2 * self.x2
                - self.a1 * self.y1 - self.a2 * self.y2;
        self.x2 = self.x1;
        self.x1 = x;
        self.y2 = self.y1;
        self.y1 = y;
        y
    }

    fn reset(&mut self) {
        self.x1 = 0.0;
        self.x2 = 0.0;
        self.y1 = 0.0;
        self.y2 = 0.0;
    }
}

impl EqNode {
    pub fn new() -> Self {
        Self {
            bands: [
                BiquadBand::new(200.0, 0.0, 0.707),   // Low
                BiquadBand::new(1000.0, 0.0, 0.707),  // Mid
                BiquadBand::new(5000.0, 0.0, 0.707),  // High
            ],
        }
    }

    /// Set gain (dB) for low / mid / high bands from UI params.
    pub fn set_band_gains(&mut self, low_db: f32, mid_db: f32, high_db: f32) {
        let gains = [low_db, mid_db, high_db];
        for (band, &gain) in self.bands.iter_mut().zip(gains.iter()) {
            if (band.gain_db - gain).abs() > 0.01 {
                band.gain_db = gain;
                band.dirty = true;
            }
        }
    }

    /// AUDIT-G04 FIX: Returns the current gain (dB) for each band.
    /// Used by `set_node_params` to preserve existing values when
    /// only a subset of bands are updated via IPC.
    pub fn current_band_gains(&self) -> (f32, f32, f32) {
        (self.bands[0].gain_db, self.bands[1].gain_db, self.bands[2].gain_db)
    }
}

impl Default for EqNode {
    fn default() -> Self {
        Self::new()
    }
}

impl FlowNode for EqNode {
    fn process(&mut self, inputs: &[FlowSignal], outputs: &mut [FlowSignal], sample_rate: f64) {
        let input = inputs.first().cloned().unwrap_or(FlowSignal::Audio(0.0));

        let x = match input {
            FlowSignal::Audio(v) => v,
            FlowSignal::Control(v) => v,
            _ => 0.0,
        };

        // Update coefficients if dirty (lazy recompute on param change)
        for band in &mut self.bands {
            band.update_coefficients(sample_rate);
        }

        // Process through all 3 bands in series
        let mut sample = x;
        for band in &mut self.bands {
            sample = band.process_sample(sample);
        }

        outputs[0] = FlowSignal::Audio(sample);
    }

    fn reset(&mut self) {
        for band in &mut self.bands {
            band.reset();
        }
    }

    fn as_any_mut(&mut self) -> &mut dyn Any { self }
}
