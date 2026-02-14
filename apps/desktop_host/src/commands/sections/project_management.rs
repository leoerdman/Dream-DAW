// ═══════════════════════════════════════════════════════════════════════

fn canonical_internal_plugin_for_import(plugin_id: &str, plugin_name: &str) -> Option<(&'static str, &'static str, &'static str)> {
    let merged = format!("{} {}", plugin_id, plugin_name).to_lowercase();
    let compact = merged.replace(|c: char| !c.is_ascii_alphanumeric(), "");

    if merged.contains("operator")
        || merged.contains("analog")
        || merged.contains("wavetable")
        || compact.contains("simplesinesynth")
        || merged.contains("wave synth")
        || compact.contains("wavesynth")
    {
        return Some(("internal://instrument/wave-synth", "Wave Synth", "instrument"));
    }
    if merged.contains("sampler") || merged.contains("simpler") {
        return Some(("internal://instrument/sampler", "Sampler", "instrument"));
    }

    if merged.contains("eq") || merged.contains("channel eq") {
        return Some(("internal://effect/eq-eight", "EQ Eight", "effect"));
    }
    if merged.contains("compressor") || merged.contains("glue") || merged.contains("multiband dynamics") {
        return Some(("internal://effect/compressor", "Compressor", "effect"));
    }
    if merged.contains("delay") || merged.contains("echo") || merged.contains("ping pong") {
        return Some(("internal://effect/delay", "Delay", "effect"));
    }
    if merged.contains("reverb") {
        return Some(("internal://effect/reverb", "Reverb", "effect"));
    }
    if merged.contains("chorus") {
        return Some(("internal://effect/chorus", "Chorus", "effect"));
    }
    if merged.contains("saturator") {
        return Some(("internal://effect/saturator", "Saturator", "effect"));
    }
    if merged.contains("utility") {
        return Some(("internal://effect/utility", "Utility", "effect"));
    }
    if merged.contains("limiter") {
        return Some(("internal://effect/limiter", "Limiter", "effect"));
    }
    if merged.contains("gate") {
        return Some(("internal://effect/gate", "Gate", "effect"));
    }
    if merged.contains("auto filter") || merged.contains("autofilter") {
        return Some(("internal://effect/auto-filter", "Auto Filter", "effect"));
    }
    if merged.contains("phaser") {
        return Some(("internal://effect/phaser", "Phaser", "effect"));
    }
    if merged.contains("flanger") {
        return Some(("internal://effect/flanger", "Flanger", "effect"));
    }
    if merged.contains("distortion") || merged.contains("overdrive") || merged.contains("pedal") || merged.contains("cabinet") || merged.contains("amp") {
        return Some(("internal://effect/distortion", "Distortion", "effect"));
    }
    if merged.contains("bitcrusher") || merged.contains("redux") {
        return Some(("internal://effect/bitcrusher", "Bitcrusher", "effect"));
    }
    None
}

fn normalize_internal_plugins_for_import(project: &mut Project) {
    for track in &mut project.tracks {
        if let Some(inst) = &mut track.instrument
            && let Some((canonical_id, canonical_name, slot)) =
                canonical_internal_plugin_for_import(&inst.plugin_id, &inst.name)
            && slot == "instrument"
        {
            inst.plugin_id = canonical_id.to_string();
            if inst.name.trim().is_empty() || inst.name.to_lowercase() != canonical_name.to_lowercase() {
                inst.name = canonical_name.to_string();
            }
            if track.sampler.is_none() {
                track.sampler = Some(SamplerConfig::default());
            }
            if canonical_id == "internal://instrument/wave-synth"
                && let Some(cfg) = &mut track.sampler
                && cfg.sample_path.trim().is_empty()
            {
                cfg.sample_path = "internal://waveform/sine".to_string();
            }
        }
        for fx in &mut track.effects {
            if let Some((canonical_id, canonical_name, slot)) =
                canonical_internal_plugin_for_import(&fx.plugin_id, &fx.name)
                && slot == "effect"
            {
                fx.plugin_id = canonical_id.to_string();
                if fx.name.trim().is_empty() || fx.name.to_lowercase() != canonical_name.to_lowercase() {
                    fx.name = canonical_name.to_string();
                }
            }
        }
    }
}

