// ═══════════════════════════════════════════════════════════════════════

/// Closes the splash screen and instantly shows the perfectly maximized DAW window.
///
/// Called from React when the headless initialization (AppStartupManager) is complete.
#[tauri::command]
fn close_splashscreen(app: tauri::AppHandle) -> Result<(), String> {
    let splash_window = app.get_webview_window("splashscreen");

    let main_window = app
        .get_webview_window("main")
        .ok_or("Main window not found")?;

    // Enable resizing & decorations
    if let Err(e) = main_window.set_decorations(true) {
        log::warn!("[Splash] set_decorations failed: {e}");
    }
    if let Err(e) = main_window.set_resizable(true) {
        log::warn!("[Splash] set_resizable failed: {e}");
    }

    let min_size = tauri::LogicalSize::new(900.0_f64, 600.0_f64);
    if let Err(e) = main_window.set_min_size(Some(min_size)) {
        log::warn!("[Splash] set_min_size failed: {e}");
    }

    // Snap window bounds to primary monitor to avoid macOS zoom animation.
    if let Ok(Some(monitor)) = main_window.primary_monitor() {
        let size = monitor.size();
        let pos = monitor.position();
        let _ = main_window.set_size(*size);
        let _ = main_window.set_position(*pos);
    }

    // Show, focus, and maximize — all non-fatal.
    if let Err(e) = main_window.show() {
        log::warn!("[Splash] show failed: {e}");
    }
    if let Err(e) = main_window.set_focus() {
        log::warn!("[Splash] set_focus failed: {e}");
    }
    if let Err(e) = main_window.maximize() {
        log::warn!("[Splash] maximize failed: {e}");
    }

    // Close splash ALWAYS — never skip this.
    if let Some(splash_window) = splash_window {
        if let Err(err) = splash_window.close() {
            log::warn!("[Splash] failed to close splash window: {}", err);
        }
    }

    log::info!("[Splash] Closed splash screen, showed DAW main window");
    Ok(())
}
