// ═══════════════════════════════════════════════════════════════════════

/// Configures the main window for DAW mode by adding decorations and enabling resizing.
///
/// Called from React at app startup.
/// Window already starts at 1400×900, this just adds the title bar and makes it resizable.
///
/// Transitions:
///   1400×900 borderless → 1400×900 with decorations + resizable + fullscreen button
#[tauri::command]
fn expand_window(app: tauri::AppHandle) -> Result<(), String> {
    let window = app
        .get_webview_window("main")
        .ok_or("Main window not found")?;

    // ── Phase 1: Reconfigure window for DAW mode ──
    // Enable decorations (title bar with traffic lights: red/yellow/GREEN fullscreen)
    window
        .set_decorations(true)
        .map_err(|e| format!("Failed to set decorations: {e}"))?;

    // Enable resizing (required for green fullscreen button to work on macOS)
    window
        .set_resizable(true)
        .map_err(|e| format!("Failed to set resizable: {e}"))?;

    // Minimum size so the DAW doesn't get too small
    let min_size = tauri::LogicalSize::new(900.0_f64, 600.0_f64);
    window
        .set_min_size(Some(min_size))
        .map_err(|e| format!("Failed to set min size: {e}"))?;

    // Focus the window so it's the frontmost app
    window
        .set_focus()
        .map_err(|e| format!("Failed to focus window: {e}"))?;

    log::info!("[Splash] Window configured for DAW mode");
    Ok(())
}

/// Maximizes the main window to fill the screen.
#[tauri::command]
fn maximize_window(app: tauri::AppHandle) -> Result<(), String> {
    let window = app
        .get_webview_window("main")
        .ok_or("Main window not found")?;

    window
        .maximize()
        .map_err(|e| format!("Failed to maximize: {e}"))?;

    log::info!("[Splash] Window maximized");
    Ok(())
}
