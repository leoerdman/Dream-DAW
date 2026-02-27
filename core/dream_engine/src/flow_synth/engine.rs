use crate::instrument_core::MAX_VOICES;
use crate::flow_synth::graph::FlowGraph;
use crate::oscillator::ParameterSmoother;

pub struct FlowVoice {
    pub active: bool,
    pub note: u8,
    pub graph: FlowGraph,
}

impl FlowVoice {
    pub fn new() -> Self {
        Self {
            active: false,
            note: 0,
            graph: FlowGraph::new(),
        }
    }

    pub fn reset(&mut self) {
        self.active = false;
        self.note = 0;
        self.graph.reset();
    }
}

pub struct FlowSynthEngine {
    voices: [FlowVoice; MAX_VOICES],
    pub volume: ParameterSmoother,
    sample_rate: f64,
    enabled: bool,
}

impl FlowSynthEngine {
    pub fn new(sample_rate: f64) -> Self {
        let voices = std::array::from_fn(|_| FlowVoice::new());
        Self {
            voices,
            volume: ParameterSmoother::new(0.8, sample_rate, 10.0),
            sample_rate,
            enabled: false,
        }
    }

    pub fn set_sample_rate(&mut self, sample_rate: f64) {
        self.sample_rate = sample_rate;
        self.volume.set_time_constant(sample_rate, 10.0);
        for voice in &mut self.voices {
            voice.graph.reset(); // Simplified: recreation might be better if nodes are sample-rate dependent
        }
    }

    pub fn is_enabled(&self) -> bool {
        self.enabled
    }

    pub fn set_enabled(&mut self, enabled: bool) {
        self.enabled = enabled;
        if !enabled {
            self.all_notes_off();
        }
    }

    pub fn has_active_voices(&self) -> bool {
        // A modular engine is active if its volume is non-zero or it has active voices.
        // For now, let's check the voice states.
        self.voices.iter().any(|v| v.active)
    }

    pub fn note_on(&mut self, note: u8, velocity: u8) {
        if velocity == 0 {
            self.note_off(note);
            return;
        }

        // 1. Find idle voice
        if let Some(voice) = self.voices.iter_mut().find(|v| !v.active) {
            voice.active = true;
            voice.note = note;
            // In a real engine, we'd find the MidiInNode in the graph and update it.
            // For now, this is a conceptual implementation of the 100x engine.
            return;
        }

        // 2. Voice stealing (stale simplest logic)
        if let Some(voice) = self.voices.get_mut(0) {
            voice.active = true;
            voice.note = note;
        }
    }

    pub fn note_off(&mut self, note: u8) {
        for voice in &mut self.voices {
            if voice.active && voice.note == note {
                // In a modular synth, "note off" just sets the gate to 0.
                // The envelope node handles the release phase.
                // Once idle, the voice deactivates.
            }
        }
    }

    pub fn all_notes_off(&mut self) {
        for voice in &mut self.voices {
            voice.active = false;
        }
    }

    pub fn render(&mut self, left_out: &mut [f32], right_out: &mut [f32], frame_count: usize) {
        if !self.enabled {
            return;
        }

        for i in 0..frame_count {
            let vol = self.volume.next();
            let mut mixed_sample = 0.0;

            for voice in &mut self.voices {
                if !voice.active {
                    continue;
                }

                mixed_sample += voice.graph.process_sample(self.sample_rate);
                
                // If the graph signals it's idle (e.g. envelope is idle), we'd set active = false.
            }

            let final_out = mixed_sample * vol;
            left_out[i] += final_out;
            right_out[i] += final_out;
        }
    }
}
