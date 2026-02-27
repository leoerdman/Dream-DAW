/// Imports an Ableton `.als` project and installs it as the active session.
#[tauri::command]
fn import_ableton_project(
    path: String,
    project_registry: tauri::State<'_, crate::state_managers::ProjectRegistry>,
    clip_pool_state: tauri::State<'_, ClipPoolState>,
    automation_runtime: tauri::State<'_, AutomationRuntime>,
    handle: tauri::State<'_, AudioEngineHandle>,
    plugin_host_state: tauri::State<'_, PluginHostState>,
    app: tauri::AppHandle,
) -> Result<DeltaMutationResponse, String>  {
    let active_project_arc = match project_registry.get_active_project() {
        Some(p) => p,
        None => return Err("No active project".to_string()),
    };
    let _project_state: &crate::state_managers::ProjectState = &*active_project_arc;
    open_project(
        path,
        project_registry.clone(),
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
    project_registry: tauri::State<'_, crate::state_managers::ProjectRegistry>,
    clip_pool_state: tauri::State<'_, ClipPoolState>,
    automation_runtime: tauri::State<'_, AutomationRuntime>,
    handle: tauri::State<'_, AudioEngineHandle>,
    plugin_host_state: tauri::State<'_, PluginHostState>,
    app: tauri::AppHandle,
) -> Result<DeltaMutationResponse, String>  {
    let active_project_arc = match project_registry.get_active_project() {
        Some(p) => p,
        None => return Err("No active project".to_string()),
    };
    let project_state: &crate::state_managers::ProjectState = &*active_project_arc;
    let mut new = dream_models::project::Project::default();
    new.normalize_invariants();
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

    // Update window title (safe — absorbs ObjC crashes from VST plugins)
    crate::state_managers::project_state::safe_set_window_title(&app, &format!("Dream DAW — {}", new.name));

    log::info!("New project created: '{}'", new.name);
    Ok(DeltaMutationResponse {
        deltas: vec![dream_models::delta::ProjectDelta::ProjectSnapshotReplaced {
            project: Box::new(new),
        }],
    })
}

fn canonical_project_path(path: &std::path::Path, project_name: &str) -> std::path::PathBuf {
    let canonical_name = if project_name.trim().is_empty() {
        "Untitled Project"
    } else {
        project_name.trim()
    };
    if path
        .extension()
        .and_then(|ext| ext.to_str())
        .is_some_and(|ext| ext.eq_ignore_ascii_case("ddpj"))
    {
        return path.to_path_buf();
    }
    let is_legacy_json = path
        .file_name()
        .and_then(|name| name.to_str())
        .is_some_and(|name| name.ends_with(".dream.json") || name.ends_with(".json"));
    if is_legacy_json {
        return path
            .parent()
            .unwrap_or(std::path::Path::new("."))
            .join(format!("{canonical_name}.ddpj"));
    }
    path.to_path_buf()
}

fn is_legacy_project_path(path: &std::path::Path) -> bool {
    path.file_name()
        .and_then(|name| name.to_str())
        .is_some_and(|name| name.ends_with(".dream.json") || name.ends_with(".json"))
}

/// Saves the current project to its existing path (or fails if unsaved).
#[tauri::command]
async fn save_project(
    project_registry: tauri::State<'_, crate::state_managers::ProjectRegistry>,
    plugin_host_state: tauri::State<'_, PluginHostState>,
    app: tauri::AppHandle,
) -> Result<String, String>  {
    let active_project_arc = match project_registry.get_active_project() {
        Some(p) => p,
        None => return Err("No active project".to_string()),
    };
    let project_state: &crate::state_managers::ProjectState = &*active_project_arc;
    let (snapshot, path, project_name, legacy_path_to_remove) = {
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

        let canonical_path = canonical_project_path(&path, &snapshot.name);
        let legacy_path_to_remove = if canonical_path != path && is_legacy_project_path(&path) {
            Some(path.clone())
        } else {
            None
        };
        (
            snapshot.clone(),
            canonical_path,
            snapshot.name.clone(),
            legacy_path_to_remove,
        )
    };

    let save_path = path.clone();
    tauri::async_runtime::spawn_blocking(move || ProjectFile::save(&snapshot, &save_path))
        .await
        .map_err(|e| format!("Save task join error: {e}"))?
        .map_err(|e| e.to_string())?;
    if let Some(legacy_path) = legacy_path_to_remove
        && legacy_path.exists()
        && let Err(e) = std::fs::remove_file(&legacy_path)
    {
        log::warn!(
            "[Save] Could not remove legacy project file {}: {}",
            legacy_path.display(),
            e
        );
    }

    {
        let mut project = project_state.project.lock().map_err(|e| e.to_string())?;
        project.name = project_name.clone();
    }
    *project_state.file_path.lock().map_err(|e| e.to_string())? = Some(path.clone());
    *project_state.project_folder.lock().map_err(|e| e.to_string())? =
        path.parent().map(|p| p.to_path_buf());

    *project_state.is_dirty.lock().map_err(|e| e.to_string())? = false;
    project_state.record_history("save", format!("saved to {}", path.display()))?;

    // Update window title (safe — absorbs ObjC crashes from VST plugins)
    crate::state_managers::project_state::safe_set_window_title(&app, &format!("Dream DAW — {}", project_name));

    log::info!("Project saved: '{}' → {}", project_name, path.display());
    Ok(path.display().to_string())
}

/// Saves the project to a specific path.
#[tauri::command]
async fn save_project_as(
    path: String,
    project_registry: tauri::State<'_, crate::state_managers::ProjectRegistry>,
    plugin_host_state: tauri::State<'_, PluginHostState>,
    app: tauri::AppHandle,
) -> Result<String, String>  {
    let active_project_arc = match project_registry.get_active_project() {
        Some(p) => p,
        None => return Err("No active project".to_string()),
    };
    let project_state: &crate::state_managers::ProjectState = &*active_project_arc;
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

    // Update window title (safe — absorbs ObjC crashes from VST plugins)
    crate::state_managers::project_state::safe_set_window_title(&app, &format!("Dream DAW — {}", project_name));

    log::info!("Project saved as: '{}' → {}", project_name, actual_file_path.display());
    Ok(result_path)
}

/// Opens a project from a file path.
#[tauri::command]
fn open_project(
    path: String,
    project_registry: tauri::State<'_, crate::state_managers::ProjectRegistry>,
    clip_pool_state: tauri::State<'_, ClipPoolState>,
    automation_runtime: tauri::State<'_, AutomationRuntime>,
    handle: tauri::State<'_, AudioEngineHandle>,
    plugin_host_state: tauri::State<'_, PluginHostState>,
    app: tauri::AppHandle,
) -> Result<DeltaMutationResponse, String>  {
    let active_project_arc = match project_registry.get_active_project() {
        Some(p) => p,
        None => return Err("No active project".to_string()),
    };
    let project_state: &crate::state_managers::ProjectState = &*active_project_arc;
    let file_path = PathBuf::from(&path);

    let importing_als = file_path
        .extension()
        .and_then(|s| s.to_str())
        .map(|s| s.eq_ignore_ascii_case("als"))
        .unwrap_or(false);

    let mut normalized_empty_tracks_on_load = false;
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
        // CRITICAL: Do NOT call normalize_internal_plugins_for_import() here.
        // That normalizer is intended for ALS imports (where plugin names need
        // mapping to internal://). Calling it on native .ddpj projects destroys
        // external VST3 plugin IDs (e.g. ShaperBox3 → Distortion) because the
        // keyword matcher hits on substrings like "shaper" in "ShaperBox".
        let (project, report) = ProjectFile::load_with_report(&file_path).map_err(|e| e.to_string())?;
        normalized_empty_tracks_on_load = report.default_tracks_injected;
        project
    };
    let mut als_auto_resolve_stats = MissingPluginAutoResolveStats::default();
    let missing_slots_before_auto_resolve = count_missing_plugin_slots(&loaded);
    if importing_als || missing_slots_before_auto_resolve > 0 {
        als_auto_resolve_stats = auto_resolve_missing_external_plugin_slots(&mut loaded);
    }
    if importing_als {
        for track in &mut loaded.tracks {
            track.height = track.height.clamp(24.0, 120.0);
        }
    }
    let als_norm_report = loaded.normalize_invariants();
    if importing_als && als_norm_report.default_tracks_injected {
        normalized_empty_tracks_on_load = true;
    }
    normalize_runtime_external_plugin_slots(&mut loaded, &plugin_host_state);
    refresh_offline_flags(&mut loaded);
    let missing_slots_after_auto_resolve = count_missing_plugin_slots(&loaded);
    let unresolved_missing_after_open = collect_missing_slot_labels(&loaded, 20);

    let _ = plugin_host_state.unload_all_instances();
    // Best-effort preload of external slots so imported projects sound/render
    // correctly immediately after open, without requiring manual plugin opens.
    // This remains non-fatal: any single plugin load failure is logged and the
    // project still opens.
    let mut external_slots_for_boot: Vec<dream_models::project::PluginSlot> = Vec::new();
    let mut collect_external_slot = |slot: &dream_models::project::PluginSlot| {
        let pid = slot.plugin_id.as_str();
        if !pid.starts_with("internal://") && !pid.starts_with("missing://") {
            external_slots_for_boot.push(slot.clone());
        }
    };
    for track in &loaded.tracks {
        if let Some(inst) = &track.instrument {
            for slot in inst.collect_plugin_slots() {
                collect_external_slot(slot);
            }
        }
        for node in &track.effects {
            for slot in node.collect_plugin_slots() {
                collect_external_slot(slot);
            }
        }
    }
    if let Some(inst) = &loaded.master_track.instrument {
        for slot in inst.collect_plugin_slots() {
            collect_external_slot(slot);
        }
    }
    for node in &loaded.master_track.effects {
        for slot in node.collect_plugin_slots() {
            collect_external_slot(slot);
        }
    }
    if !external_slots_for_boot.is_empty() {
        if let Some(err) = crate::commands::plugins_routing_helpers::load_external_slots_best_effort(
            &external_slots_for_boot,
            &plugin_host_state,
            "open_project_preload_external_plugins",
        ) {
            log::warn!("[OpenProject] External plugin preload completed with warning: {}", err);
        }
    }

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
    if normalized_empty_tracks_on_load {
        project_state.record_history(
            "project_invariant_fix",
            format!(
                "auto-injected default tracks for '{}' because source project had empty track list",
                loaded.name
            ),
        )?;
    }

    // ── Keep project-open hot path deterministic and low-latency ──────────
    // External plugin activation/probing is intentionally LAZY for both
    // native projects and ALS imports. Eager activation in open_project()
    // caused large startup stalls and CPU spikes on big sessions.
    log::info!(
        "[OpenProject] Skipping eager external plugin activation (lazy activation mode)"
    );

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

    // Update window title (safe — absorbs ObjC crashes from VST plugins)
    if importing_als {
        crate::state_managers::project_state::safe_set_window_title(&app, &format!("Dream DAW — {}*", loaded.name));
    } else {
        crate::state_managers::project_state::safe_set_window_title(&app, &format!("Dream DAW — {}", loaded.name));
    }

    if importing_als {
        log::info!(
            "Ableton project imported: '{}' ({} tracks) from {}",
            loaded.name,
            loaded.track_count(),
            file_path.display()
        );

        let missing_after = count_missing_plugin_slots(&loaded);
        let mut warped_clip_count = 0usize;
        let mut warp_marker_count = 0usize;
        let mut warped_with_source_frames = 0usize;
        for track in &loaded.tracks {
            for clip in &track.clips {
                if clip.is_warped {
                    warped_clip_count = warped_clip_count.saturating_add(1);
                    warp_marker_count = warp_marker_count.saturating_add(clip.warp_markers.len());
                    if clip.warp_source_duration_frames > 0 {
                        warped_with_source_frames = warped_with_source_frames.saturating_add(1);
                    }
                }
            }
        }

        let summary = AlsImportSummaryPayload {
            project_name: loaded.name.clone(),
            track_count: loaded.track_count(),
            missing_slots_before: missing_slots_before_auto_resolve,
            missing_slots_after: missing_after,
            auto_resolved_internal: als_auto_resolve_stats.replaced_internal,
            auto_resolved_external: als_auto_resolve_stats.replaced_external,
            warped_clip_count,
            warp_marker_count,
            warped_with_source_frames,
            unresolved_missing_labels: collect_missing_slot_labels(&loaded, 10),
        };
        let _ = app.emit("als_import_summary", &summary);
    } else {
        log::info!("Project opened: '{}' ({} tracks)", loaded.name, loaded.track_count());
    }

    if als_auto_resolve_stats.replaced_internal > 0
        || als_auto_resolve_stats.replaced_external > 0
        || missing_slots_after_auto_resolve > 0
    {
        let _ = app.emit(
            "missing_plugins_summary",
            serde_json::json!({
                "projectName": loaded.name,
                "source": if importing_als { "als_import" } else { "project_open" },
                "missingBefore": missing_slots_before_auto_resolve,
                "missingAfter": missing_slots_after_auto_resolve,
                "autoResolvedInternal": als_auto_resolve_stats.replaced_internal,
                "autoResolvedExternal": als_auto_resolve_stats.replaced_external,
                "unresolvedMissingLabels": unresolved_missing_after_open,
            }),
        );
    }
    Ok(DeltaMutationResponse {
        deltas: vec![dream_models::delta::ProjectDelta::ProjectSnapshotReplaced {
            project: Box::new(loaded),
        }],
    })
}

