/// Attempts to parse a UUID from a routing target string.
///
/// Routing targets come in multiple formats:
///   - Raw UUID: `"550e8400-e29b-41d4-a716-446655440000"`
///   - Qualified path: `"AudioIn/Track.550e8400-e29b-41d4-a716-446655440000"`
///   - Legacy: `"AudioOut/Track.{uuid}"`
///
/// We try the last dot-segment first (qualified), then the full string (raw).
fn extract_uuid_from_routing(routing_target: &str) -> Option<uuid::Uuid> {
    // Try last segment after '.' for qualified paths (e.g. "AudioIn/Track.{uuid}")
    if let Some(pos) = routing_target.rfind('.') {
        if let Ok(id) = uuid::Uuid::parse_str(&routing_target[pos + 1..]) {
            return Some(id);
        }
    }
    // Try last segment after '/' (e.g. some internal formats)
    if let Some(pos) = routing_target.rfind('/') {
        if let Ok(id) = uuid::Uuid::parse_str(&routing_target[pos + 1..]) {
            return Some(id);
        }
    }
    // Fallback: try parsing the whole string as UUID
    uuid::Uuid::parse_str(routing_target).ok()
}

/// Recursively collects all sidechain source track UUIDs from a DeviceNode tree,
/// handling nested racks with solo/disabled states (matching the offline renderer's
/// `collect_sidechain_sources_from_node` logic exactly).
fn collect_sidechain_uuids_from_node(
    node: &dream_models::project::DeviceNode,
    parent_bypassed: bool,
    out: &mut Vec<uuid::Uuid>,
) {
    match node {
        dream_models::project::DeviceNode::Single(slot) => {
            let effectively_bypassed = parent_bypassed || slot.is_bypassed;
            if !effectively_bypassed {
                if let Some(sc_id_str) = &slot.sidechain_source_track_id {
                    if let Ok(sc_id) = uuid::Uuid::parse_str(sc_id_str) {
                        out.push(sc_id);
                    }
                }
            }
        }
        dream_models::project::DeviceNode::Rack(rack) => {
            let rack_bypassed = parent_bypassed || rack.is_bypassed;
            let has_solo = rack.chains.iter().any(|c| c.is_solo);
            for chain in &rack.chains {
                if chain.is_disabled { continue; }
                if has_solo && !chain.is_solo { continue; }
                for n in &chain.devices {
                    collect_sidechain_uuids_from_node(n, rack_bypassed, out);
                }
            }
        }
    }
}

/// Scans FlowSynth node `data` maps for values that look like track UUIDs.
///
/// FlowSynth nodes can reference external tracks (e.g., audio input nodes
/// pulling from a specific track). We scan every value in every node's data
/// map and attempt UUID parsing.
fn collect_flow_synth_track_refs(
    flow: &dream_models::project::FlowSynthConfig,
    out: &mut Vec<uuid::Uuid>,
) {
    for node in &flow.nodes {
        for value in node.data.values() {
            if let Ok(id) = uuid::Uuid::parse_str(value) {
                out.push(id);
            }
            // Also try extracting from qualified strings like "Track.{uuid}"
            if let Some(extracted) = extract_uuid_from_routing(value) {
                out.push(extracted);
            }
        }
    }
}

// ═══════════════════════════════════════════════════════════════════════════
// Enterprise Fixed-Point Graph Traversal for Offline Bounce Dependencies
// ═══════════════════════════════════════════════════════════════════════════

