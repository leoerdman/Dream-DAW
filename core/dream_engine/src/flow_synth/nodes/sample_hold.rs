use std::any::Any;
use crate::flow_synth::graph::{FlowNode, FlowSignal};

/// Sample & Hold Node — Captures input value on rising trigger edge.
///
/// Classic analog module: samples the input signal level when a gate/trigger
/// goes high, then holds that value until the next trigger. Essential for
/// creating stepped random modulation, quantized sequences, and track-and-hold
/// effects. Bitwig Grid equivalent: Sample / Hold module.
pub struct SampleHoldNode {
    held_value: f32,
    prev_trigger: f32,
}

impl SampleHoldNode {
    pub fn new() -> Self {
        Self {
            held_value: 0.0,
            prev_trigger: 0.0,
        }
    }
}

impl Default for SampleHoldNode {
    fn default() -> Self { Self::new() }
}

impl FlowNode for SampleHoldNode {
    fn process(&mut self, inputs: &[FlowSignal], outputs: &mut [FlowSignal], _sample_rate: f64) {
        // Input 0: signal to sample
        let signal = inputs.first().and_then(|s| s.as_float()).unwrap_or(0.0);
        // Input 1: trigger (gate)
        let trigger = inputs.get(1).and_then(|s| s.as_float()).unwrap_or(0.0);

        // Rising edge detection
        if trigger >= 0.5 && self.prev_trigger < 0.5 {
            // ENTERPRISE BUG-21 FIX: Guard against capturing NaN — once held,
            // this value is output indefinitely until next trigger.
            self.held_value = if signal.is_finite() { signal } else { 0.0 };
        }
        self.prev_trigger = trigger;

        outputs[0] = FlowSignal::Control(self.held_value);
    }

    fn reset(&mut self) {
        self.held_value = 0.0;
        self.prev_trigger = 0.0;
    }

    fn as_any_mut(&mut self) -> &mut dyn Any { self }
}
