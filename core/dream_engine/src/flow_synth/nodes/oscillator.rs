use crate::flow_synth::graph::{FlowNode, FlowSignal};
use crate::synth_types::Waveform;
use crate::oscillator::oscillator_sample_blep;

pub struct OscillatorNode {
    waveform: Waveform,
    phase: f64,
    tri_state: f64,
}

impl OscillatorNode {
    pub fn new(waveform: Waveform) -> Self {
        Self {
            waveform,
            phase: 0.0,
            tri_state: 0.0,
        }
    }
}

impl FlowNode for OscillatorNode {
    fn process(&mut self, inputs: &[FlowSignal], outputs: &mut [FlowSignal], sample_rate: f64) {
        // Input 0: Frequency in Hz (CV)
        // Input 1: Pulse Width (0..1)
        // Input 2: FM (Frequency modulation)
        // Input 3: PM (Phase modulation)
        
        let freq_hz = inputs[0].0.max(0.0) as f64;
        let pw = inputs[1].0 as f64;
        let fm = inputs[2].0 as f64;
        let pm = inputs[3].0 as f64;

        // Apply FM
        let modulated_freq = freq_hz + fm;
        let dt = (modulated_freq / sample_rate).clamp(0.0, 0.5);

        // Apply PM (additive to phase)
        let effective_phase = (self.phase + pm).fract();

        outputs[0] = FlowSignal(oscillator_sample_blep(
            self.waveform,
            effective_phase,
            dt,
            &mut self.tri_state,
            pw,
        ));

        // Advance internal phase
        self.phase = (self.phase + dt).fract();
    }

    fn reset(&mut self) {
        self.phase = 0.0;
        self.tri_state = 0.0;
    }
}
