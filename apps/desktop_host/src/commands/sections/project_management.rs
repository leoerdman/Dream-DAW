/// Imports an Ableton `.als` project and installs it as the active session.
#[tauri::command]
fn import_ableton_project(
    path: String,
    project_state: tauri::State<'_, ProjectState>,
    clip_pool_state: tauri::State<'_, ClipPoolState>,
    automation_runtime: tauri::State<'_, AutomationRuntime>,
    handle: tauri::State<'_, AudioEngineHandle>,
    plugin_host_state: tauri::State<'_, PluginHostState>,
    app: tauri::AppHandle,
) -> Result<Project, String> {
    open_project(
        path,
        project_state,
        clip_pool_state,
        automation_runtime,
        handle,
        plugin_host_state,
        app,
    )
}

/// Creates a new empty project and replaces the current one.
#[tauri::command]
fn new_project(
    project_state: tauri::State<'_, ProjectState>,
    clip_pool_state: tauri::State<'_, ClipPoolState>,
    automation_runtime: tauri::State<'_, AutomationRuntime>,
    handle: tauri::State<'_, AudioEngineHandle>,
    plugin_host_state: tauri::State<'_, PluginHostState>,
    app: tauri::AppHandle,
) -> Result<Project, String> {
    let mut new = Project::default();
    refresh_offline_flags(&mut new);
    *project_state.project.lock().map_err(|e| e.to_string())? = new.clone();
    *project_state.file_path.lock().map_err(|e| e.to_string())? = None;
    *project_state.project_folder.lock().map_err(|e| e.to_string())? = None;
    *project_state.is_dirty.lock().map_err(|e| e.to_string())? = false;
    *project_state.undo.lock().map_err(|e| e.to_string())? = UndoState::new();
    *project_state.history.lock().map_err(|e| e.to_string())? = ProjectHistory::new();
    project_state.record_history("new_project", format!("created '{}'", new.name))?;
    let _ = plugin_host_state.unload_all_instances();
    clip_pool_state.rebuild_snapshot(&new);
    clip_pool_state.rebuild_external_fx_snapshot(&new, plugin_host_state.slot_instance_snapshot().as_ref());
    plugin_host_state.publish_registry();
    rebuild_automation_snapshot_from_project(&new, &automation_runtime);
    rebuild_midi_snapshot_from_project(&new, &handle);
    rebuild_sampler_snapshot_from_project(&new, &clip_pool_state, &handle);
    rebuild_runtime_device_chains_from_project(&new, &handle)?;
    sync_transport_from_project(&new, &handle)?;
    sync_track_mix_state_from_project(&new, &handle)?;

    // Update window title
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.set_title(&format!("Dream DAW — {}", new.name));
    }

    log::info!("New project created: '{}'", new.name);
    Ok(new)
}

/// Saves the current project to its existing path (or fails if unsaved).
#[tauri::command]
async fn save_project(
    project_state: tauri::State<'_, ProjectState>,
    plugin_host_state: tauri::State<'_, PluginHostState>,
    app: tauri::AppHandle,
) -> Result<String, String> {
    let (snapshot, path, project_name) = {
        let mut project = project_state.project.lock().map_err(|e| e.to_string())?;

        // ── Capture live plugin state into the project model ──
        // This ensures all knob positions, preset selections, and internal
        // plugin state are persisted before serialization.
        if let Err(e) = plugin_host_state.capture_plugin_states_into_project(&mut project) {
            log::warn!("[Save] Plugin state capture failed (non-fatal): {e}");
        }

        let file_path_guard = project_state.file_path.lock().map_err(|e| e.to_string())?;
        let path = file_path_guard
            .as_ref()
            .ok_or("No file path set. Use Save As first.")?
            .clone();

        let mut snapshot = project.clone();

        // Keep serialized project name aligned with the active file name.
        if let Some(stem) = path.file_stem().and_then(|s| s.to_str()) {
            let normalized = stem.trim_end_matches(".dream").trim();
            if !normalized.is_empty() && snapshot.name != normalized {
                snapshot.name = normalized.to_string();
            }
        }

        (snapshot.clone(), path, snapshot.name.clone())
    };

    let save_path = path.clone();
    tauri::async_runtime::spawn_blocking(move || ProjectFile::save(&snapshot, &save_path))
        .await
        .map_err(|e| format!("Save task join error: {e}"))?
        .map_err(|e| e.to_string())?;

    {
        let mut project = project_state.project.lock().map_err(|e| e.to_string())?;
        project.name = project_name.clone();
    }

    *project_state.is_dirty.lock().map_err(|e| e.to_string())? = false;
    project_state.record_history("save", format!("saved to {}", path.display()))?;

    // Update window title (also clears any dirty marker left from mark_dirty_cmd).
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.set_title(&format!("Dream DAW — {}", project_name));
    }

    log::info!("Project saved: '{}' → {}", project_name, path.display());
    Ok(path.display().to_string())
}

