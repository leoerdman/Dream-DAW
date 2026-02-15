// ═══════════════════════════════════════════════════════════════════════════
// Dream DAW — Directed Acyclic Graph (Audio Topology)
// ═══════════════════════════════════════════════════════════════════════════
//
// This module defines the audio processing graph: a DAG where each node is
// an audio processor (track, effect, bus, master) and each edge represents
// a connection carrying audio buffers between processors.
//
// The DAG is validated on every mutation to guarantee:
//   1. No cycles (feedback loops) — prevented via DFS cycle detection.
//   2. Exactly one master output node — enforced at construction.
//   3. All nodes are reachable from at least one source.
//
// The DAG itself is immutable once built. Mutations happen via the RCU
// pattern (see rcu.rs): build a new DAG → validate → atomic swap.
//
// ═══════════════════════════════════════════════════════════════════════════

use petgraph::algo;
use petgraph::graph::{DiGraph, NodeIndex};
use petgraph::visit::{EdgeRef, NodeIndexable};

use std::fmt;

// ── Node Types ──────────────────────────────────────────────────────────

/// Unique identifier for an audio node. Monotonically increasing.
/// Decoupled from petgraph's internal indices to survive graph rebuilds.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub struct NodeId(pub u64);

/// The type of processing a node performs.
#[derive(Debug, Clone)]
pub enum NodeKind {
    /// Audio track — reads clips from disk/memory, outputs raw PCM.
    Track { name: String },

    /// Audio effect — processes input buffer (e.g., reverb, EQ, compressor).
    /// `latency_samples` is the plugin's reported processing delay.
    Effect {
        name: String,
        latency_samples: u32,
    },

    /// Auxiliary bus — sums multiple inputs (send/return routing).
    Bus { name: String },

    /// Master output — the final summing point. Exactly one per graph.
    MasterOutput,
}

/// A node in the audio processing graph.
#[derive(Debug, Clone)]
pub struct AudioNode {
    /// Stable ID that survives graph rebuilds.
    pub id: NodeId,
    /// What this node does.
    pub kind: NodeKind,
}

impl AudioNode {
    pub fn new(id: NodeId, kind: NodeKind) -> Self {
        Self { id, kind }
    }

    /// Returns the processing latency of this node in samples.
    pub fn latency_samples(&self) -> u32 {
        match &self.kind {
            NodeKind::Effect {
                latency_samples, ..
            } => *latency_samples,
            _ => 0,
        }
    }

    /// Human-readable name for logging.
    pub fn display_name(&self) -> &str {
        match &self.kind {
            NodeKind::Track { name } => name,
            NodeKind::Effect { name, .. } => name,
            NodeKind::Bus { name } => name,
            NodeKind::MasterOutput => "Master Output",
        }
    }
}

// ── Edge Type ───────────────────────────────────────────────────────────

/// An edge in the audio graph. Currently carries no data (audio buffers
/// are managed separately by the execution plan), but the type exists
/// for future extension (e.g., gain, channel mapping).
#[derive(Debug, Clone, Copy, Default)]
pub struct AudioEdge;

// ── Audio DAG ───────────────────────────────────────────────────────────

/// The audio processing graph — a validated Directed Acyclic Graph.
///
/// This is an immutable snapshot. The RCU module creates new instances
/// when the user modifies routing; the audio thread reads the current
/// snapshot via `arc-swap`.
#[derive(Debug, Clone)]
pub struct AudioDag {
    /// The underlying petgraph directed graph.
    graph: DiGraph<AudioNode, AudioEdge>,

    /// The index of the master output node (always present).
    master_idx: NodeIndex,
}

/// Errors during graph construction or validation.
#[derive(Debug)]
pub enum GraphError {
    /// A cycle (feedback loop) was detected in the graph.
    CycleDetected,
    /// No master output node was found.
    NoMasterOutput,
    /// Multiple master output nodes were found.
    MultipleMasterOutputs(usize),
    /// A node ID was referenced that doesn't exist in the graph.
    NodeNotFound(NodeId),
    /// Attempted to create a connection that would form a cycle.
    ConnectionWouldCycle {
        from: NodeId,
        to: NodeId,
    },
}

