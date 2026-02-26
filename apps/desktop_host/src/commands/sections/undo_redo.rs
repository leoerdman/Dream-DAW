// ═══════════════════════════════════════════════════════════════════════

/// Undo the last project mutation.
///
/// Pops the most recent snapshot from the undo stack and swaps it
/// into the current project. The current state is pushed onto redo.
#[tauri::command]
async fn undo_cmd(
    project_registry: tauri::State<'_, crate::state_managers::ProjectRegistry>,
    clip_pool_state: tauri::State<'_, ClipPoolState>,
    automation_runtime: tauri::State<'_, AutomationRuntime>,
    handle: tauri::State<'_, AudioEngineHandle>,
    app: tauri::AppHandle,
) -> Result<(), String>  {
    let active_project_arc = match project_registry.get_active_project() {
        Some(p) => p,
        None => return Err("No active project".to_string()),
    };
    let project_state: &crate::state_managers::ProjectState = &*active_project_arc;
    // Keep lock order consistent with push_undo(): project -> undo
    let mut project = project_state.project.lock().map_err(|e| e.to_string())?;
    let mut undo = project_state.undo.lock().map_err(|e| e.to_string())?;
    let previous = undo.undo_stack.pop_back()
        .ok_or_else(|| "Nothing to undo".to_string())?;

    // Save current state to redo stack
    let current_snapshot = SharedProjectSnapshot::from_project(&project, undo.redo_stack.back());
    undo.redo_stack.push_back(current_snapshot);
    // BUG-024 FIX: Cap redo stack to prevent unbounded memory growth.
    while undo.redo_stack.len() > MAX_REDO_DEPTH {
        undo.redo_stack.pop_front();
    }
    *project = previous.to_project();
    drop(undo);

    let project_name = project.name.clone();
    project_state.mark_dirty(&project_name, Some(&app))?;
    clip_pool_state.rebuild_snapshot(&project);
    rebuild_automation_snapshot_from_project(&project, &automation_runtime);
    rebuild_midi_snapshot_from_project(&project, &handle);
    rebuild_sampler_snapshot_from_project(&project, &clip_pool_state, &handle);
    rebuild_runtime_device_chains_from_project(&project, &handle)?;
    project_state.record_history("undo", "restored previous project snapshot")?;
    log::info!("[IPC] undo_cmd: restored previous state");
    Ok(())
}

/// Undo and return a snapshot delta for deterministic frontend sync.
#[tauri::command]
async fn undo_with_deltas_cmd(
    project_registry: tauri::State<'_, crate::state_managers::ProjectRegistry>,
    clip_pool_state: tauri::State<'_, ClipPoolState>,
    automation_runtime: tauri::State<'_, AutomationRuntime>,
    handle: tauri::State<'_, AudioEngineHandle>,
    app: tauri::AppHandle,
) -> Result<DeltaMutationResponse, String>  {
    let active_project_arc = match project_registry.get_active_project() {
        Some(p) => p,
        None => return Err("No active project".to_string()),
    };
    let project_state: &crate::state_managers::ProjectState = &*active_project_arc;
    let mut project = project_state.project.lock().map_err(|e| e.to_string())?;
    let mut undo = project_state.undo.lock().map_err(|e| e.to_string())?;
    let previous = undo
        .undo_stack
        .pop_back()
        .ok_or_else(|| "Nothing to undo".to_string())?;

    let current_snapshot = SharedProjectSnapshot::from_project(&project, undo.redo_stack.back());
    undo.redo_stack.push_back(current_snapshot);
    while undo.redo_stack.len() > MAX_REDO_DEPTH {
        undo.redo_stack.pop_front();
    }
    *project = previous.to_project();
    drop(undo);

    let project_name = project.name.clone();
    project_state.mark_dirty(&project_name, Some(&app))?;
    clip_pool_state.rebuild_snapshot(&project);
    rebuild_automation_snapshot_from_project(&project, &automation_runtime);
    rebuild_midi_snapshot_from_project(&project, &handle);
    rebuild_sampler_snapshot_from_project(&project, &clip_pool_state, &handle);
    rebuild_runtime_device_chains_from_project(&project, &handle)?;

    // BUG-002 FIX: Clone for delta response, then drop the project lock.
    // Previously, the clone happened while the lock was held, blocking all IPC.
    let snapshot_clone = project.clone();
    drop(project);

    project_state.record_history("undo", "restored previous project snapshot")?;
    log::info!("[IPC] undo_with_deltas_cmd: restored previous state");

    Ok(DeltaMutationResponse {
        deltas: vec![dream_models::delta::ProjectDelta::ProjectSnapshotReplaced {
            project: Box::new(snapshot_clone),
        }],
    })
}

