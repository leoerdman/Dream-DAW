// ═══════════════════════════════════════════════════════════════════════════
// Dream DAW — Read-Copy-Update (Zero-Wait Graph Mutations)
// ═══════════════════════════════════════════════════════════════════════════
//
// THE PROBLEM:
//   When a user adds a plugin or reconnects a send, the audio graph must
//   change. But the audio callback runs every ~0.5ms on a real-time thread.
//   We CANNOT lock a mutex to swap the graph — that would cause dropouts.
//
// THE SOLUTION: Read-Copy-Update (RCU)
//   1. The UI thread builds a NEW execution plan from the new graph.
//   2. It calls `store()` on the `arc-swap` pointer.
//   3. The audio callback calls `load()` on the next cycle.
//   4. The old plan is dropped asynchronously when no readers remain.
//
// RESULT: Zero-wait, zero-dropout, zero-lock graph mutations.
//
// Memory model:
//   - `arc_swap::ArcSwap<ExecutionPlan>` is effectively an atomic pointer.
//   - `load()` returns an `arc_swap::Guard`, not a full `Arc::clone()`.
//     This is faster than `Arc::load()` because it avoids the atomic
//     reference count increment on the hot path.
//   - The old `Arc<ExecutionPlan>` is reclaimed when the last reader drops.
//
// ═══════════════════════════════════════════════════════════════════════════

use std::sync::Arc;

use arc_swap::ArcSwap;

use std::sync::atomic::{AtomicU64, Ordering as AtomicOrdering};

use petgraph::visit::{EdgeRef, NodeIndexable};

use crate::dag::{AudioDag, ExecutionPlan, GraphError};
use crate::pdc;

// ── Live Graph ──────────────────────────────────────────────────────────

/// Thread-safe, atomically swappable execution plan.
///
/// This is the bridge between the UI thread (writer) and the audio
/// callback (reader). The audio callback never blocks — it simply reads
/// the current plan pointer every cycle.
///
/// # Performance
/// - `load()` on the audio thread: ~1ns (pointer read + guard creation)
/// - `store()` on the UI thread: ~10ns (pointer swap + old Arc decrement)
pub struct LiveGraph {
    /// The current execution plan, atomically swappable.
    current_plan: ArcSwap<ExecutionPlan>,
    /// GR-027 FIX: Monotonically increasing generation counter.
    /// Incremented on every swap_graph() for debugging plan staleness.
    generation: AtomicU64,
    // GR-012 FIX: Deferred garbage collection to prevent RT deallocations.
    garbage: std::sync::Mutex<Vec<Arc<ExecutionPlan>>>,
}

impl LiveGraph {
    /// Creates a `LiveGraph` from a validated `AudioDag`.
    ///
    /// Computes the initial execution plan (topological sort + PDC)
    /// and stores it as the current plan.
    pub fn from_dag(dag: &AudioDag) -> Result<Self, GraphError> {
        let plan = Self::compute_plan(dag)?;
        Ok(Self {
            current_plan: ArcSwap::from_pointee(plan),
            generation: AtomicU64::new(1),
            garbage: std::sync::Mutex::new(Vec::new()),
        })
    }

    /// Creates a `LiveGraph` with an empty default plan (no nodes).
    ///
    /// Used during initialization before the first graph is built.
    pub fn empty() -> Self {
        let empty_plan = ExecutionPlan {
            processing_order: Vec::new(),
            delay_compensation: Vec::new(),
            edge_delay_compensation: Vec::new(),
            parallel_stages: Vec::new(),
            parallelism_metrics: crate::dag::ParallelismMetrics::default(),
            dependency_counts: Vec::new(),
            dependents: Vec::new(),
        };
        Self {
            current_plan: ArcSwap::from_pointee(empty_plan),
            generation: AtomicU64::new(0),
            garbage: std::sync::Mutex::new(Vec::new()),
        }
    }

    /// **UI THREAD ONLY**: Atomically swaps the current execution plan.
    ///
    /// 1. Computes the new topological order from the DAG.
    /// 2. Computes PDC (Plugin Delay Compensation) for all paths.
    /// 3. Atomically stores the new plan.
    ///
    /// The audio callback will see the new plan on its next cycle.
    /// The old plan is dropped when no readers remain.
    pub fn swap_graph(&self, dag: &AudioDag) -> Result<(), GraphError> {
        let new_plan = Self::compute_plan(dag)?;
        let new_arc = Arc::new(new_plan);
        let old_arc = self.current_plan.swap(new_arc);

        // GR-013 FIX: Defer dropping the old execution plan to the UI thread.
        // If the RT thread is holding a guard, it would drop the last reference
        // and pay the deallocation cost. By pushing to `garbage`, we guarantee
        // the UI thread holds a strong ref and pays the drop cost on the next swap.
        if let Ok(mut trash) = self.garbage.lock() {
            trash.clear(); // Drop previous plans on the UI thread
            trash.push(old_arc);
        }

        // GR-027 FIX: Increment generation counter for staleness tracking.
        self.generation.fetch_add(1, AtomicOrdering::Release);
        Ok(())
    }

    /// **AUDIO THREAD (HOT PATH)**: Loads the current execution plan.
    ///
    /// Returns an `Arc<ExecutionPlan>` guard with zero-cost access.
    /// This is the ONLY method called from the real-time audio callback.
    ///
    /// # Real-Time Safety
    /// - No allocations, no locks, no syscalls.
    /// - Single atomic pointer load (~1ns on modern CPUs).
    #[inline(always)]
    pub fn load(&self) -> arc_swap::Guard<Arc<ExecutionPlan>> {
        self.current_plan.load()
    }

