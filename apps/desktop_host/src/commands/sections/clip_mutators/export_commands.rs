fn restore_slot_state_for_export(
    plugin_host_state: &PluginHostState,
    slot: &dream_models::project::PluginSlot,
    instance_id: uuid::Uuid,
    restored_state_count: &mut usize,
) {
    if slot.external_state_blob.is_none() && slot.external_preset_blob.is_none() {
        return;
    }

    let Ok(mut host) = plugin_host_state.host.lock() else {
        log::warn!(
            "[Export] Host lock failed for plugin state restore (slot='{}' id={})",
            slot.name,
            slot.id
        );
        return;
    };

    if let Err(err) = crate::commands::plugins_routing_helpers::apply_imported_external_state_blob(
        &mut host,
        instance_id,
        slot,
    ) {
        log::warn!(
            "[Export] Failed to restore imported state for slot '{}' ({}): {}",
            slot.name,
            slot.id,
            err
        );
    } else {
        *restored_state_count = restored_state_count.saturating_add(1);
    }
}

fn ensure_slot_loaded_for_export(
    plugin_host_state: &PluginHostState,
    slot: &dream_models::project::PluginSlot,
    slot_instance_map: &mut std::sync::Arc<std::collections::HashMap<uuid::Uuid, uuid::Uuid>>,
    ensure_loaded_count: &mut usize,
    restored_state_count: &mut usize,
) {
    let plugin_id = slot.plugin_id.as_str();
    if plugin_id.starts_with("internal://") || plugin_id.starts_with("missing://") {
        return;
    }

    if let Some(instance_id) = slot_instance_map.get(&slot.id).copied() {
        restore_slot_state_for_export(plugin_host_state, slot, instance_id, restored_state_count);
        return;
    }

    match plugin_host_state.ensure_loaded_instance_for_slot(slot.id, plugin_id) {
        Ok(_) => {
            *ensure_loaded_count = ensure_loaded_count.saturating_add(1);
            *slot_instance_map = plugin_host_state.slot_instance_snapshot();
            if let Some(instance_id) = slot_instance_map.get(&slot.id).copied() {
                restore_slot_state_for_export(
                    plugin_host_state,
                    slot,
                    instance_id,
                    restored_state_count,
                );
            }
        }
        Err(err) => {
            log::warn!(
                "[Export] Failed to ensure plugin instance for slot '{}' ({}): {}",
                slot.name,
                plugin_id,
                err
            );
        }
    }
}

fn export_quiescence_wait_ms(sample_rate_hz: f64) -> u64 {
    let sr = if sample_rate_hz.is_finite() && sample_rate_hz > 0.0 {
        sample_rate_hz
    } else {
        44_100.0
    };
    // Wait roughly two callback periods, using the offline buffer size as
    // a conservative reference. Keeps the wait tight to avoid UI stalls.
    let frames_ref = dream_engine::offline_bounce::OFFLINE_BUFFER_FRAMES_FOR_PLUGINS as f64;
    ((frames_ref * 2.0 / sr) * 1000.0).round().clamp(35.0, 140.0) as u64
}

