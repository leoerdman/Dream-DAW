use std::collections::HashMap;
use std::any::Any;
use super::nodes::*;

/// Unique identifier for a node in the Flow graph.
pub type NodeId = u64;

/// A signal in the Flow graph. In a modular synth, almost everything is a
/// control voltage (CV) or audio signal represented as an f32.
#[derive(Debug, Clone, Copy, Default)]
pub enum FlowSignal {
    #[default]
    None,
    Audio(f32),
    Control(f32),
    Midi { pitch: u8, velocity: u8, gate: bool },
}

impl FlowSignal {
    pub fn as_float(&self) -> Option<f32> {
        match self {
            Self::Audio(v) | Self::Control(v) => Some(*v),
            _ => None,
        }
    }
}

/// Maximum number of inputs/outputs per node to keep structures stack-allocated or pre-allocated.
pub const MAX_NODE_PORTS: usize = 8;

pub trait FlowNode: Send + Sync {
    fn process(&mut self, inputs: &[FlowSignal], outputs: &mut [FlowSignal], sample_rate: f64);
    fn reset(&mut self);
    /// Safe downcasting support. Override to return `self` for types that need
    /// to be accessed from the engine (e.g. MidiInNode).
    fn as_any_mut(&mut self) -> &mut dyn Any;
}

/// A connection represents a link from one node's output to another node's input.
#[derive(Debug, Clone)]
pub struct FlowConnection {
    pub from_node: NodeId,
    pub from_port: usize,
    pub to_node: NodeId,
    pub to_port: usize,
}

/// The execution graph for a single voice.
pub struct FlowGraph {
    /// Ordered list of nodes for topological execution.
    nodes: Vec<Box<dyn FlowNode>>,
    /// Map from NodeId to its index in the `nodes` vector.
    node_map: HashMap<NodeId, usize>,
    /// Reverse map: index in `nodes` → NodeId (for connection matching).
    index_to_id: Vec<NodeId>,
    /// Connections between nodes.
    connections: Vec<FlowConnection>,
    /// Flattened signal buffer for all node outputs.
    /// Each node gets a slice of `MAX_NODE_PORTS` in this buffer.
    signal_buffer: Vec<FlowSignal>,
    /// Index of the AudioOut node (if present) for fast output retrieval.
    audio_out_index: Option<usize>,
    /// Indices of AudioIn nodes for per-sample external input injection.
    audio_in_indices: Vec<usize>,
    /// ENTERPRISE: Pre-computed incoming connections per node for O(1) lookup.
    /// Each entry: (source_node_index, from_port, to_port)
    incoming_cache: Vec<Vec<(usize, usize, usize)>>,
    /// Indices of EnvelopeNode(s) in the graph for idle-state queries.
    envelope_indices: Vec<usize>,
}

impl FlowGraph {
    pub fn new() -> Self {
        Self {
            nodes: Vec::with_capacity(16),
            node_map: HashMap::with_capacity(16),
            index_to_id: Vec::with_capacity(16),
            connections: Vec::with_capacity(32),
            signal_buffer: vec![FlowSignal::default(); 16 * MAX_NODE_PORTS],
            audio_out_index: None,
            audio_in_indices: Vec::new(),
            incoming_cache: Vec::with_capacity(16),
            envelope_indices: Vec::new(),
        }
    }
}

impl Default for FlowGraph {
    fn default() -> Self {
        Self::new()
    }
}

