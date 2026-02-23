/// Offline bounce/export command.
#[tauri::command]
async fn export_mix_cmd(
    settings: ExportSettingsPayload,
    app: tauri::AppHandle,
    project_state: tauri::State<'_, ProjectState>,
    clip_pool_state: tauri::State<'_, ClipPoolState>,
    handle: tauri::State<'_, AudioEngineHandle>,
    plugin_host_state: tauri::State<'_, PluginHostState>,
) -> Result<String, String> {
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
    let mut slot_instance_map = plugin_host_state.slot_instance_snapshot();
    let mut ensure_loaded_slot = |slot: &dream_models::project::PluginSlot| {
        let plugin_id = slot.plugin_id.as_str();
        if plugin_id.starts_with("internal://") || plugin_id.starts_with("missing://") {
            return;
        }
        if slot_instance_map.contains_key(&slot.id) {
            return;
        }
        match plugin_host_state.ensure_loaded_instance_for_slot(slot.id, plugin_id) {
            Ok(_) => {
                ensure_loaded_count = ensure_loaded_count.saturating_add(1);
                slot_instance_map = plugin_host_state.slot_instance_snapshot();
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
    };

    for track in &project.tracks {
        if let Some(inst) = &track.instrument {
            for slot in inst.collect_plugin_slots() {
                ensure_loaded_slot(slot);
            }
        }
        for node in &track.effects {
            for slot in node.collect_plugin_slots() {
                ensure_loaded_slot(slot);
            }
        }
    }
    if let Some(inst) = &project.master_track.instrument {
        for slot in inst.collect_plugin_slots() {
            ensure_loaded_slot(slot);
        }
    }
    for node in &project.master_track.effects {
        for slot in node.collect_plugin_slots() {
            ensure_loaded_slot(slot);
        }
    }
    if ensure_loaded_count > 0 {
        log::info!(
            "[Export] Ensured {} previously-unbound external plugin slot(s) before bounce",
            ensure_loaded_count
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

    // Refresh runtime snapshots used by OfflineBouncer.
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
        log::error!(
            "[Export] external FX runtime snapshot missing instrument slot(s): {}",
            details
        );
        return Err(format!(
            "Export aborted: runtime VST instrument binding is incomplete ({details})"
        ));
    }

    // Ensure plugins are reactivated for the current export processing format.
    // This avoids silent passthrough when a plugin stayed in a stale inactive state.
    plugin_host_state
        .reactivate_all(project.sample_rate.max(1.0), 512)
        .map_err(|e| format!("Export aborted: failed to reactivate plugin runtime: {e}"))?;

    // ── VST3 instrument pre-render: clone host + slot map for spawn_blocking ──
    let plugin_host_arc = std::sync::Arc::clone(&plugin_host_state.host);

    // ── ENTERPRISE FIX: Stop playback before VST pre-render ────────────
    // The RT audio thread shares PluginInstanceArc with this export thread.
    // Both call process() on the same VST instances concurrently, which
    // corrupts oscillator/envelope state and produces silence in the export.
    // Solution: stop playback so the RT thread no longer touches VST plugins.
    let was_playing = {
        let state = handle.playback_state.lock().map_err(|e| e.to_string())?;
        state.is_playing
    };
    if was_playing {
        push_command(&handle, EngineCommand::SetPlay(false))?;
        {
            let mut state = handle.playback_state.lock().map_err(|e| e.to_string())?;
            state.is_playing = false;
        }
        log::info!("[Export] Stopped playback to prevent VST state corruption during export");
        // Allow the RT audio thread to finish its current buffer cycle
        // before we start processing VST plugins from the export thread.
        std::thread::sleep(std::time::Duration::from_millis(200));
    }

    // Clone the command producer so we can resume playback from spawn_blocking.
    let cmd_producer = {
        let producer_guard = handle.producer.lock().map_err(|e| e.to_string())?;
        // We can't clone the producer, but we need it for post-export.
        // Instead, pass the was_playing flag and resume via the app handle.
        drop(producer_guard);
        was_playing
    };
    // Snapshot runtime plugin state used by OfflineBouncer.
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
    tauri::async_runtime::spawn_blocking(move || {
        let _export_sample_rate = cfg.sample_rate;
        let export_bpm = cfg.bpm;
        let _export_start_frame = cfg.start_frame;
        let export_project_sr = cfg.project_sample_rate;
        let mut bouncer = OfflineBouncer::new(cfg);
        bouncer.cancel_flag = std::sync::Arc::clone(&cancel_flag);
        let mut project = project;
        let mut local_pool = local_pool;

        // Pre-render MIDI-driven external instruments so offline bounce
        // captures their output in the same project time domain.
        // Tracks external slot IDs that were already pre-rendered into audio.
        // These slots must be excluded from the runtime FX snapshot used by
        // OfflineBouncer to avoid double-processing (instrument/fx).
        let mut prerendered_external_slots_by_track: std::collections::HashMap<
            usize,
            std::collections::HashSet<uuid::Uuid>,
        > = std::collections::HashMap::new();

        {
            let sample_rate = export_project_sr;
            let total_frames = (end_frame - start_frame).max(0) as usize;
            const CHUNK_FRAMES: usize = 512;

            if total_frames > 0 {
                let mut vst3_rendered = 0usize;

                for track_idx in 0..project.tracks.len() {
                    let track = &project.tracks[track_idx];

                    // Skip tracks without MIDI clips.
                    if track.midi_clips.is_empty() {
                        continue;
                    }

                    // FIX-1: Skip tracks WITH a sampler config ONLY if they
                    // do NOT also have a VST3 instrument (e.g. Serum). ALS imports
                    // may populate both fields — prefer VST3 instrument when present.
                    if track.sampler.is_some() && track.instrument.is_none() {
                        continue;
                    }

                    // ── Find VST3 instrument instance for this track ──
                    let instrument_slot_id = match &track.instrument {
                        Some(DeviceNode::Single(slot)) => Some(slot.id),
                        Some(DeviceNode::Rack(rack)) => {
                            // For instrument racks, find the first plugin slot
                            rack.chains
                                .iter()
                                .flat_map(|chain| chain.devices.iter())
                                .find_map(|dev| match dev {
                                    DeviceNode::Single(slot) => Some(slot.id),
                                    _ => None,
                                })
                        }
                        None => None,
                    };

                    let Some(slot_id) = instrument_slot_id else {
                        log::warn!(
                            "[Export/VST3-MIDI] Track '{}' has {} MIDI clips but no instrument — skipping",
                            track.name,
                            track.midi_clips.len()
                        );
                        continue;
                    };

                    let instance_id = if let Some(bound) = slot_instance_map.get(&slot_id).copied() {
                        bound
                    } else {
                        // Fallback path for stale slot-id bindings after import/mutation:
                        // runtime external FX snapshot is keyed by track index and may still
                        // contain a valid external instrument instance for this track.
                        let fallback = external_fx_snapshot
                            .get(track_idx)
                            .and_then(|slots| {
                                slots
                                    .iter()
                                    .find(|slot| {
                                        slot.instance_id.is_some()
                                            && slot.internal_slot_index.is_none()
                                    })
                                    .and_then(|slot| slot.instance_id)
                            });
                        match fallback {
                            Some(instance_id) => {
                                log::warn!(
                                    "[Export/VST3-MIDI] Track '{}': slot-id {} not bound; using runtime snapshot fallback instance={}",
                                    track.name,
                                    slot_id,
                                    instance_id
                                );
                                instance_id
                            }
                            None => {
                                log::warn!(
                                    "[Export/VST3-MIDI] Track '{}': instrument slot {} not bound and no runtime fallback instance — skipping",
                                    track.name,
                                    slot_id
                                );
                                continue;
                            }
                        }
                    };

                    log::info!(
                        "[Export/VST3-MIDI] Pre-rendering track '{}': {} clips, instance={}, slot_id={}, {} frames",
                        track.name,
                        track.midi_clips.len(),
                        instance_id,
                        slot_id,
                        total_frames
                    );

                    // ── Pre-render buffer by buffer ───────────────
                    let midi_clips = track.midi_clips.clone();
                    let track_name = track.name.clone();

                    let mut out_left = vec![0.0f32; total_frames];
                    let mut out_right = vec![0.0f32; total_frames];

                    let mut schedule_scratch: Vec<
                        dream_clip_engine::midi_scheduler::ScheduledNote,
                    > = Vec::new();
                    let mut frames_done = 0usize;
                    let mut playhead = start_frame;

                    let mut total_midi_events_sent = 0usize;
                    let mut chunk_index = 0usize;

                    while frames_done < total_frames {
                        let remaining = total_frames - frames_done;
                        let chunk_frames = remaining.min(CHUNK_FRAMES);

                        // Schedule MIDI events for this buffer window.
                        MidiScheduler::fill_active(
                            &midi_clips,
                            playhead,
                            chunk_frames,
                            &mut schedule_scratch,
                        );

                        // Convert to VST3 MidiEvent format.
                        let mut midi_events: Vec<PluginMidiEvent> = Vec::new();
                        for event in &schedule_scratch {
                            if event.is_note_off {
                                midi_events.push(PluginMidiEvent::note_off(
                                    event.buffer_offset_end.min(chunk_frames) as i32,
                                    0,
                                    event.pitch,
                                    0,
                                ));
                            }
                            if event.is_note_on {
                                midi_events.push(PluginMidiEvent::note_on(
                                    event.buffer_onset.min(chunk_frames) as i32,
                                    0,
                                    event.pitch,
                                    event.velocity,
                                ));
                            }
                        }

                        // Sort: by sample_offset, then note-off before note-on at same offset
                        midi_events.sort_by(|a, b| {
                            a.sample_offset
                                .cmp(&b.sample_offset)
                                .then_with(|| a.data[0].cmp(&b.data[0]))
                        });

                        total_midi_events_sent += midi_events.len();

                        // ── Process through VST3 plugin ──────────
                        let mut chunk_left = vec![0.0f32; chunk_frames];
                        let mut chunk_right = vec![0.0f32; chunk_frames];

                        // Lock plugin host, set transport context, process one chunk, release.
                        {
                            let silence_l = vec![0.0f32; chunk_frames];
                            let silence_r = vec![0.0f32; chunk_frames];
                            let inputs: [&[f32]; 2] = [&silence_l, &silence_r];
                            let mut outputs: [&mut [f32]; 2] = [&mut chunk_left, &mut chunk_right];

                            match plugin_host_arc.lock() {
                                Ok(mut host) => {
                                    // Set transport context so the VST knows tempo and position.
                                    let _ = host.set_transport_context(
                                        instance_id,
                                        TransportContext {
                                            sample_rate: export_project_sr,
                                            position_samples: playhead,
                                            tempo: export_bpm,
                                            is_playing: true,
                                            is_recording: false,
                                            time_sig_numerator: 4,
                                            time_sig_denominator: 4,
                                        },
                                    );
                                    if let Err(e) = host.process_with_sidechain(
                                        instance_id,
                                        &inputs,
                                        None,
                                        &mut outputs,
                                        chunk_frames,
                                        &midi_events,
                                    ) {
                                        log::warn!(
                                            "[Export/VST3-MIDI] process_with_sidechain failed for '{}': {}",
                                            track_name,
                                            e
                                        );
                                    }
                                }
                                Err(e) => {
                                    log::error!(
                                        "[Export/VST3-MIDI] PluginHost lock poisoned: {}",
                                        e
                                    );
                                    break;
                                }
                            }
                        }

                        // Copy chunk into output buffers.
                        out_left[frames_done..frames_done + chunk_frames]
                            .copy_from_slice(&chunk_left[..chunk_frames]);
                        out_right[frames_done..frames_done + chunk_frames]
                            .copy_from_slice(&chunk_right[..chunk_frames]);

                        frames_done += chunk_frames;
                        playhead += chunk_frames as i64;
                        chunk_index += 1;
                    }

                    log::info!(
                        "[Export/VST3-MIDI] Track '{}': pre-render complete, total_midi_events_sent={}, chunks={}",
                        track_name, total_midi_events_sent, chunk_index
                    );

                    // Collect external slot IDs touched by this pre-render.
                    // They will be excluded from runtime bounce processing only
                    // if this pre-render actually produces non-silent audio.
                    let mut pending_excluded_slots: std::collections::HashSet<uuid::Uuid> =
                        std::collections::HashSet::new();

                    // ── FIX-2: Apply track insert FX chain to pre-rendered audio ──
                    // The instrument pre-render above produced raw Serum output.
                    // Now run it through all non-bypassed insert FX slots so
                    // reverb/EQ/compressor etc. appear in the export, matching
                    // what the user hears from the master in real-time.
                    {
                        let track_effects = project.tracks[track_idx].effects.clone();
                        let fx_slots: Vec<_> = track_effects
                            .iter()
                            .flat_map(|node| node.collect_plugin_slots())
                            .filter(|slot| !slot.is_bypassed)
                            .collect();

                        // BUG-E4 FIX: Pad output buffers for FX tail (reverb/delay).
                        // Without this, tails from MIDI instrument FX chains are cut off
                        // at the exact end of the last MIDI note. Mirrors BUG-E3 for audio.
                        const MIDI_FX_TAIL_FRAMES: usize = 44100 * 4; // 4 seconds
                        let has_vst3_fx = fx_slots
                            .iter()
                            .any(|s| slot_instance_map.contains_key(&s.id));
                        let padded_total = if has_vst3_fx {
                            total_frames + MIDI_FX_TAIL_FRAMES
                        } else {
                            total_frames
                        };
                        out_left.resize(padded_total, 0.0);
                        out_right.resize(padded_total, 0.0);

                        for fx_slot in &fx_slots {
                            let Some(fx_instance_id) = slot_instance_map.get(&fx_slot.id).copied()
                            else {
                                log::debug!(
                                    "[Export/VST3-FX] Track '{}': FX slot '{}' ({}) not bound — skipping",
                                    track_name,
                                    fx_slot.name,
                                    fx_slot.id
                                );
                                continue;
                            };

                            log::info!(
                                "[Export/VST3-FX] Track '{}': applying FX '{}' (instance={})",
                                track_name,
                                fx_slot.name,
                                fx_instance_id
                            );

                            // Process the entire pre-rendered buffer through this FX in chunks.
                            let mut fx_offset = 0usize;
                            while fx_offset < padded_total {
                                let remaining = padded_total - fx_offset;
                                let chunk = remaining.min(CHUNK_FRAMES);

                                let mut fx_out_l = vec![0.0f32; chunk];
                                let mut fx_out_r = vec![0.0f32; chunk];

                                let in_l = &out_left[fx_offset..fx_offset + chunk];
                                let in_r = &out_right[fx_offset..fx_offset + chunk];
                                let inputs: [&[f32]; 2] = [in_l, in_r];
                                let mut outputs: [&mut [f32]; 2] = [&mut fx_out_l, &mut fx_out_r];

                                match plugin_host_arc.lock() {
                                    Ok(mut host) => {
                                        let empty_midi: Vec<PluginMidiEvent> = Vec::new();
                                        if let Err(e) = host.process_with_sidechain(
                                            fx_instance_id,
                                            &inputs,
                                            None,
                                            &mut outputs,
                                            chunk,
                                            &empty_midi,
                                        ) {
                                            log::warn!(
                                                "[Export/VST3-FX] FX '{}' process failed: {}",
                                                fx_slot.name,
                                                e
                                            );
                                        }
                                    }
                                    Err(e) => {
                                        log::error!(
                                            "[Export/VST3-FX] PluginHost lock poisoned: {}",
                                            e
                                        );
                                        break;
                                    }
                                }

                                // Write FX output back into the pre-render buffers.
                                out_left[fx_offset..fx_offset + chunk].copy_from_slice(&fx_out_l);
                                out_right[fx_offset..fx_offset + chunk].copy_from_slice(&fx_out_r);
                                fx_offset += chunk;
                            }
                        }

                        if !fx_slots.is_empty() {
                            log::info!(
                                "[Export/VST3-FX] Track '{}': applied {} insert FX slot(s)",
                                track_name,
                                fx_slots.len()
                            );
                        }

                        // Record applied external FX slot IDs for potential exclusion.
                        for fx_slot in &fx_slots {
                            if slot_instance_map.contains_key(&fx_slot.id) {
                                pending_excluded_slots.insert(fx_slot.id);
                            }
                        }
                    }

                    // Instrument slot itself was pre-rendered; potentially exclude it.
                    pending_excluded_slots.insert(slot_id);

                    // ── Check if anything was rendered ──────────
                    let peak = out_left
                        .iter()
                        .chain(out_right.iter())
                        .fold(0.0f32, |acc, &s| acc.max(s.abs()));

                    if peak < 1e-7 {
                        log::warn!(
                            "[Export/VST3-MIDI] Track '{}': pre-render produced silence (peak={:.2e}); keeping runtime VST instrument path enabled",
                            track_name,
                            peak
                        );
                        // Do NOT commit a silent pre-render clip and do NOT exclude
                        // runtime external slots. Let OfflineBouncer render this track
                        // through the normal runtime VST instrument chain.
                        continue;
                    } else {
                        log::info!(
                            "[Export/VST3-MIDI] Track '{}': pre-render complete, peak={:.4}, {} frames",
                            track_name,
                            peak,
                            total_frames
                        );
                    }

                    // ── Create synthetic ClipAudio + AudioClip ──
                    let synth_path = format!("__vst3_midi_prerender__/track_{}", track_idx);
                    // BUG-E4: Capture actual buffer length (includes FX tail padding)
                    // BEFORE out_left is moved into ClipAudio.
                    let rendered_frames = out_left.len();
                    let clip_audio =
                        ClipAudio::new(synth_path.clone(), vec![out_left, out_right], sample_rate as u32);
                    let _ = local_pool.insert(clip_audio);

                    let synth_clip = AudioClip::new(
                        format!("{} (VST3 Pre-render)", track_name),
                        synth_path,
                        AbsoluteTime::new(start_frame),
                        AbsoluteTime::new(rendered_frames as i64),
                    );
                    project.tracks[track_idx].clips.push(synth_clip);

                    // Pre-render succeeded: exclude touched runtime external slots
                    // to prevent double-processing during final bounce.
                    if !pending_excluded_slots.is_empty() {
                        prerendered_external_slots_by_track
                            .entry(track_idx)
                            .or_default()
                            .extend(pending_excluded_slots.into_iter());
                    }
                    vst3_rendered += 1;
                }

                if vst3_rendered > 0 {
                    log::info!(
                        "[Export/VST3-MIDI] Pre-rendered {} VST3 instrument track(s)",
                        vst3_rendered
                    );
                }
            }
        }

        // ── EXPORT-FIX-01: Pre-render audio tracks through VST3 FX chain ──
        // The bounce engine only applies native device_chain FX. Any VST3 insert
        // FX on audio tracks (reverb, EQ, compressor plugins etc.) would be
        // completely missing from the export. Pre-render each audio track's clips
        // through its VST3 FX chain here, then replace the clip audio in the pool
        // with the processed version.
        //
        // BUG-E10 FIX: Use per-track synthetic keys to prevent cross-track
        // contamination when multiple tracks reference the same audio file.
        if true {
            const FX_CHUNK_FRAMES: usize = 4096;
            let mut vst3_fx_rendered = 0usize;
            for track_idx in 0..project.tracks.len() {
                let track = &project.tracks[track_idx];

                // Skip tracks without audio clips.
                if track.clips.is_empty() {
                    continue;
                }

                // Collect VST3 FX slots for this track's insert chain.
                let fx_slots: Vec<_> = track
                    .effects
                    .iter()
                    .flat_map(|node| node.collect_plugin_slots())
                    .filter(|slot| !slot.is_bypassed)
                    .collect();

                // Find VST3 FX slots that have bound instances.
                let vst3_fx: Vec<_> = fx_slots
                    .iter()
                    .filter_map(|slot| {
                        slot_instance_map
                            .get(&slot.id)
                            .map(|&iid| (slot.id, slot.name.clone(), iid))
                    })
                    .collect();

                if vst3_fx.is_empty() {
                    continue;
                }

                log::info!(
                    "[Export/AudioFX] Track '{}': {} audio clips, {} VST3 FX to pre-render",
                    track.name,
                    track.clips.len(),
                    vst3_fx.len()
                );

                // For each audio clip on this track, read its raw audio from the pool,
                // process through VST3 FX chain, and write to a NEW per-track key.
                // BUG-E2 FIX: Deduplicate by file_path to prevent double-processing.
                // BUG-E10 FIX: Use per-track synthetic keys instead of overwriting
                // the original pool entry, so other tracks sharing the same file
                // read the unprocessed original.
                let mut already_processed: std::collections::HashSet<String> =
                    std::collections::HashSet::new();
                for clip_idx in 0..project.tracks[track_idx].clips.len() {
                    let original_path = project.tracks[track_idx].clips[clip_idx].file_path.clone();
                    if original_path.is_empty() {
                        continue;
                    }
                    if !already_processed.insert(original_path.clone()) {
                        // Already processed this file for this track — just update the clip ref.
                        let fx_key =
                            format!("__fx_processed__/track_{}/{}", track_idx, original_path);
                        project.tracks[track_idx].clips[clip_idx].file_path = fx_key;
                        continue;
                    }

                    let clip_audio = match local_pool.get(&original_path) {
                        Some(ca) => ca,
                        None => {
                            log::warn!(
                                "[Export/AudioFX] Track '{}': clip '{}' not in pool — skipping",
                                project.tracks[track_idx].name,
                                original_path
                            );
                            continue;
                        }
                    };

                    let num_channels = clip_audio.channels.len();
                    if num_channels == 0 {
                        continue;
                    }

                    let total_clip_frames = clip_audio.num_frames;
                    if total_clip_frames == 0 {
                        continue;
                    }

                    // Create writable copies of L/R channels.
                    let mut buf_l: Vec<f32> = clip_audio.channels[0].clone();
                    let mut buf_r: Vec<f32> = if num_channels > 1 {
                        clip_audio.channels[1].clone()
                    } else {
                        clip_audio.channels[0].clone() // Mono → duplicate to R
                    };

                    // BUG-E3 FIX: Allow FX tail to ring out beyond clip boundary.
                    // Reverb/delay tails extend past the source audio duration.
                    // Pad buffers with 4 seconds of silence so tails are captured.
                    const FX_TAIL_FRAMES: usize = 44100 * 4;
                    let padded_frames = total_clip_frames + FX_TAIL_FRAMES;
                    buf_l.resize(padded_frames, 0.0);
                    buf_r.resize(padded_frames, 0.0);

                    // Process through each VST3 FX plugin in chain order.
                    for (_fx_slot_id, fx_name, fx_instance_id) in &vst3_fx {
                        let mut fx_offset = 0usize;
                        while fx_offset < padded_frames {
                            let remaining = padded_frames - fx_offset;
                            let chunk = remaining.min(FX_CHUNK_FRAMES);

                            let mut fx_out_l = vec![0.0f32; chunk];
                            let mut fx_out_r = vec![0.0f32; chunk];

                            let in_l = &buf_l[fx_offset..fx_offset + chunk];
                            let in_r = &buf_r[fx_offset..fx_offset + chunk];
                            let inputs: [&[f32]; 2] = [in_l, in_r];
                            let mut outputs: [&mut [f32]; 2] = [&mut fx_out_l, &mut fx_out_r];

                            match plugin_host_arc.lock() {
                                Ok(mut host) => {
                                    let empty_midi: Vec<PluginMidiEvent> = Vec::new();
                                    if let Err(e) = host.process_with_sidechain(
                                        *fx_instance_id,
                                        &inputs,
                                        None,
                                        &mut outputs,
                                        chunk,
                                        &empty_midi,
                                    ) {
                                        log::warn!(
                                            "[Export/AudioFX] FX '{}' process failed: {}",
                                            fx_name,
                                            e
                                        );
                                    }
                                }
                                Err(e) => {
                                    log::error!("[Export/AudioFX] PluginHost lock poisoned: {}", e);
                                    break;
                                }
                            }

                            buf_l[fx_offset..fx_offset + chunk].copy_from_slice(&fx_out_l);
                            buf_r[fx_offset..fx_offset + chunk].copy_from_slice(&fx_out_r);
                            fx_offset += chunk;
                        }
                    }

                    // BUG-E1 FIX: VST3 FX produce stereo output even for mono input.
                    // Always save both channels after FX processing to preserve stereo image.
                    // BUG-E10 FIX: Write to per-track synthetic key, NOT the original path.
                    let fx_key = format!("__fx_processed__/track_{}/{}", track_idx, original_path);
                    let processed_channels = vec![buf_l, buf_r];
                    let processed_clip =
                        ClipAudio::new(fx_key.clone(), processed_channels, clip_audio.sample_rate);
                    let _ = local_pool.insert(processed_clip);
                    // Update the clip's file_path to point to the FX-processed version.
                    project.tracks[track_idx].clips[clip_idx].file_path = fx_key;
                }

                vst3_fx_rendered += 1;
                log::info!(
                    "[Export/AudioFX] Track '{}': VST3 FX pre-render complete ({} FX applied)",
                    project.tracks[track_idx].name,
                    vst3_fx.len()
                );

                // Mark audio-track external FX slots that were pre-rendered so
                // OfflineBouncer does not process them again.
                {
                    let slot_set = prerendered_external_slots_by_track
                        .entry(track_idx)
                        .or_default();
                    for (slot_id, _name, _iid) in &vst3_fx {
                        slot_set.insert(*slot_id);
                    }
                }
            }

            if vst3_fx_rendered > 0 {
                log::info!(
                    "[Export/AudioFX] Pre-rendered {} audio track(s) through VST3 FX chains",
                    vst3_fx_rendered
                );
            }
        }

        // Build bounce-specific runtime FX snapshot with pre-rendered external
        // slots removed, preventing double-processing and instrument re-entry.
        let mut external_fx_snapshot_for_bounce = Vec::clone(&external_fx_snapshot);
        for (track_idx, excluded_slot_ids) in &prerendered_external_slots_by_track {
            if let Some(track_slots) = external_fx_snapshot_for_bounce.get_mut(*track_idx) {
                track_slots.retain(|slot| {
                    let Some(slot_id) = slot.slot_id else {
                        return true;
                    };
                    !excluded_slot_ids.contains(&slot_id)
                });
            }
        }

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