/// Resolves ALL tracks required to accurately render a target set of tracks.
///
/// This is a **fixed-point iterative graph traversal** that converges to
/// mathematical steady-state across the entire DAW signal flow topology.
///
/// A track becomes `required` if it satisfies **any** of these 7 rules:
///
/// 1. **Explicit Target** — selected for bounce/split.
/// 2. **Group Children** (downward) — children of a required group track.
/// 3. **Group Parent** (upward) — parent group bus of a required child track.
///    Without the parent, the child's summed bus strip won't process.
/// 4. **Sidechain Tap** — provides sidechain input to an already-required
///    track's plugin. Respects bypass/solo states in nested racks exactly
///    mirroring the offline renderer's `collect_sidechain_sources_from_node`.
/// 5. **Intermediate Buses** — track routes its `output_destination_id` into
///    a required track (e.g., submix bus feeding the target).
/// 6. **Phase 5 Routing Overrides** — `audio_output_routing` or
///    `midi_output_routing` explicitly broadcasts to a required track.
///    Also, `audio_input_routing`, `midi_input_routing`, and legacy
///    `input_source_id` on a required track explicitly listen to another.
/// 7. **FlowSynth Cross-Track Bindings** — UUID values in FlowSynth node
///    `data` maps referencing external tracks (modular grid routing).
///
/// The algorithm iterates until no new tracks are discovered (steady-state).
/// This ensures that chained dependencies (A→B→C) are resolved even if
/// they span multiple levels of indirection.
pub fn collect_required_bounce_tracks(
    project: &dream_models::project::Project,
    targets: &[uuid::Uuid],
) -> std::collections::HashSet<uuid::Uuid> {
    let mut required: std::collections::HashSet<uuid::Uuid> = targets.iter().copied().collect();
    let mut changed = true;

    while changed {
        changed = false;

        for track in &project.tracks {
            let id = track.id;

            if required.contains(&id) {
                // ── Rule 2: Include all children of a required group track ──
                for child_id in &track.child_track_ids {
                    if required.insert(*child_id) {
                        changed = true;
                    }
                }

                // ── Rule 3: Include parent group bus (upward propagation) ──
                if let Some(parent_id) = track.parent_track_id {
                    if required.insert(parent_id) {
                        changed = true;
                    }
                }

                // ── Rule 4: Sidechain source dependencies ──────────────────
                // Mirror offline renderer's bypass-aware sidechain collection
                let mut sc_deps = Vec::new();
                if let Some(inst) = &track.instrument {
                    collect_sidechain_uuids_from_node(inst, false, &mut sc_deps);
                }
                for fx in &track.effects {
                    collect_sidechain_uuids_from_node(fx, false, &mut sc_deps);
                }
                for sc_id in sc_deps {
                    if required.insert(sc_id) {
                        changed = true;
                    }
                }

                // ── Rule 6: Explicit input listeners ───────────────────────
                let mut check_input = |s: &str| {
                    if let Some(in_uuid) = extract_uuid_from_routing(s) {
                        if project.tracks.iter().any(|t| t.id == in_uuid) {
                            if required.insert(in_uuid) {
                                changed = true;
                            }
                        }
                    }
                };
                if let Some(in_str) = &track.input_source_id { check_input(in_str); }
                if let Some(a_in) = &track.audio_input_routing { check_input(&a_in.target); }
                if let Some(m_in) = &track.midi_input_routing { check_input(&m_in.target); }

                // ── Rule 7: FlowSynth cross-track bindings ─────────────────
                if let Some(flow) = &track.flow_synth {
                    let mut flow_deps = Vec::new();
                    collect_flow_synth_track_refs(flow, &mut flow_deps);
                    for dep_id in flow_deps {
                        if project.tracks.iter().any(|t| t.id == dep_id) {
                            if required.insert(dep_id) {
                                changed = true;
                            }
                        }
                    }
                }

            } else {
                // ── Rule 5: Track is NOT required. Does it FEED one? ───────
                // Check output_destination_id (submix bus routing)
                if let Some(out_id) = track.output_destination_id {
                    if required.contains(&out_id) {
                        if required.insert(id) { changed = true; }
                        continue;
                    }
                }
                // Check Phase 5 audio_output_routing
                if let Some(audio_out) = &track.audio_output_routing {
                    if let Some(target_uuid) = extract_uuid_from_routing(&audio_out.target) {
                        if required.contains(&target_uuid) {
                            if required.insert(id) { changed = true; }
                            continue;
                        }
                    }
                }
                // Check Phase 5 midi_output_routing
                if let Some(midi_out) = &track.midi_output_routing {
                    if let Some(target_uuid) = extract_uuid_from_routing(&midi_out.target) {
                        if required.contains(&target_uuid) {
                            if required.insert(id) { changed = true; }
                            continue;
                        }
                    }
                }
            }
        }
    }

    required
}