include!("project_management_missing.rs");

#[tauri::command]
fn get_recent_projects(
    app: tauri::AppHandle,
) -> Result<Vec<RecentProject>, String> {
    let app_data_dir = app.path().app_data_dir()
        .map_err(|e| e.to_string())?;
    let recent = RecentProjects::load(&app_data_dir);
    Ok(recent.projects)
}

/// Returns whether the project has unsaved changes and the current file path.
#[tauri::command]
fn get_project_status(
    project_registry: tauri::State<'_, crate::state_managers::ProjectRegistry>,
) -> Result<serde_json::Value, String>  {
    let active_project_arc = match project_registry.get_active_project() {
        Some(p) => p,
        None => return Err("No active project".to_string()),
    };
    let project_state: &crate::state_managers::ProjectState = &*active_project_arc;
    let is_dirty = *project_state.is_dirty.lock().map_err(|e| e.to_string())?;
    let file_path = project_state.file_path.lock().map_err(|e| e.to_string())?;
    let project_folder = project_state.project_folder.lock().map_err(|e| e.to_string())?;
    Ok(serde_json::json!({
        "isDirty": is_dirty,
        "filePath": file_path.as_ref().map(|p| p.display().to_string()),
        "projectFolder": project_folder.as_ref().map(|p| p.display().to_string()),
    }))
}

