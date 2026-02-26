// ═══════════════════════════════════════════════════════════════════════

/// Closes the splash screen and instantly shows the perfectly maximized DAW window.
///
/// Called from React when the headless initialization (AppStartupManager) is complete.
#[tauri::command]
fn close_splashscreen(app: tauri::AppHandle) -> Result<(), String> {
    // 1. Close the splash screen window if it exists.
    if let Some(splash_window) = app.get_webview_window("splashscreen") {
        let _ = splash_window.close();
    }

    // 2. Setup the main window to be instantly ready
    let main_window = app
        .get_webview_window("main")
        .ok_or("Main window not found")?;

    // Enable resizing & decorations (they should be true in tauri.conf but we can ensure it here if you like)
    let _ = main_window.set_decorations(true);
    let _ = main_window.set_resizable(true);

    let min_size = tauri::LogicalSize::new(900.0_f64, 600.0_f64);
    let _ = main_window.set_min_size(Some(min_size));

    // 3. Maximize BEFORE showing to avoid visual stretching
    let _ = main_window.maximize();

    // 4. To give the Webview a split second to paint the new size *before* we show it,
    // we can use show() but the exact moment of rendering depends on the OS composer.
    // By the time this Rust command runs, React has already mounted <Workspace />, 
    // so `maximize` will stretch the DOM, and `show` will reveal the painted frame.
    let _ = main_window.show();
    let _ = main_window.set_focus();

    log::info!("[Splash] Closed splash screen, showed DAW main window");
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
