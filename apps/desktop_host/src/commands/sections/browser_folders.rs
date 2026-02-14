// ═══════════════════════════════════════════════════════════════════════

/// A file system entry returned by `scan_folder_all`.
/// Classifies files into audio, plugin, project, preset, or other.
#[derive(Debug, Clone, Serialize, Deserialize)]
struct BrowserFileEntry {
    name: String,
    path: String,
    size_bytes: u64,
    modified_at: String,
    /// File extension (uppercase), e.g. "WAV", "VST3"
    extension: String,
    /// Semantic type: "audio", "plugin", "project", "preset", "folder", "other"
    file_type: String,
    /// Whether this entry is a directory
    is_directory: bool,
    /// Exact audio duration in seconds when known (audio files only).
    duration_seconds: Option<f64>,
}

/// Returns the list of user-added browser folders from settings.
#[tauri::command]
fn get_browser_folders(
    settings_state: tauri::State<'_, SettingsState>,
) -> Result<Vec<String>, String> {
    let settings = settings_state.settings.lock().map_err(|e| e.to_string())?;
    Ok(settings.browser_folders.clone())
}

/// Adds a folder to the browser PLACES section (with native picker).
/// Returns the updated list of browser folders.
#[tauri::command]
async fn add_browser_folder(
    app: tauri::AppHandle,
    settings_state: tauri::State<'_, SettingsState>,
) -> Result<Vec<String>, String> {
    use tauri_plugin_dialog::DialogExt;

    let (tx, rx) = std::sync::mpsc::channel();

    app.dialog().file()
        .pick_folder(move |folder| {
            let _ = tx.send(folder.map(|p| p.to_string()));
        });

    let picked = tauri::async_runtime::spawn_blocking(move || {
        rx.recv().map_err(|e| format!("Dialog error: {}", e))
    })
    .await
    .map_err(|e| format!("Join error: {}", e))?
    .map_err(|e| e.to_string())?
    .ok_or_else(|| "Cancelled".to_string())?;

    {
        let mut settings = settings_state.settings.lock().map_err(|e| e.to_string())?;
        // Don't add duplicates
        if !settings.browser_folders.contains(&picked) {
            settings.browser_folders.push(picked.clone());
        }
    }
    settings_state.save_to_user_folder()?;

    let settings = settings_state.settings.lock().map_err(|e| e.to_string())?;
    log::info!("[Browser] Added folder: '{}' (total: {})", picked, settings.browser_folders.len());
    Ok(settings.browser_folders.clone())
}

/// Removes a folder from the browser PLACES section.
/// Returns the updated list.
#[tauri::command]
fn remove_browser_folder(
    path: String,
    settings_state: tauri::State<'_, SettingsState>,
) -> Result<Vec<String>, String> {
    {
        let mut settings = settings_state.settings.lock().map_err(|e| e.to_string())?;
        settings.browser_folders.retain(|f| f != &path);
    }
    settings_state.save_to_user_folder()?;

    let settings = settings_state.settings.lock().map_err(|e| e.to_string())?;
    log::info!("[Browser] Removed folder: '{}' (total: {})", path, settings.browser_folders.len());
    Ok(settings.browser_folders.clone())
}

/// Classifies a file extension into a semantic type.
fn classify_file_type(ext: &str) -> &'static str {
    let lower = ext.to_lowercase();
    if AUDIO_EXTENSIONS.contains(&lower.as_str()) {
        "audio"
    } else if PLUGIN_EXTENSIONS.contains(&lower.as_str()) {
        "plugin"
    } else if PROJECT_EXTENSIONS.contains(&lower.as_str()) {
        "project"
    } else if PRESET_EXTENSIONS.contains(&lower.as_str()) {
        "preset"
    } else {
        "other"
    }
}

