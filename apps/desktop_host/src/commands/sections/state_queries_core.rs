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

/// Legacy compatibility endpoint.
///
/// Full snapshot fallback is disabled in strict delta mode.
/// We return an explicit error (instead of empty deltas) to avoid
/// silent state desynchronization when old clients call this command.
#[tauri::command]
fn get_project_snapshot_delta(
    _project_state: tauri::State<'_, ProjectState>,
) -> Result<DeltaMutationResponse, String> {
    Err("get_project_snapshot_delta is disabled in strict delta mode".to_string())
}

/// Deep audit of end-to-end audio chain topology:
/// source -> instrument/effects -> track routing -> group -> master.
#[tauri::command]
fn get_audio_chain_audit(
    project_state: tauri::State<'_, ProjectState>,
    clip_pool_state: tauri::State<'_, ClipPoolState>,
) -> Result<AudioChainAuditPayload, String> {
    use std::collections::{HashMap, HashSet};

    let project = project_state
        .project
        .lock()
        .map_err(|e| format!("Lock poisoned: {e}"))?
        .clone();

    let id_to_index: HashMap<Uuid, usize> = project
        .tracks
        .iter()
        .enumerate()
        .map(|(i, t)| (t.id, i))
        .collect();

    let mut issues = Vec::new();
    let mut tracks = Vec::with_capacity(project.tracks.len());
    let mut routing_edges = 0usize;
    let mut invalid_routing_edges = 0usize;
    let mut sidechain_links = 0usize;
    let mut tracks_with_external_fx = 0usize;
    let mut tracks_with_internal_fx = 0usize;
    let mut total_missing_plugin_slots = 0usize;
    let mut group_track_count = 0usize;
    let mut muted_track_count = 0usize;
    let mut solo_track_count = 0usize;

    for (track_index, track) in project.tracks.iter().enumerate() {
        if track.track_type == TrackType::Group {
            group_track_count = group_track_count.saturating_add(1);
        }
        let effective_mute = track.effective_disabled_from_model();
        if effective_mute {
            muted_track_count = muted_track_count.saturating_add(1);
        }
        if track.is_solo {
            solo_track_count = solo_track_count.saturating_add(1);
        }

        let mut instrument_audit = AudioChainNodeAudit {
            total_nodes: 0,
            internal_effects: 0,
            external_plugins: 0,
            missing_plugins: 0,
            bypassed_nodes: 0,
        };
        if let Some(inst) = &track.instrument {
            audit_device_node(inst, false, &mut instrument_audit);
        }

        let mut effects_audit = AudioChainNodeAudit {
            total_nodes: 0,
            internal_effects: 0,
            external_plugins: 0,
            missing_plugins: 0,
            bypassed_nodes: 0,
        };
        for fx in &track.effects {
            audit_device_node(fx, false, &mut effects_audit);
        }

        if instrument_audit.external_plugins + effects_audit.external_plugins > 0 {
            tracks_with_external_fx = tracks_with_external_fx.saturating_add(1);
        }
        if instrument_audit.internal_effects + effects_audit.internal_effects > 0 {
            tracks_with_internal_fx = tracks_with_internal_fx.saturating_add(1);
        }
        total_missing_plugin_slots = total_missing_plugin_slots
            .saturating_add(instrument_audit.missing_plugins + effects_audit.missing_plugins);

        let parent_track_index = track
            .parent_track_id
            .and_then(|pid| id_to_index.get(&pid).copied());
        let output_track_index = track
            .output_destination_id
            .and_then(|oid| id_to_index.get(&oid).copied());
        if track.output_destination_id.is_some() {
            routing_edges = routing_edges.saturating_add(1);
            if output_track_index.is_none() {
                invalid_routing_edges = invalid_routing_edges.saturating_add(1);
                issues.push(format!(
                    "Invalid routing target: track '{}' points to unknown destination",
                    track.name
                ));
            }
        }

        let mut sidechain_sources = Vec::new();
        if let Some(inst) = &track.instrument {
            collect_sidechain_indices(inst, &id_to_index, &mut sidechain_sources);
        }
        for fx in &track.effects {
            collect_sidechain_indices(fx, &id_to_index, &mut sidechain_sources);
        }
        sidechain_sources.sort_unstable();
        sidechain_sources.dedup();
        sidechain_links = sidechain_links.saturating_add(sidechain_sources.len());

        tracks.push(AudioTrackRouteAudit {
            track_index,
            track_id: track.id.to_string(),
            name: track.name.clone(),
            track_type: format!("{:?}", track.track_type),
            muted: effective_mute,
            solo: track.is_solo,
            parent_track_index,
            output_track_index,
            routes_to_master: output_track_index.is_none(),
            receives_children: project
                .tracks
                .iter()
                .any(|candidate| candidate.output_destination_id == Some(track.id)),
            sidechain_source_indices: sidechain_sources,
            instrument: instrument_audit,
            effects: effects_audit,
        });
    }

    let mut routing_cycles = 0usize;
    for (idx, _) in project.tracks.iter().enumerate() {
        let mut seen = HashSet::new();
        let mut current = idx;
        while let Some(next) = project.tracks[current]
            .output_destination_id
            .and_then(|id| id_to_index.get(&id).copied())
        {
            if !seen.insert(next) {
                routing_cycles = routing_cycles.saturating_add(1);
                issues.push(format!("Routing cycle detected at track index {idx}"));
                break;
            }
            if next == current || next >= project.tracks.len() {
                break;
            }
            current = next;
        }
    }

    let mut master_instrument = AudioChainNodeAudit {
        total_nodes: 0,
        internal_effects: 0,
        external_plugins: 0,
        missing_plugins: 0,
        bypassed_nodes: 0,
    };
    if let Some(inst) = &project.master_track.instrument {
        audit_device_node(inst, false, &mut master_instrument);
    }
    let mut master_effects = AudioChainNodeAudit {
        total_nodes: 0,
        internal_effects: 0,
        external_plugins: 0,
        missing_plugins: 0,
        bypassed_nodes: 0,
    };
    for fx in &project.master_track.effects {
        audit_device_node(fx, false, &mut master_effects);
    }

    let snapshot = clip_pool_state.external_fx_snapshot.load();
    let expected_snapshot_tracks = project.tracks.len().min(MAX_TRACKS).saturating_add(1);
    if snapshot.len() != expected_snapshot_tracks {
        issues.push(format!(
            "External FX snapshot mismatch: actual={}, expected={}",
            snapshot.len(),
            expected_snapshot_tracks
        ));
    }

    let summary = AudioChainAuditSummary {
        track_count: project.tracks.len(),
        routing_edges,
        group_track_count,
        muted_track_count,
        solo_track_count,
        tracks_with_external_fx,
        tracks_with_internal_fx,
        total_missing_plugin_slots,
        routing_cycles,
        invalid_routing_edges,
        sidechain_links,
        external_snapshot_tracks: snapshot.len(),
        external_snapshot_expected: expected_snapshot_tracks,
    };

    Ok(AudioChainAuditPayload {
        summary,
        issues,
        tracks,
        master: AudioTrackRouteAudit {
            track_index: usize::MAX,
            track_id: project.master_track.id.to_string(),
            name: project.master_track.name.clone(),
            track_type: "Master".to_string(),
            muted: project.master_track.is_disabled,
            solo: project.master_track.is_solo,
            parent_track_index: None,
            output_track_index: None,
            routes_to_master: false,
            receives_children: true,
            sidechain_source_indices: Vec::new(),
            instrument: master_instrument,
            effects: master_effects,
        },
    })
}
