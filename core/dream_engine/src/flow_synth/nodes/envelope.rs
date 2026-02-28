use std::any::Any;
use crate::flow_synth::graph::{FlowNode, FlowSignal};
use crate::instrument_core::{AdsrEnvelope, AdsrParams};

/// Default sample rate used when the EnvelopeNode is created without context.
const DEFAULT_SAMPLE_RATE: f64 = 44100.0;

pub struct EnvelopeNode {
    envelope: AdsrEnvelope,
    last_gate: f32,
    params: AdsrParams,
}

impl EnvelopeNode {
    /// Create with default sample rate. The audio thread will call process
    /// with the actual sample rate, but the envelope time constants are set
    /// here as a starting point.
    pub fn new() -> Self {
        let params = AdsrParams::default();
        let mut envelope = AdsrEnvelope::new(DEFAULT_SAMPLE_RATE);
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

        let gate = inputs.first().and_then(|s| s.as_float()).unwrap_or(0.0);

        // Update parameters if they changed
        let attack = inputs.get(1).and_then(|s| s.as_float()).unwrap_or(0.01) as f64;
        let decay = inputs.get(2).and_then(|s| s.as_float()).unwrap_or(0.1) as f64;
        let sustain = inputs.get(3).and_then(|s| s.as_float()).unwrap_or(0.7) as f64;
        let release = inputs.get(4).and_then(|s| s.as_float()).unwrap_or(0.3) as f64;

        if (self.params.attack - attack).abs() > 0.001
            || (self.params.decay - decay).abs() > 0.001
            || (self.params.sustain - sustain).abs() > 0.001
            || (self.params.release - release).abs() > 0.001
        {
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

        outputs[0] = FlowSignal::Control(self.envelope.process());
    }

    fn reset(&mut self) {
        self.envelope.reset();
        self.last_gate = 0.0;
    }

    fn as_any_mut(&mut self) -> &mut dyn Any { self }
}