/// Redo a previously undone mutation.
///
/// Pops from the redo stack, pushes current state onto undo, and
/// swaps the redo snapshot into the project.
#[tauri::command]
async fn redo_cmd(
    project_registry: tauri::State<'_, crate::state_managers::ProjectRegistry>,
    clip_pool_state: tauri::State<'_, ClipPoolState>,
    automation_runtime: tauri::State<'_, AutomationRuntime>,
    handle: tauri::State<'_, AudioEngineHandle>,
    app: tauri::AppHandle,
) -> Result<(), String>  {
    let active_project_arc = match project_registry.get_active_project() {
        Some(p) => p,
        None => return Err("No active project".to_string()),
    };
    let project_state: &crate::state_managers::ProjectState = &*active_project_arc;
    // Keep lock order consistent with push_undo(): project -> undo
    let mut project = project_state.project.lock().map_err(|e| e.to_string())?;
    let mut undo = project_state.undo.lock().map_err(|e| e.to_string())?;
    let next = undo.redo_stack.pop_back()
        .ok_or_else(|| "Nothing to redo".to_string())?;

    // Save current state to undo stack
    let current_snapshot = SharedProjectSnapshot::from_project(&project, undo.undo_stack.back());
    undo.undo_stack.push_back(current_snapshot);
    // BUG-025 FIX: Cap undo stack during redo — mirror of BUG-024 fix in undo_cmd.
    // Without this, repeated undo/redo cycles (Ctrl+Z / Ctrl+Shift+Z) cause
    // unbounded memory growth because every redo pushes a snapshot without eviction.
    while undo.undo_stack.len() > MAX_UNDO_DEPTH {
        undo.undo_stack.pop_front();
    }
    *project = next.to_project();
    drop(undo);

    let project_name = project.name.clone();
    project_state.mark_dirty(&project_name, Some(&app))?;
    clip_pool_state.rebuild_snapshot(&project);
    rebuild_automation_snapshot_from_project(&project, &automation_runtime);
    rebuild_midi_snapshot_from_project(&project, &handle);
    rebuild_sampler_snapshot_from_project(&project, &clip_pool_state, &handle);
    rebuild_runtime_device_chains_from_project(&project, &handle)?;
    project_state.record_history("redo", "reapplied project snapshot")?;
    log::info!("[IPC] redo_cmd: restored redo state");
    Ok(())
}

/// Redo and return a snapshot delta for deterministic frontend sync.
#[tauri::command]
async fn redo_with_deltas_cmd(
    project_registry: tauri::State<'_, crate::state_managers::ProjectRegistry>,
    clip_pool_state: tauri::State<'_, ClipPoolState>,
    automation_runtime: tauri::State<'_, AutomationRuntime>,
    handle: tauri::State<'_, AudioEngineHandle>,
    app: tauri::AppHandle,
) -> Result<DeltaMutationResponse, String>  {
    let active_project_arc = match project_registry.get_active_project() {
        Some(p) => p,
        None => return Err("No active project".to_string()),
    };
    let project_state: &crate::state_managers::ProjectState = &*active_project_arc;
    let mut project = project_state.project.lock().map_err(|e| e.to_string())?;
    let mut undo = project_state.undo.lock().map_err(|e| e.to_string())?;
    let next = undo
        .redo_stack
        .pop_back()
        .ok_or_else(|| "Nothing to redo".to_string())?;

    let current_snapshot = SharedProjectSnapshot::from_project(&project, undo.undo_stack.back());
    undo.undo_stack.push_back(current_snapshot);
    while undo.undo_stack.len() > MAX_UNDO_DEPTH {
        undo.undo_stack.pop_front();
    }
    *project = next.to_project();
    drop(undo);

    let project_name = project.name.clone();
    project_state.mark_dirty(&project_name, Some(&app))?;
    clip_pool_state.rebuild_snapshot(&project);
    rebuild_automation_snapshot_from_project(&project, &automation_runtime);
    rebuild_midi_snapshot_from_project(&project, &handle);
    rebuild_sampler_snapshot_from_project(&project, &clip_pool_state, &handle);
    rebuild_runtime_device_chains_from_project(&project, &handle)?;

    // BUG-003 FIX: Clone for delta response, then drop the project lock.
    let snapshot_clone = project.clone();
    drop(project);

    project_state.record_history("redo", "reapplied project snapshot")?;
    log::info!("[IPC] redo_with_deltas_cmd: restored redo state");

    Ok(DeltaMutationResponse {
        deltas: vec![dream_models::delta::ProjectDelta::ProjectSnapshotReplaced {
            project: Box::new(snapshot_clone),
        }],
    })
}
