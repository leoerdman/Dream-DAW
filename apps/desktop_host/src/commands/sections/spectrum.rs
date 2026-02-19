// ═══════════════════════════════════════════════════════════════════════
// Spectrum Analyzer — Real-time FFT data for EQ display
// ═══════════════════════════════════════════════════════════════════════

#[tauri::command]
fn get_spectrum_data(
    state: tauri::State<'_, SpectrumState>,
) -> Result<Vec<f32>, String> {
    let mut inner = state.inner.lock().map_err(|e| e.to_string())?;

    // Drain all available samples from the ring buffer consumer
    let mut drained = 0usize;
    loop {
        match inner.consumer.pop() {
            Ok(sample) => {
                inner.analyzer.push(&[sample]);
                drained += 1;
            }
            Err(_) => break,
        }
    }

    if drained == 0 {
        // Return last known magnitudes or floor values
        return Ok(inner.last_magnitudes.clone());
    }

    // Compute FFT and return magnitudes
    if let Some(data) = inner.analyzer.compute() {
        inner.last_magnitudes = data.magnitudes.to_vec();
        Ok(inner.last_magnitudes.clone())
    } else {
        Ok(inner.last_magnitudes.clone())
    }
}
