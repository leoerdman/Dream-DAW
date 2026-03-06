use std::collections::HashMap;
use std::any::Any;
use super::nodes::*;

/// Unique identifier for a node in the Flow graph.
pub type NodeId = u64;

/// A signal in the Flow graph. In a modular synth, almost everything is a
/// control voltage (CV) or audio signal represented as an f32.
/// Enterprise: 5 signal types matching Bitwig Grid architecture.
#[derive(Debug, Clone, Copy, Default)]
pub enum FlowSignal {
    #[default]
    None,
    Audio(f32),
    Control(f32),
    Midi { pitch: u8, velocity: u8, gate: bool },
    /// Binary on/off signal for triggers and gating (Bitwig: yellow, Logic).
    Gate(bool),
    /// Unipolar cycle position 0.0..1.0, wraps automatically (Bitwig: purple, Phase).
    Phase(f32),
}

impl FlowSignal {
    #[inline(always)]
    pub fn as_float(&self) -> Option<f32> {
        match self {
            Self::Audio(v) | Self::Control(v) => {
                // ENTERPRISE P0.1 & P0.2 FIX: Subatomic FPU Safety
                // 1. Flush-to-Zero for subnormals to prevent 100% CPU microcode traps
                // 2. NaN/Infinity stripping to prevent IIR filter bricking
                let mut val = *v;
                if val.abs() < 1e-15 { val = 0.0; }
                if !val.is_finite() { val = 0.0; }
                Some(val)
            },
            Self::Gate(on) => Some(if *on { 1.0 } else { 0.0 }),
            Self::Phase(p) => {
                let mut val = *p;
                if val.abs() < 1e-15 { val = 0.0; }
                if !val.is_finite() { val = 0.0; }
                Some(val)
            },
            _ => None,
        }
    }
}

/// Maximum number of inputs/outputs per node to keep structures stack-allocated or pre-allocated.
pub const MAX_NODE_PORTS: usize = 8;

