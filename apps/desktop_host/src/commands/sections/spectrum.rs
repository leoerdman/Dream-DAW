// ═══════════════════════════════════════════════════════════════════════
// Spectrum Analyzer — Real-time FFT data for EQ display
// ═══════════════════════════════════════════════════════════════════════

#[tauri::command]
fn get_spectrum_data(
    state: tauri::State<'_, SpectrumState>,
) -> Result<Vec<f32>, String> {
    let mut inner = state.inner.lock().map_err(|_| "Application state error. Please restart Dream DAW.".to_string())?;

    // Drain all available samples from the ring buffer consumer
    let mut drained = 0usize;
    while let Ok(sample) = inner.consumer.pop() {
        inner.analyzer.push(&[sample]);
        drained += 1;
    }

    if drained == 0 {
        // ENTERPRISE: Return a clone of the cached magnitudes so the cache
        // is preserved for subsequent polls. Previously used `mem::take`
        // which emptied the cache, causing the spectrum to flicker off
        // every other frame when no new audio data was available.
        return Ok(inner.last_magnitudes.clone());
    }

    // Compute FFT and return magnitudes
    if let Some(data) = inner.analyzer.compute() {
        inner.last_magnitudes.clear();
        inner.last_magnitudes.extend_from_slice(&data.magnitudes);
    }
    Ok(inner.last_magnitudes.clone())
}

/// Per-track spectrum data for EQ display.
/// Returns FFT magnitudes for the specified track's post-FX audio.
#[tauri::command]
fn get_spectrum_data_for_track(
    track_index: usize,
    state: tauri::State<'_, SpectrumState>,
) -> Result<Vec<f32>, String> {
    let track_lock = state.tracks.get(track_index).ok_or_else(|| {
        format!("Track index {} out of range (max {})", track_index, state.tracks.len())
    })?;

    let mut inner = track_lock.lock().map_err(|_| "Application state error. Please restart Dream DAW.".to_string())?;

    // Drain all available samples from the per-track ring buffer consumer
    let mut drained = 0usize;
    while let Ok(sample) = inner.consumer.pop() {
        inner.analyzer.push(&[sample]);
        drained += 1;
    }

    if drained == 0 {
        return Ok(inner.last_magnitudes.clone());
    }

    if let Some(data) = inner.analyzer.compute() {
        inner.last_magnitudes.clear();
        inner.last_magnitudes.extend_from_slice(&data.magnitudes);
    }
    Ok(inner.last_magnitudes.clone())
}
