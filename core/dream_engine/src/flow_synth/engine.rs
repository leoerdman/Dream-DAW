use crate::instrument_core::MAX_VOICES;
use crate::flow_synth::graph::{FlowGraph, FlowConnection};
use crate::flow_synth::nodes::MidiInNode;
use crate::oscillator::ParameterSmoother;
use std::collections::{HashMap, VecDeque};

/// A single polyphonic voice in the Flow Synth.
pub struct FlowVoice {
    pub active: bool,
    /// True when the voice has received note_off but is still in release phase.
    /// The voice renders until the envelope reaches idle, then transitions to inactive.
    pub releasing: bool,
    pub note: u8,
    pub velocity: u8,
    pub graph: FlowGraph,
    /// Monotonic frame counter when this voice was activated via note_on.
    /// Used for oldest-voice stealing strategy.
    pub start_frame: u64,
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
            releasing: false,
            note: 0,
            velocity: 0,
            graph: FlowGraph::new(),
            start_frame: 0,
            midi_in_index: None,
        }
    }

    pub fn reset(&mut self) {
        self.active = false;
        self.releasing = false;
        self.note = 0;
        self.velocity = 0;
        self.start_frame = 0;
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
    /// Monotonic frame counter for voice-age tracking (voice stealing).
    frame_counter: u64,
}

impl FlowSynthEngine {
    #[inline]
    fn sanitize(sample: f32) -> f32 {
        if sample.is_finite() { sample } else { 0.0 }
    }

    /// ENTERPRISE: Threshold-based soft limiter that preserves dynamics in the
    /// linear region (below threshold) and applies smooth saturation above.
    /// Previous implementation `(sample * 0.95).tanh()` ate ~26% of headroom
    /// at normal levels (tanh(0.95) ≈ 0.74).
    #[inline]
    fn soft_limit(sample: f32) -> f32 {
        let threshold = 0.8_f32;
        let abs = sample.abs();
        if abs <= threshold {
            sample // Linear pass-through — no headroom loss
        } else {
            // Smooth saturation: maps [threshold..∞) → [threshold..1.0)
            let excess = abs - threshold;
            let saturated = threshold + (1.0 - threshold) * (excess / (excess + (1.0 - threshold)));
            saturated.copysign(sample)
        }
    }

    pub fn new(sample_rate: f64) -> Self {
        let voices = std::array::from_fn(|_| FlowVoice::new());
        Self {
            voices,
            volume: ParameterSmoother::new(0.8, sample_rate, 10.0),
            sample_rate,
            enabled: false,
            frame_counter: 0,
        }
    }