    /// Returns an owned Arc clone of the current execution plan.
    pub fn load_full(&self) -> Arc<ExecutionPlan> {
        self.current_plan.load_full()
    }

    /// GR-027 FIX: Returns the current generation counter.
    pub fn generation(&self) -> u64 {
        self.generation.load(AtomicOrdering::Acquire)
    }

    /// Computes an execution plan from a validated DAG.
    fn compute_plan(dag: &AudioDag) -> Result<ExecutionPlan, GraphError> {
        let processing_order = dag.topological_order()?;
        // GR-013 FIX: Compute source-level PDC (was zeroed, disabling source compensation).
        // GR-014 FIX: Use node_bound() for correct array sizing.
        let delay_compensation = pdc::compute_delay_compensation(dag, &processing_order);
        let edge_delay_compensation = pdc::compute_edge_delay_compensation(dag, &processing_order);
        let parallel_stages = dag.parallel_stages_from_order(&processing_order);
        let parallelism_metrics = AudioDag::parallelism_metrics_from_stages(&parallel_stages);

        // Compute fast-path parallel scheduling tables (lock-free stage dispatch).
        let node_bound = dag.graph().node_bound();
        let mut dependency_counts = vec![0usize; node_bound];
        let mut dependents: Vec<Vec<_>> = vec![Vec::new(); node_bound];
        for node_idx in dag.graph().node_indices() {
            let n_idx = node_idx.index();
            for edge in dag
                .graph()
                .edges_directed(node_idx, petgraph::Direction::Incoming)
            {
                let src_idx = edge.source().index();
                dependency_counts[n_idx] += 1;
                dependents[src_idx].push(node_idx);
            }
        }

        debug_assert_eq!(
            parallel_stages.iter().map(|s| s.len()).sum::<usize>(),
            processing_order.len(),
            "parallel stages must cover every node exactly once",
        );
        debug_assert!(
            {
                let mut stage_of = std::collections::HashMap::new();
                for (stage_idx, stage) in parallel_stages.iter().enumerate() {
                    for &node in stage {
                        stage_of.insert(node, stage_idx);
                    }
                }

                dag.graph().edge_references().all(|e| {
                    let from = petgraph::visit::EdgeRef::source(&e);
                    let to = petgraph::visit::EdgeRef::target(&e);
                    match (stage_of.get(&from), stage_of.get(&to)) {
                        (Some(&a), Some(&b)) => a < b,
                        _ => false,
                    }
                })
            },
            "stage partition must preserve DAG dependency direction",
        );

        Ok(ExecutionPlan {
            processing_order,
            delay_compensation,
            edge_delay_compensation,
            parallel_stages,
            dependency_counts,
            dependents,
            parallelism_metrics,
        })
    }
}

// ── Tests ───────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;
    use crate::dag::*;

    fn build_simple_dag() -> AudioDag {
        GraphBuilder::new()
            .add_node(AudioNode::new(NodeId(0), NodeKind::MasterOutput))
            .add_node(AudioNode::new(
                NodeId(1),
                NodeKind::Track {
                    name: "Track 1".into(),
                    latency_samples: 0,
                },
            ))
            .add_edge(NodeId(1), NodeId(0))
            .unwrap()
            .build()
            .unwrap()
    }

    #[test]
    fn live_graph_initializes_from_dag() {
        let dag = build_simple_dag();
        let live = LiveGraph::from_dag(&dag).unwrap();
        let plan = live.load();
        assert_eq!(plan.processing_order.len(), 2);
    }

    #[test]
    fn live_graph_empty_has_no_nodes() {
        let live = LiveGraph::empty();
        let plan = live.load();
        assert!(plan.processing_order.is_empty());
    }

    #[test]
    fn swap_graph_updates_atomically() {
        let dag1 = build_simple_dag();
        let live = LiveGraph::from_dag(&dag1).unwrap();
        assert_eq!(live.load().processing_order.len(), 2);

        // Build a larger graph
        let dag2 = GraphBuilder::new()
            .add_node(AudioNode::new(NodeId(0), NodeKind::MasterOutput))
            .add_node(AudioNode::new(
                NodeId(1),
                NodeKind::Track {
                    name: "Track 1".into(),
                    latency_samples: 0,
                },
            ))
            .add_node(AudioNode::new(
                NodeId(2),
                NodeKind::Track {
                    name: "Track 2".into(),
                    latency_samples: 0,
                },
            ))
            .add_node(AudioNode::new(
                NodeId(3),
                NodeKind::Effect {
                    name: "Reverb".into(),
                    latency_samples: 256,
                },
            ))
            .add_edge(NodeId(1), NodeId(0))
            .unwrap()
            .add_edge(NodeId(2), NodeId(3))
            .unwrap()
            .add_edge(NodeId(3), NodeId(0))
            .unwrap()
            .build()
            .unwrap();

        live.swap_graph(&dag2).unwrap();
        assert_eq!(live.load().processing_order.len(), 4);
    }

    #[test]
    fn concurrent_read_during_swap() {
        // Verify that reading the old plan while swapping doesn't panic.
        let dag = build_simple_dag();
        let live = LiveGraph::from_dag(&dag).unwrap();

        // Take a "snapshot" (simulates audio thread holding a reference)
        let _old_plan = live.load();

        // Swap graph (simulates UI thread mutation)
        let dag2 = GraphBuilder::new()
            .add_node(AudioNode::new(NodeId(0), NodeKind::MasterOutput))
            .build()
            .unwrap();
        live.swap_graph(&dag2).unwrap();

        // Old snapshot is still valid (no use-after-free)
        assert_eq!(_old_plan.processing_order.len(), 2);

        // New plan reflects the swap
        assert_eq!(live.load().processing_order.len(), 1);
    }
}