/// Bounce selected clips or selected time range to a new audio track.
#[tauri::command]
async fn bounce_selection_to_track_cmd(
    payload: BounceSelectionPayload,
    app: tauri::AppHandle,
    project_registry: tauri::State<'_, crate::state_managers::ProjectRegistry>,
    clip_pool_state: tauri::State<'_, ClipPoolState>,
    handle: tauri::State<'_, AudioEngineHandle>,
    plugin_host_state: tauri::State<'_, PluginHostState>,
) -> Result<(), String> {
    let active_project_arc = active_project!(project_registry);
    let project_state: &crate::state_managers::ProjectState = &active_project_arc;
    let project = project_state
        .project
        .lock()
        .map_err(|e| e.to_string())?
        .clone();
    let mut bounce_project = project.clone();
    let mut bounce_track_name = "Bounce".to_string();
    let insert_after_track_index: Option<usize>;

    let clip_ids: std::collections::HashSet<Uuid> = payload
        .clip_ids
        .iter()
        .filter_map(|id| Uuid::parse_str(id).ok())
        .collect();

    let (start_frame, end_frame) = if !clip_ids.is_empty() {
        for track in &mut bounce_project.tracks {
            track.clips.retain(|c| clip_ids.contains(&c.id));
            track.midi_clips.retain(|c| clip_ids.contains(&c.id));
        }

        let selected_track_indices: Vec<usize> = project
            .tracks
            .iter()
            .enumerate()
            .filter_map(|(idx, track)| {
                let has_selected_audio = track.clips.iter().any(|c| clip_ids.contains(&c.id));
                let has_selected_midi = track.midi_clips.iter().any(|c| clip_ids.contains(&c.id));
                if has_selected_audio || has_selected_midi {
                    Some(idx)
                } else {
                    None
                }
            })
            .collect();
        if selected_track_indices.len() == 1
            && let Some(track) = project.tracks.get(selected_track_indices[0])
        {
            bounce_track_name = format!("{} Bounce", track.name);
        }
        // Insert the bounced track right after the last selected track.
        insert_after_track_index = selected_track_indices.last().copied();

        let selected_audio = project
            .tracks
            .iter()
            .flat_map(|t| t.clips.iter())
            .filter(|c| clip_ids.contains(&c.id));
        let selected_midi = project
            .tracks
            .iter()
            .flat_map(|t| t.midi_clips.iter())
            .filter(|c| clip_ids.contains(&c.id));
        let mut start = i64::MAX;
        let mut end = i64::MIN;
        for c in selected_audio {
            start = start.min(c.position.sample_frame);
            end = end.max(c.position.sample_frame + c.duration.sample_frame);
        }
        for c in selected_midi {
            start = start.min(c.position.sample_frame);
            end = end.max(c.position.sample_frame + c.duration.sample_frame);
        }
        if start == i64::MAX || end == i64::MIN || end <= start {
            return Err("Nothing selected to bounce".to_string());
        }
        (start, end)
    } else if let (Some(range_start), Some(range_end), Some(start_track), Some(end_track)) = (
        payload.range_start_frames,
        payload.range_end_frames,
        payload.start_track_index,
        payload.end_track_index,
    ) {
        if range_end <= range_start {
            return Err("Invalid bounce range: end must be greater than start".to_string());
        }
        let lo = start_track.min(end_track);
        let hi = start_track.max(end_track);
        if lo == hi
            && let Some(track) = project.tracks.get(lo)
        {
            bounce_track_name = format!("{} Bounce", track.name);
        }
        insert_after_track_index = Some(hi);
        
        // Use Enterprise dependency algorithm to ONLY clear clips of isolated tracks.
        let targets: Vec<Uuid> = project.tracks[lo..=hi].iter().map(|t| t.id).collect();
        let required = collect_required_bounce_tracks(&project, &targets);
        
        for (idx, track) in bounce_project.tracks.iter_mut().enumerate() {
            if !required.contains(&track.id) {
                track.clips.clear();
                track.midi_clips.clear();
                // Ensure muted in topology
                track.is_solo = false;
            } else if idx >= lo && idx <= hi {
                // The explicit target tracks
                track.is_solo = true;
                track.is_disabled = false;
            } else {
                // A sidechain dependency track outside the bounce range.
                // Keep its clips but ensure it does not leak audio to master.
                track.is_solo = false;
            }
        }
        (range_start, range_end)
    } else {
        return Err("Bounce requires selected clips or a selected time range".to_string());
    };

    let local_pool = build_local_pool_for_project(&bounce_project, &clip_pool_state)?;
    let output_path = dream_importers::stem_separation::make_bounce_output_path("selection_bounce")?;
    let cfg = BounceConfig {
        output_path: output_path.clone(),
        sample_rate: project.sample_rate.max(1.0).round() as u32,
        bit_depth: 32,
        start_frame,
        end_frame,
        normalize: false,
        include_tail: false,
        format: "wav".to_string(),
        project_sample_rate: project.sample_rate.max(1.0),
        bpm: handle.playback_state.lock().map_err(|_| "Application state error. Please restart Dream DAW.".to_string())?.bpm,
    };

    crate::commands::plugins_routing_helpers::ensure_external_plugins_prepared_for_offline_render(
        &bounce_project,
        &clip_pool_state,
        &plugin_host_state,
        project.sample_rate,
        "Bounce",
    )?;

    let (job_id, job_cancel) = start_job(&app, "bounce_selection", true)?;
    let plugin_registry_snapshot = (*handle.plugin_registry.load()).clone();
    let external_fx_snapshot = (*handle.external_fx_snapshot.load()).clone();

    handle
        .export_cancel
        .store(false, std::sync::atomic::Ordering::SeqCst);
    let cancel_flag = std::sync::Arc::clone(&job_cancel);
    let app_for_progress = app.clone();
    let job_id_for_progress = job_id.clone();
    let bounce_res = tauri::async_runtime::spawn_blocking(move || {
        let mut bouncer = OfflineRenderer::new(cfg);
        bouncer.cancel_flag = cancel_flag;
        let mut bounce_project = bounce_project;
        let mut local_pool = local_pool;
        let plugin_registry_snapshot = plugin_registry_snapshot;
        let external_fx_snapshot = external_fx_snapshot;
        bouncer
            .bounce(
                &mut bounce_project,
                &mut local_pool,
                None,
                &plugin_registry_snapshot,
                &external_fx_snapshot,
                move |progress| {
                    let _ = set_job_progress(
                        &app_for_progress,
                        &job_id_for_progress,
                        (progress * 100.0).clamp(0.0, 100.0),
                        "Rendering",
                    );
                },
            )
            .map_err(|e| e.to_string())
    })
    .await
    .map_err(|e| format!("Bounce worker failed: {e}"))?;

    if let Err(e) = bounce_res {
        let cancelled = job_cancel.load(std::sync::atomic::Ordering::SeqCst);
        let _ = finish_job(&app, &job_id, false, cancelled, Some(e.clone()));
        return Err(e);
    }

    if job_cancel.load(std::sync::atomic::Ordering::SeqCst) {
        let _ = finish_job(
            &app,
            &job_id,
            false,
            true,
            Some("Bounce cancelled".to_string()),
        );
        return Err("Bounce cancelled".to_string());
    }

    let place_result = place_bounced_file_on_new_track(
        project_state,
        &clip_pool_state,
        &handle,
        &app,
        &output_path,
        &bounce_track_name,
        start_frame,
        &bounce_track_name,
        insert_after_track_index,
    );
    if let Err(err) = &place_result {
        let _ = finish_job(&app, &job_id, false, false, Some(err.clone()));
    }
    place_result?;
    let _ = finish_job(&app, &job_id, true, false, None);
    Ok(())
}

