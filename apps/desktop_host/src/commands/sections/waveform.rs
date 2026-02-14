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