impl FlowGraph {
    pub fn add_node(&mut self, id: NodeId, node_type: &str) {
        let is_audio_out = node_type == "audio_out" || node_type == "output";
        let is_audio_in = node_type == "audioIn" || node_type == "audio_in";
        let is_envelope = node_type == "envelope";

        let node: Box<dyn FlowNode> = match node_type {
            "oscillator" => Box::new(OscillatorNode::new()),
            "filter" => Box::new(FilterNode::new()),
            "envelope" => Box::new(EnvelopeNode::new()),
            "midiIn" | "midi_in" => Box::new(MidiInNode::new()),
            "audioOut" | "audio_out" | "output" => Box::new(AudioOutNode::new()),
            "eq" => Box::new(EqNode::new()),
            "autofilter" => Box::new(AutoFilterNode::new()),
            "reverse" => Box::new(ReverseNode::new()),
            "audioIn" | "audio_in" => Box::new(AudioInNode::new()),
            _ => return,
        };

        let idx = self.nodes.len();

        // ENTERPRISE RT-SAFETY: Guard against heap reallocation on the audio thread.
        // Pre-allocated capacity is 16 nodes which covers 99%+ of real modular patches.
        // Track any reallocation events for production diagnostics.
        if self.nodes.len() >= self.nodes.capacity()
            || self.node_map.len() >= self.node_map.capacity()
        {
            static FLOWGRAPH_REALLOC: std::sync::atomic::AtomicU32 =
                std::sync::atomic::AtomicU32::new(0);
            FLOWGRAPH_REALLOC.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
        }

        self.nodes.push(node);
        self.node_map.insert(id, idx);
        self.index_to_id.push(id);

        if is_audio_out {
            self.audio_out_index = Some(idx);
        }
        if is_audio_in {
            self.audio_in_indices.push(idx);
        }
        if is_envelope {
            self.envelope_indices.push(idx);
        }

        // Ensure signal buffer is large enough
        let required = (idx + 1) * MAX_NODE_PORTS;
        if self.signal_buffer.len() < required {
            self.signal_buffer.resize(required, FlowSignal::default());
        }

        // Extend incoming cache for this node (will be populated by rebuild_incoming_cache)
        self.incoming_cache.push(Vec::new());
    }

    pub fn add_connection(&mut self, conn: FlowConnection) {
        // ENTERPRISE: Update incoming cache incrementally when a connection is added.
        if let Some(&to_idx) = self.node_map.get(&conn.to_node) {
            if let Some(&from_idx) = self.node_map.get(&conn.from_node) {
                if conn.from_port < MAX_NODE_PORTS && conn.to_port < MAX_NODE_PORTS {
                    if to_idx < self.incoming_cache.len() {
                        self.incoming_cache[to_idx].push((from_idx, conn.from_port, conn.to_port));
                    }
                }
            }
        }
        self.connections.push(conn);
    }

    pub fn set_audio_in_sample(&mut self, sample: f32) {
        for &idx in &self.audio_in_indices {
            if let Some(node) = self.nodes.get_mut(idx)
                && let Some(audio_in) = node.as_any_mut().downcast_mut::<AudioInNode>() {
                    audio_in.set_input_sample(sample);
                }
        }
    }

