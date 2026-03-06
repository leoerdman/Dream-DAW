use std::any::Any;
use super::super::graph::{FlowNode, FlowSignal};
use super::filter::FilterNode;

/// An AutoFilter node that combines an SVF with Modulation sources.
pub struct AutoFilterNode {
    filter: FilterNode,
    lfo_phase: f32,
    envelope_state: f32,
    base_freq: f32,
    resonance: f32,
    lfo_rate: f32,
    lfo_depth: f32,
    env_follow_depth: f32,
}

impl AutoFilterNode {
    pub fn new() -> Self {
        Self {
            filter: FilterNode::new(),
            lfo_phase: 0.0,
            envelope_state: 0.0,
            base_freq: 1000.0,
            resonance: 0.5,
            lfo_rate: 1.0,
            lfo_depth: 0.0,
            env_follow_depth: 0.0,
        }
    }
}

impl Default for AutoFilterNode {
    fn default() -> Self {
        Self::new()
    }
}

impl AutoFilterNode {
    pub fn set_filter_type_by_float(&mut self, val: f32) {
        self.filter.set_filter_type_by_float(val);
    }

    pub fn set_base_freq(&mut self, freq: f32) {
        self.base_freq = freq.clamp(20.0, 20_000.0);
    }

    pub fn set_resonance(&mut self, res: f32) {
        self.resonance = res.clamp(0.0, 0.99);
    }

    pub fn set_lfo_rate(&mut self, rate: f32) {
        self.lfo_rate = rate.clamp(0.01, 20.0);
    }

    pub fn set_lfo_depth(&mut self, depth: f32) {
        self.lfo_depth = depth.clamp(0.0, 1.0);
    }

    pub fn set_env_follow_depth(&mut self, depth: f32) {
        self.env_follow_depth = depth.clamp(0.0, 2.0);
    }
}

impl FlowNode for AutoFilterNode {
    fn process(&mut self, inputs: &[FlowSignal], outputs: &mut [FlowSignal], sample_rate: f64) {
        let input = inputs.first().cloned().unwrap_or(FlowSignal::Audio(0.0));
        let control_or_default = |idx: usize, default: f32| -> f32 {
            inputs.get(idx).and_then(|s| s.as_float()).unwrap_or(default)
        };
        let base_freq = control_or_default(1, self.base_freq);
        let resonance = control_or_default(2, self.resonance);
        let lfo_rate = control_or_default(3, self.lfo_rate);
        let lfo_depth = control_or_default(4, self.lfo_depth);
        let env_follow_depth = control_or_default(5, self.env_follow_depth);

        let input_val = input.as_float().unwrap_or(0.0);

        // ENT-AUTOFILTER-001: Guard against zero/non-finite sample_rate to prevent
        // Infinity/NaN in envelope follower exp() and LFO phase increment.
        if sample_rate <= 0.0 || !sample_rate.is_finite() {
            if let Some(out) = outputs.first_mut() {
                *out = input;
            }
            return;
        }
        let sr_f32 = sample_rate as f32;

        // Simple Envelope Follower
        let attack = 0.01;
        let release = 0.1;
        let abs_input = input_val.abs();
        if abs_input > self.envelope_state {
            self.envelope_state += (abs_input - self.envelope_state) * (1.0 - (-1.0 / (sr_f32 * attack)).exp());
        } else {
            self.envelope_state += (abs_input - self.envelope_state) * (1.0 - (-1.0 / (sr_f32 * release)).exp());
        }
        // ENTERPRISE BUG-03 FIX: Prevent permanent NaN corruption of envelope state
        if !self.envelope_state.is_finite() { self.envelope_state = 0.0; }
        if self.envelope_state.abs() < 1e-15 { self.envelope_state = 0.0; }

        // LFO (Sine) — ENTERPRISE: normalized 0..1 phase prevents f32 precision
        // drift after long sessions. Previous raw radian approach lost accuracy.
        self.lfo_phase += lfo_rate / sr_f32;
        self.lfo_phase = self.lfo_phase.fract();
        let lfo_val = (self.lfo_phase * 2.0 * std::f32::consts::PI).sin();

        // Combine modulations (in octaves/relative frequency)
        let modulation = (lfo_val * lfo_depth) + (self.envelope_state * env_follow_depth);
        let modulated_freq = base_freq * 2.0f32.powf(modulation);
        
        // Use internal FilterNode for the actual signal processing.
        let filter_inputs = [
            input,
            FlowSignal::Control(modulated_freq),
            FlowSignal::Control(resonance),
        ];
        
        self.filter.process(&filter_inputs, outputs, sample_rate);
    }

    fn reset(&mut self) {
        self.filter.reset();
        self.lfo_phase = 0.0;
        self.envelope_state = 0.0;
    }

    fn as_any_mut(&mut self) -> &mut dyn Any { self }
}
