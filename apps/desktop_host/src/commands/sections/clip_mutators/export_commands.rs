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

    // ── VST3 instrument pre-render: clone host + slot map for spawn_blocking ──
    let plugin_host_arc = std::sync::Arc::clone(&plugin_host_state.host);
    let slot_instance_map = plugin_host_state.slot_instance_snapshot();
    // NOTE: VST3 FX are NOT passed to bounce() — PluginInstanceArc is shared
    // with the RT audio thread, and calling process() from the offline thread
    // corrupts plugin state (rapid spurious audio, missing tracks).
    // VST3 MIDI instrument tracks are pre-rendered above via plugin_host_arc.
    // Audio track VST3 FX are applied via the pre-render FX loop (lines 2006+).
    // Only native device_chain FX are processed inside bounce().

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
        let export_sample_rate = cfg.sample_rate;
        let mut bouncer = OfflineBouncer::new(cfg);
        bouncer.cancel_flag = std::sync::Arc::clone(&cancel_flag);
        let mut project = project;
        let mut local_pool = local_pool;

        // ── CRITICAL: Pre-render VST3 instrument MIDI tracks ──────────
        // Tracks with MIDI clips but NO sampler config are VST3 instrument
        // tracks (e.g. Serum). The built-in OfflineBouncer::pre_render_midi_tracks()
        // only handles sampler-based instruments. We must pre-render VST3
        // instrument tracks HERE where we have access to the PluginHost.
        {
            let sample_rate = export_sample_rate;
            let total_frames = (end_frame - start_frame).max(0) as usize;
            const CHUNK_FRAMES: usize = 4096;

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

                    let Some(instance_id) = slot_instance_map.get(&slot_id).copied() else {
                        log::warn!(
                            "[Export/VST3-MIDI] Track '{}': instrument slot {} not bound to any instance — skipping",
                            track.name,
                            slot_id
                        );
                        continue;
                    };

                    log::info!(
                        "[Export/VST3-MIDI] Pre-rendering track '{}': {} clips, instance={}, {} frames",
                        track.name,
                        track.midi_clips.len(),
                        instance_id,
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

                        // ── Process through VST3 plugin ──────────
                        let mut chunk_left = vec![0.0f32; chunk_frames];
                        let mut chunk_right = vec![0.0f32; chunk_frames];

                        // Lock plugin host, process one chunk, release immediately.
                        {
                            let silence_l = vec![0.0f32; chunk_frames];
                            let silence_r = vec![0.0f32; chunk_frames];
                            let inputs: [&[f32]; 2] = [&silence_l, &silence_r];
                            let mut outputs: [&mut [f32]; 2] = [&mut chunk_left, &mut chunk_right];

                            match plugin_host_arc.lock() {
                                Ok(mut host) => {
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
                    }

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
                    }

                    // ── Check if anything was rendered ──────────
                    let peak = out_left
                        .iter()
                        .chain(out_right.iter())
                        .fold(0.0f32, |acc, &s| acc.max(s.abs()));

                    if peak < 1e-7 {
                        log::warn!(
                            "[Export/VST3-MIDI] Track '{}': pre-render produced silence (peak={:.2e})",
                            track_name,
                            peak
                        );
                        // Still add the clip — silence is valid (e.g. if all notes are outside range)
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
                        ClipAudio::new(synth_path.clone(), vec![out_left, out_right], sample_rate);
                    let _ = local_pool.insert(clip_audio);

                    let synth_clip = AudioClip::new(
                        format!("{} (VST3 Pre-render)", track_name),
                        synth_path,
                        AbsoluteTime::new(start_frame),
                        AbsoluteTime::new(rendered_frames as i64),
                    );
                    project.tracks[track_idx].clips.push(synth_clip);
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
        {
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
                            .map(|&iid| (slot.name.clone(), iid))
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
                    for (fx_name, fx_instance_id) in &vst3_fx {
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
            }

            if vst3_fx_rendered > 0 {
                log::info!(
                    "[Export/AudioFX] Pre-rendered {} audio track(s) through VST3 FX chains",
                    vst3_fx_rendered
                );
            }
        }

        // Pass empty plugin maps: VST3 FX are now pre-rendered above, native FX
        // are handled by device_chain inside render_routing_aware.
        let no_plugins: std::collections::HashMap<
            uuid::Uuid,
            dream_engine::driver::PluginInstanceArc,
        > = std::collections::HashMap::new();
        let no_fx: Vec<Vec<dream_engine::driver::ExternalFxRuntimeSlot>> = Vec::new();
        let result = bouncer
            .bounce(
                &mut project,
                &mut local_pool,
                None,
                &no_plugins,
                &no_fx,
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

/// Cancel an in-progress export/bounce operation.
#[tauri::command]
async fn cancel_export_cmd(
    app: tauri::AppHandle,
    handle: tauri::State<'_, AudioEngineHandle>,
) -> Result<(), String> {
    handle
        .export_cancel
        .store(true, std::sync::atomic::Ordering::SeqCst);
    if let Ok(mut jobs) = background_jobs().lock() {
        for job in jobs.values_mut() {
            if job.snapshot.status == "running" && job.snapshot.cancellable {
                job.cancel_flag
                    .store(true, std::sync::atomic::Ordering::SeqCst);
                job.snapshot.status = "cancelling".to_string();
                job.snapshot.phase = "Cancelling...".to_string();
                emit_job_update(&app, &job.snapshot);
                let _ = app.emit(
                    "bounce_progress",
                    serde_json::json!({
                        "jobId": &job.snapshot.id,
                        "progress": job.snapshot.progress,
                        "phase": job.snapshot.phase,
                        "status": job.snapshot.status,
                    }),
                );
            }
        }
    }
    log::info!("[Export] Cancel requested");
    Ok(())
}

#[tauri::command]
async fn list_background_jobs_cmd() -> Result<Vec<BackgroundJobSnapshot>, String> {
    let mut jobs = background_jobs().lock().map_err(|e| e.to_string())?;
    prune_finished_jobs_locked(&mut jobs);
    let mut out: Vec<BackgroundJobSnapshot> = jobs.values().map(|j| j.snapshot.clone()).collect();
    out.sort_by_key(|j| j.started_at_ms);
    Ok(out)
}

#[tauri::command]
async fn cancel_background_job_cmd(job_id: String, app: tauri::AppHandle) -> Result<(), String> {
    let mut jobs = background_jobs().lock().map_err(|e| e.to_string())?;
    let Some(job) = jobs.get_mut(&job_id) else {
        return Err("Job not found".to_string());
    };
    if !job.snapshot.cancellable {
        return Err("Job is not cancellable".to_string());
    }
    job.cancel_flag
        .store(true, std::sync::atomic::Ordering::SeqCst);
    if job.snapshot.status == "running" {
        job.snapshot.status = "cancelling".to_string();
        job.snapshot.phase = "Cancelling...".to_string();
        emit_job_update(&app, &job.snapshot);
        let _ = app.emit(
            "bounce_progress",
            serde_json::json!({
                "jobId": &job.snapshot.id,
                "progress": job.snapshot.progress,
                "phase": job.snapshot.phase,
                "status": job.snapshot.status,
            }),
        );
    }
    Ok(())
}

#[tauri::command]
async fn clear_finished_background_jobs_cmd() -> Result<usize, String> {
    let mut jobs = background_jobs().lock().map_err(|e| e.to_string())?;
    let before = jobs.len();
    jobs.retain(|_, job| job.snapshot.status == "running");
    Ok(before.saturating_sub(jobs.len()))
}