impl fmt::Display for GraphError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::CycleDetected => write!(f, "Cycle detected in audio graph"),
            Self::NoMasterOutput => write!(f, "No master output node in graph"),
            Self::MultipleMasterOutputs(n) => {
                write!(f, "Found {n} master output nodes (expected exactly 1)")
            }
            Self::NodeNotFound(id) => write!(f, "Node {:?} not found in graph", id),
            Self::ConnectionWouldCycle { from, to } => {
                write!(
                    f,
                    "Connection {:?} → {:?} would create a cycle",
                    from, to
                )
            }
        }
    }
}

impl std::error::Error for GraphError {}

// ── Execution Plan ──────────────────────────────────────────────────────

/// A pre-computed, topologically sorted processing order.
///
/// The audio callback iterates this list in order, calling each node's
/// `process()` method. Because the order is topologically sorted,
/// every node's inputs are guaranteed to be ready before it executes.
///
/// This struct is the one that gets atomically swapped via RCU.
#[derive(Debug, Clone)]
pub struct ExecutionPlan {
    /// Nodes in topological processing order (sources first, master last).
    pub processing_order: Vec<NodeIndex>,

    /// Per-node delay compensation in samples (indexed by NodeIndex).
    /// A value of 0 means no compensation needed.
    pub delay_compensation: Vec<u32>,

    /// Per-edge delay compensation in samples.
    ///
    /// This aligns inputs at merge points (bus/master) and handles
    /// split/rejoin topologies where node-level source compensation
    /// alone is insufficient.
    pub edge_delay_compensation: Vec<EdgeDelayCompensation>,

    /// Topology layers for parallel scheduling.
    ///
    /// Nodes within one stage are dependency-independent and can be
    /// processed concurrently. Stages themselves must execute in order.
    pub parallel_stages: Vec<Vec<NodeIndex>>,

    /// Summary statistics for stage-level parallel scheduling.
    pub parallelism_metrics: ParallelismMetrics,
}

/// Aggregate metrics describing stage-level graph parallelism.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct ParallelismMetrics {
    /// Number of topology stages.
    pub stage_count: usize,
    /// Total number of nodes covered by all stages.
    pub total_nodes: usize,
    /// Maximum number of independent nodes in a single stage.
    pub max_stage_width: usize,
    /// Average nodes per stage.
    pub avg_stage_width: f32,
    /// Recommended worker count based on current graph width.
    pub recommended_workers: usize,
}

impl Default for ParallelismMetrics {
    fn default() -> Self {
        Self {
            stage_count: 0,
            total_nodes: 0,
            max_stage_width: 0,
            avg_stage_width: 0.0,
            recommended_workers: 1,
        }
    }
}

/// Delay compensation to apply on a specific graph edge.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct EdgeDelayCompensation {
    pub from: NodeIndex,
    pub to: NodeIndex,
    pub delay_samples: u32,
}

// ── Graph Builder ───────────────────────────────────────────────────────

/// Builder pattern for constructing and validating an `AudioDag`.
///
/// Usage:
/// ```ignore
/// let dag = GraphBuilder::new()
///     .add_node(AudioNode::new(NodeId(0), NodeKind::MasterOutput))
///     .add_node(AudioNode::new(NodeId(1), NodeKind::Track { name: "Piano".into() }))
///     .add_edge(NodeId(1), NodeId(0))?  // Piano → Master
///     .build()?;
/// ```
pub struct GraphBuilder {
    graph: DiGraph<AudioNode, AudioEdge>,
}

impl GraphBuilder {
    /// Creates a new empty graph builder.
    pub fn new() -> Self {
        Self {
            graph: DiGraph::new(),
        }
    }

    /// Adds a node to the graph. Returns the builder for chaining.
    pub fn add_node(mut self, node: AudioNode) -> Self {
        self.graph.add_node(node);
        self
    }

    /// Connects two nodes by their `NodeId`.
    /// Audio flows from `from_id` to `to_id`.
    ///
    /// # Errors
    /// - `NodeNotFound` if either ID doesn't exist.
    /// - `ConnectionWouldCycle` if the edge would create a feedback loop.
    pub fn add_edge(mut self, from_id: NodeId, to_id: NodeId) -> Result<Self, GraphError> {
        let from_idx = self.find_index(from_id)?;
        let to_idx = self.find_index(to_id)?;

        // Temporarily add the edge to check for cycles.
        let edge_idx = self.graph.add_edge(from_idx, to_idx, AudioEdge);

        if algo::is_cyclic_directed(&self.graph) {
            // Remove the offending edge before returning the error.
            self.graph.remove_edge(edge_idx);
            return Err(GraphError::ConnectionWouldCycle {
                from: from_id,
                to: to_id,
            });
        }

        Ok(self)
    }

