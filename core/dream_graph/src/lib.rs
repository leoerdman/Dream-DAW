#![cfg_attr(test, allow(clippy::unwrap_used, clippy::expect_used))]

// ═══════════════════════════════════════════════════════════════════════════
// Dream DAW — Audio Graph (The Nervous System)
// ═══════════════════════════════════════════════════════════════════════════
//
// This crate implements the heart of DAW audio routing:
//
//   1. DAG (Directed Acyclic Graph) — petgraph-backed topology that
//      describes how audio flows from sources (clips, synths) through
//      processors (effects, sends) to the master output.
//
//   2. RCU (Read-Copy-Update) — zero-wait graph mutations. The UI thread
//      builds a new ExecutionPlan, then atomically swaps it via arc-swap.
//      The audio callback sees the new plan on its next cycle (~0.5ms).
//
//   3. PDC (Plugin Delay Compensation) — automatic latency alignment.
//      Finds the longest path through the DAG and inserts compensating
//      delay buffers on shorter paths, ensuring sample-accurate phase.
//      Includes edge-level compensation for split/rejoin merge points.
//
//   4. Renderer — topological executor that walks the ExecutionPlan,
//      dispatching to Track/Effect/Bus/Master nodes with PDC delay lines.
//
// ═══════════════════════════════════════════════════════════════════════════

pub mod dag;
pub mod pdc;
pub mod rcu;
pub mod renderer;

pub use dag::{
    AudioDag, AudioEdge, AudioEdgeKind, AudioNode, EdgeDelayCompensation, ExecutionPlan,
    GraphBuilder, GraphError, NodeId, NodeKind,
};
pub use rcu::LiveGraph;
pub use renderer::{GraphRenderer, NodeBuffer, PdcDelayLine};
pub mod routing;
