// ═══════════════════════════════════════════════════════════════════════

fn mono_from_channels(channels: &[Vec<f32>]) -> Vec<f32> {
    let left = channels.first().map(|c| c.as_slice()).unwrap_or(&[]);
    let right = channels.get(1).map(|c| c.as_slice()).unwrap_or(left);
    if left.is_empty() {
        return Vec::new();
    }
    if std::ptr::eq(left, right) {
        return left.to_vec();
    }
    left.iter()
        .zip(right.iter())
        .map(|(l, r)| (l + r) * 0.5)
        .collect()
}

fn load_or_generate_peaks_from_cache_or_source(
    file_path: &str,
    clip_pool_state: &ClipPoolState,
) -> Result<WaveformPeaks, String> {
    let source_path = PathBuf::from(file_path);

    if let Ok(peaks) = PeakCache::load_from_sidecar(&source_path) {
        return Ok(peaks);
    }

    let pool_audio = {
        let pool = clip_pool_state.pool.lock().map_err(|e| e.to_string())?;
        pool.get(file_path)
    };
    if let Some(audio) = pool_audio {
        let mono = if audio.channels.len() <= 1 {
            audio.left().to_vec()
        } else {
            audio.left()
                .iter()
                .zip(audio.right().iter())
                .map(|(l, r)| (l + r) * 0.5)
                .collect()
        };
        return PeakCache::generate_to_sidecar(&mono, &source_path, audio.sample_rate)
            .map_err(|e| format!("failed to generate peak cache for '{}': {e}", source_path.display()));
    }

    // Last-resort fallback for first-open cases: decode directly from source.
    let decoded = AudioReader::read(&source_path)
        .map_err(|e| format!("failed to decode audio for peaks '{}': {e}", source_path.display()))?;
    let mono = mono_from_channels(&decoded.channels);
    PeakCache::generate_to_sidecar(&mono, &source_path, decoded.sample_rate)
        .map_err(|e| format!("failed to generate peak cache for '{}': {e}", source_path.display()))
}

/// Returns multi-resolution waveform peak data for a given audio file.
///
/// Peak data is generated from the decoded audio in the ClipPool.
/// The frontend uses this to draw high-performance canvas waveforms.
/// Returns 4 mip levels (256/1K/4K/16K samples-per-peak) for the
/// renderer to pick from based on the current zoom level.
#[tauri::command]
async fn get_waveform_peaks(
    file_path: String,
    clip_pool_state: tauri::State<'_, ClipPoolState>,
) -> Result<WaveformPeaks, String> {
    let peaks = load_or_generate_peaks_from_cache_or_source(&file_path, &clip_pool_state)?;

    log::info!(
        "[IPC] get_waveform_peaks: '{}' → {} samples, {} mip levels",
        file_path,
        peaks.total_samples,
        peaks.mip_levels.len(),
    );

    Ok(peaks)
}

// ── Binary-optimized waveform response ─────────────────────────────────

/// Response for the binary-optimized waveform peaks command.
///
/// Instead of serializing each `PeakPair` as `{"min": f32, "max": f32}`,
/// this packs all peaks into a flat `[min, max, min, max, ...]` f32 buffer
/// encoded as base64. This reduces payload size by ~80% compared to JSON:
///   - JSON: ~24 bytes per PeakPair (`{"min":-0.123,"max":0.456}`)
///   - Binary: 8 bytes per PeakPair (2 × f32), ~11 bytes after base64
///
/// For a 10-minute stereo file at 44.1kHz:
///   - Mip 0 (256 spp): ~10,300 peaks → JSON: ~250KB vs Binary: ~115KB
///   - All 4 mips total: JSON: ~270KB vs Binary: ~125KB
#[derive(Debug, Clone, Serialize)]
struct WaveformPeaksBinaryResponse {
    /// Source file identifier.
    source_id: String,
    /// Sample rate of the source audio.
    sample_rate: u32,
    /// Total number of samples in the source.
    total_samples: usize,
    /// Metadata for each mip level (samples_per_peak, peak_count, byte_offset).
    mip_levels: Vec<MipLevelMeta>,
    /// All peaks flattened as [min0, max0, min1, max1, ...] encoded as base64.
    /// Uses little-endian f32 byte representation.
    peaks_base64: String,
}

#[derive(Debug, Clone, Serialize)]
struct MipLevelMeta {
    samples_per_peak: usize,
    peak_count: usize,
    /// Float offset into the decoded f32 array (NOT byte offset).
    /// Each peak is 2 floats [min, max], so peak N starts at offset + N*2.
    float_offset: usize,
}