#[tauri::command]
async fn bounce_selection_to_track_with_deltas_cmd(
    payload: BounceSelectionPayload,
    app: tauri::AppHandle,
    project_registry: tauri::State<'_, crate::state_managers::ProjectRegistry>,
    clip_pool_state: tauri::State<'_, ClipPoolState>,
    handle: tauri::State<'_, AudioEngineHandle>,
    plugin_host_state: tauri::State<'_, PluginHostState>,
) -> Result<DeltaMutationResponse, String> {
    let active_project_arc = active_project!(project_registry);
    let project_state: &crate::state_managers::ProjectState = &active_project_arc;
    let before_project = project_state
        .project
        .lock()
        .map_err(|e| e.to_string())?
        .clone();
    bounce_selection_to_track_cmd(
        payload,
        app,
        project_registry.clone(),
        clip_pool_state,
        handle,
        plugin_host_state,
    )
    .await?;
    let after_project = project_state
        .project
        .lock()
        .map_err(|e| e.to_string())?
        .clone();
    let mut deltas = collect_added_track_and_clip_deltas(&before_project, &after_project);
    deltas.push(dream_models::delta::ProjectDelta::ProjectSnapshotReplaced {
        project: Box::new(after_project),
    });
    Ok(DeltaMutationResponse {
        deltas,
    })
}

/// Bounce an entire track to a new audio track.
#[tauri::command]
async fn bounce_track_cmd(
    track_id: String,
    app: tauri::AppHandle,
    project_registry: tauri::State<'_, crate::state_managers::ProjectRegistry>,
    clip_pool_state: tauri::State<'_, ClipPoolState>,
    handle: tauri::State<'_, AudioEngineHandle>,
    plugin_host_state: tauri::State<'_, PluginHostState>,
) -> Result<(), String> {
    let active_project_arc = active_project!(project_registry);
    let project_state: &crate::state_managers::ProjectState = &active_project_arc;
    let project = project_state
        .project
        .lock()
        .map_err(|e| e.to_string())?
        .clone();
    let track_uuid = Uuid::parse_str(&track_id).map_err(|e| format!("Invalid track ID: {e}"))?;
    let source_index = project
        .tracks
        .iter()
        .position(|t| t.id == track_uuid)
        .ok_or_else(|| "Track not found".to_string())?;
    let source_track = &project.tracks[source_index];

    let mut start_frame = i64::MAX;
    let mut end_frame = i64::MIN;
    for c in &source_track.clips {
        start_frame = start_frame.min(c.position.sample_frame);
        end_frame = end_frame.max(c.position.sample_frame + c.duration.sample_frame);
    }
    for c in &source_track.midi_clips {
        start_frame = start_frame.min(c.position.sample_frame);
        end_frame = end_frame.max(c.position.sample_frame + c.duration.sample_frame);
    }
    if start_frame == i64::MAX || end_frame == i64::MIN || end_frame <= start_frame {
        return Err("Track has no content to bounce".to_string());
    }

    let mut bounce_project = project.clone();
    let required = collect_required_bounce_tracks(&project, &[track_uuid]);
    
    for (idx, track) in bounce_project.tracks.iter_mut().enumerate() {
        if !required.contains(&track.id) {
            track.clips.clear();
            track.midi_clips.clear();
            track.is_solo = false;
        } else if idx == source_index {
            track.is_solo = true;
            track.is_disabled = false;
        } else {
            track.is_solo = false;
        }
    }

    let local_pool = build_local_pool_for_project(&bounce_project, &clip_pool_state)?;
    let output_path = dream_importers::stem_separation::make_bounce_output_path("track_bounce")?;
    let cfg = BounceConfig {
        output_path: output_path.clone(),
        sample_rate: project.sample_rate.max(1.0).round() as u32,
        bit_depth: 32,
        start_frame,
        end_frame,
        normalize: false,
        include_tail: false,
        format: "wav".to_string(),
        project_sample_rate: project.sample_rate.max(1.0),
        bpm: handle.playback_state.lock().map_err(|_| "Application state error. Please restart Dream DAW.".to_string())?.bpm,
    };

    crate::commands::plugins_routing_helpers::ensure_external_plugins_prepared_for_offline_render(
        &bounce_project,
        &clip_pool_state,
        &plugin_host_state,
        project.sample_rate,
        "Bounce",
    )?;

    let (job_id, job_cancel) = start_job(&app, "bounce_track", true)?;
    let plugin_registry_snapshot = (*handle.plugin_registry.load()).clone();
    let external_fx_snapshot = (*handle.external_fx_snapshot.load()).clone();

    handle
        .export_cancel
        .store(false, std::sync::atomic::Ordering::SeqCst);
    let cancel_flag = std::sync::Arc::clone(&job_cancel);
    let app_for_progress = app.clone();
    let job_id_for_progress = job_id.clone();
    let bounce_res = tauri::async_runtime::spawn_blocking(move || {
        let mut bouncer = OfflineRenderer::new(cfg);
        bouncer.cancel_flag = cancel_flag;
        let mut bounce_project = bounce_project;
        let mut local_pool = local_pool;
        let plugin_registry_snapshot = plugin_registry_snapshot;
        let external_fx_snapshot = external_fx_snapshot;
        bouncer
            .bounce(
                &mut bounce_project,
                &mut local_pool,
                None,
                &plugin_registry_snapshot,
                &external_fx_snapshot,
                move |progress| {
                    let _ = set_job_progress(
                        &app_for_progress,
                        &job_id_for_progress,
                        (progress * 100.0).clamp(0.0, 100.0),
                        "Rendering",
                    );
                },
            )
            .map_err(|e| e.to_string())
    })
    .await
    .map_err(|e| format!("Bounce worker failed: {e}"))?;

    if let Err(e) = bounce_res {
        let cancelled = job_cancel.load(std::sync::atomic::Ordering::SeqCst);
        let _ = finish_job(&app, &job_id, false, cancelled, Some(e.clone()));
        return Err(e);
    }

    if job_cancel.load(std::sync::atomic::Ordering::SeqCst) {
        let _ = finish_job(
            &app,
            &job_id,
            false,
            true,
            Some("Bounce cancelled".to_string()),
        );
        return Err("Bounce cancelled".to_string());
    }

    let place_result = place_bounced_file_on_new_track(
        project_state,
        &clip_pool_state,
        &handle,
        &app,
        &output_path,
        &format!("{} Bounce", source_track.name),
        start_frame,
        &format!("{} Bounce", source_track.name),
        Some(source_index),
    );
    if let Err(err) = &place_result {
        let _ = finish_job(&app, &job_id, false, false, Some(err.clone()));
    }
    place_result?;
    let _ = finish_job(&app, &job_id, true, false, None);
    Ok(())
}

