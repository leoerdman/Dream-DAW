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

    let sample_rate = decoded.sample_rate;
    let num_frames = decoded.num_frames;
    let num_channels = decoded.channels.len();
    let duration_seconds = num_frames as f64 / sample_rate as f64;

    // Build waveform peak sidecar in background (non-blocking for import UX).
    {
        let mono_for_peaks: Vec<f32> = if decoded.channels.len() <= 1 {
            decoded
                .channels
                .first()
                .cloned()
                .unwrap_or_default()
        } else {
            decoded.channels[0]
                .iter()
                .zip(decoded.channels[1].iter())
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
        channels: decoded.channels,
        sample_rate,
        num_frames,
    };

    // Insert into pool
    {
        let mut pool = clip_pool_state.pool.lock().map_err(|e| e.to_string())?;
        pool.insert(clip_audio);
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

    // Create AudioClip in the project
    let clip = AudioClip::new(
        &clip_name,
        &path,
        AbsoluteTime::new(clip_position),
        AbsoluteTime::new(num_frames as i64),
    );
    let clip_id = clip.id.to_string();

    // Add clip to the specified track (create track if needed)
    {
        // Snapshot for undo BEFORE mutation
        push_undo(&project_state)?;

        let mut project = project_state.project.lock().map_err(|e| e.to_string())?;

        let idx = track_index as usize;
        while project.tracks.len() <= idx {
            let track_num = project.tracks.len() + 1;
            project.add_track(Track::new(format!("Track {track_num}")));
        }

        project.tracks[idx].clips.push(clip);

        // Mark project dirty
        *project_state.is_dirty.lock().map_err(|e| e.to_string())? = true;

        // Rebuild clip snapshot for audio thread
        clip_pool_state.rebuild_snapshot(&project);
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
