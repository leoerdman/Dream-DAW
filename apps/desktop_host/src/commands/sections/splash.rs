// ═══════════════════════════════════════════════════════════════════════

/// Closes the splash screen and instantly shows the perfectly maximized DAW window.
///
/// Called from React when the headless initialization (AppStartupManager) is complete.
#[tauri::command]
fn close_splashscreen(app: tauri::AppHandle) -> Result<(), String> {
    // Keep splash visible until main window handoff succeeds to avoid blank-screen
    // gaps if foregrounding main fails on some OS/window managers.
    let splash_window = app.get_webview_window("splashscreen");

    // 2. Setup the main window to be instantly ready
    let main_window = app
        .get_webview_window("main")
        .ok_or("Main window not found")?;

    // Force main window to the foreground during splash handoff, then release.
    // This avoids occasional OS/window-manager Z-order races on startup.
    main_window
        .set_always_on_top(true)
        .map_err(|e| format!("Failed to elevate main window for splash handoff: {e}"))?;

    // Enable resizing & decorations (they should be true in tauri.conf but we can ensure it here if you like)
    main_window
        .set_decorations(true)
        .map_err(|e| format!("Failed to enable main window decorations: {e}"))?;
    main_window
        .set_resizable(true)
        .map_err(|e| format!("Failed to enable main window resizing: {e}"))?;

    let min_size = tauri::LogicalSize::new(900.0_f64, 600.0_f64);
    main_window
        .set_min_size(Some(min_size))
        .map_err(|e| format!("Failed to set main window min size: {e}"))?;

    // 3. To completely bypass the macOS native "zoom" animation from offscreen/hidden state,
    // we manually snap the window bounds to match the primary monitor's available work area
    // *before* making the window visible.
    if let Ok(Some(monitor)) = main_window.primary_monitor() {
        let size = monitor.size();
        let pos = monitor.position();
        main_window
            .set_size(*size)
            .map_err(|e| format!("Failed to set main window size: {e}"))?;
        main_window
            .set_position(*pos)
            .map_err(|e| format!("Failed to set main window position: {e}"))?;
    }

    // Now showing the window will be an instant painted reveal of the pre-stretched bounds.
    main_window
        .show()
        .map_err(|e| format!("Failed to show main window: {e}"))?;
    main_window
        .set_focus()
        .map_err(|e| format!("Failed to focus main window: {e}"))?;
    
    // Register the OS maximized state so native window controls (green button) sync up
    main_window
        .maximize()
        .map_err(|e| format!("Failed to maximize main window: {e}"))?;

    let main_window_for_release = main_window.clone();
    if let Err(err) = std::thread::Builder::new()
        .name("main-window-zorder-release".into())
        .spawn(move || {
            std::thread::sleep(std::time::Duration::from_millis(350));
            if let Err(err) = main_window_for_release.set_always_on_top(false) {
                log::warn!(
                    "[Splash] failed to release temporary main window always-on-top: {}",
                    err
                );
            }
        })
    {
        log::warn!(
            "[Splash] failed to spawn main-window-zorder-release thread: {}",
            err
        );
    }

    // Close splash only after main is visible/focused.
    if let Some(splash_window) = splash_window {
        if let Err(err) = splash_window.set_always_on_top(false) {
            log::warn!("[Splash] set_always_on_top(false) failed before close: {}", err);
        }
        if let Err(err) = splash_window.close() {
            log::warn!("[Splash] failed to close splash window after handoff: {}", err);
        }
    }

    log::info!("[Splash] Closed splash screen, showed DAW main window");
    Ok(())
}