/// Bounce an entire track to a new audio track and return deltas for frontend sync.
#[tauri::command]
async fn bounce_track_with_deltas_cmd(
    track_id: String,
    app: tauri::AppHandle,
    project_registry: tauri::State<'_, crate::state_managers::ProjectRegistry>,
    clip_pool_state: tauri::State<'_, ClipPoolState>,
    handle: tauri::State<'_, AudioEngineHandle>,
    plugin_host_state: tauri::State<'_, PluginHostState>,
) -> Result<DeltaMutationResponse, String> {
    let active_project_arc = active_project!(project_registry);
    let project_state: &crate::state_managers::ProjectState = &active_project_arc;
    let project = project_state
        .project
        .lock()
        .map_err(|e| e.to_string())?
        .clone();
    let track_uuid = Uuid::parse_str(&track_id).map_err(|e| format!("Invalid track ID: {e}"))?;
    let source_index = project
        .tracks
        .iter()
        .position(|t| t.id == track_uuid)
        .ok_or_else(|| "Track not found".to_string())?;
    let source_track = &project.tracks[source_index];

    bounce_track_cmd(
        track_id,
        app.clone(),
        project_registry.clone(),
        clip_pool_state.clone(),
        handle.clone(),
        plugin_host_state,
    )
    .await?;

    let placement_project = project_state
        .project
        .lock()
        .map_err(|e| e.to_string())?
        .clone();
    let maybe_new_track = placement_project
        .tracks
        .iter()
        .enumerate()
        .rev()
        .find(|(_, t)| t.name == format!("{} Bounce", source_track.name))
        .map(|(idx, t)| (idx, t.id, t.name.clone()));
    let Some((track_index, track_id_new, track_name_new)) = maybe_new_track else {
        return Err("Bounce succeeded but bounced track was not found".to_string());
    };
    let Some(new_clip) = placement_project
        .tracks
        .get(track_index)
        .and_then(|t| t.clips.last())
    else {
        return Err("Bounce succeeded but bounced clip was not found".to_string());
    };

    Ok(DeltaMutationResponse {
        deltas: vec![
            dream_models::delta::ProjectDelta::TrackAdded {
                track_index,
                track_id: track_id_new,
                name: track_name_new,
                track_type: "audio".to_string(),
            },
            dream_models::delta::ProjectDelta::ClipAdded {
                clip_id: new_clip.id,
                track_index,
                name: new_clip.name.clone(),
                clip_type: "audio".to_string(),
                file_path: Some(new_clip.file_path.clone()),
                position: new_clip.position.sample_frame,
                duration: new_clip.duration.sample_frame,
            },
        ],
    })
}

