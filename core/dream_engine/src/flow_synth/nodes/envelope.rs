use crate::flow_synth::graph::{FlowNode, FlowSignal};
use crate::instrument_core::{AdsrEnvelope, AdsrParams};

pub struct EnvelopeNode {
    envelope: AdsrEnvelope,
    last_gate: f32,
    params: AdsrParams,
}

impl EnvelopeNode {
    pub fn new(sample_rate: f64) -> Self {
        let params = AdsrParams::default();
        let mut envelope = AdsrEnvelope::new(sample_rate);
        envelope.set_params(&params);
        Self {
            envelope,
            last_gate: 0.0,
            params,
        }
    }
}

impl FlowNode for EnvelopeNode {
    fn process(&mut self, inputs: &[FlowSignal], outputs: &mut [FlowSignal], _sample_rate: f64) {
        // Input 0: Gate Signal (trigger when > 0.1)
        // Input 1: Attack (seconds)
        // Input 2: Decay (seconds)
        // Input 3: Sustain (level 0..1)
        // Input 4: Release (seconds)
        
        let gate = inputs[0].0;
        
        // Update parameters if they changed (simplified: always check or update periodically)
        let attack = inputs[1].0 as f64;
        let decay = inputs[2].0 as f64;
        let sustain = inputs[3].0 as f64;
        let release = inputs[4].0 as f64;

        // Check if params changed significantly to avoid recalculating every sample
        // For a 100x engine, we'd only update when changed.
        if (self.params.attack - attack).abs() > 0.001 || 
           (self.params.decay - decay).abs() > 0.001 ||
           (self.params.sustain - sustain).abs() > 0.001 ||
           (self.params.release - release).abs() > 0.001 {
            self.params = AdsrParams { attack, decay, sustain, release };
            self.envelope.set_params(&self.params);
        }

        // Gate logic: trigger note_on on rising edge, note_off on falling edge
        if gate > 0.1 && self.last_gate <= 0.1 {
            self.envelope.note_on();
        } else if gate <= 0.1 && self.last_gate > 0.1 {
            self.envelope.note_off();
        }
        self.last_gate = gate;

        outputs[0] = FlowSignal(self.envelope.process());
    }

    fn reset(&mut self) {
        self.envelope.reset();
        self.last_gate = 0.0;
    }
}
