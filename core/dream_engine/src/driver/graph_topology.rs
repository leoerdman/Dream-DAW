use std::sync::Arc;
use std::sync::atomic::Ordering;

use arc_swap::ArcSwap;
use dream_graph::{
    AudioDag, AudioEdgeKind, AudioNode, ExecutionPlan, GraphBuilder, LiveGraph, NodeId, NodeKind,
};

use crate::render_callback::MAX_TRACKS;

use super::ExternalFxRuntimeSlot;

/// Resolves the runtime FX slot list for the master bus from an external-FX
/// snapshot.
///
/// Expected shape is `track_count + 1` entries, where the last entry is master.
/// During topology transitions a stale snapshot can be longer; in that case we
/// conservatively take the tail entry to preserve master processing.
pub fn resolve_master_runtime_slots(
    external_fx_map: &[Vec<ExternalFxRuntimeSlot>],
    track_count: usize,
) -> Option<&[ExternalFxRuntimeSlot]> {
    // Expected shape: track_count + 1 entries (tracks + master).
    // During topology transitions, the snapshot may be stale.
    if external_fx_map.len() == track_count + 1 {
        // Normal case: exact match.
        external_fx_map.get(track_count).map(Vec::as_slice)
    } else if external_fx_map.len() > track_count + 1 {
        // Stale snapshot with more tracks — master is the tail entry.
        external_fx_map.last().map(Vec::as_slice)
    } else if !external_fx_map.is_empty() {
        // BUG-AUD-310 FIX: Snapshot shorter than expected (topology transition).
        // The master entry is always last. Fall back to .last() to preserve
        // master FX processing during track add/remove transitions.
        external_fx_map.last().map(Vec::as_slice)
    } else {
        None
    }
}

fn build_linear_dag(track_count: usize) -> AudioDag {
    let mut builder =
        GraphBuilder::new().add_node(AudioNode::new(NodeId(0), NodeKind::MasterOutput));
    for track_idx in 0..track_count {
        builder = builder.add_node(AudioNode::new(
            NodeId((track_idx as u64) + 1),
            NodeKind::Track {
                name: String::new(),
            },
        ));
    }

    for track_idx in 0..track_count {
        let from = NodeId((track_idx as u64) + 1);
        builder = match builder.add_edge(from, NodeId(0)) {
            Ok(next) => next,
            Err(err) => {
                log::warn!(
                    "[Graph] linear edge build failed ({}), fallback to master-only",
                    err
                );
                return dream_graph::dag::AudioDag::empty();
            }
        };
    }

    builder
        .build()
        .unwrap_or_else(|_| dream_graph::dag::AudioDag::empty())
}

fn build_dag_for_tracks(
    track_count: usize,
    routing: &[Option<usize>],
    sidechains: &[Vec<Option<usize>>],
) -> AudioDag {
    let mut builder =
        GraphBuilder::new().add_node(AudioNode::new(NodeId(0), NodeKind::MasterOutput));

    for track_idx in 0..track_count {
        builder = builder.add_node(AudioNode::new(
            NodeId((track_idx as u64) + 1),
            NodeKind::Track {
                name: String::new(),
            },
        ));
    }

    let mut wired_to_master = vec![false; track_count];
    for (track_idx, wired_master) in wired_to_master.iter_mut().enumerate().take(track_count) {
        let from = NodeId((track_idx as u64) + 1);

        if let Some(Some(dest_idx)) = routing.get(track_idx) {
            if *dest_idx < track_count && *dest_idx != track_idx {
                let to = NodeId((*dest_idx as u64) + 1);
                builder = match builder.add_edge(from, to) {
                    Ok(next) => next,
                    Err(err) => {
                        log::warn!(
                            "[Graph] routing edge {} -> {} rejected ({}), fallback to linear graph",
                            track_idx,
                            dest_idx,
                            err
                        );
                        return build_linear_dag(track_count);
                    }
                };
            } else {
                *wired_master = true;
            }
        } else {
            *wired_master = true;
        }

        if let Some(sources) = sidechains.get(track_idx) {
            for maybe_source in sources {
                if let Some(source_idx) = maybe_source
                    && *source_idx < track_count
                    && *source_idx != track_idx
                {
                    let source_node = NodeId((*source_idx as u64) + 1);
                    match builder.clone().add_edge_typed(
                        source_node,
                        from,
                        AudioEdgeKind::Sidechain,
                    ) {
                        Ok(next) => builder = next,
                        Err(err) => {
                            log::warn!(
                                "[Graph] sidechain edge {} -> {} ignored (cycle/error: {})",
                                source_idx,
                                track_idx,
                                err
                            );
                        }
                    }
                }
            }
        }
    }

    for (track_idx, wired_master) in wired_to_master.iter().enumerate().take(track_count) {
        if *wired_master {
            let from = NodeId((track_idx as u64) + 1);
            builder = match builder.add_edge(from, NodeId(0)) {
                Ok(next) => next,
                Err(err) => {
                    log::warn!(
                        "[Graph] master edge rejected ({}), fallback to linear graph",
                        err
                    );
                    return build_linear_dag(track_count);
                }
            };
        }
    }

    builder.build().unwrap_or_else(|err| {
        log::warn!("[Graph] build failed ({}), fallback to linear graph", err);
        build_linear_dag(track_count)
    })
}