    /// Validates and freezes the graph into an immutable `AudioDag`.
    ///
    /// # Validation
    /// 1. Exactly one `MasterOutput` node must exist.
    /// 2. The graph must be acyclic (enforced per-edge, but double-checked here).
    pub fn build(self) -> Result<AudioDag, GraphError> {
        // ── 1. Check acyclicity ──────────────────────────────────
        if algo::is_cyclic_directed(&self.graph) {
            return Err(GraphError::CycleDetected);
        }

        // ── 2. Find master output ────────────────────────────────
        let master_indices: Vec<NodeIndex> = self
            .graph
            .node_indices()
            .filter(|&idx| matches!(self.graph[idx].kind, NodeKind::MasterOutput))
            .collect();

        match master_indices.len() {
            0 => return Err(GraphError::NoMasterOutput),
            1 => {}
            n => return Err(GraphError::MultipleMasterOutputs(n)),
        }

        let master_idx = master_indices[0];

        Ok(AudioDag {
            graph: self.graph,
            master_idx,
        })
    }

    /// Finds the petgraph NodeIndex for a given stable NodeId.
    fn find_index(&self, id: NodeId) -> Result<NodeIndex, GraphError> {
        self.graph
            .node_indices()
            .find(|&idx| self.graph[idx].id == id)
            .ok_or(GraphError::NodeNotFound(id))
    }
}

impl Default for GraphBuilder {
    fn default() -> Self {
        Self::new()
    }
}

// ── AudioDag Methods ────────────────────────────────────────────────────

impl AudioDag {
    /// Returns the underlying petgraph for read-only inspection.
    pub fn graph(&self) -> &DiGraph<AudioNode, AudioEdge> {
        &self.graph
    }

    /// Returns the master output node index.
    pub fn master_index(&self) -> NodeIndex {
        self.master_idx
    }

    /// Returns a reference to the node at the given index.
    pub fn node(&self, idx: NodeIndex) -> &AudioNode {
        &self.graph[idx]
    }

    /// Returns the number of nodes in the graph.
    pub fn node_count(&self) -> usize {
        self.graph.node_count()
    }

    /// Returns the number of edges in the graph.
    pub fn edge_count(&self) -> usize {
        self.graph.edge_count()
    }

    /// Computes the topologically sorted processing order.
    ///
    /// Returns nodes in reverse topological order (sources first, master last).
    /// This is the order the audio callback must process nodes in.
    pub fn topological_order(&self) -> Result<Vec<NodeIndex>, GraphError> {
        algo::toposort(&self.graph, None).map_err(|_| GraphError::CycleDetected)
    }

    /// Computes deterministic parallel stages from an existing topological order.
    ///
    /// Stage index equals the longest dependency depth from source nodes.
    pub fn parallel_stages_from_order(&self, topo_order: &[NodeIndex]) -> Vec<Vec<NodeIndex>> {
        if topo_order.is_empty() {
            return Vec::new();
        }

        let mut depth = vec![0usize; self.graph.node_bound()];
        let mut max_depth = 0usize;

        for &node_idx in topo_order {
            let node_depth = self
                .inputs(node_idx)
                .into_iter()
                .map(|src| depth[src.index()] + 1)
                .max()
                .unwrap_or(0);
            depth[node_idx.index()] = node_depth;
            max_depth = max_depth.max(node_depth);
        }

        let mut stages = vec![Vec::new(); max_depth + 1];
        for &node_idx in topo_order {
            stages[depth[node_idx.index()]].push(node_idx);
        }
        stages
    }

    /// Computes deterministic parallel stages directly from the graph.
    pub fn parallel_stages(&self) -> Result<Vec<Vec<NodeIndex>>, GraphError> {
        let order = self.topological_order()?;
        Ok(self.parallel_stages_from_order(&order))
    }

