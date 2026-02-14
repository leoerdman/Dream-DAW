use super::*;

// ═══════════════════════════════════════════════════════════════════════

/// Undo the last project mutation.
///
/// Pops the most recent snapshot from the undo stack and swaps it
/// into the current project. The current state is pushed onto redo.
#[tauri::command]
async fn undo_cmd(
    project_state: tauri::State<'_, ProjectState>,
    clip_pool_state: tauri::State<'_, ClipPoolState>,
    automation_runtime: tauri::State<'_, AutomationRuntime>,
    handle: tauri::State<'_, AudioEngineHandle>,
) -> Result<(), String> {
    let mut undo = project_state.undo.lock().map_err(|e| e.to_string())?;
    let previous = undo.undo_stack.pop()
        .ok_or_else(|| "Nothing to undo".to_string())?;

    // Save current state to redo stack
    let mut project = project_state.project.lock().map_err(|e| e.to_string())?;
    let current_snapshot = SharedProjectSnapshot::from_project(&project, undo.redo_stack.last());
    undo.redo_stack.push(current_snapshot);
    *project = previous.to_project();
    drop(undo);

    *project_state.is_dirty.lock().map_err(|e| e.to_string())? = true;
    clip_pool_state.rebuild_snapshot(&project);
    rebuild_automation_snapshot_from_project(&project, &automation_runtime);
    rebuild_midi_snapshot_from_project(&project, &handle);
    rebuild_sampler_snapshot_from_project(&project, &clip_pool_state, &handle);
    log::info!("[IPC] undo_cmd: restored previous state");
    Ok(())
}

/// Redo a previously undone mutation.
///
/// Pops from the redo stack, pushes current state onto undo, and
/// swaps the redo snapshot into the project.
#[tauri::command]
async fn redo_cmd(
    project_state: tauri::State<'_, ProjectState>,
    clip_pool_state: tauri::State<'_, ClipPoolState>,
    automation_runtime: tauri::State<'_, AutomationRuntime>,
    handle: tauri::State<'_, AudioEngineHandle>,
) -> Result<(), String> {
    let mut undo = project_state.undo.lock().map_err(|e| e.to_string())?;
    let next = undo.redo_stack.pop()
        .ok_or_else(|| "Nothing to redo".to_string())?;

    // Save current state to undo stack
    let mut project = project_state.project.lock().map_err(|e| e.to_string())?;
    let current_snapshot = SharedProjectSnapshot::from_project(&project, undo.undo_stack.last());
    undo.undo_stack.push(current_snapshot);
    *project = next.to_project();
    drop(undo);

    *project_state.is_dirty.lock().map_err(|e| e.to_string())? = true;
    clip_pool_state.rebuild_snapshot(&project);
    rebuild_automation_snapshot_from_project(&project, &automation_runtime);
    rebuild_midi_snapshot_from_project(&project, &handle);
    rebuild_sampler_snapshot_from_project(&project, &clip_pool_state, &handle);
    log::info!("[IPC] redo_cmd: restored redo state");
    Ok(())
}