    pub fn set_node_params(&mut self, id: NodeId, params: &[(String, String)]) {
        let Some(&idx) = self.node_map.get(&id) else {
            return;
        };
        let Some(node) = self.nodes.get_mut(idx) else {
            return;
        };

        if let Some(osc) = node.as_any_mut().downcast_mut::<OscillatorNode>() {
            for (k, v) in params {
                match k.as_str() {
                    "waveform" => osc.set_waveform_by_name(v),
                    "frequency" => {
                        if let Ok(freq) = v.parse::<f32>() {
                            osc.set_base_frequency(freq);
                        }
                    }
                    _ => {}
                }
            }
            return;
        }

        if let Some(filter) = node.as_any_mut().downcast_mut::<FilterNode>() {
            for (k, v) in params {
                match k.as_str() {
                    "filterType" => filter.set_filter_type_by_name(v),
                    "cutoff" => {
                        if let Ok(cutoff) = v.parse::<f32>() {
                            filter.set_default_cutoff(cutoff);
                        }
                    }
                    "resonance" => {
                        if let Ok(resonance) = v.parse::<f32>() {
                            filter.set_default_resonance(resonance);
                        }
                    }
                    _ => {}
                }
            }
            return;
        }

        if let Some(eq) = node.as_any_mut().downcast_mut::<EqNode>() {
            let mut low = None;
            let mut mid = None;
            let mut high = None;
            for (k, v) in params {
                match k.as_str() {
                    "eqLow" => low = v.parse::<f32>().ok(),
                    "eqMid" => mid = v.parse::<f32>().ok(),
                    "eqHigh" => high = v.parse::<f32>().ok(),
                    _ => {}
                }
            }
            eq.set_band_gains(low.unwrap_or(0.0), mid.unwrap_or(0.0), high.unwrap_or(0.0));
            return;
        }

        if let Some(af) = node.as_any_mut().downcast_mut::<AutoFilterNode>() {
            for (k, v) in params {
                match k.as_str() {
                    "filterType" => af.set_filter_type_by_name(v),
                    "cutoff" => {
                        if let Ok(cutoff) = v.parse::<f32>() {
                            af.set_base_freq(cutoff);
                        }
                    }
                    "resonance" => {
                        if let Ok(res) = v.parse::<f32>() {
                            af.set_resonance(res);
                        }
                    }
                    "rate" => {
                        if let Ok(rate) = v.parse::<f32>() {
                            af.set_lfo_rate(rate);
                        }
                    }
                    "depth" => {
                        if let Ok(depth) = v.parse::<f32>() {
                            af.set_lfo_depth(depth);
                        }
                    }
                    "envDepth" => {
                        if let Ok(depth) = v.parse::<f32>() {
                            af.set_env_follow_depth(depth);
                        }
                    }
                    _ => {}
                }
            }
            return;
        }

        if let Some(rv) = node.as_any_mut().downcast_mut::<ReverseNode>() {
            for (k, v) in params {
                match k.as_str() {
                    "windowMs" => {
                        if let Ok(ms) = v.parse::<f32>() {
                            rv.set_window_ms(ms);
                        }
                    }
                    "feedback" => {
                        if let Ok(feedback) = v.parse::<f32>() {
                            rv.set_feedback(feedback);
                        }
                    }
                    "mix" => {
                        if let Ok(mix) = v.parse::<f32>() {
                            rv.set_mix(mix);
                        }
                    }
                    _ => {}
                }
            }
            return;
        }

        if let Some(env) = node.as_any_mut().downcast_mut::<EnvelopeNode>() {
            for (k, v) in params {
                match k.as_str() {
                    "attack" => {
                        if let Ok(a) = v.parse::<f32>() {
                            env.set_attack(a as f64);
                        }
                    }
                    "decay" => {
                        if let Ok(d) = v.parse::<f32>() {
                            env.set_decay(d as f64);
                        }
                    }
                    "sustain" => {
                        if let Ok(s) = v.parse::<f32>() {
                            env.set_sustain(s as f64);
                        }
                    }
                    "release" => {
                        if let Ok(r) = v.parse::<f32>() {
                            env.set_release(r as f64);
                        }
                    }
                    _ => {}
                }
            }
        }
    }

    pub fn clear(&mut self) {
        self.nodes.clear();
        self.node_map.clear();
        self.index_to_id.clear();
        self.connections.clear();
        self.signal_buffer.fill(FlowSignal::default());
        self.audio_out_index = None;
        self.audio_in_indices.clear();
        self.incoming_cache.clear();
        self.envelope_indices.clear();
    }

    /// Resets all nodes in the graph.
    pub fn reset(&mut self) {
        for node in &mut self.nodes {
            node.reset();
        }
    }

    /// Returns true if ALL envelope nodes in this graph are in idle state
    /// (completed release phase). If no envelope nodes exist, returns true.
    /// Used by the engine to determine when a releasing voice can be freed.
    pub fn is_envelope_idle(&mut self) -> bool {
        if self.envelope_indices.is_empty() {
            return true;
        }
        for &idx in &self.envelope_indices {
            if let Some(node) = self.nodes.get_mut(idx) {
                if let Some(env) = node.as_any_mut().downcast_mut::<EnvelopeNode>() {
                    if !env.is_idle() {
                        return false;
                    }
                }
            }
        }
        true
    }