/// Bulk-resolves missing plugin slots using importer metadata + scanned runtime
/// descriptors and returns a full project snapshot delta for frontend sync.
#[tauri::command]
fn auto_resolve_missing_plugins_with_deltas_cmd(
    project_registry: tauri::State<'_, crate::state_managers::ProjectRegistry>,
    clip_pool_state: tauri::State<'_, ClipPoolState>,
    plugin_host_state: tauri::State<'_, PluginHostState>,
    app: tauri::AppHandle,
) -> Result<DeltaMutationResponse, String>  {
    let active_project_arc = match project_registry.get_active_project() {
        Some(p) => p,
        None => return Err("No active project".to_string()),
    };
    let project_state: &crate::state_managers::ProjectState = &*active_project_arc;
    let (snapshot, project_name, missing_before, missing_after, stats, unresolved_labels) = {
        let mut project = project_state.project.lock().map_err(|e| e.to_string())?;
        let missing_before = count_missing_plugin_slots(&project);
        let stats = auto_resolve_missing_external_plugin_slots(&mut project);
        normalize_runtime_external_plugin_slots(&mut project, &plugin_host_state);
        let missing_after = count_missing_plugin_slots(&project);
        let unresolved_labels = collect_missing_slot_labels(&project, 20);
        (
            project.clone(),
            project.name.clone(),
            missing_before,
            missing_after,
            stats,
            unresolved_labels,
        )
    };

    let slot_instance_map = plugin_host_state.slot_instance_snapshot();
    clip_pool_state.rebuild_external_fx_snapshot(&snapshot, slot_instance_map.as_ref());
    plugin_host_state.publish_registry();

    if stats.replaced_internal > 0 || stats.replaced_external > 0 || missing_before != missing_after {
        project_state.mark_dirty(&project_name, Some(&app))?;
    }

    log::info!(
        "[Missing plugins] bulk auto-resolve: before={}, after={}, internal_resolved={}, external_resolved={}, unresolved={}",
        missing_before,
        missing_after,
        stats.replaced_internal,
        stats.replaced_external,
        unresolved_labels.len(),
    );

    Ok(DeltaMutationResponse {
        deltas: vec![dream_models::delta::ProjectDelta::ProjectSnapshotReplaced {
            project: Box::new(snapshot),
        }],
    })
}

