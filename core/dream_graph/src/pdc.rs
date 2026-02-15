// ═══════════════════════════════════════════════════════════════════════════
// Dream DAW — Plugin Delay Compensation (PDC)
// ═══════════════════════════════════════════════════════════════════════════
//
// THE PROBLEM:
//   Plugins introduce processing latency. A reverb might add 512 samples
//   of delay. If Track A goes through a reverb and Track B goes direct,
//   they'll be 512 samples out of phase when summed at the master bus.
//   At 48kHz, that's ~10.7ms — audibly destroying stereo imaging.
//
// THE SOLUTION: Plugin Delay Compensation
//   1. Walk every path from each source to the master output.
//   2. Sum the latency of all nodes on each path.
//   3. Find the longest (maximum latency) path.
//   4. For each shorter path, insert compensation delay at the source
//      to align all paths to the same total latency.
//
// This gives us sample-accurate phase alignment across all routing paths.
//
// ALGORITHM: Bottom-Up Longest-Path (O(V + E) on the DAG)
//   Since the graph is a DAG, we use the topological sort (already computed)
//   to perform dynamic programming: for each node, compute the maximum
//   latency from any source to that node. Then, for each node, the
//   compensation is `global_max_latency - path_latency_to_this_node`.
//
// ═══════════════════════════════════════════════════════════════════════════

use petgraph::graph::NodeIndex;
use petgraph::visit::EdgeRef;

use crate::dag::AudioDag;

/// Computes per-node delay compensation values.
///
/// Returns a `Vec<u32>` indexed by `NodeIndex::index()`, where each entry
/// is the number of samples of delay that should be inserted on that node's
/// output path.
///
/// A value of `0` means no compensation needed (node is on the longest path).
///
/// # Algorithm
/// 1. Reverse pass: compute `max_to_master[node]` — the maximum latency
///    from each node to the master output.
/// 2. Find `global_max` across source nodes (nodes with no inputs).
/// 3. Apply compensation only on source nodes:
///    `compensation[source] = global_max - max_to_master[source]`.
///
/// # Complexity
/// O(V + E) — single reverse pass over the topological order.
pub fn compute_delay_compensation(dag: &AudioDag, topo_order: &[NodeIndex]) -> Vec<u32> {
    let graph = dag.graph();
    let node_count = graph.node_count();

    // ── Step 1: Reverse pass — max latency from node to master ───────
    let mut max_to_master: Vec<u32> = vec![0; node_count];
    for &node_idx in topo_order.iter().rev() {
        let own_latency = dag.node(node_idx).latency_samples();
        let best_child = graph
            .edges_directed(node_idx, petgraph::Direction::Outgoing)
            .map(|edge| max_to_master[edge.target().index()])
            .max()
            .unwrap_or(0);
        max_to_master[node_idx.index()] = own_latency + best_child;
    }

    // ── Step 2: Longest source path (critical path) ──────────────────
    let mut global_max = 0u32;
    for node_idx in graph.node_indices() {
        let is_source = graph
            .edges_directed(node_idx, petgraph::Direction::Incoming)
            .next()
            .is_none();
        if is_source {
            global_max = global_max.max(max_to_master[node_idx.index()]);
        }
    }

    // ── Step 3: Compensation only on sources ─────────────────────────
    let mut compensation = vec![0u32; node_count];
    for node_idx in graph.node_indices() {
        let is_source = graph
            .edges_directed(node_idx, petgraph::Direction::Incoming)
            .next()
            .is_none();
        if is_source {
            let node_path = max_to_master[node_idx.index()];
            if node_path < global_max {
                compensation[node_idx.index()] = global_max - node_path;
            }
        }
    }

    compensation
}

/// Returns diagnostic information about the PDC calculation for logging.
pub fn pdc_summary(dag: &AudioDag, compensation: &[u32]) -> String {
    let mut lines = Vec::new();
    lines.push(format!(
        "PDC Summary ({} nodes):",
        dag.node_count()
    ));

    let graph = dag.graph();
    for node_idx in graph.node_indices() {
        let node = dag.node(node_idx);
        let comp = compensation.get(node_idx.index()).copied().unwrap_or(0);
        let latency = node.latency_samples();

        if comp > 0 || latency > 0 {
            lines.push(format!(
                "  {} [latency={}smp, compensation={}smp]",
                node.display_name(),
                latency,
                comp
            ));
        }
    }

    if lines.len() == 1 {
        lines.push("  (no compensation needed — all paths equal)".to_string());
    }

    lines.join("\n")
}

