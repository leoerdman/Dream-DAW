use crate::instrument_core::MAX_VOICES;
use crate::flow_synth::graph::{FlowGraph, FlowConnection};
use crate::flow_synth::nodes::MidiInNode;
use crate::oscillator::ParameterSmoother;
use std::collections::HashMap;

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
        if let Some(idx) = self.midi_in_index
            && let Some(node_box) = self.graph.get_node_mut(idx)
            && let Some(midi_node) = node_box.as_any_mut().downcast_mut::<MidiInNode>()
        {
            midi_node.note = note;
            midi_node.velocity = velocity;
            midi_node.gate = gate;
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
    #[inline]
    fn sanitize(sample: f32) -> f32 {
        if sample.is_finite() { sample } else { 0.0 }
    }

    #[inline]
    fn soft_limit(sample: f32) -> f32 {
        // Gentle saturation with predictable ceiling and no hard digital clipping.
        (sample * 0.95).tanh()
    }

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
    fn topologically_sorted_nodes(
        nodes: &[(u64, String, Vec<(String, String)>)],
        connections: &[(u64, usize, u64, usize)],
    ) -> Vec<(u64, String, Vec<(String, String)>)> {
        let mut index_by_id = HashMap::with_capacity(nodes.len());
        for (idx, (id, _, _)) in nodes.iter().enumerate() {
            index_by_id.insert(*id, idx);
        }

        let mut indegree: HashMap<u64, usize> = HashMap::with_capacity(nodes.len());
        let mut outgoing: HashMap<u64, Vec<u64>> = HashMap::with_capacity(nodes.len());
        for (id, _, _) in nodes {
            indegree.insert(*id, 0);
            outgoing.insert(*id, Vec::new());
        }

        for (from_id, _, to_id, _) in connections {
            if from_id == to_id {
                continue;
            }
            if !index_by_id.contains_key(from_id) || !index_by_id.contains_key(to_id) {
                continue;
            }
            if let Some(v) = outgoing.get_mut(from_id) {
                v.push(*to_id);
            }
            if let Some(d) = indegree.get_mut(to_id) {
                *d += 1;
            }
        }

        let mut ready: Vec<u64> = indegree
            .iter()
            .filter_map(|(id, &d)| if d == 0 { Some(*id) } else { None })
            .collect();
        ready.sort_by_key(|id| index_by_id.get(id).copied().unwrap_or(usize::MAX));

        let mut ordered_ids = Vec::with_capacity(nodes.len());
        while !ready.is_empty() {
            let id = ready.remove(0);
            ordered_ids.push(id);
            if let Some(neighbors) = outgoing.get(&id) {
                for &n in neighbors {
                    if let Some(d) = indegree.get_mut(&n) {
                        *d = d.saturating_sub(1);
                        if *d == 0 {
                            ready.push(n);
                        }
                    }
                }
                ready.sort_by_key(|nid| index_by_id.get(nid).copied().unwrap_or(usize::MAX));
            }
        }

        if ordered_ids.len() < nodes.len() {
            for (id, _, _) in nodes {
                if !ordered_ids.iter().any(|v| v == id) {
                    ordered_ids.push(*id);
                }
            }
        }

        let mut by_id: HashMap<u64, (String, Vec<(String, String)>)> = HashMap::with_capacity(nodes.len());
        for (id, node_type, params) in nodes {
            by_id.insert(*id, (node_type.clone(), params.clone()));
        }

        ordered_ids
            .into_iter()
            .filter_map(|id| by_id.remove(&id).map(|(node_type, params)| (id, node_type, params)))
            .collect()
    }

    pub fn sync_graph(
        &mut self,
        nodes: &[(u64, String, Vec<(String, String)>)],
        connections: &[(u64, usize, u64, usize)],
    ) {
        let ordered_nodes = Self::topologically_sorted_nodes(nodes, connections);
        for voice in &mut self.voices {
            voice.graph.clear();
            voice.midi_in_index = None;

            for (id, node_type, params) in &ordered_nodes {
                voice.graph.add_node(*id, node_type);
                voice.graph.set_node_params(*id, params);

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
        let active_voice_count = self.voices.iter().filter(|v| v.active).count().max(1) as f32;
        let poly_norm = if has_active_voices {
            // Perceptually stable gain for polyphonic summing.
            1.0 / active_voice_count.sqrt()
        } else {
            1.0
        };
        // Free-run mode: when there are no active MIDI voices, still render voice 0
        // continuously so oscillator patches always produce signal.
        let free_run_without_midi = !has_active_voices;

        for i in 0..frame_count {
            let vol = self.volume.next();
            let mut mixed_sample = 0.0;
            let ext_in = if i < left_out.len() && i < right_out.len() {
                0.5 * (left_out[i] + right_out[i])
            } else {
                0.0
            };

            if has_active_voices {
                for voice in &mut self.voices {
                    if !voice.active {
                        continue;
                    }
                    voice.graph.set_audio_in_sample(ext_in);
                    mixed_sample += Self::sanitize(voice.graph.process_sample(self.sample_rate));
                }
            } else if free_run_without_midi {
                self.voices[0].graph.set_audio_in_sample(ext_in);
                mixed_sample = Self::sanitize(self.voices[0].graph.process_sample(self.sample_rate));
            }

            let final_out = Self::soft_limit(Self::sanitize(mixed_sample) * poly_norm * vol);
            left_out[i] += final_out;
            right_out[i] += final_out;
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn flow_engine_output_is_finite_and_bounded_under_feedback() {
        let mut engine = FlowSynthEngine::new(44_100.0);
        engine.set_enabled(true);
        engine.sync_graph(
            &[
                (1, "oscillator".to_string(), vec![]),
                (2, "reverse".to_string(), vec![
                    ("windowMs".to_string(), "30".to_string()),
                    ("feedback".to_string(), "0.95".to_string()),
                    ("mix".to_string(), "1.0".to_string()),
                ]),
                (3, "output".to_string(), vec![]),
            ],
            &[
                (1, 0, 2, 0),
                (2, 0, 3, 0),
            ],
        );

        let mut l = vec![0.0_f32; 4096];
        let mut r = vec![0.0_f32; 4096];
        engine.render(&mut l, &mut r, 4096);

        assert!(l.iter().all(|s| s.is_finite()), "left contains non-finite sample");
        assert!(r.iter().all(|s| s.is_finite()), "right contains non-finite sample");
        let peak = l.iter().chain(r.iter()).fold(0.0_f32, |m, &v| m.max(v.abs()));
        assert!(peak <= 1.0, "expected soft-limited peak <= 1.0, got {peak}");
    }
}
