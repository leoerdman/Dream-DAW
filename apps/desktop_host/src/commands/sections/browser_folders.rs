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
    let settings = settings_state.settings.lock().map_err(|_| "Application state error. Please restart Dream DAW.".to_string())?;
    Ok(settings.browser_folders.clone())
}

fn normalize_browser_path(path: &str) -> String {
    let raw = std::path::Path::new(path);
    if let Ok(canon) = raw.canonicalize() {
        return canon.to_string_lossy().to_string();
    }
    let mut trimmed = path.trim().to_string();
    while trimmed.len() > 1 && trimmed.ends_with(std::path::MAIN_SEPARATOR) {
        trimmed.pop();
    }
    trimmed
}

/// Adds a folder to the browser PLACES section (with native picker).
/// Returns the updated list of browser folders.
#[tauri::command]
async fn add_browser_folder(
    app: tauri::AppHandle,
    settings_state: tauri::State<'_, SettingsState>,
) -> Result<Vec<String>, String> {
    use tauri_plugin_dialog::DialogExt;

    let (tx, rx) = std::sync::mpsc::sync_channel(1);

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

    let normalized_picked = normalize_browser_path(&picked);

    {
        let mut settings = settings_state.settings.lock().map_err(|_| "Application state error. Please restart Dream DAW.".to_string())?;
        // Don't add duplicates
        let exists = settings
            .browser_folders
            .iter()
            .any(|f| normalize_browser_path(f) == normalized_picked);
        if !exists {
            settings.browser_folders.push(normalized_picked.clone());
        }
    }
    settings_state.request_save();

    let settings = settings_state.settings.lock().map_err(|_| "Application state error. Please restart Dream DAW.".to_string())?;
    log::info!(
        "[Browser] Added folder: '{}' (total: {})",
        normalized_picked,
        settings.browser_folders.len()
    );
    Ok(settings.browser_folders.clone())
}