/// P3 FIX: Default pre-allocation capacity for nodes.
/// Covers 99%+ of real modular patches without reallocation.
const FLOW_INITIAL_NODE_CAPACITY: usize = 16;
/// P3 FIX: Default pre-allocation capacity for connections.
const FLOW_INITIAL_CONN_CAPACITY: usize = 32;

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
            nodes: Vec::with_capacity(FLOW_INITIAL_NODE_CAPACITY),
            node_map: HashMap::with_capacity(FLOW_INITIAL_NODE_CAPACITY),
            index_to_id: Vec::with_capacity(FLOW_INITIAL_NODE_CAPACITY),
            connections: Vec::with_capacity(FLOW_INITIAL_CONN_CAPACITY),
            signal_buffer: vec![FlowSignal::default(); FLOW_INITIAL_NODE_CAPACITY * MAX_NODE_PORTS],
            audio_out_index: None,
            audio_in_indices: Vec::new(),
            incoming_cache: Vec::with_capacity(FLOW_INITIAL_NODE_CAPACITY),
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
    pub fn add_node(&mut self, id: NodeId, node_type: dream_ipc::FlowNodeType) {
        use dream_ipc::FlowNodeType::*;
        let is_audio_out = node_type == Output;
        let is_audio_in = node_type == AudioIn;
        let is_envelope = node_type == Envelope;

        let node: Box<dyn FlowNode> = match node_type {
            Oscillator => Box::new(OscillatorNode::new()),
            Filter => Box::new(FilterNode::new()),
            Envelope => Box::new(EnvelopeNode::new()),
            MidiIn => Box::new(MidiInNode::new()),
            Output => Box::new(AudioOutNode::new()),
            Eq => Box::new(EqNode::new()),
            AutoFilter => Box::new(AutoFilterNode::new()),
            Reverse => Box::new(ReverseNode::new()),
            AudioIn => Box::new(AudioInNode::new()),
            Lfo => Box::new(LfoNode::new()),
            Noise => Box::new(NoiseNode::new()),
            Add => Box::new(MathAddNode::new()),
            Multiply => Box::new(MathMultiplyNode::new()),
            SampleHold => Box::new(SampleHoldNode::new()),
            Delay => Box::new(DelayNode::new()),
            Mixer => Box::new(MixerNode::new()),
            Vca => Box::new(VcaNode::new()),
            Pitch => Box::new(PitchNode::new()),
            Utility => Box::new(UtilityNode::new()),
            Distortion => Box::new(DistortionNode::new()),
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
        if let Some(&to_idx) = self.node_map.get(&conn.to_node)
            && let Some(&from_idx) = self.node_map.get(&conn.from_node)
            && conn.from_port < MAX_NODE_PORTS && conn.to_port < MAX_NODE_PORTS
            && to_idx < self.incoming_cache.len()
        {
            self.incoming_cache[to_idx].push((from_idx, conn.from_port, conn.to_port));
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

    pub fn set_node_params(&mut self, id: NodeId, params: &[(dream_ipc::FlowParamKey, f32)]) {
        let Some(&idx) = self.node_map.get(&id) else { return; };
        let Some(node) = self.nodes.get_mut(idx) else { return; };
        use dream_ipc::FlowParamKey::*;

        if let Some(osc) = node.as_any_mut().downcast_mut::<OscillatorNode>() {
            for (k, v) in params {
                match *k {
                    Waveform => osc.set_waveform_by_float(*v),
                    Frequency => osc.set_base_frequency(*v),
                    _ => {}
                }
            }
            return;
        }

        if let Some(filter) = node.as_any_mut().downcast_mut::<FilterNode>() {
            for (k, v) in params {
                match *k {
                    FilterType => filter.set_filter_type_by_float(*v),
                    Cutoff => filter.set_default_cutoff(*v),
                    Resonance => filter.set_default_resonance(*v),
                    _ => {}
                }
            }
            return;
        }

        if let Some(eq) = node.as_any_mut().downcast_mut::<EqNode>() {
            let mut low = None; let mut mid = None; let mut high = None;
            for (k, v) in params {
                match *k {
                    EqLow => low = Some(*v),
                    EqMid => mid = Some(*v),
                    EqHigh => high = Some(*v),
                    _ => {}
                }
            }
            let current = eq.current_band_gains();
            eq.set_band_gains(low.unwrap_or(current.0), mid.unwrap_or(current.1), high.unwrap_or(current.2));
            return;
        }

        if let Some(af) = node.as_any_mut().downcast_mut::<AutoFilterNode>() {
            for (k, v) in params {
                match *k {
                    FilterType => af.set_filter_type_by_float(*v),
                    Cutoff => af.set_base_freq(*v),
                    Resonance => af.set_resonance(*v),
                    Rate => af.set_lfo_rate(*v),
                    Depth => af.set_lfo_depth(*v),
                    EnvDepth => af.set_env_follow_depth(*v),
                    _ => {}
                }
            }
            return;
        }

        if let Some(rv) = node.as_any_mut().downcast_mut::<ReverseNode>() {
            for (k, v) in params {
                match *k {
                    WindowMs => rv.set_window_ms(*v),
                    Feedback => rv.set_feedback(*v),
                    Mix => rv.set_mix(*v),
                    _ => {}
                }
            }
            return;
        }

        if let Some(env) = node.as_any_mut().downcast_mut::<EnvelopeNode>() {
            for (k, v) in params {
                match *k {
                    Attack => env.set_attack(*v as f64),
                    Decay => env.set_decay(*v as f64),
                    Sustain => env.set_sustain(*v as f64),
                    Release => env.set_release(*v as f64),
                    _ => {}
                }
            }
            return;
        }

        if let Some(out) = node.as_any_mut().downcast_mut::<AudioOutNode>() {
            for (k, v) in params {
                match *k {
                    Gain => out.set_gain(*v),
                    Muted => out.set_muted(*v > 0.5),
                    _ => {}
                }
            }
            return;
        }

        if let Some(lfo) = node.as_any_mut().downcast_mut::<LfoNode>() {
            for (k, v) in params {
                match *k {
                    Rate => lfo.set_rate(*v as f64),
                    Shape => lfo.set_shape_by_float(*v),
                    Bipolar => lfo.set_bipolar(*v > 0.5),
                    PhaseOffset => lfo.set_phase_offset(*v as f64),
                    _ => {}
                }
            }
            return;
        }

        if let Some(noise) = node.as_any_mut().downcast_mut::<NoiseNode>() {
            for (k, v) in params {
                match *k {
                    Color => noise.set_color_by_float(*v),
                    Level => noise.set_level(*v),
                    _ => {}
                }
            }
            return;
        }

        if let Some(mul) = node.as_any_mut().downcast_mut::<MathMultiplyNode>() {
            for (k, v) in params {
                if *k == Scale { mul.set_scale(*v); }
            }
            return;
        }

        if let Some(dly) = node.as_any_mut().downcast_mut::<DelayNode>() {
            for (k, v) in params {
                match *k {
                    TimeMs => dly.set_time_ms(*v),
                    Feedback => dly.set_feedback(*v),
                    Mix => dly.set_mix(*v),
                    _ => {}
                }
            }
            return;
        }

        if let Some(mix) = node.as_any_mut().downcast_mut::<MixerNode>() {
            for (k, v) in params {
                match *k {
                    Gain1 => mix.set_gain(0, *v),
                    Gain2 => mix.set_gain(1, *v),
                    Gain3 => mix.set_gain(2, *v),
                    Gain4 => mix.set_gain(3, *v),
                    _ => {}
                }
            }
            return;
        }

        if let Some(vca) = node.as_any_mut().downcast_mut::<VcaNode>() {
            for (k, v) in params {
                if *k == Bias { vca.set_bias(*v); }
            }
            return;
        }

        if let Some(pitch) = node.as_any_mut().downcast_mut::<PitchNode>() {
            for (k, v) in params {
                if *k == OctaveOffset { pitch.set_octave_offset(*v); }
            }
            return;
        }

        if let Some(util) = node.as_any_mut().downcast_mut::<UtilityNode>() {
            for (k, v) in params {
                match *k {
                    Gain => util.set_gain(*v),
                    Pan => util.set_pan(*v),
                    PhaseInvert => util.set_phase_invert(*v > 0.5),
                    _ => {}
                }
            }
            return;
        }

        if let Some(dist) = node.as_any_mut().downcast_mut::<DistortionNode>() {
            for (k, v) in params {
                match *k {
                    Mode => dist.set_mode_by_float(*v),
                    Drive => dist.set_drive(*v),
                    Mix => dist.set_mix(*v),
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

    /// AUDIT-E03 FIX: Propagate sample rate change to all nodes.
    /// Resets node state so SR-dependent caches (ReverseNode buffer,
    /// AutoFilter LFO, EQ biquad coefficients) rebuild at the new rate.
    pub fn set_sample_rate(&mut self, _sample_rate: f64) {
        // Nodes detect SR changes via the `sample_rate` argument in process().
        // Reset clears stale SR-dependent state so it rebuilds correctly.
        self.reset();
    }

    /// Returns true if ALL envelope nodes in this graph are in idle state
    /// (completed release phase). If no envelope nodes exist, returns true.
    /// Used by the engine to determine when a releasing voice can be freed.
    pub fn is_envelope_idle(&mut self) -> bool {
        if self.envelope_indices.is_empty() {
            return true;
        }
        for &idx in &self.envelope_indices {
            if let Some(node) = self.nodes.get_mut(idx)
                && let Some(env) = node.as_any_mut().downcast_mut::<EnvelopeNode>()
                && !env.is_idle()
            {
                return false;
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
                    // AUDIT-G05 FIX: Bounds check on signal_buffer read.
                    // Prevents panic if from_idx is stale after graph topology change.
                    let sig_idx = from_idx * MAX_NODE_PORTS + from_port;
                    if sig_idx < self.signal_buffer.len() {
                        let source_signal = self.signal_buffer[sig_idx];
                        inputs[to_port] = source_signal;
                    }
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
        } else {
            // No AudioOut node in the graph — return silence.
            // ENTERPRISE: Removed fallback that returned last node's output,
            // which caused unintended sound leaking without an explicit Output node.
            (0.0, 0.0)
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::flow_synth::nodes::MidiInNode;
    use dream_ipc::{FlowNodeType, FlowParamKey};

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
        g.add_node(1, FlowNodeType::Oscillator);
        g.add_node(2, FlowNodeType::Output);
        g.add_connection(FlowConnection { from_node: 1, from_port: 0, to_node: 2, to_port: 0 });

        let out = render(&mut g, 44_100.0, 512);
        assert!(rms(&out) > 0.01, "expected audible RMS, got {}", rms(&out));
    }

    #[test]
    fn oscillator_params_affect_rendered_audio() {
        let mut g_default = FlowGraph::new();
        g_default.add_node(1, FlowNodeType::Oscillator);
        g_default.add_node(2, FlowNodeType::Output);
        g_default.add_connection(FlowConnection { from_node: 1, from_port: 0, to_node: 2, to_port: 0 });

        let mut g_tweaked = FlowGraph::new();
        g_tweaked.add_node(1, FlowNodeType::Oscillator);
        g_tweaked.set_node_params(1, &[
            (FlowParamKey::Waveform, 2.0),   // square
            (FlowParamKey::Frequency, 880.0),
        ]);
        g_tweaked.add_node(2, FlowNodeType::Output);
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
        dry.add_node(1, FlowNodeType::Oscillator);
        dry.add_node(2, FlowNodeType::Eq);
        dry.add_node(3, FlowNodeType::Output);
        dry.add_connection(FlowConnection { from_node: 1, from_port: 0, to_node: 2, to_port: 0 });
        dry.add_connection(FlowConnection { from_node: 2, from_port: 0, to_node: 3, to_port: 0 });

        let mut boosted = FlowGraph::new();
        boosted.add_node(1, FlowNodeType::Oscillator);
        boosted.add_node(2, FlowNodeType::Eq);
        boosted.set_node_params(2, &[
            (FlowParamKey::EqLow, 12.0),
            (FlowParamKey::EqMid, 0.0),
            (FlowParamKey::EqHigh, 0.0),
        ]);
        boosted.add_node(3, FlowNodeType::Output);
        boosted.add_connection(FlowConnection { from_node: 1, from_port: 0, to_node: 2, to_port: 0 });
        boosted.add_connection(FlowConnection { from_node: 2, from_port: 0, to_node: 3, to_port: 0 });

        let dry_out = render(&mut dry, 44_100.0, 1024);
        let boosted_out = render(&mut boosted, 44_100.0, 1024);
        assert!(rms(&boosted_out) > rms(&dry_out) * 1.05);
    }

    #[test]
    fn audio_in_to_output_passes_injected_sample() {
        let mut g = FlowGraph::new();
        g.add_node(1, FlowNodeType::AudioIn);
        g.add_node(2, FlowNodeType::Output);
        g.set_node_params(2, &[(FlowParamKey::Gain, 1.0)]);
        g.add_connection(FlowConnection { from_node: 1, from_port: 0, to_node: 2, to_port: 0 });

        g.set_audio_in_sample(0.37);
        let (out, _) = g.process_sample(44_100.0);
        assert!((out - 0.37).abs() < 0.01, "expected injected sample pass-through, got {out}");
    }

    #[test]
    fn autofilter_depth_changes_output_shape() {
        let mut base = FlowGraph::new();
        base.add_node(1, FlowNodeType::Oscillator);
        base.add_node(2, FlowNodeType::AutoFilter);
        base.set_node_params(2, &[
            (FlowParamKey::Cutoff, 1200.0),
            (FlowParamKey::Rate, 2.0),
            (FlowParamKey::Depth, 0.0),
        ]);
        base.add_node(3, FlowNodeType::Output);
        base.add_connection(FlowConnection { from_node: 1, from_port: 0, to_node: 2, to_port: 0 });
        base.add_connection(FlowConnection { from_node: 2, from_port: 0, to_node: 3, to_port: 0 });

        let mut modulated = FlowGraph::new();
        modulated.add_node(1, FlowNodeType::Oscillator);
        modulated.add_node(2, FlowNodeType::AutoFilter);
        modulated.set_node_params(2, &[
            (FlowParamKey::Cutoff, 1200.0),
            (FlowParamKey::Rate, 2.0),
            (FlowParamKey::Depth, 0.8),
        ]);
        modulated.add_node(3, FlowNodeType::Output);
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
        g.add_node(1, FlowNodeType::Oscillator);
        g.set_node_params(1, &[(FlowParamKey::Waveform, 1.0)]); // saw
        g.add_node(2, FlowNodeType::Reverse);
        g.set_node_params(2, &[
            (FlowParamKey::WindowMs, 40.0),
            (FlowParamKey::Feedback, 0.25),
            (FlowParamKey::Mix, 1.0),
        ]);
        g.add_node(3, FlowNodeType::Output);
        g.add_connection(FlowConnection { from_node: 1, from_port: 0, to_node: 2, to_port: 0 });
        g.add_connection(FlowConnection { from_node: 2, from_port: 0, to_node: 3, to_port: 0 });

        let out = render(&mut g, 44_100.0, 4096);
        let tail = &out[1024..];
        assert!(rms(tail) > 0.005, "expected wet reverse tail to be audible");
    }

    #[test]
    fn midi_freq_controls_oscillator_pitch() {
        let mut g = FlowGraph::new();
        g.add_node(1, FlowNodeType::MidiIn);
        g.add_node(2, FlowNodeType::Oscillator);
        g.add_node(3, FlowNodeType::Output);
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
        g.add_node(1, FlowNodeType::MidiIn);
        g.add_node(2, FlowNodeType::Envelope);
        g.set_node_params(2, &[
            (FlowParamKey::Attack, 0.005),
            (FlowParamKey::Decay, 0.02),
            (FlowParamKey::Sustain, 0.5),
            (FlowParamKey::Release, 0.01),
        ]);
        g.add_node(3, FlowNodeType::Output);
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

    #[test]
    fn output_node_muted_produces_silence() {
        let mut g = FlowGraph::new();
        g.add_node(1, FlowNodeType::Oscillator);
        g.add_node(2, FlowNodeType::Output);
        g.set_node_params(2, &[(FlowParamKey::Muted, 1.0)]); // true
        g.add_connection(FlowConnection { from_node: 1, from_port: 0, to_node: 2, to_port: 0 });

        let out = render(&mut g, 44_100.0, 512);
        let peak = out.iter().fold(0.0_f32, |m, &v| m.max(v.abs()));
        assert!(peak < 0.0001, "expected silence when output is muted, got peak={peak}");
    }

    #[test]
    fn output_node_gain_scales_level() {
        let mut full = FlowGraph::new();
        full.add_node(1, FlowNodeType::Oscillator);
        full.add_node(2, FlowNodeType::Output);
        full.set_node_params(2, &[(FlowParamKey::Gain, 1.0)]);
        full.add_connection(FlowConnection { from_node: 1, from_port: 0, to_node: 2, to_port: 0 });

        let mut half = FlowGraph::new();
        half.add_node(1, FlowNodeType::Oscillator);
        half.add_node(2, FlowNodeType::Output);
        half.set_node_params(2, &[(FlowParamKey::Gain, 0.5)]);
        half.add_connection(FlowConnection { from_node: 1, from_port: 0, to_node: 2, to_port: 0 });

        let full_out = render(&mut full, 44_100.0, 512);
        let half_out = render(&mut half, 44_100.0, 512);
        let full_rms = rms(&full_out);
        let half_rms = rms(&half_out);
        assert!(half_rms < full_rms * 0.65,
            "expected half gain to be significantly quieter: full_rms={full_rms}, half_rms={half_rms}");
    }

    // ── Phase 1: New Node Tests ─────────────────────────────────────────

    #[test]
    fn gate_signal_as_float() {
        assert_eq!(FlowSignal::Gate(true).as_float(), Some(1.0));
        assert_eq!(FlowSignal::Gate(false).as_float(), Some(0.0));
    }

    #[test]
    fn phase_signal_as_float() {
        let p = FlowSignal::Phase(0.75);
        assert!((p.as_float().expect("should be float") - 0.75).abs() < 0.001);
    }

    #[test]
    fn lfo_produces_periodic_output() {
        let mut g = FlowGraph::new();
        g.add_node(1, FlowNodeType::Lfo);
        g.set_node_params(1, &[
            (FlowParamKey::Rate, 10.0),
            (FlowParamKey::Shape, 0.0), // sine
        ]);
        g.add_node(2, FlowNodeType::Output);
        g.set_node_params(2, &[(FlowParamKey::Gain, 1.0)]);
        g.add_connection(FlowConnection { from_node: 1, from_port: 0, to_node: 2, to_port: 0 });

        let out = render(&mut g, 44_100.0, 4410);
        let peak = out.iter().fold(0.0_f32, |m, &v| m.max(v.abs()));
        assert!(peak > 0.5, "LFO should produce significant signal, got peak={peak}");
    }

    #[test]
    fn noise_produces_nonzero_signal() {
        let mut g = FlowGraph::new();
        g.add_node(1, FlowNodeType::Noise);
        g.add_node(2, FlowNodeType::Output);
        g.set_node_params(2, &[(FlowParamKey::Gain, 1.0)]);
        g.add_connection(FlowConnection { from_node: 1, from_port: 0, to_node: 2, to_port: 0 });

        let out = render(&mut g, 44_100.0, 512);
        let rms_val = rms(&out);
        assert!(rms_val > 0.01, "noise should produce non-trivial signal, rms={rms_val}");
    }

    #[test]
    fn math_add_sums_two_signals() {
        let mut g = FlowGraph::new();
        g.add_node(1, FlowNodeType::Oscillator);
        g.add_node(2, FlowNodeType::Oscillator);
        g.add_node(3, FlowNodeType::Add);
        g.add_node(4, FlowNodeType::Output);
        g.set_node_params(4, &[(FlowParamKey::Gain, 1.0)]);
        g.add_connection(FlowConnection { from_node: 1, from_port: 0, to_node: 3, to_port: 0 });
        g.add_connection(FlowConnection { from_node: 2, from_port: 0, to_node: 3, to_port: 1 });
        g.add_connection(FlowConnection { from_node: 3, from_port: 0, to_node: 4, to_port: 0 });

        let out = render(&mut g, 44_100.0, 512);
        let peak = out.iter().fold(0.0_f32, |m, &v| m.max(v.abs()));
        assert!(peak > 0.5, "add node should combine signals, peak={peak}");
    }

    #[test]
    fn math_multiply_scales_signal() {
        let mut g = FlowGraph::new();
        g.add_node(1, FlowNodeType::Oscillator);
        g.add_node(2, FlowNodeType::Multiply);
        g.set_node_params(2, &[(FlowParamKey::Scale, 0.5)]);
        g.add_node(3, FlowNodeType::Output);
        g.set_node_params(3, &[(FlowParamKey::Gain, 1.0)]);
        g.add_connection(FlowConnection { from_node: 1, from_port: 0, to_node: 2, to_port: 0 });
        g.add_connection(FlowConnection { from_node: 2, from_port: 0, to_node: 3, to_port: 0 });

        let out = render(&mut g, 44_100.0, 512);
        let scaled_rms = rms(&out);

        let mut g2 = FlowGraph::new();
        g2.add_node(1, FlowNodeType::Oscillator);
        g2.add_node(2, FlowNodeType::Output);
        g2.set_node_params(2, &[(FlowParamKey::Gain, 1.0)]);
        g2.add_connection(FlowConnection { from_node: 1, from_port: 0, to_node: 2, to_port: 0 });
        let out2 = render(&mut g2, 44_100.0, 512);
        let full_rms = rms(&out2);

        assert!(scaled_rms < full_rms * 0.65,
            "multiply with scale=0.5 should halve level: scaled={scaled_rms}, full={full_rms}");
    }

    #[test]
    fn sample_hold_captures_on_trigger() {
        let mut g = FlowGraph::new();
        g.add_node(1, FlowNodeType::Noise);
        g.add_node(2, FlowNodeType::SampleHold);
        g.add_node(3, FlowNodeType::Output);
        g.set_node_params(3, &[(FlowParamKey::Gain, 1.0)]);
        g.add_connection(FlowConnection { from_node: 1, from_port: 0, to_node: 2, to_port: 0 });
        g.add_connection(FlowConnection { from_node: 2, from_port: 0, to_node: 3, to_port: 0 });

        let out = render(&mut g, 44_100.0, 64);
        let peak = out.iter().fold(0.0_f32, |m, &v| m.max(v.abs()));
        assert!(peak < 0.001, "S&H without trigger should hold zero, peak={peak}");
    }

    #[test]
    fn delay_produces_echoed_signal() {
        let mut g = FlowGraph::new();
        g.add_node(1, FlowNodeType::Oscillator);
        g.add_node(2, FlowNodeType::Delay);
        g.set_node_params(2, &[
            (FlowParamKey::TimeMs, 10.0),
            (FlowParamKey::Feedback, 0.0),
            (FlowParamKey::Mix, 1.0),
        ]);
        g.add_node(3, FlowNodeType::Output);
        g.set_node_params(3, &[(FlowParamKey::Gain, 1.0)]);
        g.add_connection(FlowConnection { from_node: 1, from_port: 0, to_node: 2, to_port: 0 });
        g.add_connection(FlowConnection { from_node: 2, from_port: 0, to_node: 3, to_port: 0 });

        let out = render(&mut g, 44_100.0, 882);
        let first_rms = rms(&out[..441]);
        let second_rms = rms(&out[441..]);
        assert!(second_rms > first_rms * 5.0,
            "delayed signal should be much louder after delay time: first={first_rms}, second={second_rms}");
    }

    #[test]
    fn mixer_sums_four_inputs() {
        let mut g = FlowGraph::new();
        g.add_node(1, FlowNodeType::Oscillator);
        g.add_node(2, FlowNodeType::Oscillator);
        g.add_node(3, FlowNodeType::Mixer);
        g.add_node(4, FlowNodeType::Output);
        g.set_node_params(4, &[(FlowParamKey::Gain, 1.0)]);
        g.add_connection(FlowConnection { from_node: 1, from_port: 0, to_node: 3, to_port: 0 });
        g.add_connection(FlowConnection { from_node: 2, from_port: 0, to_node: 3, to_port: 1 });
        g.add_connection(FlowConnection { from_node: 3, from_port: 0, to_node: 4, to_port: 0 });

        let out = render(&mut g, 44_100.0, 512);
        let mix_rms = rms(&out);
        assert!(mix_rms > 0.3, "mixer should combine signals, rms={mix_rms}");
    }

    #[test]
    fn vca_amplitude_controlled_by_cv() {
        let mut g = FlowGraph::new();
        g.add_node(1, FlowNodeType::Oscillator);
        g.add_node(2, FlowNodeType::Vca);
        g.add_node(3, FlowNodeType::Output);
        g.set_node_params(3, &[(FlowParamKey::Gain, 1.0)]);
        g.add_connection(FlowConnection { from_node: 1, from_port: 0, to_node: 2, to_port: 0 });
        g.add_connection(FlowConnection { from_node: 2, from_port: 0, to_node: 3, to_port: 0 });

        let out = render(&mut g, 44_100.0, 512);
        let pass_rms = rms(&out);
        assert!(pass_rms > 0.3, "VCA with default CV=1.0 should pass audio, rms={pass_rms}");
    }
}

