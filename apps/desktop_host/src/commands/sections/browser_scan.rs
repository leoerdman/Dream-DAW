// ═══════════════════════════════════════════════════════════════════════

/// A single audio file entry returned by the browser scan.
#[derive(Debug, Clone, Serialize, Deserialize)]
struct AudioFileEntry {
    name: String,
    path: String,
    size_bytes: u64,
    modified_at: String,
    format: String,
    duration_seconds: Option<f64>,
}

/// Audio extensions recognized by the file browser (case-insensitive).
/// These must cover every extension that `AudioReader::read()` can decode
/// (symphonia v0.5 with features=["all"]) plus common aliases.
const AUDIO_EXTENSIONS: &[&str] = &[
    "wav", "wave",
    "aiff", "aif", "aifc",
    "mp3",
    "m4a", "mp4", "aac",
    "flac",
    "ogg", "oga", "opus",
    "caf",
    "wma",
    "webm",
];

/// Plugin bundle extensions recognized by the browser.
const PLUGIN_EXTENSIONS: &[&str] = &[
    "vst", "vst3", "component", "au", "clap", "aaxplugin",
];

/// Project file extensions recognized by the browser.
const PROJECT_EXTENSIONS: &[&str] = &[
    "ddpj", "als", "flp", "logic", "ptx", "rpp",
];

/// Preset file extensions recognized by the browser.
const PRESET_EXTENSIONS: &[&str] = &[
    "fxp", "fxb", "vstpreset", "aupreset",
];

/// Generates a set of demo WAV samples in the Samples folder so the browser
/// has real draggable audio files from the very first launch.
#[tauri::command]
fn generate_demo_samples_cmd(
    app: tauri::AppHandle,
) -> Result<u32, String> {
    // Resolve samples path (also creates the directory)
    let samples_path = get_samples_path(app)?;
    let dir = std::path::Path::new(&samples_path);

    // Only generate if the folder is empty or doesn't have our marker
    let marker = dir.join(".dream_demo_generated");
    if marker.exists() {
        log::info!("[DemoSamples] Marker exists, skipping generation");
        return Ok(0);
    }

    const SR: u32 = 44100;
    let mut count: u32 = 0;

    // Helper functions for synthesis
    fn gen_sine(sr: u32, freq: f32, dur: f32, amp: f32) -> Vec<f32> {
        let n = (sr as f32 * dur) as usize;
        (0..n).map(|i| {
            let t = i as f32 / sr as f32;
            let env = if t < 0.005 { t / 0.005 }
                      else if t > dur - 0.01 { (dur - t) / 0.01 }
                      else { 1.0 };
            (t * freq * std::f32::consts::TAU).sin() * amp * env.clamp(0.0, 1.0)
        }).collect()
    }

    fn gen_noise_burst(sr: u32, dur: f32, amp: f32) -> Vec<f32> {
        let n = (sr as f32 * dur) as usize;
        let mut rng: u64 = 0xDEAD_BEEF;
        (0..n).map(|i| {
            rng = rng.wrapping_mul(6364136223846793005).wrapping_add(1);
            let noise = ((rng >> 33) as f32 / (u32::MAX >> 1) as f32) * 2.0 - 1.0;
            let t = i as f32 / sr as f32;
            let env = (-t * 20.0).exp();
            noise * amp * env
        }).collect()
    }

    fn gen_kick(sr: u32, amp: f32) -> Vec<f32> {
        let dur: f32 = 0.35;
        let n = (sr as f32 * dur) as usize;
        (0..n).map(|i| {
            let t = i as f32 / sr as f32;
            let freq = 150.0 * (-t * 8.0).exp() + 40.0;
            let env = (-t * 6.0).exp();
            (t * freq * std::f32::consts::TAU).sin() * amp * env
        }).collect()
    }

    // Generate all demo samples eagerly
    let demos: Vec<(&str, Vec<f32>)> = vec![
        ("Kick_808_Deep", gen_kick(SR, 0.85)),
        ("Kick_Acoustic", gen_kick(SR, 0.7)),
        ("Snare_Tight", {
            let body = gen_sine(SR, 200.0, 0.15, 0.5);
            let noise = gen_noise_burst(SR, 0.15, 0.6);
            body.iter().zip(noise.iter()).map(|(a, b)| a + b).collect()
        }),
        ("HiHat_Closed", gen_noise_burst(SR, 0.06, 0.4)),
        ("HiHat_Open", gen_noise_burst(SR, 0.25, 0.35)),
        ("Clap_Vinyl", {
            let mut out = Vec::new();
            for _ in 0..3 {
                out.extend(gen_noise_burst(SR, 0.01, 0.5).iter());
                out.extend(vec![0.0; 220]);
            }
            out.extend(gen_noise_burst(SR, 0.12, 0.6).iter());
            out
        }),
        ("Bass_Sub", gen_sine(SR, 55.0, 1.0, 0.7)),
        ("Pad_Ambient_Dm", {
            let dur: f32 = 2.0;
            let n = (SR as f32 * dur) as usize;
            (0..n).map(|i| {
                let t = i as f32 / SR as f32;
                let env = if t < 0.2 { t / 0.2 } else if t > dur - 0.3 { (dur - t) / 0.3 } else { 1.0 };
                let s1 = (t * 293.66 * std::f32::consts::TAU).sin();
                let s2 = (t * 349.23 * std::f32::consts::TAU).sin();
                let s3 = (t * 440.0 * std::f32::consts::TAU).sin();
                (s1 + s2 * 0.7 + s3 * 0.5) * 0.2 * env.clamp(0.0, 1.0)
            }).collect()
        }),
    ];

    for (name, samples) in &demos {
        let path = dir.join(format!("{}.wav", name));
        if path.exists() { continue; }
        if let Err(e) = WavWriter::write_interleaved(&path, samples, SR, 1, 24) {
            log::warn!("[DemoSamples] Failed to write {}: {}", name, e);
            continue;
        }
        count += 1;
    }

    // Write marker file
    let _ = std::fs::write(&marker, "generated");
    log::info!("[DemoSamples] Generated {} demo samples in {}", count, samples_path);
    Ok(count)
}