#[derive(Debug, Clone, serde::Serialize)]
struct AutoResolveMissingPluginsReportResponse {
    deltas: Vec<dream_models::delta::ProjectDelta>,
    missing_before: usize,
    missing_after: usize,
    resolved_internal: usize,
    resolved_external: usize,
    unresolved_labels: Vec<String>,
}

#[tauri::command]
fn auto_resolve_missing_plugins_report_with_deltas_cmd(
    project_registry: tauri::State<'_, crate::state_managers::ProjectRegistry>,
    clip_pool_state: tauri::State<'_, ClipPoolState>,
    plugin_host_state: tauri::State<'_, PluginHostState>,
    app: tauri::AppHandle,
) -> Result<AutoResolveMissingPluginsReportResponse, String>  {
    let active_project_arc = match project_registry.get_active_project() {
        Some(p) => p,
        None => return Err("No active project".to_string()),
    };
    let project_state: &crate::state_managers::ProjectState = &*active_project_arc;
    let (snapshot, project_name, missing_before, missing_after, stats, unresolved_labels) = {
        let mut project = project_state.project.lock().map_err(|e| e.to_string())?;
        let missing_before = count_missing_plugin_slots(&project);
        let stats = auto_resolve_missing_external_plugin_slots(&mut project);
        normalize_runtime_external_plugin_slots(&mut project, &plugin_host_state);
        let missing_after = count_missing_plugin_slots(&project);
        let unresolved_labels = collect_missing_slot_labels(&project, 20);
        (
            project.clone(),
            project.name.clone(),
            missing_before,
            missing_after,
            stats,
            unresolved_labels,
        )
    };

    let slot_instance_map = plugin_host_state.slot_instance_snapshot();
    clip_pool_state.rebuild_external_fx_snapshot(&snapshot, slot_instance_map.as_ref());
    plugin_host_state.publish_registry();

    if stats.replaced_internal > 0 || stats.replaced_external > 0 || missing_before != missing_after {
        project_state.mark_dirty(&project_name, Some(&app))?;
    }

    log::info!(
        "[Missing plugins] auto-resolve report: before={}, after={}, internal_resolved={}, external_resolved={}, unresolved={}",
        missing_before,
        missing_after,
        stats.replaced_internal,
        stats.replaced_external,
        unresolved_labels.len(),
    );

    Ok(AutoResolveMissingPluginsReportResponse {
        deltas: vec![dream_models::delta::ProjectDelta::ProjectSnapshotReplaced {
            project: Box::new(snapshot),
        }],
        missing_before,
        missing_after,
        resolved_internal: stats.replaced_internal,
        resolved_external: stats.replaced_external,
        unresolved_labels,
    })
}

