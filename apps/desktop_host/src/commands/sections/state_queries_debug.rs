/// Builds a lightweight routing DAG from current project and returns PDC diagnostics.
#[tauri::command]
fn get_pdc_debug_snapshot(
    project_registry: tauri::State<'_, crate::state_managers::ProjectRegistry>,
) -> Result<PdcDebugSnapshot, String> {
    let active_project_arc = active_project!(project_registry);
    let project_state: &crate::state_managers::ProjectState = &*active_project_arc;
    use dream_graph::{pdc, AudioNode, GraphBuilder, NodeId, NodeKind};
    use std::collections::HashMap;

    let project = project_state
        .project
        .lock()
        .map_err(|e| format!("Lock poisoned: {e}"))?
        .clone();

    #[derive(Clone, Copy)]
    struct TrackNodes {
        input: NodeId,
        output: NodeId,
    }

    let mut next_id = 0u64;
    let master_id = NodeId(next_id);
    next_id += 1;
    let master_bus_id = NodeId(next_id);
    next_id += 1;

    let mut builder = GraphBuilder::new()
        .add_node(AudioNode::new(master_id, NodeKind::MasterOutput))
        .add_node(AudioNode::new(
            master_bus_id,
            NodeKind::Bus {
                name: "Master Bus".to_string(),
            },
        ));

    let mut edges: Vec<(NodeId, NodeId)> = Vec::new();
    let mut track_nodes: HashMap<Uuid, TrackNodes> = HashMap::new();

    for track in &project.tracks {
        let input_id = NodeId(next_id);
        next_id += 1;
        builder = builder.add_node(AudioNode::new(
            input_id,
            NodeKind::Track {
                name: track.name.clone(),
                latency_samples: 0,
            },
        ));

        let latency = track.total_latency_frames();
        let output_id = if latency > 0 {
            let fx_id = NodeId(next_id);
            next_id += 1;
            builder = builder.add_node(AudioNode::new(
                fx_id,
                NodeKind::Effect {
                    name: format!("{} FX", track.name),
                    latency_samples: latency,
                },
            ));
            edges.push((input_id, fx_id));
            fx_id
        } else {
            input_id
        };

        track_nodes.insert(
            track.id,
            TrackNodes {
                input: input_id,
                output: output_id,
            },
        );
    }

    // Track output routing
    for track in &project.tracks {
        let Some(nodes) = track_nodes.get(&track.id).copied() else {
            continue;
        };
        let dst = track
            .output_destination_id
            .and_then(|id| track_nodes.get(&id).map(|n| n.input))
            .unwrap_or(master_bus_id);
        edges.push((nodes.output, dst));
    }

    // Master chain latency.
    let master_latency = project.master_track.total_latency_frames();
    if master_latency > 0 {
        let master_fx_id = NodeId(next_id);
        builder = builder.add_node(AudioNode::new(
            master_fx_id,
            NodeKind::Effect {
                name: "Master FX".to_string(),
                latency_samples: master_latency,
            },
        ));
        edges.push((master_bus_id, master_fx_id));
        edges.push((master_fx_id, master_id));
    } else {
        edges.push((master_bus_id, master_id));
    }

    for (from, to) in edges {
        builder = builder
            .add_edge(from, to)
            .map_err(|e| format!("Failed to build routing graph edge {from:?}->{to:?}: {e}"))?;
    }

    let dag = builder
        .build()
        .map_err(|e| format!("Failed to build routing graph: {e}"))?;
    let order = dag
        .topological_order()
        .map_err(|e| format!("Failed to topologically sort graph: {e}"))?;
    let node_pdc = pdc::compute_delay_compensation(&dag, &order);
    let edge_pdc = pdc::compute_edge_delay_compensation(&dag, &order);
    let nodes: Vec<PdcNodeDebug> = dag
        .graph()
        .node_indices()
        .map(|idx| {
            let node = dag.node(idx);
            let kind = match &node.kind {
                NodeKind::Track { .. } => "Track",
                NodeKind::Effect { .. } => "Effect",
                NodeKind::Bus { .. } => "Bus",
                NodeKind::MasterOutput => "MasterOutput",
            };
            PdcNodeDebug {
                node_id: node.id.0,
                name: node.display_name().to_string(),
                kind: kind.to_string(),
                own_latency_samples: node.latency_samples(),
                node_delay_samples: node_pdc.get(idx.index()).copied().unwrap_or(0),
            }
        })
        .collect();

    let edges: Vec<PdcEdgeDebug> = edge_pdc
        .iter()
        .map(|e| {
            let from = dag.node(e.from);
            let to = dag.node(e.to);
            PdcEdgeDebug {
                from_node_id: from.id.0,
                to_node_id: to.id.0,
                from_name: from.display_name().to_string(),
                to_name: to.display_name().to_string(),
                edge_delay_samples: e.delay_samples,
            }
        })
        .collect();

    Ok(PdcDebugSnapshot {
        node_count: dag.node_count(),
        edge_count: dag.edge_count(),
        node_pdc_nonzero: node_pdc.iter().filter(|&&v| v > 0).count(),
        edge_pdc_nonzero: edge_pdc.iter().filter(|e| e.delay_samples > 0).count(),
        processing_order: order
            .iter()
            .map(|&idx| dag.node(idx).display_name().to_string())
            .collect(),
        nodes,
        edges,
        node_summary: pdc::pdc_summary(&dag, &node_pdc),
        edge_summary: pdc::pdc_edge_summary(&dag, &edge_pdc),
    })
}

/// Returns real-time audio callback diagnostics for performance auditing.
#[tauri::command]
fn get_rt_debug_snapshot(
    handle: tauri::State<'_, AudioEngineHandle>,
) -> Result<RtDebugSnapshotPayload, String> {
    let snap = handle.rt_debug_stats.snapshot();
    Ok(RtDebugSnapshotPayload {
        enabled: snap.enabled,
        callback_count: snap.callback_count,
        command_count_total: snap.command_count_total,
        command_count_last: snap.command_count_last,
        command_count_max: snap.command_count_max,
        callback_duration_us_last: snap.callback_duration_us_last,
        callback_duration_us_max: snap.callback_duration_us_max,
        callback_frames_last: snap.callback_frames_last,
        plugin_host_lock_miss_total: snap.plugin_host_lock_miss_total,
        queue_full_reject_total: snap.queue_full_reject_total,
        deferred_topology_len_last: snap.deferred_topology_len_last,
        topology_overflow_total: snap.topology_overflow_total,
    })
}

#[tauri::command]
fn set_rt_debug_enabled(
    enabled: bool,
    handle: tauri::State<'_, AudioEngineHandle>,
) -> Result<(), String> {
    handle.rt_debug_stats.set_enabled(enabled);
    Ok(())
}