/// Scans a folder for ALL file types (audio, plugins, projects, presets, etc.).
/// Returns classified entries. Subfolders are also listed as navigable entries.
#[tauri::command]
fn scan_folder_all(path: String) -> Result<Vec<BrowserFileEntry>, String> {
    log::info!("[IPC] scan_folder_all: {}", path);
    let root = std::path::Path::new(&path);
    if !root.exists() {
        return Err(format!("Folder does not exist: {}", path));
    }
    if !root.is_dir() {
        return Err(format!("Path is not a directory: {}", path));
    }

    let read_dir = std::fs::read_dir(root)
        .map_err(|e| format!("Cannot read {}: {}", path, e))?;

    let mut entries = Vec::new();

    for entry in read_dir.flatten() {
        let file_name = entry.file_name().to_string_lossy().to_string();
        // Skip hidden files
        if file_name.starts_with('.') {
            continue;
        }

        let entry_path = entry.path();
        let metadata = std::fs::metadata(&entry_path).ok();
        let size_bytes = metadata.as_ref().map_or(0, |m| m.len());
        let modified_at = metadata
            .and_then(|m| m.modified().ok())
            .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
            .map(|d| d.as_secs().to_string())
            .unwrap_or_default();

        if entry_path.is_dir() {
            // Check if it's a plugin bundle (.vst, .vst3, .component, .au)
            let ext = entry_path.extension()
                .and_then(|e| e.to_str())
                .unwrap_or("");
            let ext_lower = ext.to_lowercase();
            if PLUGIN_EXTENSIONS.contains(&ext_lower.as_str()) {
                entries.push(BrowserFileEntry {
                    name: file_name,
                    path: entry_path.to_string_lossy().to_string(),
                    size_bytes,
                    modified_at,
                    extension: ext.to_uppercase(),
                    file_type: "plugin".to_string(),
                    is_directory: false, // Treat as file for UX
                    duration_seconds: None,
                });
            } else {
                // Regular subfolder
                entries.push(BrowserFileEntry {
                    name: file_name,
                    path: entry_path.to_string_lossy().to_string(),
                    size_bytes: 0,
                    modified_at,
                    extension: String::new(),
                    file_type: "folder".to_string(),
                    is_directory: true,
                    duration_seconds: None,
                });
            }
        } else if let Some(ext) = entry_path.extension().and_then(|e| e.to_str()) {
            let file_type = classify_file_type(ext);
            let duration_seconds = if file_type == "audio" {
                AudioReader::read_metadata(&entry_path)
                    .ok()
                    .and_then(|(sr, _ch, frames)| frames.map(|f| (f as f64) / (sr as f64)))
            } else {
                None
            };
            entries.push(BrowserFileEntry {
                name: file_name,
                path: entry_path.to_string_lossy().to_string(),
                size_bytes,
                modified_at,
                extension: ext.to_uppercase(),
                file_type: file_type.to_string(),
                is_directory: false,
                duration_seconds,
            });
        }
    }

    // Sort: folders first, then by name
    entries.sort_by(|a, b| {
        b.is_directory.cmp(&a.is_directory)
            .then_with(|| a.name.to_lowercase().cmp(&b.name.to_lowercase()))
    });

    Ok(entries)
}

