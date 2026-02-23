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

        // ── CRITICAL: Pre-render VST3 instrument MIDI tracks ──────────
        // Tracks with MIDI clips but NO sampler config are VST3 instrument
        // tracks (e.g. Serum). The built-in OfflineBouncer::pre_render_midi_tracks()
        // only handles sampler-based instruments. We must pre-render VST3
        // instrument tracks HERE where we have access to the PluginHost.
        {
            // ═══════════════════════════════════════════════════════════════
            // CRITICAL: The bouncer's internal render loop operates at
            // project_sample_rate, NOT export_sample_rate. It resamples
            // the final mix at the very end. Pre-rendered audio must be
            // registered at project SR so ClipScheduler plays it at the
            // correct speed. Using export SR would cause a speed mismatch:
            //   e.g. project=44100, export=48000 → notes play 8.8% too fast
            //   = "notes sound earlier than they should"
            // ═══════════════════════════════════════════════════════════════
            let sample_rate = export_project_sr as f64;
            let total_frames = (end_frame - start_frame).max(0) as usize;
            // ═══════════════════════════════════════════════════════════════
            // CRITICAL: CHUNK_FRAMES must NOT exceed the VST3 plugin's
            // max_buffer_size (set during activate()). If it does,
            // Vst3Instance::process() falls through to passthrough(), which
            // copies silence input → silence output and the MIDI events
            // are never actually processed by the plugin's DSP.
            //
            // Audio interfaces typically use 256–1024 frames. Using 512
            // is a safe default that all plugins support.
            // ═══════════════════════════════════════════════════════════════
            const CHUNK_FRAMES: usize = 512;

            // DIAGNOSTIC: Write export state to file for reliable debugging
            {
                use std::io::Write;
                if let Ok(mut f) = std::fs::File::create("/tmp/dream_daw_export_diag.log") {
                    let _ = writeln!(f, "=== Dream DAW Export Diagnostic ===");
                    let _ = writeln!(f, "total_frames: {}", total_frames);
                    let _ = writeln!(f, "start_frame: {}, end_frame: {}", start_frame, end_frame);
                    let _ = writeln!(f, "sample_rate: {}", sample_rate);
                    let _ = writeln!(f, "export_bpm: {}", export_bpm);
                    let _ = writeln!(f, "num_tracks: {}", project.tracks.len());
                    let _ = writeln!(f, "slot_instance_map entries: {}", slot_instance_map.len());
                    for (slot, inst) in slot_instance_map.iter() {
                        let _ = writeln!(f, "  slot {} -> instance {}", slot, inst);
                    }
                    let _ = writeln!(f, "");
                    for (i, track) in project.tracks.iter().enumerate() {
                        let _ = writeln!(f, "Track[{}] '{}': midi_clips={}, audio_clips={}, sampler={}, instrument={}, sample_rack={}",
                            i, track.name,
                            track.midi_clips.len(),
                            track.clips.len(),
                            track.sampler.is_some(),
                            track.instrument.is_some(),
                            track.sample_rack.is_some(),
                        );
                        if let Some(ref inst) = track.instrument {
                            match inst {
                                DeviceNode::Single(slot) => {
                                    let bound = slot_instance_map.get(&slot.id).copied();
                                    let _ = writeln!(f, "  instrument: Single(slot_id={}, plugin_id={:?}), bound_instance={:?}",
                                        slot.id, slot.plugin_id, bound);
                                }
                                DeviceNode::Rack(rack) => {
                                    let _ = writeln!(f, "  instrument: Rack with {} chains", rack.chains.len());
                                }
                            }
                        }
                    }
                    let _ = writeln!(f, "");
                }
            }

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
                        "[Export/VST3-MIDI] Pre-rendering track '{}': {} clips, instance={}, slot_id={}, {} frames",
                        track.name,
                        track.midi_clips.len(),
                        instance_id,
                        slot_id,
                        total_frames
                    );

                    // DIAGNOSTIC: Check if PluginHost actually contains this instance.
                    {
                        match plugin_host_arc.lock() {
                            Ok(mut host) => {
                                let has_instance = host.get_mut(instance_id).is_some();
                                log::info!(
                                    "[Export/VST3-MIDI] Track '{}': PluginHost.has_instance({}) = {}",
                                    track.name, instance_id, has_instance
                                );
                                if !has_instance {
                                    log::error!(
                                        "[Export/VST3-MIDI] Track '{}': VST3 instance NOT FOUND in PluginHost! Plugin may be sandboxed.",
                                        track.name
                                    );
                                }
                            }
                            Err(e) => log::error!("[Export/VST3-MIDI] PluginHost lock error: {}", e),
                        }
                    }

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

                    // Open diagnostic file in append mode for per-chunk data
                    let mut diag_file = std::fs::OpenOptions::new()
                        .create(true)
                        .append(true)
                        .open("/tmp/dream_daw_export_diag.log")
                        .ok();
                    if let Some(ref mut f) = diag_file {
                        use std::io::Write;
                        let _ = writeln!(f, "--- PRE-RENDER: track='{}', instance={}, playhead_start={} ---",
                            track_name, instance_id, playhead);
                    }

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

                        // DIAGNOSTIC: Log MIDI events for first 10 chunks to file
                        if chunk_index < 10 || !midi_events.is_empty() {
                            total_midi_events_sent += midi_events.len();
                            if let Some(ref mut f) = diag_file {
                                use std::io::Write;
                                let _ = writeln!(f, "  chunk[{}]: playhead={}, midi_events={}, schedule_notes={}",
                                    chunk_index, playhead, midi_events.len(), schedule_scratch.len());
                                for (ei, ev) in midi_events.iter().enumerate().take(8) {
                                    let _ = writeln!(f, "    event[{}]: offset={}, data=[{:#04x},{:#04x},{:#04x}]",
                                        ei, ev.sample_offset, ev.data[0], ev.data[1], ev.data[2]);
                                }
                            }
                        }

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

                        // DIAGNOSTIC: Write per-chunk peak to file
                        if chunk_index < 10 {
                            let chunk_peak = chunk_left.iter().chain(chunk_right.iter())
                                .fold(0.0f32, |acc, &s| acc.max(s.abs()));
                            if let Some(ref mut f) = diag_file {
                                use std::io::Write;
                                let _ = writeln!(f, "  chunk[{}]: output_peak = {:.6}", chunk_index, chunk_peak);
                            }
                        }

                        frames_done += chunk_frames;
                        playhead += chunk_frames as i64;
                        chunk_index += 1;
                    }

                    log::info!(
                        "[Export/VST3-MIDI] Track '{}': pre-render complete, total_midi_events_sent={}, chunks={}",
                        track_name, total_midi_events_sent, chunk_index
                    );

                    // Write final summary to diagnostic file
                    {
                        let total_peak = out_left.iter().chain(out_right.iter())
                            .fold(0.0f32, |acc, &s| acc.max(s.abs()));
                        if let Some(ref mut f) = diag_file {
                            use std::io::Write;
                            let _ = writeln!(f, "--- RESULT: total_midi_events={}, chunks={}, total_peak={:.6} ---",
                                total_midi_events_sent, chunk_index, total_peak);
                            let _ = writeln!(f, "");
                        }
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
                        ClipAudio::new(synth_path.clone(), vec![out_left, out_right], sample_rate as u32);
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