#[derive(Debug, Clone, serde::Serialize)]
struct ArrangementViewportPayload {
    pixels_per_beat: Option<f64>,
    scroll_left: Option<f64>,
    scroll_top: Option<f64>,
}

/// Stores arrangement viewport metadata in the project model so it persists in `.ddpj`.
#[tauri::command]
fn set_arrangement_viewport_cmd(
    pixels_per_beat: f64,
    scroll_left: f64,
    scroll_top: Option<f64>,
    project_registry: tauri::State<'_, crate::state_managers::ProjectRegistry>,
) -> Result<(), String>  {
    let active_project_arc = match project_registry.get_active_project() {
        Some(p) => p,
        None => return Err("No active project".to_string()),
    };
    let project_state: &crate::state_managers::ProjectState = &*active_project_arc;
    let mut project = project_state.project.lock().map_err(|e| e.to_string())?;
    let ppb = pixels_per_beat.clamp(0.5, 2000.0);
    let scroll = scroll_left.max(0.0);
    let scroll_top = scroll_top.map(|v| v.max(0.0)).unwrap_or(0.0);

    project.view_zoom_scale = Some(ppb);
    project.view_scroll_position = Some(scroll);
    project.sequencer_navigator_zoom = Some(ppb);
    project.sequencer_navigator_scroll_x = Some(scroll.round() as i32);
    project.sequencer_navigator_scroll_y = Some(scroll_top.round() as i32);
    Ok(())
}

