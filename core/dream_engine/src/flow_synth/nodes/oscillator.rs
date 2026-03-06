use std::any::Any;
use crate::flow_synth::graph::{FlowNode, FlowSignal};
use crate::synth_types::Waveform;
use crate::oscillator::oscillator_sample_blep;

pub struct OscillatorNode {
    waveform: Waveform,
    phase: f64,
    tri_state: f64,
    base_frequency_hz: f32,
}

impl Default for OscillatorNode {
    fn default() -> Self {
        Self::new()
    }
}

impl OscillatorNode {
    /// Create an oscillator with a default Sine waveform.
    /// Waveform can be changed at runtime via a control input or direct setter.
    pub fn new() -> Self {
        Self {
            waveform: Waveform::Sine,
            phase: 0.0,
            tri_state: 0.0,
            base_frequency_hz: 440.0,
        }
    }

    pub fn set_waveform(&mut self, waveform: Waveform) {
        self.waveform = waveform;
    }

    pub fn set_waveform_by_float(&mut self, val: f32) {
        self.waveform = match val as i32 {
            1 => Waveform::Saw,
            2 => Waveform::Square,
            3 => Waveform::Triangle,
            _ => Waveform::Sine,
        };
    }

    pub fn set_base_frequency(&mut self, freq_hz: f32) {
        self.base_frequency_hz = freq_hz.clamp(20.0, 20_000.0);
    }
}

impl FlowNode for OscillatorNode {
    fn process(&mut self, inputs: &[FlowSignal], outputs: &mut [FlowSignal], sample_rate: f64) {
        // Input 0: Frequency in Hz (CV)
        // Input 1: Pulse Width (0..1)
        // Input 2: FM (Frequency modulation)
        // Input 3: PM (Phase modulation)

        let control_or_default = |idx: usize, default: f32| -> f32 {
            inputs.get(idx).and_then(|s| s.as_float()).unwrap_or(default)
        };

        let freq_hz = control_or_default(0, self.base_frequency_hz).max(0.0) as f64;
        let pw = control_or_default(1, 0.5) as f64;
        let fm = control_or_default(2, 0.0) as f64;
        let pm = control_or_default(3, 0.0) as f64;

        // Apply FM — ENTERPRISE BUG-19 FIX: clamp to non-negative to prevent
        // backwards/frozen phase from strong negative FM modulation.
        let modulated_freq = (freq_hz + fm).max(0.0);
        let dt = (modulated_freq / sample_rate).clamp(0.0, 0.5);

        // Apply PM (additive to phase)
        let effective_phase = (self.phase + pm).fract();

        let sample = oscillator_sample_blep(
            self.waveform,
            effective_phase,
            dt,
            &mut self.tri_state,
            pw,
        );

        // ENTERPRISE BUG-19 FIX: Guard against NaN from BLEP edge cases
        let safe_sample = if sample.is_finite() { sample } else { 0.0 };
        outputs[0] = FlowSignal::Audio(safe_sample);

        // Advance internal phase
        self.phase = (self.phase + dt).fract();
    }

    fn reset(&mut self) {
        self.phase = 0.0;
        self.tri_state = 0.0;
    }

    fn as_any_mut(&mut self) -> &mut dyn Any { self }
}
