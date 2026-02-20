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
// ALGORITHM: Reverse Longest-Path (O(V + E) on the DAG)
//   Since the graph is a DAG, we use reverse topological order:
//   for each node, compute max latency from this node to master.
//   Then we compensate only source nodes so every source path sums
//   to the same critical-path latency.
//
// ═══════════════════════════════════════════════════════════════════════════

use petgraph::graph::NodeIndex;
use petgraph::visit::{EdgeRef, NodeIndexable};

use crate::dag::{AudioDag, EdgeDelayCompensation};

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
    // BUG-077 FIX: The original source-only computation assumed linear chains
    // and failed to report compensation for parallel routing branches.
    // We now derive diagnostic node PDC directly from the robust edge compensations by
    // assigning each node the maximum delay applied to its outgoing edges.
    let edge_delays = compute_edge_delay_compensation(dag, topo_order);
    let mut node_delays = vec![0u32; dag.graph().node_bound()];
    for edge in edge_delays {
        let from_idx = edge.from.index();
        node_delays[from_idx] = node_delays[from_idx].max(edge.delay_samples);
    }
    node_delays
}

/// Computes per-edge delay compensation for merge-point alignment.
///
/// For each destination node, all incoming edges are aligned to the latest
/// upstream contribution (maximum accumulated latency to each source node).
pub fn compute_edge_delay_compensation(
    dag: &AudioDag,
    topo_order: &[NodeIndex],
) -> Vec<EdgeDelayCompensation> {
    let graph = dag.graph();

    // GR-005 FIX: Use node_bound() not node_count() — same as GR-004.
    let mut max_to_output = vec![0u32; graph.node_bound()];

    for &node_idx in topo_order {
        let max_input = graph
            .edges_directed(node_idx, petgraph::Direction::Incoming)
            .map(|e| max_to_output[e.source().index()])
            .max()
            .unwrap_or(0);
        max_to_output[node_idx.index()] = max_input + dag.node(node_idx).latency_samples();
    }

    let mut edge_delays = Vec::new();
    for dst in graph.node_indices() {
        let incoming: Vec<_> = graph
            .edges_directed(dst, petgraph::Direction::Incoming)
            .map(|e| e.source())
            .collect();
        if incoming.is_empty() {
            continue;
        }

        let max_incoming = incoming
            .iter()
            .map(|src| max_to_output[src.index()])
            .max()
            .unwrap_or(0);

        for src in incoming {
            let src_latency = max_to_output[src.index()];
            let delay_samples = max_incoming.saturating_sub(src_latency);
            edge_delays.push(EdgeDelayCompensation {
                from: src,
                to: dst,
                delay_samples,
            });
        }
    }

    edge_delays
}

