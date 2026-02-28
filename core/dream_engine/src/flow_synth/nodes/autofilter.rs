use std::any::Any;
use super::super::graph::{FlowNode, FlowSignal};
use super::filter::FilterNode;

/// An AutoFilter node that combines an SVF with Modulation sources.
pub struct AutoFilterNode {
    filter: FilterNode,
    lfo_phase: f32,
    envelope_state: f32,
}

impl AutoFilterNode {
    pub fn new() -> Self {
        Self {
            filter: FilterNode::new(),
            lfo_phase: 0.0,
            envelope_state: 0.0,
        }
    }
}

impl FlowNode for AutoFilterNode {
    fn process(&mut self, inputs: &[FlowSignal], outputs: &mut [FlowSignal], sample_rate: f64) {
        let input = inputs.first().cloned().unwrap_or(FlowSignal::Audio(0.0));
        let base_freq = inputs.get(1).and_then(|s| s.as_float()).unwrap_or(1000.0);
        let resonance = inputs.get(2).and_then(|s| s.as_float()).unwrap_or(0.5);
        let lfo_rate = inputs.get(3).and_then(|s| s.as_float()).unwrap_or(1.0);
        let lfo_depth = inputs.get(4).and_then(|s| s.as_float()).unwrap_or(0.0);
        let env_follow_depth = inputs.get(5).and_then(|s| s.as_float()).unwrap_or(0.0);

        let input_val = input.as_float().unwrap_or(0.0);

        // Simple Envelope Follower
        let attack = 0.01;
        let release = 0.1;
        let abs_input = input_val.abs();
        if abs_input > self.envelope_state {
            self.envelope_state += (abs_input - self.envelope_state) * (1.0 - (-1.0 / (sample_rate as f32 * attack)).exp());
        } else {
            self.envelope_state += (abs_input - self.envelope_state) * (1.0 - (-1.0 / (sample_rate as f32 * release)).exp());
        }

        // LFO (Sine)
        self.lfo_phase += 2.0 * std::f32::consts::PI * lfo_rate / sample_rate as f32;
        if self.lfo_phase > 2.0 * std::f32::consts::PI {
            self.lfo_phase -= 2.0 * std::f32::consts::PI;
        }
        let lfo_val = self.lfo_phase.sin();

        // Combine modulations (in octaves/relative frequency)
        let modulation = (lfo_val * lfo_depth) + (self.envelope_state * env_follow_depth);
        let modulated_freq = base_freq * 2.0f32.powf(modulation);
        
        // Use internal FilterNode for the actual signal processing
        // FilterNode inputs: 0: Audio, 1: Freq, 2: Res, 3: Type (0.0=LP)
        let filter_inputs = [
            input,
            FlowSignal::Control(modulated_freq),
            FlowSignal::Control(resonance),
            FlowSignal::Control(0.0), // LP
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
