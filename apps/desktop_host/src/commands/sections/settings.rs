// ═══════════════════════════════════════════════════════════════════════

/// Returns the current application settings.
#[tauri::command]
fn get_settings(
    settings_state: tauri::State<'_, SettingsState>,
) -> Result<AppSettings, String> {
    let settings = settings_state.settings.lock().map_err(|e| e.to_string())?;
    Ok(settings.clone())
}

/// Returns the resolved samples folder path by reading settings.json directly.
/// This avoids the SettingsState mutex — safe for lightweight IPC calls.
#[tauri::command]
fn get_samples_path(app: tauri::AppHandle) -> Result<String, String> {
    let app_data_dir = app.path().app_data_dir()
        .map_err(|e| format!("Cannot resolve app data dir: {}", e))?;
    let settings_path = app_data_dir.join("settings.json");

    let samples_path = if settings_path.exists() {
        if let Ok(json) = std::fs::read_to_string(&settings_path) {
            if let Ok(settings) = serde_json::from_str::<AppSettings>(&json) {
                settings.samples_path
            } else {
                default_samples_path()
            }
        } else {
            default_samples_path()
        }
    } else {
        default_samples_path()
    };

    // Auto-create the samples directory if it doesn't exist
    let path = std::path::Path::new(&samples_path);
    if !path.exists() {
        let _ = std::fs::create_dir_all(path);
        log::info!("[Settings] Created samples directory: {}", samples_path);
    }

    Ok(samples_path)
}

/// Updates application settings and persists to disk.
/// If `user_folder_path` changed, migrates settings to the new location.
#[tauri::command]
fn update_settings(
    new_settings: AppSettings,
    settings_state: tauri::State<'_, SettingsState>,
) -> Result<(), String> {
    // Check if user_folder_path changed (need to migrate)
    let old_folder_path = {
        let current = settings_state.settings.lock().map_err(|e| e.to_string())?;
        current.user_folder_path.clone()
    };

    let folder_changed = old_folder_path != new_settings.user_folder_path;
    let new_folder_path = new_settings.user_folder_path.clone();

    // Update in-memory state
    *settings_state.settings.lock().map_err(|e| e.to_string())? = new_settings;

    // Persist to disk
    if folder_changed {
        settings_state.migrate_to_new_folder(&old_folder_path, &new_folder_path)?;
    } else {
        settings_state.save_to_user_folder()?;
    }

    log::info!("Settings updated and persisted");
    Ok(())
}

