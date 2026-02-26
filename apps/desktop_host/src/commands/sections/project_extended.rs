// ═══════════════════════════════════════════════════════════════════════

/// Creates a backup of the current project in the project's Backup/ directory.
///
/// Returns the path to the backup file, or an error if no project folder is set.
#[tauri::command]
fn create_backup_cmd(
    project_registry: tauri::State<'_, crate::state_managers::ProjectRegistry>,
) -> Result<String, String>  {
    let active_project_arc = match project_registry.get_active_project() {
        Some(p) => p,
        None => return Err("No active project".to_string());
    };
    let project_state_guard = active_project_arc.read().unwrap();
    let project_state: &crate::state_managers::ProjectState = &*project_state_guard;
    let project = project_state.project.lock().map_err(|e| e.to_string())?;
    let folder = project_state.project_folder.lock().map_err(|e| e.to_string())?;

    let folder = folder
        .as_ref()
        .ok_or("No project folder set. Save the project first.")?;

    let backup_path = ProjectManager::create_backup(&project, folder)
        .map_err(|e| e.to_string())?;

    log::info!("Backup created: {}", backup_path.display());
    Ok(backup_path.display().to_string())
}

/// Marks the project as having unsaved changes (dirty state).
///
/// Called by the frontend when the user makes a change that isn't
/// tracked by a backend mutation (e.g., view state changes).
#[tauri::command]
fn mark_dirty_cmd(
    project_registry: tauri::State<'_, crate::state_managers::ProjectRegistry>,
    app: tauri::AppHandle,
) -> Result<(), String>  {
    let active_project_arc = match project_registry.get_active_project() {
        Some(p) => p,
        None => return Err("No active project".to_string());
    };
    let project_state_guard = active_project_arc.read().unwrap();
    let project_state: &crate::state_managers::ProjectState = &*project_state_guard;
    let project = project_state.project.lock().map_err(|e| e.to_string())?;
    let name = project.name.clone();
    drop(project);
    project_state.mark_dirty(&name, Some(&app))?;
    Ok(())
}

/// Syncs the window title with the current dirty state.
///
/// Called by the frontend after mutations to ensure the title bar
/// accurately reflects whether there are unsaved changes.
#[tauri::command]
fn sync_title_cmd(
    project_registry: tauri::State<'_, crate::state_managers::ProjectRegistry>,
    app: tauri::AppHandle,
) -> Result<(), String>  {
    let active_project_arc = match project_registry.get_active_project() {
        Some(p) => p,
        None => return Err("No active project".to_string());
    };
    let project_state_guard = active_project_arc.read().unwrap();
    let project_state: &crate::state_managers::ProjectState = &*project_state_guard;
    let project = project_state.project.lock().map_err(|e| e.to_string())?;
    let name = project.name.clone();
    let is_dirty = *project_state.is_dirty.lock().map_err(|e| e.to_string())?;
    drop(project);

    if is_dirty {
        crate::state_managers::project_state::safe_set_window_title(&app, &format!("Dream DAW — {}*", name));
    } else {
        crate::state_managers::project_state::safe_set_window_title(&app, &format!("Dream DAW — {}", name));
    }
    Ok(())
}

// ── Project Notes ─────────────────────────────────────────────────────

/// Returns the project-level notes (annotation) text.
#[tauri::command]
fn get_project_notes(
    project_registry: tauri::State<'_, crate::state_managers::ProjectRegistry>,
) -> Result<String, String>  {
    let active_project_arc = match project_registry.get_active_project() {
        Some(p) => p,
        None => return Err("No active project".to_string());
    };
    let project_state_guard = active_project_arc.read().unwrap();
    let project_state: &crate::state_managers::ProjectState = &*project_state_guard;
    let project = project_state.project.lock().map_err(|e| e.to_string())?;
    Ok(project.annotation.clone())
}

/// Sets the project-level notes (annotation) text and marks the project dirty.
#[tauri::command]
fn set_project_notes(
    text: String,
    project_registry: tauri::State<'_, crate::state_managers::ProjectRegistry>,
    app: tauri::AppHandle,
) -> Result<(), String>  {
    let active_project_arc = match project_registry.get_active_project() {
        Some(p) => p,
        None => return Err("No active project".to_string());
    };
    let project_state_guard = active_project_arc.read().unwrap();
    let project_state: &crate::state_managers::ProjectState = &*project_state_guard;
    {
        let mut project = project_state.project.lock().map_err(|e| e.to_string())?;
        // Only mutate if the text actually changed.
        if project.annotation == text {
            return Ok(());
        }
        project.annotation = text;
    }
    // Mark project dirty so autosave picks up the change.
    let name = {
        let project = project_state.project.lock().map_err(|e| e.to_string())?;
        project.name.clone()
    };
    project_state.mark_dirty(&name, Some(&app))?;
    Ok(())
}

