use crate::flow_synth::graph::{FlowNode, FlowSignal};
use crate::synth_types::SynthFilterType;
use dream_dsp::svf::SvfState;

pub struct FilterNode {
    filter_type: SynthFilterType,
    state: SvfState,
}

impl FilterNode {
    pub fn new(filter_type: SynthFilterType) -> Self {
        Self {
            filter_type,
            state: SvfState::default(),
        }
    }
}

impl FlowNode for FilterNode {
    fn process(&mut self, inputs: &[FlowSignal], outputs: &mut [FlowSignal], sample_rate: f64) {
        // Input 0: Audio Signal to filter
        // Input 1: Cutoff Frequency in Hz
        // Input 2: Resonance (0..1)
        
        let input = inputs[0].0;
        let cutoff = inputs[1].0.clamp(20.0, 20000.0) as f64;
        let resonance = inputs[2].0.clamp(0.0, 0.99) as f64;

        let inv_sr = 1.0 / sample_rate;
        let g = (std::f64::consts::PI * cutoff * inv_sr).tan() as f32;
        let k = (2.0 * (1.0 - resonance)) as f32;

        // Denormal flush
        if self.state.ic1eq.abs() < 1e-18 { self.state.ic1eq = 0.0; }
        if self.state.ic2eq.abs() < 1e-18 { self.state.ic2eq = 0.0; }

        let ic1eq = self.state.ic1eq;
        let ic2eq = self.state.ic2eq;

        let a1 = 1.0 / (1.0 + g * (g + k));
        let a2 = g * a1;
        let a3 = g * a2;

        let v3 = input - ic2eq;
        let v1 = a1 * ic1eq + a2 * v3;
        let v2 = ic2eq + a2 * ic1eq + a3 * v3;

        self.state.ic1eq = 2.0 * v1 - ic1eq;
        self.state.ic2eq = 2.0 * v2 - ic2eq;

        let lp = v2;
        let bp = v1;
        let hp = input - k * v1 - v2;

        let filtered = match self.filter_type {
            SynthFilterType::Lowpass => lp,
            SynthFilterType::Highpass => hp,
            SynthFilterType::Bandpass => bp,
            SynthFilterType::Notch => lp + hp,
        };

        outputs[0] = FlowSignal(filtered);
    }

    fn reset(&mut self) {
        self.state.reset();
    }
}
