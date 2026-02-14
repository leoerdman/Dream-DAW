// ═══════════════════════════════════════════════════════════════════════

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
    let pool = clip_pool_state.pool.lock().map_err(|e| e.to_string())?;

    let audio = pool
        .get(&file_path)
        .ok_or_else(|| format!("Audio not loaded: {file_path}"))?;

    // Convert stereo to mono for peak generation (average L+R)
    let left = audio.left();
    let right = audio.right();
    let mono: Vec<f32> = if right.is_empty() {
        left.to_vec()
    } else {
        left.iter()
            .zip(right.iter())
            .map(|(l, r)| (l + r) * 0.5)
            .collect()
    };

    let peaks = PeakCache::generate(&mono, &file_path, audio.sample_rate);

    log::info!(
        "[IPC] get_waveform_peaks: '{}' → {} samples, 4 mip levels",
        file_path,
        mono.len(),
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

    let pool = clip_pool_state.pool.lock().map_err(|e| e.to_string())?;

    let audio = pool
        .get(&file_path)
        .ok_or_else(|| format!("Audio not loaded: {file_path}"))?;

    let left = audio.left();
    let right = audio.right();
    let mono: Vec<f32> = if right.is_empty() {
        left.to_vec()
    } else {
        left.iter()
            .zip(right.iter())
            .map(|(l, r)| (l + r) * 0.5)
            .collect()
    };

    let peaks = PeakCache::generate(&mono, &file_path, audio.sample_rate);

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
        mono.len(),
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