/// Saves the project to a specific path.
#[tauri::command]
async fn save_project_as(
    path: String,
    project_state: tauri::State<'_, ProjectState>,
    plugin_host_state: tauri::State<'_, PluginHostState>,
    app: tauri::AppHandle,
) -> Result<String, String> {
    let file_path = PathBuf::from(&path);
    log::info!("[SaveAs] Received path: {:?}", file_path);
    let (snapshot, project_name) = {
        let mut project = project_state.project.lock().map_err(|e| e.to_string())?;

        // ── Capture live plugin state ──
        if let Err(e) = plugin_host_state.capture_plugin_states_into_project(&mut project) {
            log::warn!("[SaveAs] Plugin state capture failed (non-fatal): {e}");
        }

        let computed_name = file_path
            .file_stem()
            .and_then(|s| s.to_str())
            .unwrap_or(&project.name)
            .trim_end_matches(".dream")
            .to_string();
        let mut snapshot = project.clone();
        if !computed_name.trim().is_empty() {
            snapshot.name = computed_name.trim().to_string();
        }
        (snapshot.clone(), snapshot.name.clone())
    };

    let save_target = file_path.clone();
    let project_name_for_save = project_name.clone();
    let (actual_file_path, folder) = tauri::async_runtime::spawn_blocking(move || -> Result<(PathBuf, PathBuf), String> {
        let parent_dir = save_target.parent().unwrap_or(std::path::Path::new("."));
        let is_proj_dir = ProjectManager::is_project_directory(parent_dir);
        log::info!("[SaveAs] parent_dir={:?}, is_project_dir={}, project_name={}", parent_dir, is_proj_dir, project_name_for_save);
        if is_proj_dir {
            log::info!("[SaveAs] Saving directly to existing project dir: {:?}", save_target);
            ProjectFile::save(&snapshot, &save_target).map_err(|e| e.to_string())?;
            Ok((save_target.clone(), parent_dir.to_path_buf()))
        } else {
            log::info!("[SaveAs] Non-project dir — creating project folder '{}' under {:?}", project_name_for_save, parent_dir);
            let folder = ProjectManager::create_project_folder(parent_dir, &project_name_for_save)
                .map_err(|e| e.to_string())?;
            let saved_path = ProjectManager::save_to_folder(&snapshot, &folder, true)
                .map_err(|e| e.to_string())?;
            log::info!("[SaveAs] Project saved to: {:?}", saved_path);
            Ok((saved_path, folder))
        }
    })
    .await
    .map_err(|e| format!("Save As task join error: {e}"))??;

    {
        let mut project = project_state.project.lock().map_err(|e| e.to_string())?;
        project.name = project_name.clone();
    }

    *project_state.file_path.lock().map_err(|e| e.to_string())? = Some(actual_file_path.clone());
    *project_state.project_folder.lock().map_err(|e| e.to_string())? = Some(folder);
    *project_state.is_dirty.lock().map_err(|e| e.to_string())? = false;
    project_state.record_history("save_as", format!("saved as {}", actual_file_path.display()))?;

    // Track in recent projects
    let result_path = actual_file_path.display().to_string();
    if let Ok(app_data_dir) = app.path().app_data_dir() {
        let mut recent = RecentProjects::load(&app_data_dir);
        recent.add(project_name.clone(), result_path.clone());
        let _ = recent.save(&app_data_dir);
    }

    // Update window title
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.set_title(&format!("Dream DAW — {}", project_name));
    }

    log::info!("Project saved as: '{}' → {}", project_name, actual_file_path.display());
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
    plugin_host_state: tauri::State<'_, PluginHostState>,
    app: tauri::AppHandle,
) -> Result<Project, String> {
    let file_path = PathBuf::from(&path);

    let importing_als = file_path
        .extension()
        .and_then(|s| s.to_str())
        .map(|s| s.eq_ignore_ascii_case("als"))
        .unwrap_or(false);

    let mut loaded = if importing_als {
        let runtime_sample_rate = handle
            .playback_state
            .lock()
            .map_err(|e| e.to_string())?
            .sample_rate;
        dream_importers::ableton::project_import::import_als_project_with_target_sample_rate(
            &file_path,
            Some(runtime_sample_rate),
        )?
    } else {
        let project = ProjectFile::load(&file_path).map_err(|e| e.to_string())?;
        // CRITICAL: Do NOT call normalize_internal_plugins_for_import() here.
        // That normalizer is intended for ALS imports (where plugin names need
        // mapping to internal://). Calling it on native .ddpj projects destroys
        // external VST3 plugin IDs (e.g. ShaperBox3 → Distortion) because the
        // keyword matcher hits on substrings like "shaper" in "ShaperBox".
        project
    };
    if importing_als {
        for track in &mut loaded.tracks {
            track.height = track.height.clamp(24.0, 120.0);
        }
    }
    refresh_offline_flags(&mut loaded);

    let _ = plugin_host_state.unload_all_instances();
    // Do not eagerly activate external plugins while opening a project.
    // Some third-party VSTs can crash on activation/probing; runtime activation
    // is done lazily from the rack (UI/Fix/Open actions).

    clip_pool_state.rebuild_snapshot(&loaded);
    clip_pool_state.rebuild_external_fx_snapshot(&loaded, plugin_host_state.slot_instance_snapshot().as_ref());
    plugin_host_state.publish_registry();
    clip_pool_state.load_project_clips(&loaded);
    rebuild_automation_snapshot_from_project(&loaded, &automation_runtime);
    rebuild_midi_snapshot_from_project(&loaded, &handle);
    rebuild_sampler_snapshot_from_project(&loaded, &clip_pool_state, &handle);
    rebuild_runtime_device_chains_from_project(&loaded, &handle)?;
    sync_transport_from_project(&loaded, &handle)?;
    sync_track_mix_state_from_project(&loaded, &handle)?;

    *project_state.project.lock().map_err(|e| e.to_string())? = loaded.clone();
    *project_state.file_path.lock().map_err(|e| e.to_string())? = if importing_als {
        None
    } else {
        Some(file_path.clone())
    };
    *project_state.is_dirty.lock().map_err(|e| e.to_string())? = importing_als;
    *project_state.undo.lock().map_err(|e| e.to_string())? = UndoState::new();
    *project_state.history.lock().map_err(|e| e.to_string())? = ProjectHistory::new();
    let source_kind = if importing_als { "als_import" } else { "project_open" };
    project_state.record_history(source_kind, format!("loaded '{}'", loaded.name))?;

    // Derive project folder from file path
    let folder = if importing_als {
        file_path.parent().map(|p| p.to_path_buf())
    } else {
        ProjectManager::folder_from_file(&file_path)
    };
    *project_state.project_folder.lock().map_err(|e| e.to_string())? = folder;

    // Track in recent projects
    if let Ok(app_data_dir) = app.path().app_data_dir() {
        let mut recent = RecentProjects::load(&app_data_dir);
        recent.add(loaded.name.clone(), path);
        let _ = recent.save(&app_data_dir);
    }

    // Update window title
    if let Some(window) = app.get_webview_window("main") {
        if importing_als {
            let _ = window.set_title(&format!("Dream DAW — {}*", loaded.name));
        } else {
            let _ = window.set_title(&format!("Dream DAW — {}", loaded.name));
        }
    }

    if importing_als {
        log::info!(
            "Ableton project imported: '{}' ({} tracks) from {}",
            loaded.name,
            loaded.track_count(),
            file_path.display()
        );
    } else {
        log::info!("Project opened: '{}' ({} tracks)", loaded.name, loaded.track_count());
    }
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
    // PERF-FIX: Removed refresh_offline_flags() from this hot path.
    // get_project is called after EVERY UI action (mute, solo, add track, etc.).
    // refresh_offline_flags() does PathBuf::exists() syscalls per clip per track
    // under the project Mutex — creating memory pressure and Mutex contention
    // that can preempt the CoreAudio real-time thread.
    // Offline flags are now only refreshed on project load/open/new where they
    // are actually needed.
    let project = project_state.project.lock().map_err(|e| e.to_string())?;
    Ok(project.clone())
}