/// Removes a folder from the browser PLACES section.
/// Returns the updated list.
#[tauri::command]
fn remove_browser_folder(
    path: String,
    settings_state: tauri::State<'_, SettingsState>,
) -> Result<Vec<String>, String> {
    let normalized_target = normalize_browser_path(&path);
    {
        let mut settings = settings_state.settings.lock().map_err(|_| "Application state error. Please restart Dream DAW.".to_string())?;
        settings
            .browser_folders
            .retain(|f| normalize_browser_path(f) != normalized_target);
    }
    settings_state.request_save();

    let settings = settings_state.settings.lock().map_err(|_| "Application state error. Please restart Dream DAW.".to_string())?;
    log::info!(
        "[Browser] Removed folder: '{}' (total: {})",
        normalized_target,
        settings.browser_folders.len()
    );
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

/// Iterative plugin scanner — uses an explicit work queue instead of recursion
/// to prevent stack overflow (SIGILL) on the main thread. The Tauri IPC thread
/// has a limited stack and `canonicalize()` / `realpath` syscalls consume
/// significant stack space per frame.
fn collect_plugins_recursive(
    dir: &std::path::Path,
    plugin_type: &str,
    _depth: u32,
    max_depth: u32,
    seen: &mut std::collections::HashSet<String>,
    entries: &mut Vec<BrowserFileEntry>,
) {
    use std::collections::VecDeque;

    // Work queue: (directory_path, current_depth)
    let mut queue: VecDeque<(std::path::PathBuf, u32)> = VecDeque::new();
    queue.push_back((dir.to_path_buf(), 0));

    while let Some((current_dir, depth)) = queue.pop_front() {
        if depth > max_depth {
            continue;
        }

        // Resolve symlinks and detect directory cycles via canonical path.
        // Use the raw path as fallback if canonicalize fails (e.g. broken symlink).
        let canonical = current_dir.canonicalize().unwrap_or_else(|_| current_dir.clone());
        let canonical_str = canonical.to_string_lossy().to_string();
        if !seen.insert(canonical_str.clone()) {
            log::debug!(
                "[Browser] Skipping already-visited directory: {}",
                canonical_str
            );
            continue;
        }

        let read_dir = match std::fs::read_dir(&current_dir) {
            Ok(rd) => rd,
            Err(err) => {
                log::debug!(
                    "[Browser] Failed to read plugin path '{}': {}",
                    current_dir.display(),
                    err
                );
                continue;
            }
        };

        for entry in read_dir.flatten() {
            let entry_path = entry.path();
            let file_name = entry.file_name().to_string_lossy().to_string();
            if file_name.starts_with('.') {
                continue;
            }

            let ext = entry_path
                .extension()
                .and_then(|e| e.to_str())
                .unwrap_or("");
            let ext_lower = ext.to_lowercase();
            let is_plugin_bundle = PLUGIN_EXTENSIONS.contains(&ext_lower.as_str());

            if is_plugin_bundle {
                // On macOS, .vst3 / .vst / .component / .au / .clap are directory
                // bundles. Treat them as leaf plugin files — do NOT recurse into them.
                let resolved = entry_path
                    .canonicalize()
                    .unwrap_or_else(|_| entry_path.clone());
                let path_str = resolved.to_string_lossy().to_string();
                if !seen.insert(path_str.clone()) {
                    continue;
                }

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
                continue;
            }

            // Enqueue plain directories for processing (NOT plugin bundles).
            if entry_path.is_dir() {
                queue.push_back((entry_path, depth + 1));
            }
        }
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
    plugin_host_state: tauri::State<'_, PluginHostState>,
) -> Result<Vec<BrowserFileEntry>, String> {
    let settings = settings_state.settings.lock().map_err(|_| "Application state error. Please restart Dream DAW.".to_string())?;
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
    let clap_path = "/Library/Audio/Plug-Ins/CLAP".to_string();
    let user_clap = home.join("Library/Audio/Plug-Ins/CLAP").to_string_lossy().to_string();

    let all_paths: Vec<(&str, &str)> = paths.iter()
        .map(|(p, t)| (p.as_str(), *t))
        .chain(vec![
            (user_vst.as_str(), "VST2"),
            (user_vst3.as_str(), "VST3"),
            (user_au.as_str(), "AU"),
            (clap_path.as_str(), "CLAP"),
            (user_clap.as_str(), "CLAP"),
        ])
        .collect();

    let mut seen = std::collections::HashSet::new();

    for (dir_path, plugin_type) in &all_paths {
        let dir = std::path::Path::new(dir_path);
        if !dir.exists() || !dir.is_dir() {
            continue;
        }
        collect_plugins_recursive(dir, plugin_type, 0, 4, &mut seen, &mut entries);
    }

    entries.sort_by(|a, b| a.name.to_lowercase().cmp(&b.name.to_lowercase()));
    if let Err(err) = plugin_host_state.clear_scan_cache() {
        log::warn!(
            "[IPC] scan_plugin_folders: failed to clear plugin descriptor cache: {}",
            err
        );
    } else {
        log::info!("[IPC] scan_plugin_folders: plugin descriptor cache invalidated");
    }
    log::info!("[IPC] scan_plugin_folders: found {} plugins", entries.len());
    Ok(entries)
}

/// Opens a native folder picker dialog and returns the selected path.
#[tauri::command]
async fn pick_folder(app: tauri::AppHandle) -> Result<Option<String>, String> {
    use tauri_plugin_dialog::DialogExt;

    let (tx, rx) = std::sync::mpsc::sync_channel(1);

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

    fn preferred_project_dialog_dir(project_state: &crate::state_managers::ProjectState) -> Option<std::path::PathBuf> {
        if let Ok(folder_guard) = project_state.project_folder.lock()
            && let Some(folder) = folder_guard.as_ref()
            && folder.exists()
        {
            return Some(folder.clone());
        }
        if let Ok(file_guard) = project_state.file_path.lock()
            && let Some(file_path) = file_guard.as_ref()
            && let Some(parent) = file_path.parent()
            && parent.exists()
        {
            return Some(parent.to_path_buf());
        }
        std::env::var("HOME").ok().map(std::path::PathBuf::from)
    }

    let project_registry: tauri::State<'_, crate::state_managers::ProjectRegistry> = app.state();
    let active_project_arc = active_project!(project_registry);
    let project_state: &crate::state_managers::ProjectState = &active_project_arc;

    let default_dir = preferred_project_dialog_dir(&project_state);

    let (tx, rx) = std::sync::mpsc::sync_channel(1);

    let mut builder = app.dialog().file()
        .add_filter("Dream DAW Project", &["ddpj"])
        .add_filter("Ableton Live Set", &["als"])
        .set_title("Open Project");
    if let Some(dir) = default_dir.as_ref() {
        builder = builder.set_directory(dir);
    }
    builder.pick_file(move |file| {
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
    project_registry: tauri::State<'_, crate::state_managers::ProjectRegistry>,
) -> Result<Option<String>, String> {
    let active_project_arc = active_project!(project_registry);
    let project_state: &crate::state_managers::ProjectState = &active_project_arc;
    use tauri_plugin_dialog::DialogExt;

    fn preferred_project_dialog_dir(project_state: &crate::state_managers::ProjectState) -> Option<std::path::PathBuf> {
        if let Ok(folder_guard) = project_state.project_folder.lock()
            && let Some(folder) = folder_guard.as_ref()
            && folder.exists()
        {
            return Some(folder.clone());
        }
        if let Ok(file_guard) = project_state.file_path.lock()
            && let Some(file_path) = file_guard.as_ref()
            && let Some(parent) = file_path.parent()
            && parent.exists()
        {
            return Some(parent.to_path_buf());
        }
        std::env::var("HOME").ok().map(std::path::PathBuf::from)
    }

    // Use current project name as default filename
    let default_name = {
        let project = project_state.project.lock().map_err(|_| "Application state error. Please restart Dream DAW.".to_string())?;
        format!("{}.ddpj", project.name)
    };
    let default_dir = preferred_project_dialog_dir(&project_state);

    log::info!("[SaveDialog] Opening native save dialog with default_name={:?}", default_name);

    let (tx, rx) = std::sync::mpsc::sync_channel(1);

    let mut builder = app.dialog().file()
        .add_filter("Dream DAW Project", &["ddpj"])
        .set_title("Save Project As")
        .set_file_name(&default_name);
    if let Some(dir) = default_dir.as_ref() {
        builder = builder.set_directory(dir);
    }
    builder.save_file(move |file| {
        let result = file.map(|p| {
            let raw = p.to_string();
            log::info!("[SaveDialog] Raw FilePath from dialog: {:?}", raw);
            // Enforce .ddpj extension — macOS NSSavePanel may not auto-append it
            if !raw.to_lowercase().ends_with(".ddpj") {
                format!("{}.ddpj", raw)
            } else {
                raw
            }
        });
        log::info!("[SaveDialog] Sending result to channel: {:?}", result);
        let _ = tx.send(result);
    });

    let result = tauri::async_runtime::spawn_blocking(move || {
        rx.recv().map_err(|e| format!("Dialog channel recv error: {}", e))
    })
    .await
    .map_err(|e| format!("Dialog join error: {}", e))?;
    log::info!("[SaveDialog] Final result: {:?}", result);
    result
}