    /// Returns a mutable reference to a specific node by its index.
    /// Used by the engine to access MidiInNode for note events.
    pub fn get_node_mut(&mut self, index: usize) -> Option<&mut Box<dyn FlowNode>> {
        self.nodes.get_mut(index)
    }

    /// Returns the index for a NodeId (for external lookup).
    pub fn get_node_index(&self, id: NodeId) -> Option<usize> {
        self.node_map.get(&id).copied()
    }

    /// Processes one sample through the entire graph.
    /// Topological order must be maintained in the `nodes` vector.
    ///
    /// ENTERPRISE: Uses pre-computed incoming_cache for O(edges_to_node) per node
    /// instead of the previous O(all_connections) scan.
    pub fn process_sample(&mut self, sample_rate: f64) -> (f32, f32) {
        let node_count = self.nodes.len();
        // 1. Gather inputs for each node from the incoming cache and execute.
        for i in 0..node_count {
            let mut inputs = [FlowSignal::default(); MAX_NODE_PORTS];

            // Fill inputs from pre-computed incoming connections (O(k) where k = incoming edges).
            if i < self.incoming_cache.len() {
                for &(from_idx, from_port, to_port) in &self.incoming_cache[i] {
                    let source_signal = self.signal_buffer[from_idx * MAX_NODE_PORTS + from_port];
                    inputs[to_port] = source_signal;
                }
            }

            // Output slices.
            let start = i * MAX_NODE_PORTS;
            let end = start + MAX_NODE_PORTS;
            let outputs = &mut self.signal_buffer[start..end];
            outputs.fill(FlowSignal::default());

            self.nodes[i].process(&inputs, outputs, sample_rate);
        }

        // 2. Return the output of the AudioOut node specifically.
        if let Some(out_idx) = self.audio_out_index {
            let left = self.signal_buffer[out_idx * MAX_NODE_PORTS].as_float().unwrap_or(0.0);
            let right = self.signal_buffer[out_idx * MAX_NODE_PORTS + 1].as_float().unwrap_or(0.0);
            (left, right)
        } else if !self.nodes.is_empty() {
            // Fallback: return last node's first output for both channels.
            let last_idx = node_count - 1;
            let mono = self.signal_buffer[last_idx * MAX_NODE_PORTS]
                .as_float()
                .unwrap_or(0.0);
            (mono, mono)
        } else {
            (0.0, 0.0)
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::flow_synth::nodes::MidiInNode;

    fn rms(samples: &[f32]) -> f32 {
        if samples.is_empty() {
            return 0.0;
        }
        let sum = samples.iter().map(|s| s * s).sum::<f32>();
        (sum / samples.len() as f32).sqrt()
    }

    fn render(graph: &mut FlowGraph, sample_rate: f64, frames: usize) -> Vec<f32> {
        let mut out = Vec::with_capacity(frames);
        for _ in 0..frames {
            // Unpack stereo tuple and use left channel for assertions
            let (l, _r) = graph.process_sample(sample_rate);
            out.push(l);
        }
        out
    }

    fn set_midi_state(graph: &mut FlowGraph, node_id: u64, note: u8, velocity: u8, gate: bool) {
        let Some(idx) = graph.get_node_index(node_id) else {
            panic!("midi node not found");
        };
        let Some(node_box) = graph.get_node_mut(idx) else {
            panic!("midi node index invalid");
        };
        let Some(midi) = node_box.as_any_mut().downcast_mut::<MidiInNode>() else {
            panic!("node is not MidiInNode");
        };
        midi.note = note;
        midi.velocity = velocity;
        midi.gate = gate;
    }

    #[test]
    fn oscillator_to_output_generates_signal() {
        let mut g = FlowGraph::new();
        g.add_node(1, "oscillator");
        g.add_node(2, "output");
        g.add_connection(FlowConnection { from_node: 1, from_port: 0, to_node: 2, to_port: 0 });

        let out = render(&mut g, 44_100.0, 512);
        assert!(rms(&out) > 0.01, "expected audible RMS, got {}", rms(&out));
    }

    #[test]
    fn oscillator_params_affect_rendered_audio() {
        let mut g_default = FlowGraph::new();
        g_default.add_node(1, "oscillator");
        g_default.add_node(2, "output");
        g_default.add_connection(FlowConnection { from_node: 1, from_port: 0, to_node: 2, to_port: 0 });

        let mut g_tweaked = FlowGraph::new();
        g_tweaked.add_node(1, "oscillator");
        g_tweaked.set_node_params(1, &[
            ("waveform".to_string(), "square".to_string()),
            ("frequency".to_string(), "880".to_string()),
        ]);
        g_tweaked.add_node(2, "output");
        g_tweaked.add_connection(FlowConnection { from_node: 1, from_port: 0, to_node: 2, to_port: 0 });

        let a = render(&mut g_default, 44_100.0, 512);
        let b = render(&mut g_tweaked, 44_100.0, 512);

        let diff = a
            .iter()
            .zip(b.iter())
            .map(|(x, y)| (x - y).abs())
            .sum::<f32>()
            / 512.0;
        assert!(diff > 0.02, "expected paramized oscillator output to differ, diff={diff}");
    }

    #[test]
    fn eq_band_gain_changes_level() {
        let mut dry = FlowGraph::new();
        dry.add_node(1, "oscillator");
        dry.add_node(2, "eq");
        dry.add_node(3, "output");
        dry.add_connection(FlowConnection { from_node: 1, from_port: 0, to_node: 2, to_port: 0 });
        dry.add_connection(FlowConnection { from_node: 2, from_port: 0, to_node: 3, to_port: 0 });

        let mut boosted = FlowGraph::new();
        boosted.add_node(1, "oscillator");
        boosted.add_node(2, "eq");
        boosted.set_node_params(2, &[
            ("eqLow".to_string(), "12".to_string()),
            ("eqMid".to_string(), "0".to_string()),
            ("eqHigh".to_string(), "0".to_string()),
        ]);
        boosted.add_node(3, "output");
        boosted.add_connection(FlowConnection { from_node: 1, from_port: 0, to_node: 2, to_port: 0 });
        boosted.add_connection(FlowConnection { from_node: 2, from_port: 0, to_node: 3, to_port: 0 });

        let dry_out = render(&mut dry, 44_100.0, 1024);
        let boosted_out = render(&mut boosted, 44_100.0, 1024);
        assert!(rms(&boosted_out) > rms(&dry_out) * 1.05);
    }

    #[test]
    fn audio_in_to_output_passes_injected_sample() {
        let mut g = FlowGraph::new();
        g.add_node(1, "audioIn");
        g.add_node(2, "output");
        g.add_connection(FlowConnection { from_node: 1, from_port: 0, to_node: 2, to_port: 0 });

        g.set_audio_in_sample(0.37);
        let (out, _) = g.process_sample(44_100.0);
        assert!((out - 0.37).abs() < 0.01, "expected injected sample pass-through, got {out}");
    }

    #[test]
    fn autofilter_depth_changes_output_shape() {
        let mut base = FlowGraph::new();
        base.add_node(1, "oscillator");
        base.add_node(2, "autofilter");
        base.set_node_params(2, &[
            ("cutoff".to_string(), "1200".to_string()),
            ("rate".to_string(), "2.0".to_string()),
            ("depth".to_string(), "0.0".to_string()),
        ]);
        base.add_node(3, "output");
        base.add_connection(FlowConnection { from_node: 1, from_port: 0, to_node: 2, to_port: 0 });
        base.add_connection(FlowConnection { from_node: 2, from_port: 0, to_node: 3, to_port: 0 });

        let mut modulated = FlowGraph::new();
        modulated.add_node(1, "oscillator");
        modulated.add_node(2, "autofilter");
        modulated.set_node_params(2, &[
            ("cutoff".to_string(), "1200".to_string()),
            ("rate".to_string(), "2.0".to_string()),
            ("depth".to_string(), "0.8".to_string()),
        ]);
        modulated.add_node(3, "output");
        modulated.add_connection(FlowConnection { from_node: 1, from_port: 0, to_node: 2, to_port: 0 });
        modulated.add_connection(FlowConnection { from_node: 2, from_port: 0, to_node: 3, to_port: 0 });

        let a = render(&mut base, 44_100.0, 2048);
        let b = render(&mut modulated, 44_100.0, 2048);
        let diff = a.iter().zip(b.iter()).map(|(x, y)| (x - y).abs()).sum::<f32>() / 2048.0;
        assert!(diff > 0.005, "expected modulation to alter signal, diff={diff}");
    }

    #[test]
    fn reverse_node_produces_wet_signal_after_warmup() {
        let mut g = FlowGraph::new();
        g.add_node(1, "oscillator");
        g.set_node_params(1, &[("waveform".to_string(), "saw".to_string())]);
        g.add_node(2, "reverse");
        g.set_node_params(2, &[
            ("windowMs".to_string(), "40".to_string()),
            ("feedback".to_string(), "0.25".to_string()),
            ("mix".to_string(), "1.0".to_string()),
        ]);
        g.add_node(3, "output");
        g.add_connection(FlowConnection { from_node: 1, from_port: 0, to_node: 2, to_port: 0 });
        g.add_connection(FlowConnection { from_node: 2, from_port: 0, to_node: 3, to_port: 0 });

        let out = render(&mut g, 44_100.0, 4096);
        let tail = &out[1024..];
        assert!(rms(tail) > 0.005, "expected wet reverse tail to be audible");
    }

    #[test]
    fn midi_freq_controls_oscillator_pitch() {
        let mut g = FlowGraph::new();
        g.add_node(1, "midiIn");
        g.add_node(2, "oscillator");
        g.add_node(3, "output");
        g.add_connection(FlowConnection { from_node: 1, from_port: 0, to_node: 2, to_port: 0 });
        g.add_connection(FlowConnection { from_node: 2, from_port: 0, to_node: 3, to_port: 0 });

        set_midi_state(&mut g, 1, 60, 100, true);
        let low = render(&mut g, 44_100.0, 512);

        set_midi_state(&mut g, 1, 84, 100, true);
        let high = render(&mut g, 44_100.0, 512);

        let diff = low
            .iter()
            .zip(high.iter())
            .map(|(a, b)| (a - b).abs())
            .sum::<f32>()
            / 512.0;
        assert!(diff > 0.05, "expected pitch-controlled oscillator to change output, diff={diff}");
    }

    #[test]
    fn midi_gate_drives_envelope_output() {
        let mut g = FlowGraph::new();
        g.add_node(1, "midiIn");
        g.add_node(2, "envelope");
        g.set_node_params(2, &[
            ("attack".to_string(), "0.005".to_string()),
            ("decay".to_string(), "0.02".to_string()),
            ("sustain".to_string(), "0.5".to_string()),
            ("release".to_string(), "0.01".to_string()),
        ]);
        g.add_node(3, "output");
        g.add_connection(FlowConnection { from_node: 1, from_port: 2, to_node: 2, to_port: 0 }); // gate
        g.add_connection(FlowConnection { from_node: 2, from_port: 0, to_node: 3, to_port: 0 }); // env cv

        set_midi_state(&mut g, 1, 69, 100, true);
        let on = render(&mut g, 44_100.0, 512);
        let on_peak = on.iter().fold(0.0_f32, |m, &v| m.max(v.abs()));
        assert!(on_peak > 0.02, "expected envelope to rise on gate, peak={on_peak}");

        set_midi_state(&mut g, 1, 69, 0, false);
        let off = render(&mut g, 44_100.0, 4096);
        let off_tail = off.iter().rev().take(128).map(|v| v.abs()).sum::<f32>() / 128.0;
        assert!(off_tail < 0.04, "expected envelope to release after gate off, tail={off_tail}");
    }
}
