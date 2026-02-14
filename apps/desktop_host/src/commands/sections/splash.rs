use super::*;

// ═══════════════════════════════════════════════════════════════════════

/// Expands the main window from splash mode (500×500) to full DAW mode.
///
/// Called from the React splash screen after the loading animation completes.
/// This provides the native "small window → big window" UX identical to
/// the original Swift implementation.
///
/// Transitions:
///   500×500 borderless → maximized with decorations + resizable + fullscreen button
#[tauri::command]
fn expand_window(app: tauri::AppHandle) -> Result<(), String> {
    let window = app
        .get_webview_window("main")
        .ok_or("Main window not found")?;

    // ── Phase 1: Hide the splash window (avoids visual glitch during reconfigure) ──
    window.hide()
        .map_err(|e| format!("Failed to hide window: {e}"))?;

    // ── Phase 2: Reconfigure window for DAW mode ──
    // Enable decorations (title bar with traffic lights: red/yellow/GREEN fullscreen)
    window.set_decorations(true)
        .map_err(|e| format!("Failed to set decorations: {e}"))?;

    // Enable resizing (required for green fullscreen button to work on macOS)
    window.set_resizable(true)
        .map_err(|e| format!("Failed to set resizable: {e}"))?;

    // Minimum size so the DAW doesn't get too small
    let min_size = tauri::LogicalSize::new(900.0_f64, 600.0_f64);
    window.set_min_size(Some(min_size))
        .map_err(|e| format!("Failed to set min size: {e}"))?;

    // ── Phase 3: Maximize to fill screen (minus Dock & menu bar) ──
    window.maximize()
        .map_err(|e| format!("Failed to maximize: {e}"))?;

    // Brief delay to let macOS window manager finish compositing
    std::thread::sleep(std::time::Duration::from_millis(80));

    // ── Phase 4: Show the fully-configured DAW window ──
    window.show()
        .map_err(|e| format!("Failed to show window: {e}"))?;

    // Focus the window so it's the frontmost app
    window.set_focus()
        .map_err(|e| format!("Failed to focus window: {e}"))?;

    log::info!("[Splash] Window expanded to maximized DAW mode");
    Ok(())
}