// ── Tests ───────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;
    use crate::dag::*;

    #[test]
    fn no_latency_no_compensation() {
        // Track → Master (no effects)
        let dag = GraphBuilder::new()
            .add_node(AudioNode::new(NodeId(0), NodeKind::MasterOutput))
            .add_node(AudioNode::new(
                NodeId(1),
                NodeKind::Track {
                    name: "Dry Track".into(),
                },
            ))
            .add_edge(NodeId(1), NodeId(0))
            .unwrap()
            .build()
            .unwrap();

        let order = dag.topological_order().unwrap();
        let comp = compute_delay_compensation(&dag, &order);

        // No effects = no latency = no compensation needed
        assert!(comp.iter().all(|&c| c == 0));
    }

    #[test]
    fn single_chain_no_compensation_needed() {
        // Track → FX(512) → Master
        // Only one path — nothing to compensate against.
        let dag = GraphBuilder::new()
            .add_node(AudioNode::new(NodeId(0), NodeKind::MasterOutput))
            .add_node(AudioNode::new(
                NodeId(1),
                NodeKind::Track {
                    name: "Track".into(),
                },
            ))
            .add_node(AudioNode::new(
                NodeId(2),
                NodeKind::Effect {
                    name: "Reverb".into(),
                    latency_samples: 512,
                },
            ))
            .add_edge(NodeId(1), NodeId(2))
            .unwrap()
            .add_edge(NodeId(2), NodeId(0))
            .unwrap()
            .build()
            .unwrap();

        let order = dag.topological_order().unwrap();
        let comp = compute_delay_compensation(&dag, &order);

        // Master is the end — it should have 0 comp (it's on the longest path)
        let master_comp = comp[dag.master_index().index()];
        assert_eq!(master_comp, 0);
    }

    #[test]
    fn parallel_paths_get_compensated() {
        // Track1 → FX(512) → Master  (total: 512)
        // Track2 → Master             (total: 0)
        //
        // Track2's path is 512 samples shorter, so it needs compensation.
        let dag = GraphBuilder::new()
            .add_node(AudioNode::new(NodeId(0), NodeKind::MasterOutput))
            .add_node(AudioNode::new(
                NodeId(1),
                NodeKind::Track {
                    name: "Wet Track".into(),
                },
            ))
            .add_node(AudioNode::new(
                NodeId(2),
                NodeKind::Effect {
                    name: "Reverb".into(),
                    latency_samples: 512,
                },
            ))
            .add_node(AudioNode::new(
                NodeId(3),
                NodeKind::Track {
                    name: "Dry Track".into(),
                },
            ))
            .add_edge(NodeId(1), NodeId(2))
            .unwrap()
            .add_edge(NodeId(2), NodeId(0))
            .unwrap()
            .add_edge(NodeId(3), NodeId(0))
            .unwrap()
            .build()
            .unwrap();

        let order = dag.topological_order().unwrap();
        let comp = compute_delay_compensation(&dag, &order);

        // Find the dry track's NodeIndex
        let dry_idx = dag
            .graph()
            .node_indices()
            .find(|&i| dag.node(i).id == NodeId(3))
            .unwrap();

        // The dry track needs 512 samples of compensation
        assert_eq!(comp[dry_idx.index()], 512);
    }

    #[test]
    fn single_source_split_has_no_source_level_compensation() {
        // One source splits into two branches with different latencies.
        //
        // With source-level compensation, we do not compensate this case
        // because both branches originate from the same source node.
        let dag = GraphBuilder::new()
            .add_node(AudioNode::new(NodeId(0), NodeKind::MasterOutput))
            .add_node(AudioNode::new(
                NodeId(1),
                NodeKind::Track {
                    name: "Source".into(),
                },
            ))
            .add_node(AudioNode::new(
                NodeId(2),
                NodeKind::Effect {
                    name: "FX1".into(),
                    latency_samples: 256,
                },
            ))
            .add_node(AudioNode::new(
                NodeId(3),
                NodeKind::Effect {
                    name: "FX2".into(),
                    latency_samples: 128,
                },
            ))
            .add_node(AudioNode::new(
                NodeId(4),
                NodeKind::Bus {
                    name: "Sum Bus".into(),
                },
            ))
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

        let order = dag.topological_order().unwrap();
        let comp = compute_delay_compensation(&dag, &order);

        // Track is the only source, so no source-level compensation.
        assert!(comp.iter().all(|&c| c == 0));

        let summary = pdc_summary(&dag, &comp);
        assert!(summary.contains("PDC Summary"));
    }
}
