// ═══════════════════════════════════════════════════════════════════════

/// Import response sent back to frontend.
#[derive(Debug, Clone, Serialize)]
struct ImportAudioResponse {
    clip_id: String,
    clip_name: String,
    duration_seconds: f64,
    sample_rate: u32,
    channels: usize,
    frames: usize,
}

/// Imports an audio file, decodes it into the clip pool, and places
/// a clip on the specified track at the current playhead position.
///
/// # Performance
/// Decoding happens on the Tauri async thread pool — NOT the audio thread.
/// The decoded samples are inserted into the shared ClipPool, and the
/// project clip snapshot is atomically swapped for the audio thread.
#[tauri::command]
async fn import_audio_file(
    path: String,
    track_index: u16,
    position_frames: Option<i64>,
    clip_pool_state: tauri::State<'_, ClipPoolState>,
    project_state: tauri::State<'_, ProjectState>,
    handle: tauri::State<'_, AudioEngineHandle>,
    app: tauri::AppHandle,
) -> Result<ImportAudioResponse, String> {
    log::info!("[IPC] import_audio_file: path='{}' track={} pos={:?}", path, track_index, position_frames);
    let file_path = PathBuf::from(&path);

    // Validate file exists
    if !file_path.exists() {
        return Err(format!("File not found: {}", file_path.display()));
    }

    // Validate extension
    let ext = file_path
        .extension()
        .and_then(|e| e.to_str())
        .unwrap_or("")
        .to_lowercase();
    if !matches!(ext.as_str(), "wav" | "mp3" | "flac" | "aiff" | "aif" | "ogg" | "m4a" | "aac") {
        return Err(format!("Unsupported audio format: .{ext}"));
    }

    // Snapshot for undo BEFORE mutation
    push_undo(&project_state)?;

    // Decode audio file (NOT real-time safe — runs on async thread pool)
    let decoded = AudioReader::read(&file_path)
        .map_err(|e| format!("Failed to decode audio: {e}"))?;

    let clip_name = file_path
        .file_stem()
        .and_then(|s| s.to_str())
        .unwrap_or("Untitled")
        .to_string();

    // AUD-10X FIX: Offline studio-grade resampling.
    // By default, the RT engine handles sample rate mismatches via linear interpolation,
    // which results in massive aliasing/bitcrusher artifacts when dropping 44.1kHz clips
    // into a 48kHz project. Here, we completely eliminate RT aliasing by pre-rendering
    // the audio clip to the project's sample rate using a polyphase Sinc resampler.
    let target_sample_rate = {
        let project = project_state.project.lock().map_err(|e| e.to_string())?;
        project.sample_rate as u32
    };

    let mut final_channels = decoded.channels;
    let mut final_sample_rate = decoded.sample_rate;
    
    if final_sample_rate != target_sample_rate && target_sample_rate > 0 {
        log::info!(
            "Resampling imported audio '{}' from {}Hz to project rate {}Hz...",
            clip_name, final_sample_rate, target_sample_rate
        );
        match dream_dsp::resampler::resample_channels(
            &final_channels,
            final_sample_rate as usize,
            target_sample_rate as usize,
        ) {
            Ok(resampled) => {
                final_channels = resampled;
                final_sample_rate = target_sample_rate;
            }
            Err(e) => {
                log::error!("Failed to resample audio (falling back to RT linear): {}", e);
            }
        }
    }

    let sample_rate = final_sample_rate;
    let num_frames = final_channels.first().map(|c| c.len()).unwrap_or(0);
    let num_channels = final_channels.len();
    let duration_seconds = num_frames as f64 / sample_rate as f64;

    // Build waveform peak sidecar in background (non-blocking for import UX).
    {
        let mono_for_peaks: Vec<f32> = if final_channels.len() <= 1 {
            final_channels
                .first()
                .cloned()
                .unwrap_or_default()
        } else {
            final_channels[0]
                .iter()
                .zip(final_channels[1].iter())
                .map(|(l, r)| (l + r) * 0.5)
                .collect()
        };
        let peaks_source = file_path.clone();
        tauri::async_runtime::spawn_blocking(move || {
            if let Err(e) = PeakCache::generate_to_sidecar(&mono_for_peaks, &peaks_source, sample_rate) {
                log::warn!(
                    "[Waveform] failed to write peak cache sidecar for '{}': {e}",
                    peaks_source.display()
                );
            }
        });
    }

    // Convert AudioBuffer → ClipAudio for the pool
    let clip_audio = ClipAudio {
        source_path: path.clone(),
        channels: final_channels,
        sample_rate,
        num_frames,
    };

    // Insert into pool
    {
        let mut pool = clip_pool_state.pool.lock().map_err(|e| e.to_string())?;
        if let Err(e) = pool.insert(clip_audio) { log::error!("ClipPool: {}", e); }
    }
    // Publish updated pool snapshot to audio thread
    {
        let project = project_state.project.lock().map_err(|e| e.to_string())?;
        clip_pool_state.rebuild_snapshot(&project);
    }

    // Determine clip position: use provided drop position, or fall back to playhead
    let clip_position = match position_frames {
        Some(frames) => frames,
        None => handle.master_clock.position(),
    };

    // Add clip to the specified track (create track if needed)
    let clip_id: String;
    {
        // Snapshot for undo BEFORE mutation
        push_undo(&project_state)?;

        let project = project_state.project.lock().map_err(|e| e.to_string())?;
        let project_sr = target_sample_rate as f64;
        let source_sr = sample_rate.max(1) as f64;
        let timeline_frames = ((num_frames as f64) * (project_sr / source_sr)).round() as i64;

        // Create AudioClip in the project's frame domain.
        let mut clip = AudioClip::new(
            &clip_name,
            &path,
            AbsoluteTime::new(clip_position),
            AbsoluteTime::new(timeline_frames.max(1)),
        );
        // FIX: warp_source_duration_frames must be the RAW source frame count,
        // NOT the SR-scaled timeline duration, to prevent double SR compensation
        // when warp is enabled.
        clip.warp_source_duration_frames = num_frames.max(1) as i64;
        clip_id = clip.id.to_string();

        let idx = track_index as usize;
        while project.tracks.len() <= idx {
            let track_num = project.tracks.len() + 1;
            project.add_track(Track::new(format!("Track {track_num}")));
        }

        let target_track = &mut project.tracks[idx];
        
        // BUG-C5 FIX: Handle overlaps and maintain sorted order when importing.
        // Dropping a clip from the browser must wipe underlying overlapping clips
        // and strictly maintain positional sorting, just like `move_clip`.
        dream_models::mutators::handle_overlaps(target_track, &clip);
        let insert_pos = target_track
            .clips
            .binary_search_by(|c| c.position.cmp(&clip.position))
            .unwrap_or_else(|i| i);
        target_track.clips.insert(insert_pos, clip);

        // Mark project dirty
        let project_name = project.name.clone();

        // Rebuild clip snapshot for audio thread
        clip_pool_state.rebuild_snapshot(&project);
        drop(project);
        project_state.mark_dirty(&project_name, Some(&app))?;
    }

    log::info!(
        "[IPC] import_audio_file: '{}' → track {} ({} frames, {:.1}s, {}Hz, {}ch)",
        clip_name, track_index, num_frames, duration_seconds, sample_rate, num_channels
    );

    Ok(ImportAudioResponse {
        clip_id,
        clip_name,
        duration_seconds,
        sample_rate,
        channels: num_channels,
        frames: num_frames,
    })
}