    /// Computes scheduling metrics for a concrete set of parallel stages.
    pub fn parallelism_metrics_from_stages(stages: &[Vec<NodeIndex>]) -> ParallelismMetrics {
        if stages.is_empty() {
            return ParallelismMetrics::default();
        }

        let stage_count = stages.len();
        let total_nodes = stages.iter().map(Vec::len).sum::<usize>();
        let max_stage_width = stages.iter().map(Vec::len).max().unwrap_or(0);
        let avg_stage_width = total_nodes as f32 / stage_count as f32;
        let recommended_workers = max_stage_width.max(1);

        ParallelismMetrics {
            stage_count,
            total_nodes,
            max_stage_width,
            avg_stage_width,
            recommended_workers,
        }
    }

    /// Computes scheduling metrics from an existing topological order.
    pub fn parallelism_metrics_from_order(&self, topo_order: &[NodeIndex]) -> ParallelismMetrics {
        let stages = self.parallel_stages_from_order(topo_order);
        Self::parallelism_metrics_from_stages(&stages)
    }

    /// Computes scheduling metrics directly from the graph.
    pub fn parallelism_metrics(&self) -> Result<ParallelismMetrics, GraphError> {
        let order = self.topological_order()?;
        Ok(self.parallelism_metrics_from_order(&order))
    }

    /// Returns the list of immediate input nodes for a given node.
    pub fn inputs(&self, idx: NodeIndex) -> Vec<NodeIndex> {
        self.graph
            .edges_directed(idx, petgraph::Direction::Incoming)
            .map(|e| e.source())
            .collect()
    }

    /// Returns the list of immediate output nodes for a given node.
    pub fn outputs(&self, idx: NodeIndex) -> Vec<NodeIndex> {
        self.graph
            .edges_directed(idx, petgraph::Direction::Outgoing)
            .map(|e| e.target())
            .collect()
    }
}