/// Bounce a group track (group + all descendant tracks) to a new audio track.
#[tauri::command]
async fn bounce_group_cmd(
    group_track_id: String,
    app: tauri::AppHandle,
    project_registry: tauri::State<'_, crate::state_managers::ProjectRegistry>,
    clip_pool_state: tauri::State<'_, ClipPoolState>,
    handle: tauri::State<'_, AudioEngineHandle>,
    plugin_host_state: tauri::State<'_, PluginHostState>,
) -> Result<(), String> {
    let active_project_arc = active_project!(project_registry);
    let project_state: &crate::state_managers::ProjectState = &active_project_arc;
    let project = project_state
        .project
        .lock()
        .map_err(|e| e.to_string())?
        .clone();
    let group_uuid =
        Uuid::parse_str(&group_track_id).map_err(|e| format!("Invalid group track ID: {e}"))?;
    let group_track = project
        .tracks
        .iter()
        .find(|t| t.id == group_uuid)
        .ok_or_else(|| "Group track not found".to_string())?;
    if group_track.track_type != TrackType::Group {
        return Err("bounce_group_cmd requires a Group track".to_string());
    }

    let mut included_ids: std::collections::HashSet<Uuid> = std::collections::HashSet::new();
    included_ids.insert(group_uuid);
    loop {
        let mut changed = false;
        for track in &project.tracks {
            if let Some(parent_id) = track.parent_track_id
                && included_ids.contains(&parent_id)
                && included_ids.insert(track.id)
            {
                changed = true;
            }
        }
        if !changed {
            break;
        }
    }

    let mut start_frame = i64::MAX;
    let mut end_frame = i64::MIN;
    for track in &project.tracks {
        if !included_ids.contains(&track.id) {
            continue;
        }
        for c in &track.clips {
            start_frame = start_frame.min(c.position.sample_frame);
            end_frame = end_frame.max(c.position.sample_frame + c.duration.sample_frame);
        }
        for c in &track.midi_clips {
            start_frame = start_frame.min(c.position.sample_frame);
            end_frame = end_frame.max(c.position.sample_frame + c.duration.sample_frame);
        }
    }
    if start_frame == i64::MAX || end_frame == i64::MIN || end_frame <= start_frame {
        return Err("Group has no content to bounce".to_string());
    }

    let mut bounce_project = project.clone();
    let target_ids: Vec<Uuid> = included_ids.iter().copied().collect();
    let required = collect_required_bounce_tracks(&project, &target_ids);

    for track in &mut bounce_project.tracks {
        if !required.contains(&track.id) {
            track.clips.clear();
            track.midi_clips.clear();
            track.is_solo = false;
        } else if included_ids.contains(&track.id) {
            track.is_solo = true;
            track.is_disabled = false;
        } else {
            track.is_solo = false;
        }
    }

    let local_pool = build_local_pool_for_project(&bounce_project, &clip_pool_state)?;
    let output_path = dream_importers::stem_separation::make_bounce_output_path("group_bounce")?;
    let cfg = BounceConfig {
        output_path: output_path.clone(),
        sample_rate: project.sample_rate.max(1.0).round() as u32,
        bit_depth: 32,
        start_frame,
        end_frame,
        normalize: false,
        include_tail: false,
        format: "wav".to_string(),
        project_sample_rate: project.sample_rate.max(1.0),
        bpm: handle.playback_state.lock().map_err(|_| "Application state error. Please restart Dream DAW.".to_string())?.bpm,
    };

    crate::commands::plugins_routing_helpers::ensure_external_plugins_prepared_for_offline_render(
        &bounce_project,
        &clip_pool_state,
        &plugin_host_state,
        project.sample_rate,
        "Bounce",
    )?;

    let (job_id, job_cancel) = start_job(&app, "bounce_group", true)?;
    let plugin_registry_snapshot = (*handle.plugin_registry.load()).clone();
    let external_fx_snapshot = (*handle.external_fx_snapshot.load()).clone();

    handle
        .export_cancel
        .store(false, std::sync::atomic::Ordering::SeqCst);
    let cancel_flag = std::sync::Arc::clone(&job_cancel);
    let app_for_progress = app.clone();
    let job_id_for_progress = job_id.clone();
    let bounce_res = tauri::async_runtime::spawn_blocking(move || {
        let mut bouncer = OfflineRenderer::new(cfg);
        bouncer.cancel_flag = cancel_flag;
        let mut bounce_project = bounce_project;
        let mut local_pool = local_pool;
        let plugin_registry_snapshot = plugin_registry_snapshot;
        let external_fx_snapshot = external_fx_snapshot;
        bouncer
            .bounce(
                &mut bounce_project,
                &mut local_pool,
                None,
                &plugin_registry_snapshot,
                &external_fx_snapshot,
                move |progress| {
                    let _ = set_job_progress(
                        &app_for_progress,
                        &job_id_for_progress,
                        (progress * 100.0).clamp(0.0, 100.0),
                        "Rendering",
                    );
                },
            )
            .map_err(|e| e.to_string())
    })
    .await
    .map_err(|e| format!("Bounce worker failed: {e}"))?;

    if let Err(e) = bounce_res {
        let cancelled = job_cancel.load(std::sync::atomic::Ordering::SeqCst);
        let _ = finish_job(&app, &job_id, false, cancelled, Some(e.clone()));
        return Err(e);
    }

    if job_cancel.load(std::sync::atomic::Ordering::SeqCst) {
        let _ = finish_job(
            &app,
            &job_id,
            false,
            true,
            Some("Bounce cancelled".to_string()),
        );
        return Err("Bounce cancelled".to_string());
    }

    let group_index = project.tracks.iter().position(|t| t.id == group_uuid);
    let place_result = place_bounced_file_on_new_track(
        project_state,
        &clip_pool_state,
        &handle,
        &app,
        &output_path,
        &format!("{} Bounce", group_track.name),
        start_frame,
        &format!("{} Bounce", group_track.name),
        group_index,
    );
    if let Err(err) = &place_result {
        let _ = finish_job(&app, &job_id, false, false, Some(err.clone()));
    }
    place_result?;
    let _ = finish_job(&app, &job_id, true, false, None);
    Ok(())
}

