use std::collections::HashMap;

/// Unique identifier for a node in the Flow graph.
pub type NodeId = u64;

/// A signal in the Flow graph. In a modular synth, almost everything is a 
/// control voltage (CV) or audio signal represented as an f32.
#[derive(Debug, Clone, Copy, Default)]
pub struct FlowSignal(pub f32);

/// Maximum number of inputs/outputs per node to keep structures stack-allocated or pre-allocated.
pub const MAX_NODE_PORTS: usize = 8;

pub trait FlowNode: Send + Sync {
    fn process(&mut self, inputs: &[FlowSignal], outputs: &mut [FlowSignal], sample_rate: f64);
    fn reset(&mut self);
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
    /// Connections between nodes.
    connections: Vec<FlowConnection>,
    /// Flattened signal buffer for all node outputs.
    /// Each node gets a slice of `MAX_NODE_PORTS` in this buffer.
    signal_buffer: Vec<FlowSignal>,
}

impl FlowGraph {
    pub fn new() -> Self {
        Self {
            nodes: Vec::with_capacity(16),
            node_map: HashMap::with_capacity(16),
            connections: Vec::with_capacity(32),
            signal_buffer: Vec::with_capacity(16 * MAX_NODE_PORTS),
        }
    }

    /// Resets all nodes in the graph.
    pub fn reset(&mut self) {
        for node in &mut self.nodes {
            node.reset();
        }
    }

    /// Processes one sample through the entire graph.
    /// Topological order must be maintained in the `nodes` vector.
    pub fn process_sample(&mut self, sample_rate: f64) -> f32 {
        // 1. Gather inputs for each node from the signal buffer and execute.
        for (i, node) in self.nodes.iter_mut().enumerate() {
            // This is a simplified implementation. In a real 100x engine,
            // we'd use a more efficient way to map connections to input slices.
            
            // Temporary input buffer for this node.
            let mut inputs = [FlowSignal(0.0); MAX_NODE_PORTS];
            
            // Fill inputs based on connections.
            for conn in &self.connections {
                if let Some(&to_idx) = self.node_map.get(&conn.to_node) {
                    if to_idx == i {
                        if let Some(&from_idx) = self.node_map.get(&conn.from_node) {
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

            node.process(&inputs, outputs, sample_rate);
        }

        // The "Audio Out" node is usually the last one, but we should find it.
        // For now, let's assume the last node's first output is the final audio.
        self.signal_buffer.last().cloned().unwrap_or_default().0
    }
}