/// Scans VST2 and VST3 system paths for installed plugins.
/// Returns all discovered plugin bundles.
#[tauri::command]
fn scan_plugin_folders(
    settings_state: tauri::State<'_, SettingsState>,
) -> Result<Vec<BrowserFileEntry>, String> {
    let settings = settings_state.settings.lock().map_err(|e| e.to_string())?;
    let mut entries = Vec::new();

    // Scan each plugin path
    let au_path = "/Library/Audio/Plug-Ins/Components".to_string();
    let paths: Vec<(&String, &str)> = vec![
        (&settings.vst2_path, "VST2"),
        (&settings.vst3_path, "VST3"),
        // macOS AU components
        (&au_path, "AU"),
    ];

    let home = dirs::home_dir().unwrap_or_default();
    let user_vst = home.join("Library/Audio/Plug-Ins/VST").to_string_lossy().to_string();
    let user_vst3 = home.join("Library/Audio/Plug-Ins/VST3").to_string_lossy().to_string();
    let user_au = home.join("Library/Audio/Plug-Ins/Components").to_string_lossy().to_string();

    let all_paths: Vec<(&str, &str)> = paths.iter()
        .map(|(p, t)| (p.as_str(), *t))
        .chain(vec![
            (user_vst.as_str(), "VST2"),
            (user_vst3.as_str(), "VST3"),
            (user_au.as_str(), "AU"),
        ])
        .collect();

    let mut seen = std::collections::HashSet::new();

    for (dir_path, plugin_type) in &all_paths {
        let dir = std::path::Path::new(dir_path);
        if !dir.exists() || !dir.is_dir() {
            continue;
        }

        if let Ok(read_dir) = std::fs::read_dir(dir) {
            for entry in read_dir.flatten() {
                let entry_path = entry.path();
                let file_name = entry.file_name().to_string_lossy().to_string();

                if file_name.starts_with('.') {
                    continue;
                }

                // Check if it's a plugin bundle
                let ext = entry_path.extension()
                    .and_then(|e| e.to_str())
                    .unwrap_or("");
                let ext_lower = ext.to_lowercase();

                if PLUGIN_EXTENSIONS.contains(&ext_lower.as_str()) {
                    let path_str = entry_path.to_string_lossy().to_string();
                    if seen.contains(&path_str) {
                        continue;
                    }
                    seen.insert(path_str.clone());

                    // Strip extension from display name for cleaner look
                    let display_name = file_name
                        .rsplit_once('.')
                        .map(|(n, _)| n.to_string())
                        .unwrap_or_else(|| file_name.clone());

                    let metadata = std::fs::metadata(&entry_path).ok();
                    let size_bytes = metadata.as_ref().map_or(0, |m| m.len());
                    let modified_at = metadata
                        .and_then(|m| m.modified().ok())
                        .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
                        .map(|d| d.as_secs().to_string())
                        .unwrap_or_default();

                    entries.push(BrowserFileEntry {
                        name: display_name,
                        path: path_str,
                        size_bytes,
                        modified_at,
                        extension: plugin_type.to_string(),
                        file_type: "plugin".to_string(),
                        is_directory: false,
                        duration_seconds: None,
                    });
                }
            }
        }
    }

    entries.sort_by(|a, b| a.name.to_lowercase().cmp(&b.name.to_lowercase()));
    log::info!("[IPC] scan_plugin_folders: found {} plugins", entries.len());
    Ok(entries)
}

/// Opens a native folder picker dialog and returns the selected path.
#[tauri::command]
async fn pick_folder(app: tauri::AppHandle) -> Result<Option<String>, String> {
    use tauri_plugin_dialog::DialogExt;

    let (tx, rx) = std::sync::mpsc::channel();

    app.dialog().file()
        .pick_folder(move |folder| {
            let _ = tx.send(folder.map(|p| p.to_string()));
        });

    tauri::async_runtime::spawn_blocking(move || {
        rx.recv().map_err(|e| format!("Dialog error: {}", e))
    })
    .await
    .map_err(|e| format!("Join error: {}", e))?
}

/// Opens a native file picker dialog for .ddpj project files.
#[tauri::command]
async fn pick_project_file(app: tauri::AppHandle) -> Result<Option<String>, String> {
    use tauri_plugin_dialog::DialogExt;

    let (tx, rx) = std::sync::mpsc::channel();

    app.dialog().file()
        .add_filter("Dream DAW Project", &["ddpj", "json"])
        .add_filter("Ableton Live Set", &["als"])
        .set_title("Open Project")
        .pick_file(move |file| {
            let _ = tx.send(file.map(|p| p.to_string()));
        });

    tauri::async_runtime::spawn_blocking(move || {
        rx.recv().map_err(|e| format!("Dialog error: {}", e))
    })
    .await
    .map_err(|e| format!("Join error: {}", e))?
}

/// Opens a native save dialog for .ddpj project files.
#[tauri::command]
async fn save_project_dialog(
    app: tauri::AppHandle,
    project_state: tauri::State<'_, ProjectState>,
) -> Result<Option<String>, String> {
    use tauri_plugin_dialog::DialogExt;

    // Use current project name as default filename
    let default_name = {
        let project = project_state.project.lock().map_err(|e| e.to_string())?;
        format!("{}.ddpj", project.name)
    };

    let (tx, rx) = std::sync::mpsc::channel();

    app.dialog().file()
        .add_filter("Dream DAW Project", &["ddpj"])
        .set_title("Save Project As")
        .set_file_name(&default_name)
        .save_file(move |file| {
            let _ = tx.send(file.map(|p| p.to_string()));
        });

    tauri::async_runtime::spawn_blocking(move || {
        rx.recv().map_err(|e| format!("Dialog error: {}", e))
    })
    .await
    .map_err(|e| format!("Join error: {}", e))?
}