#[tauri::command]
async fn bounce_group_with_deltas_cmd(
    group_track_id: String,
    app: tauri::AppHandle,
    project_registry: tauri::State<'_, crate::state_managers::ProjectRegistry>,
    clip_pool_state: tauri::State<'_, ClipPoolState>,
    handle: tauri::State<'_, AudioEngineHandle>,
    plugin_host_state: tauri::State<'_, PluginHostState>,
) -> Result<DeltaMutationResponse, String> {
    let active_project_arc = active_project!(project_registry);
    let project_state: &crate::state_managers::ProjectState = &active_project_arc;
    let before_project = project_state
        .project
        .lock()
        .map_err(|e| e.to_string())?
        .clone();
    bounce_group_cmd(
        group_track_id,
        app,
        project_registry.clone(),
        clip_pool_state,
        handle,
        plugin_host_state,
    )
    .await?;
    let after_project = project_state
        .project
        .lock()
        .map_err(|e| e.to_string())?
        .clone();
    let mut deltas = collect_added_track_and_clip_deltas(&before_project, &after_project);
    deltas.push(dream_models::delta::ProjectDelta::ProjectSnapshotReplaced {
        project: Box::new(after_project),
    });
    Ok(DeltaMutationResponse {
        deltas,
    })
}

/// Consolidates selected clips on a per-track basis.
/// Bounces the selected clips on a track (pre-effects) down into a single new audio file,
/// then replaces the existing clips on that track with the single new clip.
#[tauri::command]
pub async fn consolidate_selection_cmd(
    payload: BounceSelectionPayload,
    app: tauri::AppHandle,
    project_registry: tauri::State<'_, crate::state_managers::ProjectRegistry>,
    clip_pool_state: tauri::State<'_, ClipPoolState>,
    handle: tauri::State<'_, AudioEngineHandle>,
    plugin_host_state: tauri::State<'_, PluginHostState>,
) -> Result<(), String> {
    let active_project_arc = active_project!(project_registry);
    let project_state: &crate::state_managers::ProjectState = &active_project_arc;
    let project = project_state
        .project
        .lock()
        .map_err(|e| e.to_string())?
        .clone();

    let clip_ids: std::collections::HashSet<Uuid> = payload
        .clip_ids
        .iter()
        .filter_map(|id| Uuid::parse_str(id).ok())
        .collect();

    if clip_ids.is_empty() {
        return Err("Nothing selected to consolidate".to_string());
    }

    let mut tracks_to_consolidate = Vec::new();
    for (idx, track) in project.tracks.iter().enumerate() {
        let has_selected_audio = track.clips.iter().any(|c| clip_ids.contains(&c.id));
        let has_selected_midi = track.midi_clips.iter().any(|c| clip_ids.contains(&c.id));
        
        if has_selected_audio || has_selected_midi {
            let mut start = i64::MAX;
            let mut end = i64::MIN;
            let mut track_clip_ids = Vec::new();

            for c in &track.clips {
                if clip_ids.contains(&c.id) {
                    start = start.min(c.position.sample_frame);
                    end = end.max(c.position.sample_frame + c.duration.sample_frame);
                    track_clip_ids.push(c.id);
                }
            }
            for c in &track.midi_clips {
                if clip_ids.contains(&c.id) {
                    start = start.min(c.position.sample_frame);
                    end = end.max(c.position.sample_frame + c.duration.sample_frame);
                    track_clip_ids.push(c.id);
                }
            }

            if start != i64::MAX && end != i64::MIN && end > start {
                tracks_to_consolidate.push((idx, start, end, track_clip_ids));
            }
        }
    }

    if tracks_to_consolidate.is_empty() {
        return Err("Nothing selected to consolidate".to_string());
    }

    let bpm = handle.playback_state.lock().map_err(|_| "Application state error. Please restart Dream DAW.".to_string())?.bpm;
    let (job_id, job_cancel) = start_job(&app, "consolidate_clips", true)?;
    
    handle.export_cancel.store(false, std::sync::atomic::Ordering::SeqCst);
    let cancel_flag = std::sync::Arc::clone(&job_cancel);

    let mut success_count = 0;
    
    // Push undo state once for the entire consolidate action
    push_undo(project_state)?; 

    for (track_idx, start_frame, end_frame, track_clip_ids) in tracks_to_consolidate {
        let mut bounce_project = project.clone();
        
        for (i, track) in bounce_project.tracks.iter_mut().enumerate() {
            if i == track_idx {
                track.clips.retain(|c| track_clip_ids.contains(&c.id));
                track.midi_clips.retain(|c| track_clip_ids.contains(&c.id));
                track.volume = 1.0;
                track.pan = 0.0;
                track.effects.clear();
                // Ensure no automation envelopes modify the mix during consolidate
                track.automation_lanes.clear(); 
                track.is_solo = true;
                track.is_disabled = false;
            } else {
                track.is_solo = false;
            }
        }
        
        let local_pool = build_local_pool_for_project(&bounce_project, &clip_pool_state)?;
        let output_path = dream_importers::stem_separation::make_bounce_output_path(
            &format!("consolidated_track_{}", track_idx)
        )?;
        
        let cfg = BounceConfig {
            output_path: output_path.clone(),
            sample_rate: project.sample_rate.max(1.0).round() as u32,
            bit_depth: 32,
            start_frame,
            end_frame,
            normalize: false,
            include_tail: false,
            format: "wav".to_string(),
            project_sample_rate: project.sample_rate.max(1.0),
            bpm,
        };

        crate::commands::plugins_routing_helpers::ensure_external_plugins_prepared_for_offline_render(
            &bounce_project,
            &clip_pool_state,
            &plugin_host_state,
            project.sample_rate,
            "Consolidate",
        )?;

        let plugin_registry_snapshot = (*handle.plugin_registry.load()).clone();
        let external_fx_snapshot = (*handle.external_fx_snapshot.load()).clone();

        let track_cancel_flag = std::sync::Arc::clone(&cancel_flag);

        let bounce_res = tauri::async_runtime::spawn_blocking(move || {
            let mut bouncer = OfflineRenderer::new(cfg);
            bouncer.cancel_flag = track_cancel_flag;
            bouncer
                .bounce(
                    &mut bounce_project,
                    &mut local_pool.clone(),
                    None,
                    &plugin_registry_snapshot,
                    &external_fx_snapshot,
                    |_| {}, // No granular progress for each isolated track consolidate
                )
                .map_err(|e| e.to_string())
        })
        .await
        .map_err(|e| format!("Bounce worker failed: {e}"))?;

        if let Err(e) = bounce_res {
            let cancelled = job_cancel.load(std::sync::atomic::Ordering::SeqCst);
            let _ = finish_job(&app, &job_id, false, cancelled, Some(e.clone()));
            return Err(e);
        }

        if job_cancel.load(std::sync::atomic::Ordering::SeqCst) {
            let _ = finish_job(&app, &job_id, false, true, Some("Consolidate cancelled".to_string()));
            return Err("Consolidate cancelled".to_string());
        }

        // Add the bounced file to the pool and replace the clips via orchestrator command
        let decoded = AudioReader::read(PathBuf::from(&output_path))
            .map_err(|e| format!("Failed to decode bounced file: {e}"))?;
            
        {
            let mut pool = clip_pool_state.pool.lock().map_err(|_| "Application state error. Please restart Dream DAW.".to_string())?;
            pool.insert(ClipAudio {
                source_path: output_path.clone(),
                channels: decoded.channels,
                sample_rate: decoded.sample_rate,
                num_frames: decoded.num_frames,
            })?;
        }

        let project_sr = execute_orchestrator_query(
            project_state,
            &dream_orchestrator::queries::ResolveProjectSampleRateQuery,
        )?.max(1.0);

        let source_sr = decoded.sample_rate.max(1) as f64;
        let timeline_frames = ((decoded.num_frames as f64) * (project_sr / source_sr)).round() as i64;

        let cmd = dream_orchestrator::commands::clip_bounce::ConsolidateClipsCommand {
            file_path: output_path.clone(),
            clip_name: "Consolidated".to_string(),
            start_frame,
            timeline_duration_frames: timeline_frames,
            source_duration_frames: decoded.num_frames as i64,
            track_index: track_idx,
            clips_to_remove: track_clip_ids,
        };

        let cmd_res = execute_orchestrator_command(project_state, &cmd);
        if let Err(err) = cmd_res {
            let _ = finish_job(&app, &job_id, false, false, Some(err.clone()));
            return Err(err);
        }
        
        success_count += 1;
    }

    if success_count > 0 {
        rebuild_clip_views_and_mark_dirty(
            project_state,
            &clip_pool_state,
            &handle,
            &app,
            ClipRebuildMode::FullSnapshot,
        )?;
    }

    let _ = finish_job(&app, &job_id, true, false, None);
    Ok(())
}

