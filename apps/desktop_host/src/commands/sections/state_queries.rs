// ═══════════════════════════════════════════════════════════════════════

#[derive(Debug, Clone, Serialize)]
struct PdcDebugSnapshot {
    node_count: usize,
    edge_count: usize,
    node_pdc_nonzero: usize,
    edge_pdc_nonzero: usize,
    processing_order: Vec<String>,
    nodes: Vec<PdcNodeDebug>,
    edges: Vec<PdcEdgeDebug>,
    node_summary: String,
    edge_summary: String,
}

#[derive(Debug, Clone, Serialize)]
struct PdcNodeDebug {
    node_id: u64,
    name: String,
    kind: String,
    own_latency_samples: u32,
    node_delay_samples: u32,
}

#[derive(Debug, Clone, Serialize)]
struct PdcEdgeDebug {
    from_node_id: u64,
    to_node_id: u64,
    from_name: String,
    to_name: String,
    edge_delay_samples: u32,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct RtDebugSnapshotPayload {
    enabled: bool,
    callback_count: u64,
    command_count_total: u64,
    command_count_last: u64,
    command_count_max: u64,
    callback_duration_us_last: u64,
    callback_duration_us_max: u64,
    callback_frames_last: u64,
    plugin_host_lock_miss_total: u64,
    queue_full_reject_total: u64,
    deferred_topology_len_last: u64,
}

/// Returns the current engine state as JSON.
#[tauri::command]
fn get_state(handle: tauri::State<'_, AudioEngineHandle>) -> Result<EngineStateResponse, String> {
    let state = handle
        .playback_state
        .lock()
        .map_err(|e| format!("Lock poisoned: {e}"))?;

    let frames = handle.master_clock.position();

    Ok(EngineStateResponse {
        is_playing: state.is_playing,
        bpm: state.bpm,
        test_tone_freq: state.test_tone_freq,
        frames_rendered: frames,
        sample_rate: state.sample_rate,
    })
}

/// Returns recent project mutation events (append-only in-memory history).
#[tauri::command]
fn get_project_history(
    project_state: tauri::State<'_, ProjectState>,
    limit: Option<usize>,
    since_seq: Option<u64>,
) -> Result<Vec<ProjectHistoryEvent>, String> {
    project_state.history_snapshot(limit, since_seq)
}

/// Returns the current transport position and state.
///
/// Includes `output_latency_frames` so the frontend can offset the
/// visual playhead to match actual speaker output, and
/// `telemetry_timestamp_ms` so the frontend can interpolate the
/// playhead at 144fps between telemetry ticks.
#[tauri::command]
fn get_transport(
    handle: tauri::State<'_, AudioEngineHandle>,
    project_state: tauri::State<'_, ProjectState>,
) -> Result<TransportState, String> {
    use std::time::{SystemTime, UNIX_EPOCH};

    let state = handle
        .playback_state
        .lock()
        .map_err(|e| format!("Lock poisoned: {e}"))?;

    let frames = handle.master_clock.position();
    let sample_rate = state.sample_rate;
    let seconds = frames as f64 / sample_rate;
    let fallback_bpm = state.bpm;
    let is_playing = state.is_playing;
    let loop_enabled = state.loop_enabled;
    let loop_start = state.loop_start;
    let loop_end = state.loop_end;
    drop(state);

    // Authoritative beat conversion must use project pulse map, not mirrored
    // transport BPM, otherwise imported ALS projects can show playhead drift
    // (e.g. 33rd bar audio sounding while UI reads ~23rd bar).
    let (bpm, position_beats) = if let Ok(project) = project_state.project.lock() {
        let bpm = project.pulse_map.initial_bpm();
        let beats = project.pulse_map.beats(frames.max(0));
        (bpm, beats)
    } else {
        (fallback_bpm, seconds * fallback_bpm / 60.0)
    };

    // Monotonic timestamp for frontend playhead interpolation.
    // Uses wall-clock ms since UNIX epoch — the frontend converts
    // to its own `performance.now()` timebase on first receipt.
    let telemetry_timestamp_ms = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs_f64() * 1000.0)
        .unwrap_or(0.0);

    Ok(TransportState {
        is_playing,
        position_frames: frames,
        position_seconds: seconds,
        position_beats,
        bpm,
        sample_rate,
        loop_enabled,
        loop_start,
        loop_end,
        output_latency_frames: handle.output_latency_frames,
        telemetry_timestamp_ms,
    })
}

/// Returns lock-free meter readings for all tracks and master.
/// Called at 30-60fps from the frontend for VU meter animation.
///
/// # Performance
/// Zero locks. Reads atomic values via `Ordering::Relaxed`.
/// Latency: <1μs total for 64 tracks.
#[tauri::command]
fn get_meters(handle: tauri::State<'_, AudioEngineHandle>) -> Result<MeteringSnapshot, String> {
    let bank = &handle.meter_bank;

    let mut tracks = Vec::with_capacity(bank.track_count());
    for i in 0..bank.track_count() {
        if let Some((left, right)) = bank.track(i) {
            tracks.push((read_meter(left), read_meter(right)));
        }
    }

    Ok(MeteringSnapshot {
        tracks,
        master_left: read_meter(bank.master_left()),
        master_right: read_meter(bank.master_right()),
    })
}

/// Sets the test tone frequency (legacy / debug).
#[tauri::command]
fn set_frequency(freq: f32, handle: tauri::State<'_, AudioEngineHandle>) -> Result<(), String> {
    if !(20.0..=20000.0).contains(&freq) {
        return Err(format!(
            "Frequency {freq}Hz out of audible range (20–20000 Hz)"
        ));
    }

    push_command(&handle, EngineCommand::SetFreq(freq))?;

    let mut state = handle
        .playback_state
        .lock()
        .map_err(|e| format!("Lock poisoned: {e}"))?;
    state.test_tone_freq = freq;

    log::info!("[IPC] set_frequency({freq}Hz)");
    Ok(())
}

/// Builds a lightweight routing DAG from current project and returns PDC diagnostics.
#[tauri::command]
fn get_pdc_debug_snapshot(
    project_state: tauri::State<'_, ProjectState>,
) -> Result<PdcDebugSnapshot, String> {
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