/// Returns waveform peaks as a binary-optimized base64 payload.
///
/// Drop-in replacement for `get_waveform_peaks` with ~80% smaller payload.
/// The frontend decodes base64 → ArrayBuffer → Float32Array and
/// slices by mip level using the provided offsets.
#[tauri::command]
async fn get_waveform_peaks_binary(
    file_path: String,
    clip_pool_state: tauri::State<'_, ClipPoolState>,
) -> Result<WaveformPeaksBinaryResponse, String> {
    use base64::{Engine as _, engine::general_purpose::STANDARD};
    let peaks = load_or_generate_peaks_from_cache_or_source(&file_path, &clip_pool_state)?;

    // Flatten all mip levels into a single f32 buffer: [min, max, min, max, ...]
    let mut flat_floats: Vec<f32> = Vec::new();
    let mut mip_metas: Vec<MipLevelMeta> = Vec::new();

    for level in &peaks.mip_levels {
        let float_offset = flat_floats.len();
        for pair in &level.peaks {
            flat_floats.push(pair.min);
            flat_floats.push(pair.max);
        }
        mip_metas.push(MipLevelMeta {
            samples_per_peak: level.samples_per_peak,
            peak_count: level.peaks.len(),
            float_offset,
        });
    }

    // Convert f32 slice to bytes (little-endian, native on x86/ARM)
    let bytes: &[u8] = unsafe {
        std::slice::from_raw_parts(
            flat_floats.as_ptr() as *const u8,
            flat_floats.len() * std::mem::size_of::<f32>(),
        )
    };

    let encoded = STANDARD.encode(bytes);

    log::info!(
        "[IPC] get_waveform_peaks_binary: '{}' → {} samples, {} floats, {} bytes base64",
        file_path,
        peaks.total_samples,
        flat_floats.len(),
        encoded.len(),
    );

    Ok(WaveformPeaksBinaryResponse {
        source_id: peaks.source_id,
        sample_rate: peaks.sample_rate,
        total_samples: peaks.total_samples,
        mip_levels: mip_metas,
        peaks_base64: encoded,
    })
}

/// Returns one waveform LOD level as raw bytes (`Vec<u8>`) containing
/// contiguous `WaveformPeakPair` items (`min`, `max` as `f32`).
///
/// This is the zero-copy IPC payload for heavy timeline waveform drawing:
/// frontend can consume it directly as `Float32Array`/`DataView`.
#[tauri::command]
async fn get_waveform_peaks_lod_binary(
    file_path: String,
    lod_level: usize,
    clip_pool_state: tauri::State<'_, ClipPoolState>,
) -> Result<Vec<u8>, String> {
    let source_path = PathBuf::from(&file_path);
    let bytes = match PeakCache::lod_level_bytes_from_sidecar(&source_path, lod_level) {
        Ok(bytes) => bytes,
        Err(_) => {
            let peaks = load_or_generate_peaks_from_cache_or_source(&file_path, &clip_pool_state)?;
            PeakCache::lod_level_bytes(&peaks, lod_level)
        }
    };
     log::info!(
         "[IPC] get_waveform_peaks_lod_binary: '{}' lod={} -> {} bytes",
         file_path,
         lod_level,
         bytes.len(),
     );
     Ok(bytes)
 }

// ── Enterprise contract: get_peaks(clip_id, lod) ──────────────────────
//
// Resolves clip_id → file_path via ProjectState, then returns LOD-binary
// peak data. This is the canonical peaks API for the timeline renderer:
// it decouples the frontend from file paths and keeps routing through
// the normalised project model.
//
// lod_level semantics (inherited from PeakCache::lod_level_bytes):
//   0 = highest resolution (one pair per frame at native sample rate)
//   1 = 2× downsampled
//   2 = 4× downsampled  (default for timeline at 1x zoom)
//   3 = 8× downsampled  (overview/navigator)
#[tauri::command]
pub async fn get_peaks_by_clip_id(
    clip_id: String,
    lod_level: usize,
    project_state: tauri::State<'_, ProjectState>,
    clip_pool_state: tauri::State<'_, ClipPoolState>,
) -> Result<Vec<u8>, String> {
    let clip_uuid = Uuid::parse_str(&clip_id)
        .map_err(|e| format!("Invalid clip_id: {e}"))?;

    // Resolve clip_id → file_path via project model.
    let file_path = {
        let project = project_state.project.lock().map_err(|e| e.to_string())?;
        project
            .tracks
            .iter()
            .flat_map(|t| t.clips.iter())
            .find(|c| c.id == clip_uuid)
            .map(|c| c.file_path.clone())
            .ok_or_else(|| format!("Clip not found: {clip_id}"))?
    };

    let source_path = PathBuf::from(&file_path);
    let bytes = match PeakCache::lod_level_bytes_from_sidecar(&source_path, lod_level) {
        Ok(bytes) => bytes,
        Err(_) => {
            let peaks = load_or_generate_peaks_from_cache_or_source(&file_path, &clip_pool_state)?;
            PeakCache::lod_level_bytes(&peaks, lod_level)
        }
    };
    log::info!(
        "[IPC] get_peaks_by_clip_id: clip={} lod={} file='{}' -> {} bytes",
        clip_id,
        lod_level,
        file_path,
        bytes.len(),
    );
    Ok(bytes)
}

#[tauri::command]
pub async fn get_peaks(
    clip_id: String,
    lod_level: usize,
    project_state: tauri::State<'_, ProjectState>,
    clip_pool_state: tauri::State<'_, ClipPoolState>,
) -> Result<Vec<u8>, String> {
    get_peaks_by_clip_id(clip_id, lod_level, project_state, clip_pool_state).await
}
