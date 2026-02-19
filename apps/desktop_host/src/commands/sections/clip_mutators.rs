// ═══════════════════════════════════════════════════════════════════════

/// Response type for the split_clip command.
#[derive(Debug, Serialize, Deserialize)]
struct SplitClipResponse {
    left_id: String,
    right_id: String,
}

#[derive(Debug, Serialize, Deserialize)]
struct DuplicateClipResponse {
    new_id: String,
}

#[derive(Debug, Serialize, Deserialize)]
struct MergeClipsResponse {
    new_id: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct BounceSelectionPayload {
    #[serde(default)]
    clip_ids: Vec<String>,
    range_start_frames: Option<i64>,
    range_end_frames: Option<i64>,
    start_track_index: Option<usize>,
    end_track_index: Option<usize>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct SplitTrackToStemsPayload {
    track_id: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct BackgroundJobSnapshot {
    id: String,
    kind: String,
    status: String,
    progress: f32,
    phase: String,
    started_at_ms: u128,
    finished_at_ms: Option<u128>,
    error: Option<String>,
    cancellable: bool,
}

#[derive(Debug)]
struct BackgroundJobState {
    snapshot: BackgroundJobSnapshot,
    cancel_flag: std::sync::Arc<std::sync::atomic::AtomicBool>,
}

fn now_ms() -> u128 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis())
        .unwrap_or(0)
}

fn next_job_id() -> String {
    static JOB_COUNTER: std::sync::OnceLock<std::sync::atomic::AtomicU64> =
        std::sync::OnceLock::new();
    let seq = JOB_COUNTER
        .get_or_init(|| std::sync::atomic::AtomicU64::new(1))
        .fetch_add(1, std::sync::atomic::Ordering::Relaxed);
    format!("job_{:x}_{:x}", now_ms(), seq)
}

fn prune_finished_jobs_locked(
    jobs: &mut std::collections::HashMap<String, BackgroundJobState>,
) {
    const FINISHED_JOB_TTL_MS: u128 = 15 * 60 * 1000;
    const MAX_FINISHED_JOBS: usize = 200;

    let now = now_ms();
    jobs.retain(|_, job| {
        if job.snapshot.status == "running" {
            return true;
        }
        let finished_at = job.snapshot.finished_at_ms.unwrap_or(job.snapshot.started_at_ms);
        now.saturating_sub(finished_at) <= FINISHED_JOB_TTL_MS
    });

    let mut finished: Vec<(String, u128)> = jobs
        .iter()
        .filter_map(|(id, job)| {
            if job.snapshot.status == "running" {
                None
            } else {
                Some((
                    id.clone(),
                    job.snapshot
                        .finished_at_ms
                        .unwrap_or(job.snapshot.started_at_ms),
                ))
            }
        })
        .collect();

    if finished.len() <= MAX_FINISHED_JOBS {
        return;
    }

    finished.sort_by(|a, b| b.1.cmp(&a.1));
    let keep: std::collections::HashSet<String> = finished
        .iter()
        .take(MAX_FINISHED_JOBS)
        .map(|(id, _)| id.clone())
        .collect();
    jobs.retain(|id, job| job.snapshot.status == "running" || keep.contains(id));
}

fn background_jobs()
-> &'static std::sync::Mutex<std::collections::HashMap<String, BackgroundJobState>> {
    static JOBS: std::sync::OnceLock<
        std::sync::Mutex<std::collections::HashMap<String, BackgroundJobState>>,
    > = std::sync::OnceLock::new();
    JOBS.get_or_init(|| std::sync::Mutex::new(std::collections::HashMap::new()))
}

fn emit_job_update(app: &tauri::AppHandle, snapshot: &BackgroundJobSnapshot) {
    let _ = app.emit("background_job_update", snapshot);
}

fn start_job(
    app: &tauri::AppHandle,
    kind: &str,
    cancellable: bool,
) -> Result<(String, std::sync::Arc<std::sync::atomic::AtomicBool>), String> {
    let id = next_job_id();
    let cancel_flag = std::sync::Arc::new(std::sync::atomic::AtomicBool::new(false));
    let snapshot = BackgroundJobSnapshot {
        id: id.clone(),
        kind: kind.to_string(),
        status: "running".to_string(),
        progress: 0.0,
        phase: "Starting".to_string(),
        started_at_ms: now_ms(),
        finished_at_ms: None,
        error: None,
        cancellable,
    };
    {
        let mut jobs = background_jobs().lock().map_err(|e| e.to_string())?;
        prune_finished_jobs_locked(&mut jobs);
        jobs.insert(
            id.clone(),
            BackgroundJobState {
                snapshot: snapshot.clone(),
                cancel_flag: std::sync::Arc::clone(&cancel_flag),
            },
        );
    }
    emit_job_update(app, &snapshot);
    Ok((id, cancel_flag))
}