/// Preview (audition) an audio file through system audio output.
/// Decodes the file and sends it to a one-shot playback thread.
#[tauri::command]
async fn preview_audio_file_cmd(
    path: String,
    handle: tauri::State<'_, AudioEngineHandle>,
) -> Result<(), String> {
    let file_path = std::path::PathBuf::from(&path);
    if !file_path.exists() {
        return Err(format!("File not found: {}", path));
    }

    // Decode the audio file
    let decoded = AudioReader::read(&file_path)
        .map_err(|e| format!("Failed to decode: {e}"))?;
    if decoded.channels.is_empty() {
        return Err(format!("Decoded audio has no channels: {}", path));
    }

    // Build interleaved buffer for preview
    let num_ch = decoded.channels.len().min(2);
    let num_frames = decoded.num_frames;
    let mut interleaved = vec![0.0f32; num_frames * 2]; // always stereo output

    for frame in 0..num_frames {
        let l = decoded.channels[0][frame];
        let r = if num_ch > 1 { decoded.channels[1][frame] } else { l };
        interleaved[frame * 2] = l;
        interleaved[frame * 2 + 1] = r;
    }

    // Store preview buffer in engine for mixing into output.
    // SSOT-FIX: Pass source SR so the RT callback advances the cursor
    // at (source_sr / device_sr) to preserve original pitch.
    handle.set_preview_buffer(interleaved, decoded.sample_rate);

    log::info!("[Preview] Playing '{}' ({} frames, {}Hz)", 
        file_path.file_name().unwrap_or_default().to_string_lossy(),
        num_frames, decoded.sample_rate);
    Ok(())
}

/// Stop any active audio preview.
#[tauri::command]
async fn stop_preview_cmd(
    handle: tauri::State<'_, AudioEngineHandle>,
) -> Result<(), String> {
    handle.clear_preview_buffer();
    log::info!("[Preview] Stopped");
    Ok(())
}

/// Returns exact audio file duration in seconds.
#[tauri::command]
fn get_audio_file_duration(path: String) -> Result<f64, String> {
    let file_path = std::path::PathBuf::from(&path);
    if !file_path.exists() {
        return Err(format!("File not found: {}", path));
    }

    if let Ok((sample_rate, _channels, num_frames)) = AudioReader::read_metadata(&file_path)
        && let Some(frames) = num_frames
        && sample_rate > 0
    {
        return Ok(frames as f64 / sample_rate as f64);
    }

    let decoded = AudioReader::read(&file_path)
        .map_err(|e| format!("Failed to decode '{}': {}", path, e))?;
    Ok(decoded.duration_seconds())
}

/// Recursively scans the given directory for audio files.
#[tauri::command]
fn scan_audio_folder(path: String) -> Result<Vec<AudioFileEntry>, String> {
    log::info!("[IPC] scan_audio_folder: {}", path);
    let root = std::path::Path::new(&path);
    if !root.exists() {
        return Err(format!("Folder does not exist: {}", path));
    }
    if !root.is_dir() {
        return Err(format!("Path is not a directory: {}", path));
    }

    let mut entries = Vec::new();
    let mut file_count: usize = 0;
    scan_directory_recursive(root, &mut entries, 0, 8, &mut file_count, MAX_SCAN_FILES)?; // max depth 8
    entries.sort_by(|a, b| a.name.to_lowercase().cmp(&b.name.to_lowercase()));
    Ok(entries)
}