/// Returns current project wrapped as a snapshot delta event.
#[tauri::command]
fn get_project_snapshot_delta_cmd(
    project_state: tauri::State<'_, ProjectState>,
) -> Result<DeltaMutationResponse, String> {
    let project = project_state.project.lock().map_err(|e| e.to_string())?;
    Ok(DeltaMutationResponse {
        deltas: vec![dream_models::delta::ProjectDelta::ProjectSnapshotReplaced {
            project: Box::new(project.clone()),
        }],
    })
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

/// Persists arrangement/editor grid settings in the project.
#[tauri::command]
fn set_arrangement_grid_cmd(
    numerator: u16,
    denominator: u16,
    ntoles: u8,
    snap_to_grid: bool,
    fixed: bool,
    project_state: tauri::State<'_, ProjectState>,
    app: tauri::AppHandle,
) -> Result<(), String> {
    let numerator = numerator.max(1);
    let denominator = denominator.max(1);
    let ntoles = ntoles.max(1);

    let mut project = project_state.project.lock().map_err(|e| e.to_string())?;
    project.arrangement_grid_numerator = numerator;
    project.arrangement_grid_denominator = denominator;
    project.arrangement_grid_ntoles = ntoles;
    project.arrangement_snap_to_grid = snap_to_grid;
    project.arrangement_grid_fixed = fixed;
    let name = project.name.clone();
    drop(project);

    project_state.mark_dirty(&name, Some(&app))?;
    Ok(())
}

#[tauri::command]
fn set_arrangement_grid_with_deltas_cmd(
    numerator: u16,
    denominator: u16,
    ntoles: u8,
    snap_to_grid: bool,
    fixed: bool,
    project_state: tauri::State<'_, ProjectState>,
    app: tauri::AppHandle,
) -> Result<DeltaMutationResponse, String> {
    let numerator = numerator.max(1);
    let denominator = denominator.max(1);
    let ntoles = ntoles.max(1);

    set_arrangement_grid_cmd(
        numerator,
        denominator,
        ntoles,
        snap_to_grid,
        fixed,
        project_state,
        app,
    )?;

    Ok(DeltaMutationResponse {
        deltas: vec![dream_models::delta::ProjectDelta::ArrangementGridChanged {
            numerator,
            denominator,
            ntoles,
            snap_to_grid,
            fixed,
        }],
    })
}

#[tauri::command]
fn set_key_signature_cmd(
    enabled: bool,
    tonic: String,
    mode: String,
    project_state: tauri::State<'_, ProjectState>,
    app: tauri::AppHandle,
) -> Result<(), String> {
    let mut project = project_state.project.lock().map_err(|e| e.to_string())?;
    project.key_sig_enabled = enabled;
    project.key_sig_tonic = tonic;
    project.key_sig_mode = mode;
    let name = project.name.clone();
    drop(project);

    project_state.mark_dirty(&name, Some(&app))?;
    Ok(())
}

#[tauri::command]
fn set_key_signature_with_deltas_cmd(
    enabled: bool,
    tonic: String,
    mode: String,
    project_state: tauri::State<'_, ProjectState>,
    app: tauri::AppHandle,
) -> Result<DeltaMutationResponse, String> {
    set_key_signature_cmd(
        enabled,
        tonic.clone(),
        mode.clone(),
        project_state,
        app,
    )?;

    Ok(DeltaMutationResponse {
        deltas: vec![dream_models::delta::ProjectDelta::KeySignatureChanged {
            enabled,
            tonic,
            mode,
        }],
    })
}