/// Creates a new empty project and replaces the current one.
#[tauri::command]
fn new_project(
    project_state: tauri::State<'_, ProjectState>,
    clip_pool_state: tauri::State<'_, ClipPoolState>,
    automation_runtime: tauri::State<'_, AutomationRuntime>,
    handle: tauri::State<'_, AudioEngineHandle>,
    app: tauri::AppHandle,
) -> Result<Project, String> {
    let mut new = Project::default();
    refresh_offline_flags(&mut new);
    *project_state.project.lock().map_err(|e| e.to_string())? = new.clone();
    *project_state.file_path.lock().map_err(|e| e.to_string())? = None;
    *project_state.project_folder.lock().map_err(|e| e.to_string())? = None;
    *project_state.is_dirty.lock().map_err(|e| e.to_string())? = false;
    *project_state.undo.lock().map_err(|e| e.to_string())? = UndoState::new();
    clip_pool_state.rebuild_snapshot(&new);
    rebuild_automation_snapshot_from_project(&new, &automation_runtime);
    rebuild_midi_snapshot_from_project(&new, &handle);
    rebuild_sampler_snapshot_from_project(&new, &clip_pool_state, &handle);
    rebuild_runtime_device_chains_from_project(&new, &handle)?;
    sync_transport_from_project(&new, &handle)?;

    // Update window title
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.set_title(&format!("Dream DAW — {}", new.name));
    }

    log::info!("New project created: '{}'", new.name);
    Ok(new)
}

/// Saves the current project to its existing path (or fails if unsaved).
#[tauri::command]
fn save_project(
    project_state: tauri::State<'_, ProjectState>,
    app: tauri::AppHandle,
) -> Result<String, String> {
    let mut project = project_state.project.lock().map_err(|e| e.to_string())?;
    let file_path_guard = project_state.file_path.lock().map_err(|e| e.to_string())?;

    let path = file_path_guard
        .as_ref()
        .ok_or("No file path set. Use Save As first.")?
        .clone();

    // Keep project name aligned with the active file name.
    if let Some(stem) = path.file_stem().and_then(|s| s.to_str()) {
        let normalized = stem.trim_end_matches(".dream").trim();
        if !normalized.is_empty() && project.name != normalized {
            project.name = normalized.to_string();
        }
    }

    ProjectFile::save(&project, &path).map_err(|e| e.to_string())?;

    *project_state.is_dirty.lock().map_err(|e| e.to_string())? = false;

    // Update window title (also clears any dirty marker left from mark_dirty_cmd).
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.set_title(&format!("Dream DAW — {}", project.name));
    }

    log::info!("Project saved: '{}' → {}", project.name, path.display());
    Ok(path.display().to_string())
}

/// Saves the project to a specific path.
#[tauri::command]
fn save_project_as(
    path: String,
    project_state: tauri::State<'_, ProjectState>,
    app: tauri::AppHandle,
) -> Result<String, String> {
    let mut project = project_state.project.lock().map_err(|e| e.to_string())?;
    let file_path = PathBuf::from(&path);

    // Determine if we should create an Ableton-style folder structure.
    // If the user chose a path like "Foo.dream.json", we create:
    //   parent/Foo/Foo.dream.json + Samples/ + Backup/
    let parent_dir = file_path.parent().unwrap_or(std::path::Path::new("."));
    let project_name = file_path
        .file_stem()
        .and_then(|s| s.to_str())
        .unwrap_or(&project.name)
        .trim_end_matches(".dream")
        .to_string();

    // Save As should establish the active project name from chosen filename.
    if !project_name.trim().is_empty() {
        project.name = project_name.trim().to_string();
    }

    let (actual_file_path, folder) = if ProjectManager::is_project_directory(parent_dir) {
        // Already inside a project directory — save in place
        ProjectFile::save(&project, &file_path)
            .map_err(|e| e.to_string())?;
        (file_path.clone(), parent_dir.to_path_buf())
    } else {
        // New location — create Ableton-style folder structure
        let folder = ProjectManager::create_project_folder(parent_dir, &project_name)
            .map_err(|e| e.to_string())?;
        let saved_path = ProjectManager::save_to_folder(&project, &folder, true)
            .map_err(|e| e.to_string())?;
        (saved_path, folder)
    };

    *project_state.file_path.lock().map_err(|e| e.to_string())? = Some(actual_file_path.clone());
    *project_state.project_folder.lock().map_err(|e| e.to_string())? = Some(folder);
    *project_state.is_dirty.lock().map_err(|e| e.to_string())? = false;

    // Track in recent projects
    let result_path = actual_file_path.display().to_string();
    if let Ok(app_data_dir) = app.path().app_data_dir() {
        let mut recent = RecentProjects::load(&app_data_dir);
        recent.add(project.name.clone(), result_path.clone());
        let _ = recent.save(&app_data_dir);
    }

    // Update window title
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.set_title(&format!("Dream DAW — {}", project.name));
    }

    log::info!("Project saved as: '{}' → {}", project.name, actual_file_path.display());
    Ok(result_path)
}