/// Scans ALL audio sources: the configured samples_path + every user browser_folder.
/// Returns a deduplicated, alphabetically sorted list of audio files.
/// Caps at MAX_SCAN_FILES to prevent UI freeze on massive libraries.
/// This powers the unified "All" category in the browser sidebar.
const MAX_SCAN_FILES: usize = 50_000;

#[tauri::command]
fn scan_all_audio_sources(
    app: tauri::AppHandle,
    settings_state: tauri::State<'_, SettingsState>,
) -> Result<Vec<AudioFileEntry>, String> {
    let samples_path = get_samples_path(app)?;
    let browser_folders = {
        let settings = settings_state.settings.lock().map_err(|e| e.to_string())?;
        settings.browser_folders.clone()
    };

    let mut all_entries: Vec<AudioFileEntry> = Vec::new();
    let mut seen_paths = std::collections::HashSet::new();
    let mut file_count: usize = 0;
    let mut scan_errors: Vec<String> = Vec::new();

    // Scan samples_path
    let samples_dir = std::path::Path::new(&samples_path);
    if samples_dir.is_dir() {
        if let Err(err) = scan_directory_recursive(
            samples_dir,
            &mut all_entries,
            0,
            8,
            &mut file_count,
            MAX_SCAN_FILES,
        ) {
            log::warn!("[IPC] scan_all_audio_sources: failed to scan samples path '{}': {}", samples_path, err);
            scan_errors.push(format!("samples: {}", err));
        }
    }

    // Scan each browser folder
    for folder in &browser_folders {
        if file_count >= MAX_SCAN_FILES {
            break;
        }
        let dir = std::path::Path::new(folder);
        if dir.is_dir() {
            if let Err(err) = scan_directory_recursive(
                dir,
                &mut all_entries,
                0,
                8,
                &mut file_count,
                MAX_SCAN_FILES,
            ) {
                log::warn!("[IPC] scan_all_audio_sources: failed to scan browser folder '{}': {}", folder, err);
                scan_errors.push(format!("{}: {}", folder, err));
            }
        }
    }

    // Deduplicate by absolute path
    all_entries.retain(|e| seen_paths.insert(e.path.clone()));

    // Sorting deferred to frontend for instant response

    log::info!(
        "[IPC] scan_all_audio_sources: {} files from {} sources (cap: {})",
        all_entries.len(),
        1 + browser_folders.len(),
        MAX_SCAN_FILES
    );
    if all_entries.is_empty() && !scan_errors.is_empty() {
        return Err(format!(
            "Failed to scan audio sources ({} errors). First error: {}",
            scan_errors.len(),
            scan_errors[0]
        ));
    }
    Ok(all_entries)
}

/// Recursive directory walker for audio files.
/// Stops when `file_count` reaches `max_files` to prevent scanning massive libraries.
fn scan_directory_recursive(
    dir: &std::path::Path,
    entries: &mut Vec<AudioFileEntry>,
    depth: u32,
    max_depth: u32,
    file_count: &mut usize,
    max_files: usize,
) -> Result<(), String> {
    if depth > max_depth || *file_count >= max_files {
        return Ok(());
    }

    let read_dir = std::fs::read_dir(dir).map_err(|e| format!("Cannot read {}: {}", dir.display(), e))?;

    for entry in read_dir.flatten() {
        if *file_count >= max_files {
            break;
        }

        let path = entry.path();

        // Skip hidden files/directories
        if entry.file_name().to_str().is_some_and(|n| n.starts_with('.')) {
            continue;
        }

        if path.is_dir() {
            scan_directory_recursive(&path, entries, depth + 1, max_depth, file_count, max_files)?;
        } else if let Some(ext) = path.extension().and_then(|e| e.to_str())
            && AUDIO_EXTENSIONS.contains(&ext.to_lowercase().as_str())
        {
            let metadata = std::fs::metadata(&path).ok();
            let size_bytes = metadata.as_ref().map_or(0, |m| m.len());
            let modified_at = metadata
                .and_then(|m| m.modified().ok())
                .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
                .map(|d| d.as_secs().to_string())
                .unwrap_or_default();

            entries.push(AudioFileEntry {
                name: entry.file_name().to_string_lossy().to_string(),
                path: path.to_string_lossy().to_string(),
                size_bytes,
                modified_at,
                // ENT-B1: Normalize AIF → AIFF for consistent display.
                format: {
                    let upper = ext.to_uppercase();
                    if upper == "AIF" { "AIFF".to_string() } else { upper }
                },
                // Duration loaded on-demand when user selects a file.
                // Removing per-file AudioReader::read_metadata() eliminates
                // the #1 scan bottleneck (codec init × N files).
                duration_seconds: None,
            });
            *file_count += 1;
        }
    }

    Ok(())
}