fn set_job_progress(
    app: &tauri::AppHandle,
    job_id: &str,
    progress: f32,
    phase: &str,
) -> Result<(), String> {
    let mut jobs = background_jobs().lock().map_err(|e| e.to_string())?;
    if let Some(job) = jobs.get_mut(job_id) {
        job.snapshot.progress = progress.clamp(0.0, 100.0);
        job.snapshot.phase = phase.to_string();
        emit_job_update(app, &job.snapshot);
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

fn finish_job(
    app: &tauri::AppHandle,
    job_id: &str,
    ok: bool,
    cancelled: bool,
    error: Option<String>,
) -> Result<(), String> {
    let mut jobs = background_jobs().lock().map_err(|e| e.to_string())?;
    if let Some(job) = jobs.get_mut(job_id) {
        job.snapshot.progress = if ok { 100.0 } else { job.snapshot.progress };
        job.snapshot.finished_at_ms = Some(now_ms());
        job.snapshot.error = error;
        job.snapshot.status = if cancelled {
            "cancelled".to_string()
        } else if ok {
            "completed".to_string()
        } else {
            "failed".to_string()
        };
        if ok {
            job.snapshot.phase = "Done".to_string();
        }
        emit_job_update(app, &job.snapshot);
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
    prune_finished_jobs_locked(&mut jobs);
    Ok(())
}

fn mutator_err_to_string(e: MutatorError) -> String {
    e.to_string()
}

fn move_midi_clip_in_project(
    project: &mut Project,
    clip_id: Uuid,
    new_track_index: usize,
    new_position: AbsoluteTime,
) -> bool {
    let mut extracted = None;
    for track in &mut project.tracks {
        if let Some(idx) = track.midi_clips.iter().position(|c| c.id == clip_id) {
            let mut clip = track.midi_clips.remove(idx);
            clip.position = new_position;
            extracted = Some(clip);
            break;
        }
    }

    let Some(clip) = extracted else {
        return false;
    };
    let target = &mut project.tracks[new_track_index];
    
    // Handle overlaps for MIDI clips
    dream_models::mutators::handle_midi_overlaps(target, &clip);

    let insert_pos = target
        .midi_clips
        .binary_search_by(|c| c.position.cmp(&clip.position))
        .unwrap_or_else(|i| i);
    target.midi_clips.insert(insert_pos, clip);
    true
}

fn delete_midi_clip_in_project(project: &mut Project, clip_id: Uuid) -> bool {
    for track in &mut project.tracks {
        if let Some(idx) = track.midi_clips.iter().position(|c| c.id == clip_id) {
            track.midi_clips.remove(idx);
            return true;
        }
    }
    false
}

fn build_local_pool_for_project(
    project: &Project,
    clip_pool_state: &tauri::State<'_, ClipPoolState>,
) -> Result<ClipPool, String> {
    let mut local_pool = clip_pool_state
        .pool
        .lock()
        .map_err(|e| e.to_string())?
        .clone();
    for track in &project.tracks {
        for clip in &track.clips {
            if clip.file_path.is_empty() {
                continue;
            }
            if local_pool.get(&clip.file_path).is_some() {
                continue;
            }
            if !PathBuf::from(&clip.file_path).exists() {
                continue;
            }
            if let Ok(decoded) = AudioReader::read(PathBuf::from(&clip.file_path)) {
                local_pool.insert(ClipAudio {
                    source_path: clip.file_path.clone(),
                    channels: decoded.channels,
                    sample_rate: decoded.sample_rate,
                    num_frames: decoded.num_frames,
                });
            }
        }

        // Load sampler samples for MIDI tracks (needed for offline MIDI pre-rendering).
        if let Some(ref sampler_cfg) = track.sampler {
            if !sampler_cfg.sample_path.is_empty()
                && local_pool.get(&sampler_cfg.sample_path).is_none()
            {
                let path = PathBuf::from(&sampler_cfg.sample_path);
                if path.exists() {
                    if let Ok(decoded) = AudioReader::read(path) {
                        local_pool.insert(ClipAudio {
                            source_path: sampler_cfg.sample_path.clone(),
                            channels: decoded.channels,
                            sample_rate: decoded.sample_rate,
                            num_frames: decoded.num_frames,
                        });
                        log::info!(
                            "[ExportPool] Loaded sampler sample '{}' for track '{}'",
                            sampler_cfg.sample_path, track.name
                        );
                    }
                }
            }
        }
    }
    Ok(local_pool)
}

fn make_bounce_output_path(prefix: &str) -> Result<String, String> {
    let dir = std::env::temp_dir().join("dream_daw_bounces");
    std::fs::create_dir_all(&dir).map_err(|e| format!("Failed to create bounce temp dir: {e}"))?;
    let ts = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map_err(|e| e.to_string())?
        .as_millis();
    let file_name = format!("{}_{}.wav", prefix, ts);
    Ok(dir.join(file_name).to_string_lossy().to_string())
}

fn place_bounced_file_on_new_track(
    project_state: &tauri::State<'_, ProjectState>,
    clip_pool_state: &tauri::State<'_, ClipPoolState>,
    handle: &tauri::State<'_, AudioEngineHandle>,
    app: &tauri::AppHandle,
    bounced_file_path: &str,
    clip_name: &str,
    clip_start_frame: i64,
    new_track_name: &str,
) -> Result<(), String> {
    let decoded = AudioReader::read(PathBuf::from(bounced_file_path))
        .map_err(|e| format!("Failed to decode bounced file: {e}"))?;
    push_undo(project_state)?;

    {
        let mut pool = clip_pool_state.pool.lock().map_err(|e| e.to_string())?;
        pool.insert(ClipAudio {
            source_path: bounced_file_path.to_string(),
            channels: decoded.channels,
            sample_rate: decoded.sample_rate,
            num_frames: decoded.num_frames,
        });
    }

    let mut project = project_state.project.lock().map_err(|e| e.to_string())?;
    let project_sr = project.sample_rate.max(1.0);
    let source_sr = decoded.sample_rate.max(1) as f64;
    let timeline_frames = ((decoded.num_frames as f64) * (project_sr / source_sr)).round() as i64;
    project.add_track(Track::new(new_track_name));
    let new_track_index = project.tracks.len().saturating_sub(1);
    let clip = AudioClip::new(
        clip_name,
        bounced_file_path,
        AbsoluteTime::new(clip_start_frame.max(0)),
        AbsoluteTime::new(timeline_frames.max(1)),
    );
    if let Some(track) = project.tracks.get_mut(new_track_index) {
        track.clips.push(clip);
    }
    let project_name = project.name.clone();
    clip_pool_state.rebuild_snapshot(&project);
    rebuild_midi_snapshot_from_project(&project, handle);
    drop(project);
    project_state.mark_dirty(&project_name, Some(app))?;
    Ok(())
}

fn place_stem_files_on_new_tracks(
    project_state: &tauri::State<'_, ProjectState>,
    clip_pool_state: &tauri::State<'_, ClipPoolState>,
    handle: &tauri::State<'_, AudioEngineHandle>,
    app: &tauri::AppHandle,
    stems: &[(String, String)],
    clip_start_frame: i64,
) -> Result<(), String> {
    struct StemMeta {
        path: String,
        track_name: String,
        channels_data: Vec<Vec<f32>>,
        num_frames: usize,
        sample_rate: u32,
    }

    let mut metas: Vec<StemMeta> = Vec::with_capacity(stems.len());
    for (stem_path, stem_track_name) in stems {
        let decoded = AudioReader::read(PathBuf::from(stem_path))
            .map_err(|e| format!("Failed to decode stem '{}': {e}", stem_path))?;
        metas.push(StemMeta {
            path: stem_path.clone(),
            track_name: stem_track_name.clone(),
            channels_data: decoded.channels,
            num_frames: decoded.num_frames,
            sample_rate: decoded.sample_rate,
        });
    }

    push_undo(project_state)?;

    {
        let mut pool = clip_pool_state.pool.lock().map_err(|e| e.to_string())?;
        for stem in &metas {
            pool.insert(ClipAudio {
                source_path: stem.path.clone(),
                channels: stem.channels_data.clone(),
                sample_rate: stem.sample_rate,
                num_frames: stem.num_frames,
            });
        }
    }

    let mut project = project_state.project.lock().map_err(|e| e.to_string())?;
    let project_sr = project.sample_rate.max(1.0);
    for stem in &metas {
        project.add_track(Track::new(&stem.track_name));
        let new_track_index = project.tracks.len().saturating_sub(1);
        let source_sr = stem.sample_rate.max(1) as f64;
        let timeline_frames = ((stem.num_frames as f64) * (project_sr / source_sr)).round() as i64;
        let clip = AudioClip::new(
            &stem.track_name,
            &stem.path,
            AbsoluteTime::new(clip_start_frame.max(0)),
            AbsoluteTime::new(timeline_frames.max(1)),
        );
        if let Some(track) = project.tracks.get_mut(new_track_index) {
            track.clips.push(clip);
        }
    }

    let project_name = project.name.clone();
    clip_pool_state.rebuild_snapshot(&project);
    rebuild_midi_snapshot_from_project(&project, handle);
    drop(project);
    project_state.mark_dirty(&project_name, Some(app))?;
    Ok(())
}

fn run_demucs_4stems(
    input_path: &std::path::Path,
    output_root: &std::path::Path,
) -> Result<std::collections::HashMap<String, String>, String> {
    std::fs::create_dir_all(output_root)
        .map_err(|e| format!("Failed to create stems output dir: {e}"))?;

    let status = std::process::Command::new("python3")
        .arg("-m")
        .arg("demucs.separate")
        .arg("-n")
        .arg("htdemucs")
        .arg("--out")
        .arg(output_root)
        .arg(input_path)
        .status()
        .map_err(|e| {
            format!(
                "Failed to launch Demucs (python3 -m demucs.separate): {e}. Install with: pip3 install demucs"
            )
        })?;

    if !status.success() {
        return Err(
            "Demucs stem separation failed. Make sure Demucs is installed: pip3 install demucs"
                .to_string(),
        );
    }

    fn collect_files(dir: &std::path::Path, out: &mut Vec<PathBuf>) {
        if let Ok(entries) = std::fs::read_dir(dir) {
            for entry in entries.flatten() {
                let path = entry.path();
                if path.is_dir() {
                    collect_files(&path, out);
                } else {
                    out.push(path);
                }
            }
        }
    }

    let mut all_files = Vec::<PathBuf>::new();
    collect_files(output_root, &mut all_files);
    let wanted = ["drums", "bass", "other", "vocals"];
    let mut by_stem: std::collections::HashMap<String, String> = std::collections::HashMap::new();
    for file in all_files {
        let Some(stem_name) = file.file_stem().and_then(|s| s.to_str()) else {
            continue;
        };
        if wanted.contains(&stem_name) {
            by_stem.insert(stem_name.to_string(), file.to_string_lossy().to_string());
        }
    }

    for key in wanted {
        if !by_stem.contains_key(key) {
            return Err(format!(
                "Demucs output is incomplete: missing '{}' stem",
                key
            ));
        }
    }

    Ok(by_stem)
}

fn compute_file_fingerprint(path: &std::path::Path) -> Result<String, String> {
    use std::hash::{Hash, Hasher};
    let file = std::fs::File::open(path)
        .map_err(|e| format!("Failed to open file for fingerprint: {e}"))?;
    let mut reader = std::io::BufReader::new(file);
    let mut hasher = std::collections::hash_map::DefaultHasher::new();
    let mut buf = [0_u8; 64 * 1024];
    let mut total: u64 = 0;
    loop {
        let n = std::io::Read::read(&mut reader, &mut buf)
            .map_err(|e| format!("Failed reading file for fingerprint: {e}"))?;
        if n == 0 {
            break;
        }
        total = total.saturating_add(n as u64);
        buf[..n].hash(&mut hasher);
    }
    total.hash(&mut hasher);
    Ok(format!("{:016x}", hasher.finish()))
}

fn get_cached_or_build_stems(
    source_mix_path: &std::path::Path,
) -> Result<std::collections::HashMap<String, String>, String> {
    let fingerprint = compute_file_fingerprint(source_mix_path)?;
    let cache_dir = std::env::temp_dir()
        .join("dream_daw_stem_cache")
        .join(fingerprint);
    std::fs::create_dir_all(&cache_dir)
        .map_err(|e| format!("Failed to create stem cache dir: {e}"))?;

    let stems = ["drums", "bass", "other", "vocals"];
    let mut cached: std::collections::HashMap<String, String> = std::collections::HashMap::new();
    let mut all_exist = true;
    for stem in stems {
        let p = cache_dir.join(format!("{stem}.wav"));
        if p.exists() {
            cached.insert(stem.to_string(), p.to_string_lossy().to_string());
        } else {
            all_exist = false;
        }
    }
    if all_exist {
        return Ok(cached);
    }

    let run_dir = std::env::temp_dir().join("dream_daw_stems").join(format!(
        "{}",
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map_err(|e| e.to_string())?
            .as_millis()
    ));
    let produced = run_demucs_4stems(source_mix_path, &run_dir)?;

    let mut out: std::collections::HashMap<String, String> = std::collections::HashMap::new();
    for stem in ["drums", "bass", "other", "vocals"] {
        let src = produced
            .get(stem)
            .ok_or_else(|| format!("Missing generated stem: {stem}"))?;
        let dst = cache_dir.join(format!("{stem}.wav"));
        std::fs::copy(src, &dst)
            .map_err(|e| format!("Failed to cache stem '{stem}': {e}"))?;
        out.insert(stem.to_string(), dst.to_string_lossy().to_string());
    }
    Ok(out)
}

/// Moves a clip to a new track and/or position.
///
/// The clip is identified by UUID string. After mutation, the
/// clip snapshot is atomically rebuilt for the audio thread.
#[tauri::command]
async fn move_clip_cmd(
    clip_id: String,
    new_track_index: usize,
    new_position_frames: i64,
    project_state: tauri::State<'_, ProjectState>,
    clip_pool_state: tauri::State<'_, ClipPoolState>,
    handle: tauri::State<'_, AudioEngineHandle>,
    app: tauri::AppHandle,
) -> Result<(), String> {
    let uuid = Uuid::parse_str(&clip_id)
        .map_err(|e| format!("Invalid clip ID: {e}"))?;

    // Snapshot for undo BEFORE mutation
    push_undo(&project_state)?;

    let mut project = project_state.project.lock().map_err(|e| e.to_string())?;

    if new_track_index >= project.tracks.len() {
        return Err(format!(
            "Track out of range: requested {} but project has {} tracks",
            new_track_index,
            project.tracks.len()
        ));
    }

    let new_position = AbsoluteTime::new(new_position_frames);
    if let Err(audio_err) = mutators::move_clip(&mut project, uuid, new_track_index, new_position) {
        // If this is not an audio clip, attempt MIDI clip move using same UUID.
        if !move_midi_clip_in_project(&mut project, uuid, new_track_index, new_position) {
            return Err(mutator_err_to_string(audio_err));
        }
    }

    let project_name = project.name.clone();
    clip_pool_state.rebuild_snapshot(&project);
    rebuild_midi_snapshot_from_project(&project, &handle);
    drop(project);
    project_state.mark_dirty(&project_name, Some(&app))?;

    Ok(())
}

fn resize_midi_clip_in_project(
    project: &mut Project,
    clip_id: Uuid,
    new_position: AbsoluteTime,
    new_duration: AbsoluteTime,
) -> bool {
    let mut extracted = None;
    let mut source_track_idx = None;

    for (track_idx, track) in project.tracks.iter_mut().enumerate() {
        if let Some(idx) = track.midi_clips.iter().position(|c| c.id == clip_id) {
            let mut clip = track.midi_clips.remove(idx);
            clip.position = new_position;
            clip.duration = new_duration;
            extracted = Some(clip);
            source_track_idx = Some(track_idx);
            break;
        }
    }

    let Some(clip) = extracted else {
        return false;
    };
    
    // Safety check: re-insert into the same track if found
    if let Some(ti) = source_track_idx {
        let target = &mut project.tracks[ti];
        
        // Handle overlaps for MIDI clips
        dream_models::mutators::handle_midi_overlaps(target, &clip);

        let insert_pos = target
            .midi_clips
            .binary_search_by(|c| c.position.cmp(&clip.position))
            .unwrap_or_else(|i| i);
        target.midi_clips.insert(insert_pos, clip);
        true
    } else {
        false
    }
}

/// Resizes a clip to a new position and duration.
#[tauri::command]
async fn resize_clip_cmd(
    clip_id: String,
    new_position_frames: i64,
    new_duration_frames: i64,
    project_state: tauri::State<'_, ProjectState>,
    clip_pool_state: tauri::State<'_, ClipPoolState>,
    handle: tauri::State<'_, AudioEngineHandle>,
    app: tauri::AppHandle,
) -> Result<(), String> {
    let uuid = Uuid::parse_str(&clip_id)
        .map_err(|e| format!("Invalid clip ID: {e}"))?;

    push_undo(&project_state)?;

    let mut project = project_state.project.lock().map_err(|e| e.to_string())?;

    let new_position = AbsoluteTime::new(new_position_frames);
    let new_duration = AbsoluteTime::new(new_duration_frames);

    if let Err(audio_err) = mutators::resize_clip(&mut project, uuid, new_position, new_duration) {
        // If this is not an audio clip, attempt MIDI clip resize using same UUID.
        if !resize_midi_clip_in_project(&mut project, uuid, new_position, new_duration) {
            return Err(mutator_err_to_string(audio_err));
        }
    }

    let project_name = project.name.clone();
    clip_pool_state.rebuild_snapshot(&project);
    rebuild_midi_snapshot_from_project(&project, &handle);
    drop(project);
    project_state.mark_dirty(&project_name, Some(&app))?;

    Ok(())
}

/// Splits a clip at the given sample frame position.
///
/// Returns the UUIDs of the two resulting clips (left keeps original UUID).
/// Both halves preserve correct source_offset for seamless playback.
/// Handles both audio and MIDI clips — tries audio first, falls back to MIDI.
#[tauri::command]
async fn split_clip_cmd(
    clip_id: String,
    split_frame: i64,
    project_state: tauri::State<'_, ProjectState>,
    clip_pool_state: tauri::State<'_, ClipPoolState>,
    handle: tauri::State<'_, AudioEngineHandle>,
    app: tauri::AppHandle,
) -> Result<SplitClipResponse, String> {
    let uuid = Uuid::parse_str(&clip_id)
        .map_err(|e| format!("Invalid clip ID: {e}"))?;

    // Snapshot for undo BEFORE mutation
    push_undo(&project_state)?;

    let mut project = project_state.project.lock().map_err(|e| e.to_string())?;

    // Try audio clip split first, fall back to MIDI clip split
    let result = match mutators::split_clip(&mut project, uuid, split_frame) {
        Ok(r) => r,
        Err(_audio_err) => {
            mutators::split_midi_clip(&mut project, uuid, split_frame)
                .map_err(mutator_err_to_string)?
        }
    };

    let project_name = project.name.clone();
    clip_pool_state.rebuild_snapshot(&project);
    rebuild_midi_snapshot_from_project(&project, &handle);
    drop(project);
    project_state.mark_dirty(&project_name, Some(&app))?;

    Ok(SplitClipResponse {
        left_id: result.left_id.to_string(),
        right_id: result.right_id.to_string(),
    })
}

/// Deletes a clip from the project by UUID.
///
/// The removed clip data is returned for potential client-side undo.
#[tauri::command]
async fn delete_clip_cmd(
    clip_id: String,
    project_state: tauri::State<'_, ProjectState>,
    clip_pool_state: tauri::State<'_, ClipPoolState>,
    handle: tauri::State<'_, AudioEngineHandle>,
    app: tauri::AppHandle,
) -> Result<(), String> {
    let uuid = Uuid::parse_str(&clip_id)
        .map_err(|e| format!("Invalid clip ID: {e}"))?;

    // Snapshot for undo BEFORE mutation
    push_undo(&project_state)?;

    let mut project = project_state.project.lock().map_err(|e| e.to_string())?;

    if let Err(audio_err) = mutators::delete_clip(&mut project, uuid) {
        // If this is not an audio clip, attempt MIDI clip delete using same UUID.
        if !delete_midi_clip_in_project(&mut project, uuid) {
            return Err(mutator_err_to_string(audio_err));
        }
    }

    let project_name = project.name.clone();
    clip_pool_state.rebuild_snapshot(&project);
    rebuild_midi_snapshot_from_project(&project, &handle);
    drop(project);
    project_state.mark_dirty(&project_name, Some(&app))?;

    Ok(())
}

/// Duplicate a clip, optionally at a specific destination position.
#[tauri::command]
async fn duplicate_clip_cmd(
    clip_id: String,
    new_position_frames: Option<i64>,
    project_state: tauri::State<'_, ProjectState>,
    clip_pool_state: tauri::State<'_, ClipPoolState>,
    handle: tauri::State<'_, AudioEngineHandle>,
    app: tauri::AppHandle,
) -> Result<DuplicateClipResponse, String> {
    let uuid = Uuid::parse_str(&clip_id).map_err(|e| format!("Invalid clip ID: {e}"))?;
    push_undo(&project_state)?;

    let mut project = project_state.project.lock().map_err(|e| e.to_string())?;
    let target_pos = new_position_frames.map(AbsoluteTime::new);

    let new_id = match mutators::duplicate_clip(&mut project, uuid, target_pos) {
        Ok(dup) => dup.id,
        Err(_) => {
            mutators::duplicate_midi_clip(&mut project, uuid, target_pos)
                .map_err(mutator_err_to_string)?
                .id
        }
    };


    let project_name = project.name.clone();
    clip_pool_state.rebuild_snapshot(&project);
    rebuild_midi_snapshot_from_project(&project, &handle);
    drop(project);
    project_state.mark_dirty(&project_name, Some(&app))?;

    Ok(DuplicateClipResponse {
        new_id: new_id.to_string(),
    })
}

/// Merge selected clips into one clip on the same track.
#[tauri::command]
async fn merge_clips_cmd(
    clip_ids: Vec<String>,
    project_state: tauri::State<'_, ProjectState>,
    clip_pool_state: tauri::State<'_, ClipPoolState>,
    handle: tauri::State<'_, AudioEngineHandle>,
    app: tauri::AppHandle,
) -> Result<MergeClipsResponse, String> {
    if clip_ids.is_empty() {
        return Err("No clips selected".to_string());
    }

    let ids: Result<Vec<Uuid>, _> = clip_ids.iter().map(|id| Uuid::parse_str(id)).collect();
    let ids = ids.map_err(|e| format!("Invalid clip ID: {e}"))?;
    push_undo(&project_state)?;

    let mut project = project_state.project.lock().map_err(|e| e.to_string())?;

    // Find track containing all selected clips.
    let mut selected_track_idx: Option<usize> = None;
    for (ti, track) in project.tracks.iter().enumerate() {
        let audio_hits = ids.iter().filter(|id| track.clips.iter().any(|c| c.id == **id)).count();
        let midi_hits = ids.iter().filter(|id| track.midi_clips.iter().any(|c| c.id == **id)).count();
        if audio_hits == ids.len() || midi_hits == ids.len() {
            selected_track_idx = Some(ti);
            break;
        }
    }
    let ti = selected_track_idx.ok_or_else(|| "Selected clips must be on one track".to_string())?;
    let track = &mut project.tracks[ti];

    let audio_selected: Vec<_> = track
        .clips
        .iter()
        .filter(|c| ids.contains(&c.id))
        .cloned()
        .collect();
    let midi_selected: Vec<_> = track
        .midi_clips
        .iter()
        .filter(|c| ids.contains(&c.id))
        .cloned()
        .collect();

    if !audio_selected.is_empty() && !midi_selected.is_empty() {
        return Err("Cannot merge audio and MIDI clips together".to_string());
    }
    if audio_selected.len() + midi_selected.len() < 2 {
        return Err("Select at least two clips to merge".to_string());
    }

    let new_id = Uuid::new_v4();
    if !audio_selected.is_empty() {
        let first = audio_selected
            .iter()
            .min_by_key(|c| c.position.sample_frame)
            .ok_or_else(|| "No audio clips selected".to_string())?;
        let start = audio_selected
            .iter()
            .map(|c| c.position.sample_frame)
            .min()
            .unwrap_or(first.position.sample_frame);
        let end = audio_selected
            .iter()
            .map(|c| c.end_position().sample_frame)
            .max()
            .unwrap_or(first.end_position().sample_frame);

        track.clips.retain(|c| !ids.contains(&c.id));
        let merged = AudioClip {
            id: new_id,
            name: "Merged Clip".to_string(),
            position: AbsoluteTime::new(start),
            duration: AbsoluteTime::new((end - start).max(1)),
            fade_in_frames: 0,
            fade_out_frames: 0,
            is_selected: false,
            is_muted: false,
            // BUG-6 FIX: Reset source_offset to ZERO for merged clips.
            // Previously inherited from first.clone(), causing the playback
            // cursor inside merged clips to start at the wrong position.
            source_offset: AbsoluteTime::ZERO,
            ..first.clone()
        };
        let insert_at = track
            .clips
            .binary_search_by(|c| c.position.cmp(&merged.position))
            .unwrap_or_else(|i| i);
        track.clips.insert(insert_at, merged);
    } else {
        let start = midi_selected
            .iter()
            .map(|c| c.position.sample_frame)
            .min()
            .ok_or_else(|| "No MIDI clips selected".to_string())?;
        let end = midi_selected
            .iter()
            .map(|c| c.end_position().sample_frame)
            .max()
            .ok_or_else(|| "No MIDI clips selected".to_string())?;

        let mut merged = MidiClip::new("Merged Clip", AbsoluteTime::new(start), AbsoluteTime::new((end - start).max(1)));
        merged.id = new_id;
        for clip in &midi_selected {
            let clip_offset = clip.position.sample_frame - start;
            for note in &clip.notes {
                let mut moved = *note;
                moved.start_frame = (note.start_frame + clip_offset).max(0);
                merged.add_note(moved);
            }
        }

        track.midi_clips.retain(|c| !ids.contains(&c.id));
        let insert_at = track
            .midi_clips
            .binary_search_by(|c| c.position.cmp(&merged.position))
            .unwrap_or_else(|i| i);
        track.midi_clips.insert(insert_at, merged);
    }

    let project_name = project.name.clone();
    clip_pool_state.rebuild_snapshot(&project);
    rebuild_midi_snapshot_from_project(&project, &handle);
    drop(project);
    project_state.mark_dirty(&project_name, Some(&app))?;

    Ok(MergeClipsResponse {
        new_id: new_id.to_string(),
    })
}

/// Update a clip's source offset (slip editing).
#[tauri::command]
async fn set_clip_source_offset_cmd(
    clip_id: String,
    source_offset_frames: i64,
    project_state: tauri::State<'_, ProjectState>,
    clip_pool_state: tauri::State<'_, ClipPoolState>,
    app: tauri::AppHandle,
) -> Result<(), String> {
    let uuid = Uuid::parse_str(&clip_id).map_err(|e| format!("Invalid clip ID: {e}"))?;
    push_undo(&project_state)?;

    let mut project = project_state.project.lock().map_err(|e| e.to_string())?;
    let mut updated = false;
    for track in &mut project.tracks {
        if let Some(clip) = track.clips.iter_mut().find(|c| c.id == uuid) {
            clip.source_offset = AbsoluteTime::new(source_offset_frames.max(0));
            updated = true;
            break;
        }
    }

    if !updated {
        return Err(format!("Clip not found: {clip_id}"));
    }

    let project_name = project.name.clone();
    clip_pool_state.rebuild_snapshot(&project);
    drop(project);
    project_state.mark_dirty(&project_name, Some(&app))?;
    Ok(())
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct SetClipWarpPayload {
    clip_id: String,
    is_warped: bool,
    warp_mode: Option<i32>,
    warp_base_bpm: Option<f64>,
}

/// Set clip warp state/mode/base BPM and recalculate timeline duration.
#[tauri::command]
async fn set_clip_warp_cmd(
    payload: SetClipWarpPayload,
    project_state: tauri::State<'_, ProjectState>,
    clip_pool_state: tauri::State<'_, ClipPoolState>,
    app: tauri::AppHandle,
) -> Result<(), String> {
    let uuid = Uuid::parse_str(&payload.clip_id).map_err(|e| format!("Invalid clip ID: {e}"))?;
    let base_bpm = payload.warp_base_bpm.unwrap_or(120.0);
    if !(20.0..=300.0).contains(&base_bpm) {
        return Err(format!("Warp base BPM {base_bpm} out of range (20-300)"));
    }

    push_undo(&project_state)?;

    let mut project = project_state.project.lock().map_err(|e| e.to_string())?;
    let project_bpm = project.pulse_map.initial_bpm().clamp(20.0, 999.0);
    let mut updated = false;

    for track in &mut project.tracks {
        if let Some(clip) = track.clips.iter_mut().find(|c| c.id == uuid) {
            if clip.warp_source_duration_frames <= 0 {
                // Look up the real file duration from the clip pool so we
                // never accidentally capture an already-warped timeline length.
                let pool = clip_pool_state.pool.lock().map_err(|e| e.to_string())?;
                let source_frames = pool
                    .get(&clip.file_path)
                    .map(|audio| audio.num_frames.max(1) as i64)
                    .unwrap_or(clip.duration.sample_frame.max(1));
                clip.warp_source_duration_frames = source_frames;
            }

            clip.is_warped = payload.is_warped;
            clip.warp_mode = payload.warp_mode.or(Some(0));
            clip.warp_base_bpm = base_bpm;

            if clip.is_warped {
                let source_len = clip.warp_source_duration_frames.max(1) as f64;
                let next_len = (source_len * (clip.warp_base_bpm / project_bpm)).round() as i64;
                clip.duration = AbsoluteTime::new(next_len.max(1));
            } else {
                clip.duration = AbsoluteTime::new(clip.warp_source_duration_frames.max(1));
            }

            updated = true;
            break;
        }
    }

    if !updated {
        return Err(format!("Clip not found: {}", payload.clip_id));
    }

    let project_name = project.name.clone();
    clip_pool_state.rebuild_snapshot(&project);
    drop(project);
    project_state.mark_dirty(&project_name, Some(&app))?;
    Ok(())
}

/// Set clip fades. Current engine applies always-on micro-fades; this command is
/// accepted for IPC compatibility with interactive UI fade handles.
#[tauri::command]
async fn set_clip_fades_cmd(
    clip_id: String,
    fade_in_frames: i64,
    fade_out_frames: i64,
    project_state: tauri::State<'_, ProjectState>,
    clip_pool_state: tauri::State<'_, ClipPoolState>,
    handle: tauri::State<'_, AudioEngineHandle>,
    app: tauri::AppHandle,
) -> Result<(), String> {
    let uuid = Uuid::parse_str(&clip_id).map_err(|e| format!("Invalid clip ID: {e}"))?;
    push_undo(&project_state)?;

    let mut project = project_state.project.lock().map_err(|e| e.to_string())?;
    let mut updated = false;
    for track in &mut project.tracks {
        if let Some(clip) = track.clips.iter_mut().find(|c| c.id == uuid) {
            let clip_len = clip.duration.sample_frame.max(1);
            let max_fade = (clip_len / 2).max(0);
            clip.fade_in_frames = fade_in_frames.max(0).min(max_fade);
            clip.fade_out_frames = fade_out_frames.max(0).min(max_fade);
            updated = true;
            break;
        }
    }

    if !updated {
        for track in &mut project.tracks {
            if let Some(clip) = track.midi_clips.iter_mut().find(|c| c.id == uuid) {
                let clip_len = clip.duration.sample_frame.max(1);
                let max_fade = (clip_len / 2).max(0);
                clip.fade_in_frames = fade_in_frames.max(0).min(max_fade);
                clip.fade_out_frames = fade_out_frames.max(0).min(max_fade);
                updated = true;
                break;
            }
        }
    }

    if !updated {
        return Err(format!("Clip not found: {clip_id}"));
    }

    let project_name = project.name.clone();
    clip_pool_state.rebuild_snapshot(&project);
    rebuild_midi_snapshot_from_project(&project, &handle);
    drop(project);
    project_state.mark_dirty(&project_name, Some(&app))?;

    log::info!(
        "[IPC] set_clip_fades_cmd clip={} fade_in={} fade_out={}",
        clip_id,
        fade_in_frames.max(0),
        fade_out_frames.max(0)
    );
    Ok(())
}

/// Toggle mute state on a clip (audio or MIDI).
///
/// Muted clips remain on the timeline but are skipped during playback.
/// The visual renderer draws them with a dark overlay.
fn apply_clip_mute(project: &mut Project, clip_id: Uuid, muted: bool) -> (bool, bool) {
    for track in &mut project.tracks {
        if let Some(clip) = track.clips.iter_mut().find(|c| c.id == clip_id) {
            let changed = clip.is_muted != muted;
            if changed {
                clip.is_muted = muted;
            }
            return (true, changed);
        }
    }

    for track in &mut project.tracks {
        if let Some(clip) = track.midi_clips.iter_mut().find(|c| c.id == clip_id) {
            let changed = clip.is_muted != muted;
            if changed {
                clip.is_muted = muted;
            }
            return (true, changed);
        }
    }

    (false, false)
}

fn clip_mute_status(project: &Project, clip_id: Uuid, muted: bool) -> (bool, bool) {
    for track in &project.tracks {
        if let Some(clip) = track.clips.iter().find(|c| c.id == clip_id) {
            return (true, clip.is_muted != muted);
        }
    }
    for track in &project.tracks {
        if let Some(clip) = track.midi_clips.iter().find(|c| c.id == clip_id) {
            return (true, clip.is_muted != muted);
        }
    }
    (false, false)
}

#[tauri::command]
async fn set_clip_muted_cmd(
    clip_id: String,
    muted: bool,
    project_state: tauri::State<'_, ProjectState>,
    clip_pool_state: tauri::State<'_, ClipPoolState>,
    handle: tauri::State<'_, AudioEngineHandle>,
    app: tauri::AppHandle,
) -> Result<(), String> {
    let uuid = Uuid::parse_str(&clip_id).map_err(|e| format!("Invalid clip ID: {e}"))?;

    let (found, changed) = {
        let project = project_state.project.lock().map_err(|e| e.to_string())?;
        clip_mute_status(&project, uuid, muted)
    };

    if !found {
        return Err(format!("Clip not found: {clip_id}"));
    }

    if !changed {
        return Ok(());
    }

    push_undo(&project_state)?;

    let mut project = project_state.project.lock().map_err(|e| e.to_string())?;
    let (_, changed_again) = apply_clip_mute(&mut project, uuid, muted);
    if !changed_again {
        return Ok(());
    }

    let project_name = project.name.clone();
    clip_pool_state.rebuild_snapshot(&project);
    rebuild_midi_snapshot_from_project(&project, &handle);
    drop(project);
    project_state.mark_dirty(&project_name, Some(&app))?;

    log::info!("[IPC] set_clip_muted_cmd clip={} muted={}", clip_id, muted);
    Ok(())
}

/// Set mute state on multiple clips in one operation.
///
/// This creates a single undo step for the whole batch and avoids undo spam.
#[tauri::command]
async fn set_clips_muted_cmd(
    clip_ids: Vec<String>,
    muted: bool,
    project_state: tauri::State<'_, ProjectState>,
    clip_pool_state: tauri::State<'_, ClipPoolState>,
    handle: tauri::State<'_, AudioEngineHandle>,
    app: tauri::AppHandle,
) -> Result<usize, String> {
    let uuids: Vec<Uuid> = clip_ids
        .iter()
        .map(|id| Uuid::parse_str(id).map_err(|e| format!("Invalid clip ID '{id}': {e}")))
        .collect::<Result<Vec<_>, _>>()?;

    if uuids.is_empty() {
        return Ok(0);
    }

    let (found_count, changed_count) = {
        let project = project_state.project.lock().map_err(|e| e.to_string())?;
        let mut found = 0usize;
        let mut changed = 0usize;
        for uuid in &uuids {
            let (is_found, is_changed) = clip_mute_status(&project, *uuid, muted);
            if is_found {
                found += 1;
            }
            if is_changed {
                changed += 1;
            }
        }
        (found, changed)
    };

    if found_count == 0 {
        return Err("No clips found for mute operation".to_string());
    }
    if changed_count == 0 {
        return Ok(0);
    }

    push_undo(&project_state)?;

    let mut project = project_state.project.lock().map_err(|e| e.to_string())?;
    let mut applied = 0usize;
    for uuid in &uuids {
        let (_, changed) = apply_clip_mute(&mut project, *uuid, muted);
        if changed {
            applied += 1;
        }
    }

    if applied == 0 {
        return Ok(0);
    }

    let project_name = project.name.clone();
    clip_pool_state.rebuild_snapshot(&project);
    rebuild_midi_snapshot_from_project(&project, &handle);
    drop(project);
    project_state.mark_dirty(&project_name, Some(&app))?;

    log::info!(
        "[IPC] set_clips_muted_cmd clips={} muted={} applied={}",
        uuids.len(),
        muted,
        applied
    );

    Ok(applied)
}

/// Clear clip color overrides on a track so all clips inherit track color.
#[tauri::command]
async fn paint_track_clips_with_track_color_cmd(
    track_id: String,
    project_state: tauri::State<'_, ProjectState>,
    clip_pool_state: tauri::State<'_, ClipPoolState>,
    handle: tauri::State<'_, AudioEngineHandle>,
    app: tauri::AppHandle,
) -> Result<(), String> {
    let track_uuid = Uuid::parse_str(&track_id).map_err(|e| format!("Invalid track ID: {e}"))?;
    push_undo(&project_state)?;

    let mut project = project_state.project.lock().map_err(|e| e.to_string())?;
    let track = project
        .tracks
        .iter_mut()
        .find(|t| t.id == track_uuid)
        .ok_or_else(|| format!("Track not found: {track_id}"))?;

    let mut changed = false;
    let target_color = track.color.clone();
    let target_color_hex = track.color_hex.clone();

    for clip in &mut track.clips {
        if clip.color_override.as_ref() != Some(&target_color)
            || clip.color_hex != target_color_hex
        {
            changed = true;
        }
        clip.color_override = Some(target_color.clone());
        clip.color_hex = target_color_hex.clone();
    }

    for clip in &mut track.midi_clips {
        if clip.color_override.as_ref() != Some(&target_color)
            || clip.color_hex != target_color_hex
        {
            changed = true;
        }
        clip.color_override = Some(target_color.clone());
        clip.color_hex = target_color_hex.clone();
    }

    if changed {
        clip_pool_state.rebuild_snapshot(&project);
        rebuild_midi_snapshot_from_project(&project, &handle);
        let project_name = project.name.clone();
        drop(project);
        project_state.mark_dirty(&project_name, Some(&app))?;
    } else {
        drop(project);
    }

    Ok(())
}

/// Resolve offline media path for an existing clip.
#[tauri::command]
async fn resolve_missing_file_cmd(
    clip_id: String,
    new_path: String,
    project_state: tauri::State<'_, ProjectState>,
    clip_pool_state: tauri::State<'_, ClipPoolState>,
    app: tauri::AppHandle,
) -> Result<(), String> {
    let uuid = Uuid::parse_str(&clip_id).map_err(|e| format!("Invalid clip ID: {e}"))?;
    if !PathBuf::from(&new_path).exists() {
        return Err(format!("Resolved file does not exist: {new_path}"));
    }

    push_undo(&project_state)?;
    let mut project = project_state.project.lock().map_err(|e| e.to_string())?;
    let mut updated = false;
    for track in &mut project.tracks {
        if let Some(clip) = track.clips.iter_mut().find(|c| c.id == uuid) {
            clip.file_path = new_path.clone();
            clip.is_offline = false;
            updated = true;
            break;
        }
    }
    if !updated {
        return Err(format!("Clip not found: {clip_id}"));
    }

    // Load resolved media into clip pool so playback recovers immediately.
    let decoded = AudioReader::read(PathBuf::from(&new_path))
        .map_err(|e| format!("Failed to decode resolved audio: {e}"))?;
    {
        let mut pool = clip_pool_state.pool.lock().map_err(|e| e.to_string())?;
        pool.insert(ClipAudio {
            source_path: new_path.clone(),
            channels: decoded.channels,
            sample_rate: decoded.sample_rate,
            num_frames: decoded.num_frames,
        });
    }

    let project_name = project.name.clone();
    clip_pool_state.rebuild_snapshot(&project);
    drop(project);
    project_state.mark_dirty(&project_name, Some(&app))?;
    Ok(())
}

/// Accept automation points from frontend (throttled there to 16ms).
#[tauri::command]
async fn set_automation_points_cmd(
    track_id: String,
    param_id: String,
    points: Vec<AutomationPointPayload>,
    project_state: tauri::State<'_, ProjectState>,
    automation_runtime: tauri::State<'_, AutomationRuntime>,
    app: tauri::AppHandle,
) -> Result<(), String> {
    let track_uuid = Uuid::parse_str(&track_id).map_err(|e| format!("Invalid track ID: {e}"))?;
    let normalized_param_id = param_id.trim().to_string();
    if normalized_param_id.is_empty() {
        return Err("Parameter ID cannot be empty".to_string());
    }
    push_undo(&project_state)?;
    {
        let mut project = project_state.project.lock().map_err(|e| e.to_string())?;
        let track = project
            .tracks
            .iter_mut()
            .find(|t| t.id == track_uuid)
            .ok_or_else(|| format!("Track not found: {track_id}"))?;

        let mut persistent_points: Vec<dream_models::project::AutomationPoint> = points
            .iter()
            .map(|p| dream_models::project::AutomationPoint {
                beat: p.beat.max(0.0),
                value: p.value,
                curve_type: p.curve_type.clone(),
                tension: p.tension,
                bezier_cp1x: None, bezier_cp1y: None, bezier_cp2x: None, bezier_cp2y: None,
            })
            .collect();
        persistent_points.sort_by(|a, b| a.beat.total_cmp(&b.beat));

        if let Some(existing) = track
            .automation_lanes
            .iter_mut()
            .find(|lane| lane.param_id.eq_ignore_ascii_case(&normalized_param_id))
        {
            existing.points = persistent_points;
            existing.param_id = normalized_param_id.clone();
        } else {
            track.automation_lanes.push(dream_models::project::AutomationLane {
                param_id: normalized_param_id.clone(),
                points: persistent_points,
            });
        }

        // Keep project clean: remove empty lanes.
        track.automation_lanes.retain(|lane| !lane.points.is_empty());

        let project_name = project.name.clone();
        rebuild_automation_snapshot_from_project(&project, &automation_runtime);
        drop(project);
        project_state.mark_dirty(&project_name, Some(&app))?;
    }

    log::debug!(
        "[IPC] set_automation_points_cmd track={} param={} points={}",
        track_id,
        param_id,
        points.len()
    );
    Ok(())
}

/// Arm/disarm a track for recording.
#[tauri::command]
async fn arm_track_cmd(
    track_index: usize,
    armed: bool,
    project_state: tauri::State<'_, ProjectState>,
    app: tauri::AppHandle,
) -> Result<(), String> {
    let mut project = project_state.project.lock().map_err(|e| e.to_string())?;
    let track = project
        .tracks
        .get_mut(track_index)
        .ok_or_else(|| format!("Track index out of range: {track_index}"))?;
    track.is_armed = armed;
    let project_name = project.name.clone();
    drop(project);
    project_state.mark_dirty(&project_name, Some(&app))?;
    Ok(())
}

/// Start live recording on the first armed track.
#[tauri::command]
async fn start_recording_cmd(
    app: tauri::AppHandle,
    project_state: tauri::State<'_, ProjectState>,
    recording_runtime: tauri::State<'_, RecordingRuntime>,
    handle: tauri::State<'_, AudioEngineHandle>,
) -> Result<(), String> {
    if recording_runtime
        .session
        .lock()
        .map_err(|e| e.to_string())?
        .is_some()
    {
        return Err("Recording already in progress".to_string());
    }

    let armed_track_index = {
        let project = project_state.project.lock().map_err(|e| e.to_string())?;
        project
            .tracks
            .iter()
            .position(|t| t.is_armed)
            .ok_or_else(|| "No armed tracks".to_string())?
    };

    let output_dir = std::env::temp_dir().join("dream_daw_recordings");
    let start_frame = handle.master_clock.position();
    let file_name = format!("recording_{}", std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map_err(|e| e.to_string())?.as_secs());

    let session = RecordingSession::start(&output_dir, &file_name, start_frame)
        .map_err(|e| format!("start_recording failed: {e}"))?;

    let is_recording = Arc::clone(&session.state().is_recording);
    let peak_left = Arc::clone(&session.state().peak_left);
    let peak_right = Arc::clone(&session.state().peak_right);
    let app_for_peaks = app.clone();
    std::thread::spawn(move || {
        while is_recording.load(Ordering::Relaxed) {
            let left = f32::from_bits(peak_left.load(Ordering::Relaxed));
            let right = f32::from_bits(peak_right.load(Ordering::Relaxed));
            let payload = serde_json::json!({
                "track_index": armed_track_index,
                "peak": left.abs().max(right.abs()),
                "peaks": [left, right]
            });
            let _ = app_for_peaks.emit("live_audio_peaks", payload);
            std::thread::sleep(Duration::from_millis(16));
        }
    });

    *recording_runtime.session.lock().map_err(|e| e.to_string())? = Some(session);
    *recording_runtime
        .armed_track_index
        .lock()
        .map_err(|e| e.to_string())? = Some(armed_track_index);

    Ok(())
}

/// Stop recording, finalize file, and place resulting clip on armed track.
#[tauri::command]
async fn stop_recording_cmd(
    project_state: tauri::State<'_, ProjectState>,
    clip_pool_state: tauri::State<'_, ClipPoolState>,
    recording_runtime: tauri::State<'_, RecordingRuntime>,
    app: tauri::AppHandle,
) -> Result<(), String> {
    let session = recording_runtime
        .session
        .lock()
        .map_err(|e| e.to_string())?
        .take()
        .ok_or_else(|| "No active recording session".to_string())?;

    let armed_idx = recording_runtime
        .armed_track_index
        .lock()
        .map_err(|e| e.to_string())?
        .take()
        .ok_or_else(|| "Missing armed track index".to_string())?;

    let result = session
        .stop()
        .map_err(|e| format!("stop_recording failed: {e}"))?;
    let path = result.file_path.display().to_string();

    let decoded = AudioReader::read(&result.file_path)
        .map_err(|e| format!("Failed to decode recorded file: {e}"))?;
    {
        let mut pool = clip_pool_state.pool.lock().map_err(|e| e.to_string())?;
        pool.insert(ClipAudio {
            source_path: path.clone(),
            channels: decoded.channels,
            sample_rate: decoded.sample_rate,
            num_frames: decoded.num_frames,
        });
    }

    push_undo(&project_state)?;
    let mut project = project_state.project.lock().map_err(|e| e.to_string())?;
    let project_sr = project.sample_rate.max(1.0);
    let source_sr = decoded.sample_rate.max(1) as f64;
    let timeline_frames = ((result.total_frames as f64) * (project_sr / source_sr)).round() as i64;
    while project.tracks.len() <= armed_idx {
        let track_num = project.tracks.len() + 1;
        project.add_track(Track::new(format!("Track {track_num}")));
    }

    let clip = AudioClip::new(
        "Recording",
        &path,
        AbsoluteTime::new(result.start_frame),
        AbsoluteTime::new(timeline_frames.max(1)),
    );
    project.tracks[armed_idx].clips.push(clip);
    let project_name = project.name.clone();
    clip_pool_state.rebuild_snapshot(&project);
    drop(project);
    project_state.mark_dirty(&project_name, Some(&app))?;

    Ok(())
}

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
    let project = project_state.project.lock().map_err(|e| e.to_string())?.clone();

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
    };

    // ── VST3 instrument pre-render: clone host + slot map for spawn_blocking ──
    let plugin_host_arc = std::sync::Arc::clone(&plugin_host_state.host);
    let slot_instance_map = plugin_host_state.slot_instance_snapshot();

    let (job_id, job_cancel) = start_job(&app, "export_mix", true)?;
    
    // Reset cancel flag and execute export as detached background worker.
    handle.export_cancel.store(false, std::sync::atomic::Ordering::SeqCst);
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

                    // Skip tracks WITH a sampler config — those are handled
                    // by OfflineBouncer::pre_render_midi_tracks().
                    if track.sampler.is_some() {
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
                            track.name, track.midi_clips.len()
                        );
                        continue;
                    };

                    let Some(instance_id) = slot_instance_map.get(&slot_id).copied() else {
                        log::warn!(
                            "[Export/VST3-MIDI] Track '{}': instrument slot {} not bound to any instance — skipping",
                            track.name, slot_id
                        );
                        continue;
                    };

                    log::info!(
                        "[Export/VST3-MIDI] Pre-rendering track '{}': {} clips, instance={}, {} frames",
                        track.name, track.midi_clips.len(), instance_id, total_frames
                    );

                    // ── Pre-render buffer by buffer ───────────────
                    let midi_clips = track.midi_clips.clone();
                    let track_name = track.name.clone();

                    let mut out_left = vec![0.0f32; total_frames];
                    let mut out_right = vec![0.0f32; total_frames];

                    let mut schedule_scratch: Vec<dream_clip_engine::midi_scheduler::ScheduledNote> = Vec::new();
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
                            a.sample_offset.cmp(&b.sample_offset)
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
                                            track_name, e
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

                    // ── Check if anything was rendered ──────────
                    let peak = out_left.iter().chain(out_right.iter())
                        .fold(0.0f32, |acc, &s| acc.max(s.abs()));

                    if peak < 1e-7 {
                        log::warn!(
                            "[Export/VST3-MIDI] Track '{}': pre-render produced silence (peak={:.2e})",
                            track_name, peak
                        );
                        // Still add the clip — silence is valid (e.g. if all notes are outside range)
                    } else {
                        log::info!(
                            "[Export/VST3-MIDI] Track '{}': pre-render complete, peak={:.4}, {} frames",
                            track_name, peak, total_frames
                        );
                    }

                    // ── Create synthetic ClipAudio + AudioClip ──
                    let synth_path = format!("__vst3_midi_prerender__/track_{}", track_idx);
                    let clip_audio = ClipAudio::new(
                        synth_path.clone(),
                        vec![out_left, out_right],
                        sample_rate,
                    );
                    local_pool.insert(clip_audio);

                    let synth_clip = AudioClip::new(
                        format!("{} (VST3 Pre-render)", track_name),
                        synth_path,
                        AbsoluteTime::new(start_frame),
                        AbsoluteTime::new(total_frames as i64),
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

        let result = bouncer
            .bounce(&mut project, &mut local_pool, None, move |progress| {
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
            })
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
    handle.export_cancel.store(true, std::sync::atomic::Ordering::SeqCst);
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

/// Bounce selected clips or selected time range to a new audio track.
#[tauri::command]
async fn bounce_selection_to_track_cmd(
    payload: BounceSelectionPayload,
    app: tauri::AppHandle,
    project_state: tauri::State<'_, ProjectState>,
    clip_pool_state: tauri::State<'_, ClipPoolState>,
    handle: tauri::State<'_, AudioEngineHandle>,
) -> Result<(), String> {
    let project = project_state.project.lock().map_err(|e| e.to_string())?.clone();
    let mut bounce_project = project.clone();
    let mut bounce_track_name = "Bounce".to_string();

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
        if lo == hi && let Some(track) = project.tracks.get(lo) {
            bounce_track_name = format!("{} Bounce", track.name);
        }
        for (idx, track) in bounce_project.tracks.iter_mut().enumerate() {
            if idx < lo || idx > hi {
                track.clips.clear();
                track.midi_clips.clear();
            }
        }
        (range_start, range_end)
    } else {
        return Err("Bounce requires selected clips or a selected time range".to_string());
    };

    let local_pool = build_local_pool_for_project(&bounce_project, &clip_pool_state)?;
    let output_path = make_bounce_output_path("selection_bounce")?;
    let cfg = BounceConfig {
        output_path: output_path.clone(),
        sample_rate: project.sample_rate.max(1.0).round() as u32,
        bit_depth: 32,
        start_frame,
        end_frame,
        normalize: false,
        tail_frames: 0,
        format: "wav".to_string(),
        project_sample_rate: project.sample_rate.max(1.0),
    };

    let (job_id, job_cancel) = start_job(&app, "bounce_selection", true)?;

    handle
        .export_cancel
        .store(false, std::sync::atomic::Ordering::SeqCst);
    let cancel_flag = std::sync::Arc::clone(&job_cancel);
    let app_for_progress = app.clone();
    let job_id_for_progress = job_id.clone();
    let bounce_res = tauri::async_runtime::spawn_blocking(move || {
        let mut bouncer = OfflineBouncer::new(cfg);
        bouncer.cancel_flag = cancel_flag;
        let mut bounce_project = bounce_project;
        let mut local_pool = local_pool;
        bouncer.bounce(&mut bounce_project, &mut local_pool, None, move |progress| {
            let _ = set_job_progress(
                &app_for_progress,
                &job_id_for_progress,
                (progress * 100.0).clamp(0.0, 100.0),
                "Rendering",
            );
        })
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
        &project_state,
        &clip_pool_state,
        &handle,
        &app,
        &output_path,
        &bounce_track_name,
        start_frame,
        &bounce_track_name,
    );
    if let Err(err) = &place_result {
        let _ = finish_job(&app, &job_id, false, false, Some(err.clone()));
    }
    place_result?;
    let _ = finish_job(&app, &job_id, true, false, None);
    Ok(())
}

/// Bounce an entire track to a new audio track.
#[tauri::command]
async fn bounce_track_cmd(
    track_id: String,
    app: tauri::AppHandle,
    project_state: tauri::State<'_, ProjectState>,
    clip_pool_state: tauri::State<'_, ClipPoolState>,
    handle: tauri::State<'_, AudioEngineHandle>,
) -> Result<(), String> {
    let project = project_state.project.lock().map_err(|e| e.to_string())?.clone();
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
    for (idx, track) in bounce_project.tracks.iter_mut().enumerate() {
        if idx != source_index {
            track.clips.clear();
            track.midi_clips.clear();
        }
    }

    let local_pool = build_local_pool_for_project(&bounce_project, &clip_pool_state)?;
    let output_path = make_bounce_output_path("track_bounce")?;
    let cfg = BounceConfig {
        output_path: output_path.clone(),
        sample_rate: project.sample_rate.max(1.0).round() as u32,
        bit_depth: 32,
        start_frame,
        end_frame,
        normalize: false,
        tail_frames: 0,
        format: "wav".to_string(),
        project_sample_rate: project.sample_rate.max(1.0),
    };

    let (job_id, job_cancel) = start_job(&app, "bounce_track", true)?;

    handle
        .export_cancel
        .store(false, std::sync::atomic::Ordering::SeqCst);
    let cancel_flag = std::sync::Arc::clone(&job_cancel);
    let app_for_progress = app.clone();
    let job_id_for_progress = job_id.clone();
    let bounce_res = tauri::async_runtime::spawn_blocking(move || {
        let mut bouncer = OfflineBouncer::new(cfg);
        bouncer.cancel_flag = cancel_flag;
        let mut bounce_project = bounce_project;
        let mut local_pool = local_pool;
        bouncer.bounce(&mut bounce_project, &mut local_pool, None, move |progress| {
            let _ = set_job_progress(
                &app_for_progress,
                &job_id_for_progress,
                (progress * 100.0).clamp(0.0, 100.0),
                "Rendering",
            );
        })
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
        &project_state,
        &clip_pool_state,
        &handle,
        &app,
        &output_path,
        &format!("{} Bounce", source_track.name),
        start_frame,
        &format!("{} Bounce", source_track.name),
    );
    if let Err(err) = &place_result {
        let _ = finish_job(&app, &job_id, false, false, Some(err.clone()));
    }
    place_result?;
    let _ = finish_job(&app, &job_id, true, false, None);
    Ok(())
}

/// Bounce a group track (group + all descendant tracks) to a new audio track.
#[tauri::command]
async fn bounce_group_cmd(
    group_track_id: String,
    app: tauri::AppHandle,
    project_state: tauri::State<'_, ProjectState>,
    clip_pool_state: tauri::State<'_, ClipPoolState>,
    handle: tauri::State<'_, AudioEngineHandle>,
) -> Result<(), String> {
    let project = project_state.project.lock().map_err(|e| e.to_string())?.clone();
    let group_uuid = Uuid::parse_str(&group_track_id)
        .map_err(|e| format!("Invalid group track ID: {e}"))?;
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
    for track in &mut bounce_project.tracks {
        if !included_ids.contains(&track.id) {
            track.clips.clear();
            track.midi_clips.clear();
        }
    }

    let local_pool = build_local_pool_for_project(&bounce_project, &clip_pool_state)?;
    let output_path = make_bounce_output_path("group_bounce")?;
    let cfg = BounceConfig {
        output_path: output_path.clone(),
        sample_rate: project.sample_rate.max(1.0).round() as u32,
        bit_depth: 32,
        start_frame,
        end_frame,
        normalize: false,
        tail_frames: 0,
        format: "wav".to_string(),
        project_sample_rate: project.sample_rate.max(1.0),
    };

    let (job_id, job_cancel) = start_job(&app, "bounce_group", true)?;

    handle
        .export_cancel
        .store(false, std::sync::atomic::Ordering::SeqCst);
    let cancel_flag = std::sync::Arc::clone(&job_cancel);
    let app_for_progress = app.clone();
    let job_id_for_progress = job_id.clone();
    let bounce_res = tauri::async_runtime::spawn_blocking(move || {
        let mut bouncer = OfflineBouncer::new(cfg);
        bouncer.cancel_flag = cancel_flag;
        let mut bounce_project = bounce_project;
        let mut local_pool = local_pool;
        bouncer.bounce(&mut bounce_project, &mut local_pool, None, move |progress| {
            let _ = set_job_progress(
                &app_for_progress,
                &job_id_for_progress,
                (progress * 100.0).clamp(0.0, 100.0),
                "Rendering",
            );
        })
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
        &project_state,
        &clip_pool_state,
        &handle,
        &app,
        &output_path,
        &format!("{} Bounce", group_track.name),
        start_frame,
        &format!("{} Bounce", group_track.name),
    );
    if let Err(err) = &place_result {
        let _ = finish_job(&app, &job_id, false, false, Some(err.clone()));
    }
    place_result?;
    let _ = finish_job(&app, &job_id, true, false, None);
    Ok(())
}

/// Split a track into 4 stems (drums, bass, other, vocals) and place each stem on a new track.
#[tauri::command]
async fn split_track_to_stems_cmd(
    payload: SplitTrackToStemsPayload,
    app: tauri::AppHandle,
    project_state: tauri::State<'_, ProjectState>,
    clip_pool_state: tauri::State<'_, ClipPoolState>,
    handle: tauri::State<'_, AudioEngineHandle>,
) -> Result<(), String> {
    let project = project_state.project.lock().map_err(|e| e.to_string())?.clone();
    let track_uuid = Uuid::parse_str(&payload.track_id)
        .map_err(|e| format!("Invalid track ID: {e}"))?;
    let source_index = project
        .tracks
        .iter()
        .position(|t| t.id == track_uuid)
        .ok_or_else(|| "Track not found".to_string())?;
    let source_track = &project.tracks[source_index];

    let mut included_ids: std::collections::HashSet<Uuid> = std::collections::HashSet::new();
    included_ids.insert(source_track.id);
    if source_track.track_type == TrackType::Group {
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
        return Err("Track has no content to split into stems".to_string());
    }

    let mut bounce_project = project.clone();
    for track in &mut bounce_project.tracks {
        if !included_ids.contains(&track.id) {
            track.clips.clear();
            track.midi_clips.clear();
        }
    }

    let local_pool = build_local_pool_for_project(&bounce_project, &clip_pool_state)?;
    let source_mix_path = make_bounce_output_path("stems_source")?;
    let cfg = BounceConfig {
        output_path: source_mix_path.clone(),
        sample_rate: project.sample_rate.max(1.0).round() as u32,
        bit_depth: 32,
        start_frame,
        end_frame,
        normalize: false,
        tail_frames: 0,
        format: "wav".to_string(),
        project_sample_rate: project.sample_rate.max(1.0),
    };

    let (job_id, job_cancel) = start_job(&app, "split_to_stems", true)?;
    let _ = app.emit(
        "bounce_progress",
        serde_json::json!({ "jobId": &job_id, "progress": 5.0, "phase": "Preparing stem split" }),
    );
    let _ = set_job_progress(&app, &job_id, 5.0, "Preparing stem split");

    handle
        .export_cancel
        .store(false, std::sync::atomic::Ordering::SeqCst);
    let cancel_flag = std::sync::Arc::clone(&job_cancel);
    let app_for_progress = app.clone();
    let job_id_for_progress = job_id.clone();
    let bounce_res = tauri::async_runtime::spawn_blocking(move || {
        let mut bouncer = OfflineBouncer::new(cfg);
        bouncer.cancel_flag = cancel_flag;
        let mut bounce_project = bounce_project;
        let mut local_pool = local_pool;
        bouncer.bounce(&mut bounce_project, &mut local_pool, None, move |progress| {
            let p = (progress * 45.0).clamp(0.0, 45.0);
            let _ = set_job_progress(&app_for_progress, &job_id_for_progress, p, "Rendering source mix");
        })
        .map_err(|e| e.to_string())
    })
    .await
    .map_err(|e| format!("Stem bounce worker failed: {e}"))?;

    if let Err(e) = bounce_res {
        let cancelled = job_cancel.load(std::sync::atomic::Ordering::SeqCst);
        let _ = finish_job(&app, &job_id, false, cancelled, Some(e.clone()));
        return Err(e);
    }

    let _ = app.emit(
        "bounce_progress",
        serde_json::json!({ "jobId": &job_id, "progress": 45.0, "phase": "Separating stems (AI)" }),
    );
    let _ = set_job_progress(&app, &job_id, 45.0, "Separating stems (AI)");

    let source_mix_path_for_stems = source_mix_path.clone();
    let stem_files = tauri::async_runtime::spawn_blocking(move || {
        get_cached_or_build_stems(PathBuf::from(&source_mix_path_for_stems).as_path())
    })
    .await
    .map_err(|e| format!("Stem separation worker failed: {e}"))?
    .map_err(|e| {
        let _ = finish_job(&app, &job_id, false, false, Some(e.clone()));
        e
    })?;

    if job_cancel.load(std::sync::atomic::Ordering::SeqCst) {
        let _ = finish_job(
            &app,
            &job_id,
            false,
            true,
            Some("Stem split cancelled".to_string()),
        );
        return Err("Stem split cancelled".to_string());
    }

    let order = ["drums", "bass", "other", "vocals"];
    let mut stem_tracks: Vec<(String, String)> = Vec::new();
    for stem in order {
        if let Some(path) = stem_files.get(stem) {
            let label = match stem {
                "drums" => "Drums",
                "bass" => "Bass",
                "other" => "Other",
                "vocals" => "Vocals",
                _ => stem,
            };
            stem_tracks.push((
                path.clone(),
                format!("{} {}", source_track.name, label),
            ));
        }
    }

    let result = place_stem_files_on_new_tracks(
        &project_state,
        &clip_pool_state,
        &handle,
        &app,
        &stem_tracks,
        start_frame,
    );

    if result.is_ok() {
        if job_cancel.load(std::sync::atomic::Ordering::SeqCst) {
            let _ = finish_job(
                &app,
                &job_id,
                false,
                true,
                Some("Stem split cancelled".to_string()),
            );
            return Err("Stem split cancelled".to_string());
        }
        let _ = set_job_progress(&app, &job_id, 100.0, "Stem split complete");
        let _ = app.emit(
            "bounce_progress",
            serde_json::json!({ "jobId": &job_id, "progress": 100.0, "phase": "Stem split complete" }),
        );
        let _ = finish_job(&app, &job_id, true, false, None);
    } else if let Err(err) = &result {
        let _ = finish_job(&app, &job_id, false, false, Some(err.clone()));
    }

    result
}