    pub fn set_sample_rate(&mut self, sample_rate: f64) {
        self.sample_rate = sample_rate;
        self.volume.set_time_constant(sample_rate, 10.0);
        // AUDIT-E03 FIX: Propagate SR to graph so nodes that cache
        // SR-dependent state (ReverseNode window, AutoFilter LFO) rebuild.
        // Previously just called reset() which cleared state but left
        // SR-dependent parameters stale.
        for voice in &mut self.voices {
            voice.graph.set_sample_rate(sample_rate);
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
        nodes: &[dream_ipc::FlowNodeDescriptor],
        connections: &[(u64, usize, u64, usize)],
    ) -> Vec<dream_ipc::FlowNodeDescriptor> {
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

        // ENTERPRISE: Use VecDeque for efficient O(1) pop_front instead of Vec::remove(0).
        let mut ready: VecDeque<u64> = indegree
            .iter()
            .filter_map(|(id, &d)| if d == 0 { Some(*id) } else { None })
            .collect();
        // Sort initial ready set deterministically by original index.
        let mut ready_vec: Vec<u64> = ready.drain(..).collect();
        ready_vec.sort_by_key(|id| index_by_id.get(id).copied().unwrap_or(usize::MAX));
        ready = ready_vec.into();

        let mut ordered_ids = Vec::with_capacity(nodes.len());
        while let Some(id) = ready.pop_front() {
            ordered_ids.push(id);
            if let Some(neighbors) = outgoing.get(&id) {
                let mut new_ready = Vec::new();
                for &n in neighbors {
                    if let Some(d) = indegree.get_mut(&n) {
                        *d = d.saturating_sub(1);
                        if *d == 0 {
                            new_ready.push(n);
                        }
                    }
                }
                // Sort newly ready nodes by original index for deterministic ordering.
                new_ready.sort_by_key(|nid| index_by_id.get(nid).copied().unwrap_or(usize::MAX));
                ready.extend(new_ready);
            }
        }

        // ENTERPRISE: Detect feedback loops — if some nodes weren't reached by topo sort,
        // they form a cycle. Log a warning and append them (best-effort processing).
        if ordered_ids.len() < nodes.len() {
            let cycle_count = nodes.len() - ordered_ids.len();
            log::warn!(
                "[FlowSynth] Feedback loop detected: {} node(s) form a cycle. \
                 Sound may not render correctly. Consider breaking the loop.",
                cycle_count
            );
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
        nodes: &[dream_ipc::FlowNodeDescriptor],
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

    /// ENTERPRISE: Update a single parameter on a specific node across all polyphonic voices.
    /// Bypasses the expensive O(N) `sync_graph` topological sort and allocation.
    pub fn update_node_param(&mut self, node_id: u64, key: &str, value: &str) {
        let param_slice = [(key.to_string(), value.to_string())];
        for voice in &mut self.voices {
            voice.graph.set_node_params(node_id, &param_slice);
        }
    }

    pub fn note_on(&mut self, note: u8, velocity: u8) {
        if velocity == 0 {
            self.note_off(note);
            return;
        }

        // 1. Find idle voice (not active at all)
        let idle_idx = self.voices.iter().position(|v| !v.active);

        // 2. If no idle voice, find a releasing voice to steal (prefer oldest releasing)
        let voice_idx = if let Some(idx) = idle_idx {
            idx
        } else {
            // ENTERPRISE: Steal the oldest active voice by start_frame (not always voice[0]).
            // Prefer releasing voices first (they've already had their note_off).
            let releasing_oldest = self.voices
                .iter()
                .enumerate()
                .filter(|(_, v)| v.releasing)
                .min_by_key(|(_, v)| v.start_frame)
                .map(|(i, _)| i);

            if let Some(idx) = releasing_oldest {
                idx
            } else {
                // All voices are actively held — steal the oldest active one.
                self.voices
                    .iter()
                    .enumerate()
                    .min_by_key(|(_, v)| v.start_frame)
                    .map(|(i, _)| i)
                    .unwrap_or(0)
            }
        };

        let voice = &mut self.voices[voice_idx];
        voice.active = true;
        voice.releasing = false;
        voice.note = note;
        voice.velocity = velocity;
        voice.start_frame = self.frame_counter;
        voice.graph.reset();
        voice.set_midi_state(note, velocity, true);
    }

    pub fn note_off(&mut self, note: u8) {
        for voice in &mut self.voices {
            if voice.active && !voice.releasing && voice.note == note {
                // ENTERPRISE: Set gate to 0 but keep voice ACTIVE in releasing state.
                // The envelope handles the release phase. The render loop checks
                // for idle envelopes and deactivates voices when release finishes.
                voice.set_midi_state(note, 0, false);
                voice.releasing = true;
            }
        }
    }

    pub fn all_notes_off(&mut self) {
        for voice in &mut self.voices {
            if voice.active {
                voice.set_midi_state(voice.note, 0, false);
                voice.releasing = true;
            }
        }
    }

    pub fn render(&mut self, left_out: &mut [f32], right_out: &mut [f32], frame_count: usize) {
        if !self.enabled {
            return;
        }

        for i in 0..frame_count {
            let vol = self.volume.next();
            let mut mixed_left = 0.0_f32;
            let mut mixed_right = 0.0_f32;
            let mut rendering_voice_count = 0_u32;
            let ext_in = if i < left_out.len() && i < right_out.len() {
                0.5 * (left_out[i] + right_out[i])
            } else {
                0.0
            };

            for voice in &mut self.voices {
                if !voice.active {
                    continue;
                }

                // Check if a releasing voice has finished its envelope release.
                // Deactivate it to free the voice for future note_on events.
                if voice.releasing && voice.graph.is_envelope_idle() {
                    voice.active = false;
                    voice.releasing = false;
                    continue;
                }

                voice.graph.set_audio_in_sample(ext_in);
                let (vl, vr) = voice.graph.process_sample(self.sample_rate);
                mixed_left += Self::sanitize(vl);
                mixed_right += Self::sanitize(vr);
                rendering_voice_count += 1;
            }

            // No voices rendering (either none active or all just deactivated) — silence.
            if rendering_voice_count == 0 {
                // AUDIT-E01 FIX: Removed per-frame `frame_counter += 1`.
                // It was double-incremented: once here and once at L376 via `+= frame_count`.
                // This caused frame_counter to grow at 2× rate during mixed silence/activity
                // frames, making voice-age tracking inaccurate and stealing the wrong voice.
                continue;
            }

            // Perceptually stable gain for polyphonic summing.
            let poly_norm = 1.0 / (rendering_voice_count as f32).sqrt();
            let final_left = Self::soft_limit(mixed_left * poly_norm * vol);
            let final_right = Self::soft_limit(mixed_right * poly_norm * vol);
            // AUDIT-E02 FIX: Bounds guard on output write (mirrors ext_in read guard at L336).
            // Prevents panic if caller passes frame_count > buffer length.
            if i < left_out.len() && i < right_out.len() {
                left_out[i] += final_left;
                right_out[i] += final_right;
            }
        }

        self.frame_counter += frame_count as u64;
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

        // Need note_on for voice to be active (no more free-run mode)
        engine.note_on(60, 100);

        let mut l = vec![0.0_f32; 4096];
        let mut r = vec![0.0_f32; 4096];
        engine.render(&mut l, &mut r, 4096);

        assert!(l.iter().all(|s| s.is_finite()), "left contains non-finite sample");
        assert!(r.iter().all(|s| s.is_finite()), "right contains non-finite sample");
        let peak = l.iter().chain(r.iter()).fold(0.0_f32, |m, &v| m.max(v.abs()));
        assert!(peak <= 1.0, "expected soft-limited peak <= 1.0, got {peak}");
    }

    #[test]
    fn note_off_keeps_voice_active_during_release() {
        let mut engine = FlowSynthEngine::new(44_100.0);
        engine.set_enabled(true);
        engine.sync_graph(
            &[
                (1, "midiIn".to_string(), vec![]),
                (2, "oscillator".to_string(), vec![]),
                (3, "envelope".to_string(), vec![
                    ("attack".to_string(), "0.005".to_string()),
                    ("decay".to_string(), "0.01".to_string()),
                    ("sustain".to_string(), "0.8".to_string()),
                    ("release".to_string(), "0.1".to_string()),
                ]),
                (4, "output".to_string(), vec![]),
            ],
            &[
                (1, 0, 2, 0), // freq -> osc
                (1, 2, 3, 0), // gate -> envelope
                (2, 0, 4, 0), // osc -> output
            ],
        );

        engine.note_on(60, 100);
        let mut l = vec![0.0_f32; 512];
        let mut r = vec![0.0_f32; 512];
        engine.render(&mut l, &mut r, 512);

        // After note_off, voice should still be active (releasing)
        engine.note_off(60);
        assert!(engine.has_active_voices(), "voice should remain active in release phase");

        // Render the release — should produce non-zero audio
        let mut l2 = vec![0.0_f32; 512];
        let mut r2 = vec![0.0_f32; 512];
        engine.render(&mut l2, &mut r2, 512);
        let release_rms: f32 = (l2.iter().map(|s| s * s).sum::<f32>() / 512.0).sqrt();
        assert!(release_rms > 0.0001, "expected audible release tail, got rms={release_rms}");
    }

    #[test]
    fn voice_stealing_targets_oldest_voice() {
        let mut engine = FlowSynthEngine::new(44_100.0);
        engine.set_enabled(true);
        engine.sync_graph(
            &[
                (1, "midiIn".to_string(), vec![]),
                (2, "oscillator".to_string(), vec![]),
                (3, "output".to_string(), vec![]),
            ],
            &[
                (1, 0, 2, 0),
                (2, 0, 3, 0),
            ],
        );

        // Fill all voices
        for i in 0..MAX_VOICES {
            engine.note_on(60 + i as u8, 100);
            // Render a bit so frame_counter advances
            let mut l = vec![0.0_f32; 16];
            let mut r = vec![0.0_f32; 16];
            engine.render(&mut l, &mut r, 16);
        }

        // All voices should be active
        assert_eq!(engine.voices.iter().filter(|v| v.active).count(), MAX_VOICES);

        // Record which voice is oldest (has lowest start_frame)
        let oldest_idx = engine.voices
            .iter()
            .enumerate()
            .min_by_key(|(_, v)| v.start_frame)
            .map(|(i, _)| i)
            .unwrap();
        let oldest_note = engine.voices[oldest_idx].note;

        // Trigger one more — should steal the oldest
        engine.note_on(100, 100);
        assert_eq!(engine.voices[oldest_idx].note, 100,
            "expected oldest voice (note={oldest_note}) to be stolen, but voice at idx={oldest_idx} has note={}",
            engine.voices[oldest_idx].note);
    }

    #[test]
    fn no_free_run_background_tone() {
        let mut engine = FlowSynthEngine::new(44_100.0);
        engine.set_enabled(true);
        engine.sync_graph(
            &[
                (1, "oscillator".to_string(), vec![]),
                (2, "output".to_string(), vec![]),
            ],
            &[
                (1, 0, 2, 0),
            ],
        );

        // No note_on — just render
        let mut l = vec![0.0_f32; 512];
        let mut r = vec![0.0_f32; 512];
        engine.render(&mut l, &mut r, 512);

        let peak = l.iter().chain(r.iter()).fold(0.0_f32, |m, &v| m.max(v.abs()));
        assert!(peak < 0.0001, "expected silence without note_on, got peak={peak}");
    }

    #[test]
    fn soft_limit_preserves_dynamics() {
        // Linear region: should preserve the signal
        assert!((FlowSynthEngine::soft_limit(0.5) - 0.5).abs() < 0.001,
            "expected ~0.5, got {}", FlowSynthEngine::soft_limit(0.5));
        assert!((FlowSynthEngine::soft_limit(0.0)).abs() < 0.001);

        // Just at threshold
        assert!((FlowSynthEngine::soft_limit(0.8) - 0.8).abs() < 0.001);

        // Above threshold — saturated but never exceeds 1.0
        let heavy = FlowSynthEngine::soft_limit(5.0);
        assert!(heavy > 0.8 && heavy < 1.0, "expected saturated output in (0.8, 1.0), got {heavy}");

        // Negative values
        assert!((FlowSynthEngine::soft_limit(-0.5) + 0.5).abs() < 0.001);
    }
}