/// Reads persisted arrangement viewport metadata from the project model.
#[tauri::command]
fn get_arrangement_viewport_cmd(
    project_registry: tauri::State<'_, crate::state_managers::ProjectRegistry>,
) -> Result<ArrangementViewportPayload, String>  {
    let active_project_arc = match project_registry.get_active_project() {
        Some(p) => p,
        None => return Err("No active project".to_string()),
    };
    let project_state: &crate::state_managers::ProjectState = &*active_project_arc;
    let project = project_state.project.lock().map_err(|e| e.to_string())?;
    let pixels_per_beat = project.view_zoom_scale.or(project.sequencer_navigator_zoom);
    let scroll_left = project
        .view_scroll_position
        .or(project.sequencer_navigator_scroll_x.map(f64::from));
    let scroll_top = project.sequencer_navigator_scroll_y.map(f64::from);
    Ok(ArrangementViewportPayload {
        pixels_per_beat,
        scroll_left,
        scroll_top,
    })
}

/// Persists arrangement/editor grid settings in the project.
#[tauri::command]
fn set_arrangement_grid_cmd(
    numerator: u16,
    denominator: u16,
    ntoles: u8,
    snap_to_grid: bool,
    fixed: bool,
    project_registry: tauri::State<'_, crate::state_managers::ProjectRegistry>,
    app: tauri::AppHandle,
) -> Result<(), String>  {
    let active_project_arc = match project_registry.get_active_project() {
        Some(p) => p,
        None => return Err("No active project".to_string()),
    };
    let project_state: &crate::state_managers::ProjectState = &*active_project_arc;
    let cmd = dream_orchestrator::commands::SetArrangementGridCommand {
        numerator,
        denominator,
        ntoles,
        snap_to_grid,
        fixed,
    };
    execute_orchestrator_command(&project_state, &cmd)?;
    let name = project_state
        .project
        .lock()
        .map_err(|e| e.to_string())?
        .name
        .clone();

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
    project_registry: tauri::State<'_, crate::state_managers::ProjectRegistry>,
    app: tauri::AppHandle,
) -> Result<DeltaMutationResponse, String>  {
    let active_project_arc = match project_registry.get_active_project() {
        Some(p) => p,
        None => return Err("No active project".to_string()),
    };
    let project_state: &crate::state_managers::ProjectState = &*active_project_arc;
    let cmd = dream_orchestrator::commands::SetArrangementGridCommand {
        numerator,
        denominator,
        ntoles,
        snap_to_grid,
        fixed,
    };
    let result = execute_orchestrator_command(&project_state, &cmd)?;
    let name = project_state
        .project
        .lock()
        .map_err(|e| e.to_string())?
        .name
        .clone();
    project_state.mark_dirty(&name, Some(&app))?;

    Ok(DeltaMutationResponse {
        deltas: vec![dream_models::delta::ProjectDelta::ArrangementGridChanged {
            numerator: result.numerator,
            denominator: result.denominator,
            ntoles: result.ntoles,
            snap_to_grid: result.snap_to_grid,
            fixed: result.fixed,
        }],
    })
}

#[tauri::command]
fn set_key_signature_cmd(
    enabled: bool,
    tonic: String,
    mode: String,
    project_registry: tauri::State<'_, crate::state_managers::ProjectRegistry>,
    app: tauri::AppHandle,
) -> Result<(), String>  {
    let active_project_arc = match project_registry.get_active_project() {
        Some(p) => p,
        None => return Err("No active project".to_string()),
    };
    let project_state: &crate::state_managers::ProjectState = &*active_project_arc;
    let cmd = dream_orchestrator::commands::SetKeySignatureCommand {
        enabled,
        tonic,
        mode,
    };
    execute_orchestrator_command(&project_state, &cmd)?;
    let name = project_state
        .project
        .lock()
        .map_err(|e| e.to_string())?
        .name
        .clone();

    project_state.mark_dirty(&name, Some(&app))?;
    Ok(())
}

#[tauri::command]
fn set_key_signature_with_deltas_cmd(
    enabled: bool,
    tonic: String,
    mode: String,
    project_registry: tauri::State<'_, crate::state_managers::ProjectRegistry>,
    app: tauri::AppHandle,
) -> Result<DeltaMutationResponse, String>  {
    let active_project_arc = match project_registry.get_active_project() {
        Some(p) => p,
        None => return Err("No active project".to_string()),
    };
    let project_state: &crate::state_managers::ProjectState = &*active_project_arc;
    let cmd = dream_orchestrator::commands::SetKeySignatureCommand {
        enabled,
        tonic,
        mode,
    };
    let result = execute_orchestrator_command(&project_state, &cmd)?;
    let name = project_state
        .project
        .lock()
        .map_err(|e| e.to_string())?
        .name
        .clone();
    project_state.mark_dirty(&name, Some(&app))?;

    Ok(DeltaMutationResponse {
        deltas: vec![dream_models::delta::ProjectDelta::KeySignatureChanged {
            enabled: result.enabled,
            tonic: result.tonic,
            mode: result.mode,
        }],
    })
}