fn build_master_only_dag() -> AudioDag {
    dream_graph::dag::AudioDag::empty()
}

#[derive(Debug, Clone)]
pub struct PreparedGraphSnapshot {
    pub dag: AudioDag,
    pub plan: ExecutionPlan,
    pub track_count: usize,
    pub generation: u64,
}

impl PreparedGraphSnapshot {
    fn master_only() -> Self {
        let dag = build_master_only_dag();
        let plan = LiveGraph::from_dag(&dag)
            .map(|live| (*live.load_full()).clone())
            .unwrap_or_else(|_| ExecutionPlan {
                processing_order: Vec::new(),
                delay_compensation: Vec::new(),
                edge_delay_compensation: Vec::new(),
                parallel_stages: Vec::new(),
                dependency_counts: Vec::new(),
                dependents: Vec::new(),
                parallelism_metrics: dream_graph::dag::ParallelismMetrics::default(),
            });
        Self {
            dag,
            plan,
            track_count: 0,
            generation: 0,
        }
    }
}

pub fn prepare_graph_snapshot_for_routing(
    track_count: usize,
    routing: &[Option<usize>],
    sidechains: &[Vec<Option<usize>>],
    generation: u64,
) -> PreparedGraphSnapshot {
    let safe_track_count = track_count.min(MAX_TRACKS);
    let dag = build_dag_for_tracks(safe_track_count, routing, sidechains);
    let plan = LiveGraph::from_dag(&dag)
        .map(|live| (*live.load_full()).clone())
        .unwrap_or_else(|_| ExecutionPlan {
            processing_order: Vec::new(),
            delay_compensation: Vec::new(),
            edge_delay_compensation: Vec::new(),
            parallel_stages: Vec::new(),
            dependency_counts: Vec::new(),
            dependents: Vec::new(),
            parallelism_metrics: dream_graph::dag::ParallelismMetrics::default(),
        });

    PreparedGraphSnapshot {
        dag,
        plan,
        track_count: safe_track_count,
        generation,
    }
}

pub struct SharedPreparedGraphSnapshot {
    inner: ArcSwap<PreparedGraphSnapshot>,
    generation: std::sync::atomic::AtomicU64,
}

impl SharedPreparedGraphSnapshot {
    pub fn new() -> Self {
        Self {
            inner: ArcSwap::from_pointee(PreparedGraphSnapshot::master_only()),
            generation: std::sync::atomic::AtomicU64::new(0),
        }
    }

    pub fn rebuild_for_routing(
        &self,
        track_count: usize,
        routing: &[Option<usize>],
        sidechains: &[Vec<Option<usize>>],
    ) {
        let generation = self
            .generation
            .fetch_add(1, Ordering::AcqRel)
            .wrapping_add(1);
        let snapshot =
            prepare_graph_snapshot_for_routing(track_count, routing, sidechains, generation);
        self.inner.store(Arc::new(snapshot));
    }

    pub fn load(&self) -> arc_swap::Guard<Arc<PreparedGraphSnapshot>> {
        self.inner.load()
    }
}

impl Default for SharedPreparedGraphSnapshot {
    fn default() -> Self {
        Self::new()
    }
}