/// Returns diagnostic information about the PDC calculation for logging.
pub fn pdc_summary(dag: &AudioDag, compensation: &[u32]) -> String {
    let mut lines = Vec::new();
    lines.push(format!("PDC Summary ({} nodes):", dag.node_count()));

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

/// Returns diagnostic information about per-edge PDC calculation.
pub fn pdc_edge_summary(dag: &AudioDag, edge_compensation: &[EdgeDelayCompensation]) -> String {
    let mut lines = Vec::new();
    lines.push(format!("PDC Edge Summary ({} edges):", dag.edge_count()));

    for edge in edge_compensation {
        if edge.delay_samples == 0 {
            continue;
        }
        let from = dag.node(edge.from).display_name();
        let to = dag.node(edge.to).display_name();
        lines.push(format!(
            "  {} -> {} [delay={}smp]",
            from, to, edge.delay_samples
        ));
    }

    if lines.len() == 1 {
        lines.push("  (no edge compensation needed)".to_string());
    }

    lines.join("\n")
}

// ── Tests ───────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;
    use crate::dag::*;
    use std::collections::HashMap;

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
    fn single_source_split_shows_compensation_on_shorter_branch() {
        // One source splits into two branches with different latencies.
        //
        // BUG-077 FIX: Now derived from edge delays, so the node feeding the
        // shorter branch (FX2) correctly shows compensation to align with FX1.
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

        // FX2's short path needs 128 samples compensation before Sum Bus
        let fx2_idx = dag
            .graph()
            .node_indices()
            .find(|&i| dag.node(i).id == NodeId(3))
            .unwrap();

        assert_eq!(comp[fx2_idx.index()], 128);

        let summary = pdc_summary(&dag, &comp);
        assert!(summary.contains("PDC Summary"));
    }

    #[derive(Clone, Copy)]
    struct XorShift64(u64);

    impl XorShift64 {
        fn new(seed: u64) -> Self {
            Self(seed)
        }

        fn next_u32(&mut self) -> u32 {
            let mut x = self.0;
            x ^= x << 13;
            x ^= x >> 7;
            x ^= x << 17;
            self.0 = x;
            (x >> 16) as u32
        }

        fn range(&mut self, min: u32, max_exclusive: u32) -> u32 {
            min + (self.next_u32() % (max_exclusive - min).max(1))
        }
    }

    fn longest_to_master(
        dag: &AudioDag,
        node_idx: petgraph::graph::NodeIndex,
        memo: &mut HashMap<petgraph::graph::NodeIndex, u32>,
    ) -> u32 {
        if let Some(v) = memo.get(&node_idx) {
            return *v;
        }

        let own = dag.node(node_idx).latency_samples();
        let outs = dag.outputs(node_idx);
        let best_child = outs
            .iter()
            .map(|&child| longest_to_master(dag, child, memo))
            .max()
            .unwrap_or(0);
        let total = own + best_child;
        memo.insert(node_idx, total);
        total
    }

    #[test]
    fn randomized_dag_compensation_property_holds() {
        let mut rng = XorShift64::new(0xC0FFEE_u64);

        // Fuzz-style deterministic sweep of random DAGs.
        for _ in 0..300 {
            let node_count = rng.range(4, 14) as usize;
            let master_id = (node_count - 1) as u64;

            let mut builder = GraphBuilder::new()
                .add_node(AudioNode::new(NodeId(master_id), NodeKind::MasterOutput));

            for id in 0..(node_count as u64 - 1) {
                let choose = rng.range(0, 3);
                let node = match choose {
                    0 => AudioNode::new(
                        NodeId(id),
                        NodeKind::Track {
                            name: format!("T{id}"),
                        },
                    ),
                    1 => AudioNode::new(
                        NodeId(id),
                        NodeKind::Bus {
                            name: format!("B{id}"),
                        },
                    ),
                    _ => AudioNode::new(
                        NodeId(id),
                        NodeKind::Effect {
                            name: format!("FX{id}"),
                            latency_samples: rng.range(0, 2049),
                        },
                    ),
                };
                builder = builder.add_node(node);
            }

            // Mandatory forward chain guarantees all nodes reach master.
            for id in 0..(node_count as u64 - 1) {
                let next = id + 1;
                builder = builder.add_edge(NodeId(id), NodeId(next)).unwrap();
            }

            // Random extra edges (acyclic by construction: from lower id to higher id).
            let extra_edges = rng.range(0, (node_count * 3) as u32) as usize;
            for _ in 0..extra_edges {
                let from = rng.range(0, (node_count - 1) as u32) as u64;
                let to = rng.range((from + 1) as u32, node_count as u32) as u64;
                builder = builder.add_edge(NodeId(from), NodeId(to)).unwrap();
            }

            let dag = builder.build().unwrap();
            let order = dag.topological_order().unwrap();
            let comp = compute_delay_compensation(&dag, &order);
            let edge_comp = compute_edge_delay_compensation(&dag, &order);

            let mut memo = HashMap::new();
            let mut global_max = 0u32;
            let sources: Vec<_> = dag
                .graph()
                .node_indices()
                .filter(|&idx| dag.inputs(idx).is_empty())
                .collect();

            for &src in &sources {
                global_max = global_max.max(longest_to_master(&dag, src, &mut memo));
            }

            // Property 1: No double-compensation (max node delay in any path component <= edge delays)
            // (Replaced the source-only linear DAG tests as BUG-077 correctly identifies 
            // that parallel chains mandate non-source node compensation).
            for idx in dag.graph().node_indices() {
                let comp_val = comp[idx.index()];
                let max_out_edge = dag.graph().edges_directed(idx, petgraph::Direction::Outgoing)
                    .map(|e| {
                        edge_comp.iter().find(|c| c.from == e.source() && c.to == e.target())
                            .map(|c| c.delay_samples)
                            .unwrap_or(0)
                    })
                    .max()
                    .unwrap_or(0);
                assert_eq!(comp_val, max_out_edge);
            }

            // Property 3: at every merge node, edge-compensated inputs align.
            let mut max_to_output = vec![0u32; dag.graph().node_bound()];
            for &node_idx in &order {
                let max_input = dag
                    .inputs(node_idx)
                    .into_iter()
                    .map(|src| max_to_output[src.index()])
                    .max()
                    .unwrap_or(0);
                max_to_output[node_idx.index()] = max_input + dag.node(node_idx).latency_samples();
            }

            for node_idx in dag.graph().node_indices() {
                let incoming = dag.inputs(node_idx);
                if incoming.len() <= 1 {
                    continue;
                }

                let mut aligned: Option<u32> = None;
                for src in incoming {
                    let edge_delay = edge_comp
                        .iter()
                        .find(|e| e.from == src && e.to == node_idx)
                        .map(|e| e.delay_samples)
                        .unwrap_or(0);
                    let v = max_to_output[src.index()] + edge_delay;
                    if let Some(target) = aligned {
                        assert_eq!(
                            v,
                            target,
                            "merge node {:?} has unaligned inputs",
                            dag.node(node_idx).id
                        );
                    } else {
                        aligned = Some(v);
                    }
                }
            }
        }
    }

    #[test]
    fn edge_compensation_aligns_master_inputs() {
        // Wet(512) -> Master, Dry(0) -> Master
        let dag = GraphBuilder::new()
            .add_node(AudioNode::new(NodeId(0), NodeKind::MasterOutput))
            .add_node(AudioNode::new(
                NodeId(1),
                NodeKind::Track { name: "Wet".into() },
            ))
            .add_node(AudioNode::new(
                NodeId(2),
                NodeKind::Effect {
                    name: "FX".into(),
                    latency_samples: 512,
                },
            ))
            .add_node(AudioNode::new(
                NodeId(3),
                NodeKind::Track { name: "Dry".into() },
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
        let edge = compute_edge_delay_compensation(&dag, &order);

        let dry_idx = dag
            .graph()
            .node_indices()
            .find(|&i| dag.node(i).id == NodeId(3))
            .unwrap();
        let master_idx = dag.master_index();
        let dry_edge_delay = edge
            .iter()
            .find(|e| e.from == dry_idx && e.to == master_idx)
            .map(|e| e.delay_samples)
            .unwrap_or(0);

        assert_eq!(dry_edge_delay, 512);
    }

    #[test]
    fn edge_compensation_handles_multilevel_split_rejoin() {
        // A -> FX1(300) --\
        //                  Bus1 -> Master
        // A -> FX2(100) --/
        // B -> FX3(50)  ----> Bus1
        let dag = GraphBuilder::new()
            .add_node(AudioNode::new(NodeId(0), NodeKind::MasterOutput))
            .add_node(AudioNode::new(
                NodeId(1),
                NodeKind::Track { name: "A".into() },
            ))
            .add_node(AudioNode::new(
                NodeId(2),
                NodeKind::Track { name: "B".into() },
            ))
            .add_node(AudioNode::new(
                NodeId(3),
                NodeKind::Effect {
                    name: "FX1".into(),
                    latency_samples: 300,
                },
            ))
            .add_node(AudioNode::new(
                NodeId(4),
                NodeKind::Effect {
                    name: "FX2".into(),
                    latency_samples: 100,
                },
            ))
            .add_node(AudioNode::new(
                NodeId(5),
                NodeKind::Effect {
                    name: "FX3".into(),
                    latency_samples: 50,
                },
            ))
            .add_node(AudioNode::new(
                NodeId(6),
                NodeKind::Bus {
                    name: "Bus1".into(),
                },
            ))
            .add_edge(NodeId(1), NodeId(3))
            .unwrap()
            .add_edge(NodeId(1), NodeId(4))
            .unwrap()
            .add_edge(NodeId(2), NodeId(5))
            .unwrap()
            .add_edge(NodeId(3), NodeId(6))
            .unwrap()
            .add_edge(NodeId(4), NodeId(6))
            .unwrap()
            .add_edge(NodeId(5), NodeId(6))
            .unwrap()
            .add_edge(NodeId(6), NodeId(0))
            .unwrap()
            .build()
            .unwrap();

        let order = dag.topological_order().unwrap();
        let edges = compute_edge_delay_compensation(&dag, &order);

        let bus_idx = dag
            .graph()
            .node_indices()
            .find(|&i| dag.node(i).id == NodeId(6))
            .unwrap();
        let fx1_idx = dag
            .graph()
            .node_indices()
            .find(|&i| dag.node(i).id == NodeId(3))
            .unwrap();
        let fx2_idx = dag
            .graph()
            .node_indices()
            .find(|&i| dag.node(i).id == NodeId(4))
            .unwrap();
        let fx3_idx = dag
            .graph()
            .node_indices()
            .find(|&i| dag.node(i).id == NodeId(5))
            .unwrap();

        let d1 = edges
            .iter()
            .find(|e| e.from == fx1_idx && e.to == bus_idx)
            .map(|e| e.delay_samples)
            .unwrap_or(0);
        let d2 = edges
            .iter()
            .find(|e| e.from == fx2_idx && e.to == bus_idx)
            .map(|e| e.delay_samples)
            .unwrap_or(0);
        let d3 = edges
            .iter()
            .find(|e| e.from == fx3_idx && e.to == bus_idx)
            .map(|e| e.delay_samples)
            .unwrap_or(0);

        assert_eq!(d1, 0);
        assert_eq!(d2, 200);
        assert_eq!(d3, 250);
    }
}