/// Offline bounce/export command.
#[tauri::command]
async fn export_mix_cmd(
    settings: ExportSettingsPayload,
    app: tauri::AppHandle,
    project_registry: tauri::State<'_, crate::state_managers::ProjectRegistry>,
    clip_pool_state: tauri::State<'_, ClipPoolState>,
    handle: tauri::State<'_, AudioEngineHandle>,
    plugin_host_state: tauri::State<'_, PluginHostState>,
) -> Result<String, String>  {
    let active_project_arc = match project_registry.get_active_project() {
        Some(p) => p,
        None => return Err("No active project".to_string()),
    };
    let project_state: &crate::state_managers::ProjectState = &*active_project_arc;
    let project = project_state
        .project
        .lock()
        .map_err(|e| e.to_string())?
        .clone();

    let export_range = settings.range.trim().to_ascii_lowercase();
    if !["full", "loop", "selected"].contains(&export_range.as_str()) {
        return Err(format!(
            "Unsupported export range '{}'. Use 'full', 'loop', or 'selected'.",
            settings.range
        ));
    }
    let export_format = settings.format.trim().to_ascii_lowercase();
    if export_format != "wav" && export_format != "mp3" {
        return Err(format!(
            "Unsupported export format '{}'. Use 'wav' or 'mp3'.",
            settings.format
        ));
    }

    let project_end_frame = project
        .tracks
        .iter()
        .map(|t| {
            let audio_end = t
                .clips
                .iter()
                .map(|c| c.position.sample_frame + c.duration.sample_frame)
                .max()
                .unwrap_or(0);
            let midi_end = t
                .midi_clips
                .iter()
                .map(|c| c.position.sample_frame + c.duration.sample_frame)
                .max()
                .unwrap_or(0);
            audio_end.max(midi_end)
        })
        .max()
        .unwrap_or(0)
        .max(1);

    let (start_frame, end_frame) = if export_range == "selected" {
        match (settings.start_frame, settings.end_frame) {
            (Some(s), Some(e)) if e > s => (s, e),
            _ => return Err("Selected range requires valid start_frame and end_frame".to_string()),
        }
    } else if export_range == "loop" {
        let state = handle.playback_state.lock().map_err(|e| e.to_string())?;
        if state.loop_enabled && state.loop_end > state.loop_start {
            (state.loop_start, state.loop_end)
        } else {
            (0, project_end_frame)
        }
    } else {
        (0, project_end_frame)
    };

    let local_pool = build_local_pool_for_project(&project, &clip_pool_state)?;

    let export_bpm = handle.playback_state.lock().map_err(|e| e.to_string())?.bpm;
    let cfg = BounceConfig {
        output_path: settings.output_path.clone(),
        sample_rate: settings.sample_rate,
        bit_depth: settings.bit_depth,
        start_frame,
        end_frame,
        normalize: settings.normalize,
        tail_frames: ((settings.tail_ms as f64 / 1000.0) * settings.sample_rate as f64) as i64,
        format: export_format,
        project_sample_rate: project.sample_rate.max(1.0),
        bpm: export_bpm,
    };

    // ── Ensure external plugin runtime bindings are ready for export ──
    // Export uses lock-free runtime snapshots; if a slot is not currently bound
    // to a plugin instance, VST instruments/FX can render as silence.
    // Re-bind missing external slots before snapshotting.
    let mut ensure_loaded_count = 0usize;
    let mut restored_state_count = 0usize;
    let mut slot_instance_map = plugin_host_state.slot_instance_snapshot();
    for track in &project.tracks {
        if let Some(inst) = &track.instrument {
            for slot in inst.collect_plugin_slots() {
                ensure_slot_loaded_for_export(
                    &plugin_host_state,
                    slot,
                    &mut slot_instance_map,
                    &mut ensure_loaded_count,
                    &mut restored_state_count,
                );
            }
        }
        for node in &track.effects {
            for slot in node.collect_plugin_slots() {
                ensure_slot_loaded_for_export(
                    &plugin_host_state,
                    slot,
                    &mut slot_instance_map,
                    &mut ensure_loaded_count,
                    &mut restored_state_count,
                );
            }
        }
    }
    if let Some(inst) = &project.master_track.instrument {
        for slot in inst.collect_plugin_slots() {
            ensure_slot_loaded_for_export(
                &plugin_host_state,
                slot,
                &mut slot_instance_map,
                &mut ensure_loaded_count,
                &mut restored_state_count,
            );
        }
    }
    for node in &project.master_track.effects {
        for slot in node.collect_plugin_slots() {
            ensure_slot_loaded_for_export(
                &plugin_host_state,
                slot,
                &mut slot_instance_map,
                &mut ensure_loaded_count,
                &mut restored_state_count,
            );
        }
    }
    if ensure_loaded_count > 0 {
        log::info!(
            "[Export] Ensured {} previously-unbound external plugin slot(s) before bounce",
            ensure_loaded_count
        );
    }
    if restored_state_count > 0 {
        log::info!(
            "[Export] Restored imported plugin state/preset for {} external slot(s) before bounce",
            restored_state_count
        );
    }

    // Preflight (soft): if slot-id binding is still missing after ensure_loaded,
    // do not abort yet. Slot IDs can desync transiently after project import/edit,
    // while the runtime snapshot may still contain a valid external instrument slot.
    // We keep this as diagnostics and rely on the stricter runtime snapshot
    // verification below for hard-fail decisions.
    let mut unresolved_vst_instruments: Vec<String> = Vec::new();
    for track in &project.tracks {
        if track.midi_clips.is_empty() {
            continue;
        }
        let Some(inst_node) = &track.instrument else {
            continue;
        };
        let mut track_has_external_instrument = false;
        let mut track_has_bound_external_instrument = false;
        for slot in inst_node.collect_plugin_slots() {
            let plugin_id = slot.plugin_id.as_str();
            if plugin_id.starts_with("internal://") || plugin_id.starts_with("missing://") {
                continue;
            }
            track_has_external_instrument = true;
            if slot_instance_map.contains_key(&slot.id) {
                track_has_bound_external_instrument = true;
                break;
            }
        }
        if track_has_external_instrument && !track_has_bound_external_instrument {
            unresolved_vst_instruments.push(format!("track='{}' id={}", track.name, track.id));
        }
    }
    if !unresolved_vst_instruments.is_empty() {
        log::warn!(
            "[Export] unresolved external instrument runtime binding(s) after ensure_loaded: {}",
            unresolved_vst_instruments.join("; ")
        );
    }

    // Refresh runtime snapshots used by OfflineRenderer.
    clip_pool_state.rebuild_external_fx_snapshot(&project, slot_instance_map.as_ref());
    plugin_host_state.publish_registry();
    let external_fx_snapshot_for_preflight = (*handle.external_fx_snapshot.load()).clone();
    let mut unresolved_runtime_tracks: Vec<String> = Vec::new();
    for (track_idx, track) in project.tracks.iter().enumerate() {
        if track.midi_clips.is_empty() {
            continue;
        }
        let Some(inst_node) = &track.instrument else {
            continue;
        };
        let has_external_inst_declared = inst_node
            .collect_plugin_slots()
            .iter()
            .any(|slot| {
                let pid = slot.plugin_id.as_str();
                !pid.starts_with("internal://") && !pid.starts_with("missing://")
            });
        if !has_external_inst_declared {
            continue;
        }
        let runtime_slots = external_fx_snapshot_for_preflight
            .get(track_idx)
            .map(|slots| slots.as_slice())
            .unwrap_or(&[]);
        let has_runtime_external_slot = runtime_slots
            .iter()
            .any(|slot| slot.instance_id.is_some() && slot.internal_slot_index.is_none());
        if !has_runtime_external_slot {
            unresolved_runtime_tracks.push(format!(
                "track='{}' index={} id={}",
                track.name, track_idx, track.id
            ));
        }
    }
    if !unresolved_runtime_tracks.is_empty() {
        let details = unresolved_runtime_tracks.join("; ");
        log::warn!(
            "[Export] external FX runtime snapshot missing instrument slot(s); continuing best-effort export: {}",
            details
        );
    }

    // ── ENTERPRISE FIX: Stop playback BEFORE reactivating plugins ─────
    // CRITICAL ORDERING: Previously, reactivate_all(sr, 512) was called
    // while the RT audio thread was still running. This caused:
    // 1. Race condition: deactivate()/activate() from export thread vs
    //    process() from RT callback on the same PluginInstanceArc.
    // 2. After reactivation to 512, the RT thread sent >512 frame blocks,
    //    triggering the VST3 passthrough guard → all FX/instruments silent.
    // Fix: stop playback FIRST, wait for quiescence, THEN reactivate.
    let was_playing = {
        let state = handle.playback_state.lock().map_err(|e| e.to_string())?;
        state.is_playing
    };
    if was_playing {
        push_command(&handle, EngineCommand::SetPlay(false))?;
        let timeline_sr = {
            let state = handle.playback_state.lock().map_err(|e| e.to_string())?;
            state.sample_rate
        };
        {
            let mut state = handle.playback_state.lock().map_err(|e| e.to_string())?;
            state.is_playing = false;
        }
        log::info!("[Export] Stopped playback to prevent VST state corruption during export");
        let wait_start = std::time::Instant::now();
        let wait_ms = export_quiescence_wait_ms(timeline_sr);
        std::thread::sleep(std::time::Duration::from_millis(wait_ms));
        log::info!(
            "[Export] Waited {}ms for RT thread quiescence (target={}ms @ {:.0}Hz)",
            wait_start.elapsed().as_millis(),
            wait_ms,
            timeline_sr
        );
    }

    // Signal the RT callback to stop ALL external VST plugin processing.
    // This MUST happen after quiescence wait so the command is drained
    // in the next callback cycle. After this, the RT callback will skip
    // all try_lock() calls on shared PluginInstanceArc objects.
    push_command(&handle, EngineCommand::SetExportActive(true))?;
    // BUF-E04 FIX: Adaptive wait for the RT callback to drain SetExportActive.
    // The old hardcoded 50ms was insufficient at high buffer sizes (e.g.
    // 8192 frames @ 44.1kHz = 186ms callback period). Now uses the same
    // adaptive quiescence calculation to ensure at least one full callback.
    let export_active_wait = export_quiescence_wait_ms(project.sample_rate.max(1.0));
    std::thread::sleep(std::time::Duration::from_millis(export_active_wait));

    // Ensure plugins are reactivated for the offline export processing format.
    // MUST happen AFTER stopping playback — the RT thread must not be calling
    // process() on plugins while we deactivate/reactivate them.
    let offline_buffer_size = dream_engine::offline_bounce::OFFLINE_BUFFER_FRAMES_FOR_PLUGINS;
    if let Err(e) = plugin_host_state.reactivate_all(project.sample_rate.max(1.0), offline_buffer_size) {
        log::warn!(
            "[Export] Failed to reactivate plugin runtime; continuing best-effort export: {}",
            e
        );
    }

    // Clone the command producer so we can resume playback from spawn_blocking.
    let cmd_producer = {
        let producer_guard = handle.producer.lock().map_err(|e| e.to_string())?;
        // We can't clone the producer, but we need it for post-export.
        // Instead, pass the was_playing flag and resume via the app handle.
        drop(producer_guard);
        was_playing
    };
    // Snapshot runtime plugin state used by OfflineRenderer.
    // This keeps offline export timing aligned with realtime graph processing.
    let plugin_registry_snapshot = (*handle.plugin_registry.load()).clone();
    let external_fx_snapshot = (*handle.external_fx_snapshot.load()).clone();
    let mut missing_registry_instances: Vec<String> = Vec::new();
    for (track_idx, slots) in external_fx_snapshot.iter().enumerate() {
        for slot in slots {
            if let Some(instance_id) = slot.instance_id
                && !plugin_registry_snapshot.contains_key(&instance_id)
            {
                missing_registry_instances.push(format!(
                    "track_index={} slot_id={:?} instance_id={}",
                    track_idx, slot.slot_id, instance_id
                ));
            }
        }
    }
    if !missing_registry_instances.is_empty() {
        log::warn!(
            "[Export] plugin registry missing external runtime instance(s): {}",
            missing_registry_instances.join("; ")
        );
    }
    // Store the handle's producer as a Send-safe wrapper for the blocking task.
    // We'll use the AppHandle to send an IPC command to resume playback.
    let app_for_resume = app.clone();

    let (job_id, job_cancel) = start_job(&app, "export_mix", true)?;

    // Reset cancel flag and execute export as detached background worker.
    handle
        .export_cancel
        .store(false, std::sync::atomic::Ordering::SeqCst);
    let cancel_flag = std::sync::Arc::clone(&job_cancel);
    let app_for_progress = app.clone();
    let app_for_finish = app.clone();
    let job_id_for_progress = job_id.clone();
    let job_id_for_finish = job_id.clone();
    // Capture plugin host Arc for post-export reactivation back to RT buffer size.
    let plugin_host_arc = std::sync::Arc::clone(&plugin_host_state.host);
    let project_sr_for_reactivate = project.sample_rate.max(1.0);

    tauri::async_runtime::spawn_blocking(move || {
        let mut bouncer = OfflineRenderer::new(cfg);
        bouncer.cancel_flag = std::sync::Arc::clone(&cancel_flag);
        let mut project = project;
        let mut local_pool = local_pool;

        // ENTERPRISE: single-source offline render path.
        // We intentionally avoid pre-rendering VST instruments/FX here because
        // split pipelines caused drift, double-processing, and silent fallback
        // states across project variants. OfflineRenderer already supports
        // timeline-accurate runtime VST processing (instrument + track FX + master FX).
        let external_fx_snapshot_for_bounce = Vec::clone(&external_fx_snapshot);

        // Use runtime plugin snapshots for continuous, timeline-accurate export.
        // This avoids per-clip pre-render drift and keeps track alignment stable.
        let result = bouncer
            .bounce(
                &mut project,
                &mut local_pool,
                None,
                &plugin_registry_snapshot,
                &external_fx_snapshot_for_bounce,
                move |progress| {
                    let payload = serde_json::json!({
                        "jobId": &job_id_for_progress,
                        "progress": (progress * 100.0).clamp(0.0, 100.0),
                        "phase": "Rendering"
                    });
                    let _ = app_for_progress.emit("bounce_progress", payload);
                    let _ = set_job_progress(
                        &app_for_progress,
                        &job_id_for_progress,
                        (progress * 100.0).clamp(0.0, 100.0),
                        "Rendering",
                    );
                },
            )
            .map_err(|e| e.to_string());

        // ── Reactivate plugins to RT buffer size after export ────────
        // During export, plugins were activated with OFFLINE_BUFFER_FRAMES (512).
        // The RT audio thread may deliver up to MAX_BUFFER_FRAMES (8192) per
        // callback. If we don't reactivate, the num_frames > max_buffer_size
        // guard in VST3 plugins would trigger, causing silent passthrough.
        if let Ok(mut host) = plugin_host_arc.lock() {
            host.reactivate_all(
                project_sr_for_reactivate,
                dream_engine::render_callback::MAX_BUFFER_FRAMES,
            );
            log::info!("[Export] Reactivated plugins to RT buffer size ({})", dream_engine::render_callback::MAX_BUFFER_FRAMES);
        }

        // ── Re-enable RT external VST processing after export ───────
        // Send SetExportActive(false) to the RT callback so it resumes
        // try_lock() calls on external plugins (now safely reactivated
        // to the RT buffer size).
        if let Some(engine_handle) = app_for_resume.try_state::<crate::state_managers::audio_engine::AudioEngineHandle>() {
            if let Ok(mut producer) = engine_handle.producer.lock() {
                let _ = producer.push(EngineCommand::SetExportActive(false));
            }
        }

        // ── Resume playback if it was playing before export ──────────
        if cmd_producer {
            log::info!("[Export] Resuming playback after export");
            // Use the app handle to invoke the 'play' IPC command.
            // This is safer than trying to push directly to the command queue
            // from inside spawn_blocking.
            let _ = app_for_resume.emit("export_resume_playback", ());
        }

        match result {
            Ok(_) => {
                let cancelled = cancel_flag.load(std::sync::atomic::Ordering::SeqCst);
                let _ = finish_job(
                    &app_for_finish,
                    &job_id_for_finish,
                    !cancelled,
                    cancelled,
                    if cancelled {
                        Some("Export cancelled".to_string())
                    } else {
                        None
                    },
                );
            }
            Err(err) => {
                let cancelled = cancel_flag.load(std::sync::atomic::Ordering::SeqCst);
                let _ = finish_job(
                    &app_for_finish,
                    &job_id_for_finish,
                    false,
                    cancelled,
                    Some(err),
                );
            }
        }
    });
    Ok(job_id)
}
