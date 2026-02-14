use super::*;

// ═══════════════════════════════════════════════════════════════════════

/// Creates a backup of the current project in the project's Backup/ directory.
///
/// Returns the path to the backup file, or an error if no project folder is set.
#[tauri::command]
fn create_backup_cmd(
    project_state: tauri::State<'_, ProjectState>,
) -> Result<String, String> {
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
    project_state: tauri::State<'_, ProjectState>,
    app: tauri::AppHandle,
) -> Result<(), String> {
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
    project_state: tauri::State<'_, ProjectState>,
    app: tauri::AppHandle,
) -> Result<(), String> {
    let project = project_state.project.lock().map_err(|e| e.to_string())?;
    let name = project.name.clone();
    let is_dirty = *project_state.is_dirty.lock().map_err(|e| e.to_string())?;
    drop(project);

    if let Some(window) = app.get_webview_window("main") {
        if is_dirty {
            let _ = window.set_title(&format!("Dream DAW — {}*", name));
        } else {
            let _ = window.set_title(&format!("Dream DAW — {}", name));
        }
    }
    Ok(())
}