// ═══════════════════════════════════════════════════════════════════════════
// Auto-Save (Strike 6: Titanium Shield)
// ═══════════════════════════════════════════════════════════════════════════

/// Auto-saves the project if it has unsaved changes AND a file path is set.
///
/// Called periodically from the frontend (every 3 minutes). Silently no-ops
/// if the project is clean or has never been saved (no file path).
///
/// Uses the same `ProjectFile::save()` pipeline as manual save, which means:
/// - Atomic write (`.tmp` → `fsync` → `.bak` backup → `rename`)
/// - Crash-safe: power loss at any point preserves either old or new file
/// - Plugin state capture before serialization
#[tauri::command]
async fn auto_save_if_dirty(
    project_registry: tauri::State<'_, crate::state_managers::ProjectRegistry>,
    plugin_host_state: tauri::State<'_, PluginHostState>,
    app: tauri::AppHandle,
) -> Result<serde_json::Value, String>  {
    let active_project_arc = match project_registry.get_active_project() {
        Some(p) => p,
        None => return Err("No active project".to_string()),
    };
    let project_state: &crate::state_managers::ProjectState = &*active_project_arc;
    // ── Gate 1: Check dirty flag ──
    let is_dirty = *project_state.is_dirty.lock().map_err(|e| e.to_string())?;
    if !is_dirty {
        return Ok(serde_json::json!({ "saved": false, "reason": "clean" }));
    }

    // ── Gate 2: Check file path exists (skip unsaved/new projects) ──
    let raw_path = {
        let fp = project_state.file_path.lock().map_err(|e| e.to_string())?;
        match fp.as_ref() {
            Some(p) => p.clone(),
            None => return Ok(serde_json::json!({ "saved": false, "reason": "no_path" })),
        }
    };
    let project_name = project_state
        .project
        .lock()
        .map_err(|e| e.to_string())?
        .name
        .clone();
    let path = canonical_project_path(&raw_path, &project_name);
    let legacy_path_to_remove = if path != raw_path && is_legacy_project_path(&raw_path) {
        Some(raw_path.clone())
    } else {
        None
    };

    // ── Gate 3: Capture plugin states + serialize ──
    let snapshot = {
        let mut project = project_state.project.lock().map_err(|e| e.to_string())?;

        if let Err(e) = plugin_host_state.capture_plugin_states_into_project(&mut project) {
            log::warn!("[AutoSave] Plugin state capture failed (non-fatal): {e}");
        }

        project.clone()
    };

    // ── Gate 4: Atomic save (background thread) ──
    let save_path = path.clone();
    tauri::async_runtime::spawn_blocking(move || ProjectFile::save(&snapshot, &save_path))
        .await
        .map_err(|e| format!("AutoSave task join error: {e}"))?
        .map_err(|e| e.to_string())?;
    if let Some(legacy_path) = legacy_path_to_remove
        && legacy_path.exists()
        && let Err(e) = std::fs::remove_file(&legacy_path)
    {
        log::warn!(
            "[AutoSave] Could not remove legacy project file {}: {}",
            legacy_path.display(),
            e
        );
    }

    // ── Gate 5: Clear dirty flag ──
    *project_state.file_path.lock().map_err(|e| e.to_string())? = Some(path.clone());
    *project_state.project_folder.lock().map_err(|e| e.to_string())? =
        path.parent().map(|p| p.to_path_buf());
    *project_state.is_dirty.lock().map_err(|e| e.to_string())? = false;
    project_state.record_history("auto_save", format!("auto-saved to {}", path.display()))?;

    // Update window title (safe — absorbs ObjC crashes from VST plugins)
    {
        let project = project_state.project.lock().map_err(|e| e.to_string())?;
        crate::state_managers::project_state::safe_set_window_title(&app, &format!("Dream DAW — {}", project.name));
    }

    log::info!("[AutoSave] Project auto-saved → {}", path.display());
    Ok(serde_json::json!({ "saved": true, "path": path.display().to_string() }))
}