/// Opens a project from a file path.
#[tauri::command]
fn open_project(
    path: String,
    project_state: tauri::State<'_, ProjectState>,
    clip_pool_state: tauri::State<'_, ClipPoolState>,
    automation_runtime: tauri::State<'_, AutomationRuntime>,
    handle: tauri::State<'_, AudioEngineHandle>,
    app: tauri::AppHandle,
) -> Result<Project, String> {
    let file_path = PathBuf::from(&path);

    let mut loaded = ProjectFile::load(&file_path)
        .map_err(|e| e.to_string())?;
    normalize_internal_plugins_for_import(&mut loaded);
    refresh_offline_flags(&mut loaded);

    *project_state.project.lock().map_err(|e| e.to_string())? = loaded.clone();
    *project_state.file_path.lock().map_err(|e| e.to_string())? = Some(file_path.clone());
    *project_state.is_dirty.lock().map_err(|e| e.to_string())? = false;
    *project_state.undo.lock().map_err(|e| e.to_string())? = UndoState::new();
    clip_pool_state.rebuild_snapshot(&loaded);
    clip_pool_state.load_project_clips(&loaded);
    rebuild_automation_snapshot_from_project(&loaded, &automation_runtime);
    rebuild_midi_snapshot_from_project(&loaded, &handle);
    rebuild_sampler_snapshot_from_project(&loaded, &clip_pool_state, &handle);
    rebuild_runtime_device_chains_from_project(&loaded, &handle)?;
    sync_transport_from_project(&loaded, &handle)?;

    // Derive project folder from file path
    let folder = ProjectManager::folder_from_file(&file_path);
    *project_state.project_folder.lock().map_err(|e| e.to_string())? = folder;

    // Track in recent projects
    if let Ok(app_data_dir) = app.path().app_data_dir() {
        let mut recent = RecentProjects::load(&app_data_dir);
        recent.add(loaded.name.clone(), path);
        let _ = recent.save(&app_data_dir);
    }

    // Update window title
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.set_title(&format!("Dream DAW — {}", loaded.name));
    }

    log::info!("Project opened: '{}' ({} tracks)", loaded.name, loaded.track_count());
    Ok(loaded)
}

/// Returns the list of recently opened projects.
#[tauri::command]
fn get_recent_projects(
    app: tauri::AppHandle,
) -> Result<Vec<RecentProject>, String> {
    let app_data_dir = app.path().app_data_dir()
        .map_err(|e| e.to_string())?;
    let recent = RecentProjects::load(&app_data_dir);
    Ok(recent.projects)
}

/// Returns the current project state.
#[tauri::command]
fn get_project(
    project_state: tauri::State<'_, ProjectState>,
) -> Result<Project, String> {
    let mut project = project_state.project.lock().map_err(|e| e.to_string())?;
    refresh_offline_flags(&mut project);
    Ok(project.clone())
}

/// Returns whether the project has unsaved changes and the current file path.
#[tauri::command]
fn get_project_status(
    project_state: tauri::State<'_, ProjectState>,
) -> Result<serde_json::Value, String> {
    let is_dirty = *project_state.is_dirty.lock().map_err(|e| e.to_string())?;
    let file_path = project_state.file_path.lock().map_err(|e| e.to_string())?;
    let project_folder = project_state.project_folder.lock().map_err(|e| e.to_string())?;
    Ok(serde_json::json!({
        "isDirty": is_dirty,
        "filePath": file_path.as_ref().map(|p| p.display().to_string()),
        "projectFolder": project_folder.as_ref().map(|p| p.display().to_string()),
    }))
}