#[tauri::command]
pub async fn consolidate_selection_with_deltas_cmd(
    payload: BounceSelectionPayload,
    app: tauri::AppHandle,
    project_registry: tauri::State<'_, crate::state_managers::ProjectRegistry>,
    clip_pool_state: tauri::State<'_, ClipPoolState>,
    handle: tauri::State<'_, AudioEngineHandle>,
    plugin_host_state: tauri::State<'_, PluginHostState>,
) -> Result<DeltaMutationResponse, String> {
    let active_project_arc = active_project!(project_registry);
    let project_state: &crate::state_managers::ProjectState = &active_project_arc;
    let before_project = project_state
        .project
        .lock()
        .map_err(|e| e.to_string())?
        .clone();
        
    consolidate_selection_cmd(
        payload,
        app,
        project_registry.clone(),
        clip_pool_state,
        handle,
        plugin_host_state,
    )
    .await?;

    let after_project = project_state
        .project
        .lock()
        .map_err(|e| e.to_string())?
        .clone();
        
    let mut deltas = collect_added_track_and_clip_deltas(&before_project, &after_project);
    deltas.push(dream_models::delta::ProjectDelta::ProjectSnapshotReplaced {
        project: Box::new(after_project),
    });
    Ok(DeltaMutationResponse { deltas })
}
