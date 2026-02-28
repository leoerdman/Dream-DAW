use crate::instrument_core::MAX_VOICES;
use crate::flow_synth::graph::{FlowGraph, FlowConnection};
use crate::flow_synth::nodes::MidiInNode;
use crate::oscillator::ParameterSmoother;

/// A single polyphonic voice in the Flow Synth.
pub struct FlowVoice {
    pub active: bool,
    pub note: u8,
    pub velocity: u8,
    pub graph: FlowGraph,
    /// Index of the MidiInNode inside the graph (if present).
    midi_in_index: Option<usize>,
}

impl Default for FlowVoice {
    fn default() -> Self {
        Self::new()
    }
}


impl FlowVoice {
    pub fn new() -> Self {
        Self {
            active: false,
            note: 0,
            velocity: 0,
            graph: FlowGraph::new(),
            midi_in_index: None,
        }
    }

    pub fn reset(&mut self) {
        self.active = false;
        self.note = 0;
        self.velocity = 0;
        self.graph.reset();
    }

    /// Set gate/note/velocity on this voice's MidiInNode.
    fn set_midi_state(&mut self, note: u8, velocity: u8, gate: bool) {
        if let Some(idx) = self.midi_in_index {
            if let Some(node_box) = self.graph.get_node_mut(idx) {
                if let Some(midi_node) = node_box.as_any_mut().downcast_mut::<MidiInNode>() {
                    midi_node.note = note;
                    midi_node.velocity = velocity;
                    midi_node.gate = gate;
                }
            }
        }
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
            voice.graph.reset();
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
        self.voices.iter().any(|v| v.active)
    }

    /// Synchronize the entire graph structure from the UI thread.
    /// This is called from the command handler and replaces all voices' graphs.
    pub fn sync_graph(&mut self, nodes: &[(u64, String)], connections: &[(u64, usize, u64, usize)]) {
        for voice in &mut self.voices {
            voice.graph.clear();
            voice.midi_in_index = None;

            for (id, node_type) in nodes {
                voice.graph.add_node(*id, node_type);

                // Track the MidiInNode index for note routing.
                if node_type == "midiIn" || node_type == "midi_in" {
                    voice.midi_in_index = voice.graph.get_node_index(*id);
                }
            }
            for &(from_id, from_port, to_id, to_port) in connections {
                voice.graph.add_connection(FlowConnection {
                    from_node: from_id,
                    from_port,
                    to_node: to_id,
                    to_port,
                });
            }
        }
    }

    pub fn note_on(&mut self, note: u8, velocity: u8) {
        if velocity == 0 {
            self.note_off(note);
            return;
        }

        // 1. Find idle voice
        let voice = self.voices.iter_mut().find(|v| !v.active);

        let voice = if let Some(v) = voice {
            v
        } else {
            // 2. Voice stealing: steal the oldest active voice (index 0)
            &mut self.voices[0]
        };

        voice.active = true;
        voice.note = note;
        voice.velocity = velocity;
        voice.set_midi_state(note, velocity, true);
    }

    pub fn note_off(&mut self, note: u8) {
        for voice in &mut self.voices {
            if voice.active && voice.note == note {
                // Set gate to 0 — the envelope handles the release phase.
                voice.set_midi_state(note, 0, false);
                // Mark voice as inactive immediately.
                // In a proper modular synth with release tails, we'd defer this
                // until the envelope signals idle. For now, immediate deactivation.
                voice.active = false;
            }
        }
    }

    pub fn all_notes_off(&mut self) {
        for voice in &mut self.voices {
            if voice.active {
                voice.set_midi_state(voice.note, 0, false);
                voice.active = false;
            }
        }
    }

    pub fn render(&mut self, left_out: &mut [f32], right_out: &mut [f32], frame_count: usize) {
        if !self.enabled {
            return;
        }

        let has_active_voices = self.voices.iter().any(|v| v.active);
        // Free-run mode: when there are no active MIDI voices, still render voice 0
        // continuously so oscillator patches always produce signal.
        let free_run_without_midi = !has_active_voices;

        for i in 0..frame_count {
            let vol = self.volume.next();
            let mut mixed_sample = 0.0;

            if has_active_voices {
                for voice in &mut self.voices {
                    if !voice.active {
                        continue;
                    }
                    mixed_sample += voice.graph.process_sample(self.sample_rate);
                }
            } else if free_run_without_midi {
                mixed_sample = self.voices[0].graph.process_sample(self.sample_rate);
            }

            let final_out = mixed_sample * vol;
            left_out[i] += final_out;
            right_out[i] += final_out;
        }
    }
}
