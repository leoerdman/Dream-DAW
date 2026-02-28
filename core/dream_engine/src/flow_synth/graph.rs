use std::collections::HashMap;
use std::any::Any;
use super::nodes::*;

/// Unique identifier for a node in the Flow graph.
pub type NodeId = u64;

/// A signal in the Flow graph. In a modular synth, almost everything is a
/// control voltage (CV) or audio signal represented as an f32.
#[derive(Debug, Clone, Copy)]
pub enum FlowSignal {
    Audio(f32),
    Control(f32),
    Midi { pitch: u8, velocity: u8, gate: bool },
}

impl Default for FlowSignal {
    fn default() -> Self {
        Self::Audio(0.0)
    }
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
        self.nodes.push(node);
        self.node_map.insert(id, idx);
        self.index_to_id.push(id);

        if is_audio_out {
            self.audio_out_index = Some(idx);
        }

        // Ensure signal buffer is large enough
        let required = (idx + 1) * MAX_NODE_PORTS;
        if self.signal_buffer.len() < required {
            self.signal_buffer.resize(required, FlowSignal::default());
        }
    }

    pub fn add_connection(&mut self, conn: FlowConnection) {
        self.connections.push(conn);
    }

    pub fn clear(&mut self) {
        self.nodes.clear();
        self.node_map.clear();
        self.index_to_id.clear();
        self.connections.clear();
        self.signal_buffer.fill(FlowSignal::default());
        self.audio_out_index = None;
    }

    /// Resets all nodes in the graph.
    pub fn reset(&mut self) {
        for node in &mut self.nodes {
            node.reset();
        }
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
    pub fn process_sample(&mut self, sample_rate: f64) -> f32 {
        // 1. Gather inputs for each node from the signal buffer and execute.
        for i in 0..self.nodes.len() {
            // Temporary input buffer for this node.
            let mut inputs = [FlowSignal::default(); MAX_NODE_PORTS];

            // Get the NodeId for this index to match connections correctly.
            let this_node_id = self.index_to_id[i];

            // Fill inputs based on connections.
            for conn in &self.connections {
                if conn.to_node == this_node_id {
                    if let Some(&from_idx) = self.node_map.get(&conn.from_node) {
                        if conn.from_port < MAX_NODE_PORTS && conn.to_port < MAX_NODE_PORTS {
                            let source_signal = self.signal_buffer[from_idx * MAX_NODE_PORTS + conn.from_port];
                            inputs[conn.to_port] = source_signal;
                        }
                    }
                }
            }

            // Output slices.
            let start = i * MAX_NODE_PORTS;
            let end = start + MAX_NODE_PORTS;
            let outputs = &mut self.signal_buffer[start..end];

            self.nodes[i].process(&inputs, outputs, sample_rate);
        }

        // 2. Return the output of the AudioOut node specifically.
        if let Some(out_idx) = self.audio_out_index {
            let sig = self.signal_buffer[out_idx * MAX_NODE_PORTS];
            sig.as_float().unwrap_or(0.0)
        } else if !self.nodes.is_empty() {
            // Fallback: return last node's first output.
            let last_idx = self.nodes.len() - 1;
            self.signal_buffer[last_idx * MAX_NODE_PORTS]
                .as_float()
                .unwrap_or(0.0)
        } else {
            0.0
        }
    }
}