// ── Tests ───────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;

    fn make_master() -> AudioNode {
        AudioNode::new(NodeId(0), NodeKind::MasterOutput)
    }

    fn make_track(id: u64, name: &str) -> AudioNode {
        AudioNode::new(
            NodeId(id),
            NodeKind::Track {
                name: name.to_string(),
            },
        )
    }

    fn make_effect(id: u64, name: &str, latency: u32) -> AudioNode {
        AudioNode::new(
            NodeId(id),
            NodeKind::Effect {
                name: name.to_string(),
                latency_samples: latency,
            },
        )
    }

    fn make_bus(id: u64, name: &str) -> AudioNode {
        AudioNode::new(
            NodeId(id),
            NodeKind::Bus {
                name: name.to_string(),
            },
        )
    }

    #[test]
    fn simple_chain_builds_successfully() {
        // Track → Effect → Master
        let dag = GraphBuilder::new()
            .add_node(make_master())
            .add_node(make_track(1, "Piano"))
            .add_node(make_effect(2, "Reverb", 512))
            .add_edge(NodeId(1), NodeId(2))
            .unwrap()
            .add_edge(NodeId(2), NodeId(0))
            .unwrap()
            .build()
            .unwrap();

        assert_eq!(dag.node_count(), 3);
        assert_eq!(dag.edge_count(), 2);
    }

    #[test]
    fn cycle_detection_prevents_feedback() {
        // Attempt: A → B → C → A (cycle)
        let result = GraphBuilder::new()
            .add_node(make_master())
            .add_node(make_track(1, "A"))
            .add_node(make_effect(2, "B", 0))
            .add_node(make_effect(3, "C", 0))
            .add_edge(NodeId(1), NodeId(2))
            .unwrap()
            .add_edge(NodeId(2), NodeId(3))
            .unwrap()
            .add_edge(NodeId(3), NodeId(1)); // This should fail — cycle!

        assert!(matches!(
            result,
            Err(GraphError::ConnectionWouldCycle { .. })
        ));
    }

    #[test]
    fn no_master_output_fails() {
        let result = GraphBuilder::new()
            .add_node(make_track(1, "Orphan"))
            .build();

        assert!(matches!(result, Err(GraphError::NoMasterOutput)));
    }

    #[test]
    fn multiple_master_outputs_fails() {
        let result = GraphBuilder::new()
            .add_node(make_master())
            .add_node(AudioNode::new(NodeId(99), NodeKind::MasterOutput))
            .build();

        assert!(matches!(
            result,
            Err(GraphError::MultipleMasterOutputs(2))
        ));
    }

    #[test]
    fn topological_order_is_valid() {
        // Track1 → Master
        // Track2 → Master
        let dag = GraphBuilder::new()
            .add_node(make_master())
            .add_node(make_track(1, "Track 1"))
            .add_node(make_track(2, "Track 2"))
            .add_edge(NodeId(1), NodeId(0))
            .unwrap()
            .add_edge(NodeId(2), NodeId(0))
            .unwrap()
            .build()
            .unwrap();

        let order = dag.topological_order().unwrap();
        assert_eq!(order.len(), 3);

        // Master must be LAST (it depends on both tracks).
        let master_pos = order.iter().position(|&idx| idx == dag.master_index());
        assert_eq!(master_pos, Some(2));
    }

    #[test]
    fn diamond_topology_builds() {
        // Track → FX1 ─┐
        //               ├→ Bus → Master
        // Track → FX2 ─┘
        let dag = GraphBuilder::new()
            .add_node(make_master())
            .add_node(make_track(1, "Track"))
            .add_node(make_effect(2, "FX1", 256))
            .add_node(make_effect(3, "FX2", 128))
            .add_node(make_bus(4, "Sum Bus"))
            .add_edge(NodeId(1), NodeId(2))
            .unwrap()
            .add_edge(NodeId(1), NodeId(3))
            .unwrap()
            .add_edge(NodeId(2), NodeId(4))
            .unwrap()
            .add_edge(NodeId(3), NodeId(4))
            .unwrap()
            .add_edge(NodeId(4), NodeId(0))
            .unwrap()
            .build()
            .unwrap();

        assert_eq!(dag.node_count(), 5);
        assert_eq!(dag.edge_count(), 5);

        // Bus should have 2 inputs
        let bus_idx = dag
            .graph()
            .node_indices()
            .find(|&i| dag.node(i).id == NodeId(4))
            .unwrap();
        assert_eq!(dag.inputs(bus_idx).len(), 2);
    }

    #[test]
    fn node_not_found_error() {
        let result = GraphBuilder::new()
            .add_node(make_master())
            .add_edge(NodeId(999), NodeId(0));

        assert!(matches!(result, Err(GraphError::NodeNotFound(NodeId(999)))));
    }

    #[test]
    fn parallel_stages_for_diamond_topology() {
        // Track -> FX1 -> Bus -> Master
        //      \-> FX2 -/
        let dag = GraphBuilder::new()
            .add_node(make_master())
            .add_node(make_track(1, "Track"))
            .add_node(make_effect(2, "FX1", 0))
            .add_node(make_effect(3, "FX2", 0))
            .add_node(make_bus(4, "Bus"))
            .add_edge(NodeId(1), NodeId(2))
            .unwrap()
            .add_edge(NodeId(1), NodeId(3))
            .unwrap()
            .add_edge(NodeId(2), NodeId(4))
            .unwrap()
            .add_edge(NodeId(3), NodeId(4))
            .unwrap()
            .add_edge(NodeId(4), NodeId(0))
            .unwrap()
            .build()
            .unwrap();

        let stages = dag.parallel_stages().unwrap();
        assert_eq!(stages.len(), 4);
        assert_eq!(stages[0].len(), 1); // Track
        assert_eq!(stages[1].len(), 2); // FX1 + FX2
        assert_eq!(stages[2].len(), 1); // Bus
        assert_eq!(stages[3].len(), 1); // Master
    }

    #[test]
    fn parallelism_metrics_for_diamond_topology() {
        // Track -> FX1 -> Bus -> Master
        //      \-> FX2 -/
        let dag = GraphBuilder::new()
            .add_node(make_master())
            .add_node(make_track(1, "Track"))
            .add_node(make_effect(2, "FX1", 0))
            .add_node(make_effect(3, "FX2", 0))
            .add_node(make_bus(4, "Bus"))
            .add_edge(NodeId(1), NodeId(2))
            .unwrap()
            .add_edge(NodeId(1), NodeId(3))
            .unwrap()
            .add_edge(NodeId(2), NodeId(4))
            .unwrap()
            .add_edge(NodeId(3), NodeId(4))
            .unwrap()
            .add_edge(NodeId(4), NodeId(0))
            .unwrap()
            .build()
            .unwrap();

        let metrics = dag.parallelism_metrics().unwrap();
        assert_eq!(metrics.stage_count, 4);
        assert_eq!(metrics.total_nodes, 5);
        assert_eq!(metrics.max_stage_width, 2);
        assert!((metrics.avg_stage_width - 1.25).abs() < 1e-6);
        assert_eq!(metrics.recommended_workers, 2);
    }
}
