use std::path::PathBuf;
use std::sync::Mutex;

use dream_models::project::{DeviceNode, Project};
use tauri::Manager;

use crate::snapshot::{ProjectHistory, ProjectHistoryEvent, UndoState};

/// Thread-safe handle to the current project's state.
/// The project is independently managed from the audio engine.
/// Changes to the project trigger serialization and engine re-sync.
pub struct ProjectState {
    /// The currently loaded project.
    pub project: Mutex<Project>,

    /// Path to the current project file on disk. `None` if unsaved.
    pub file_path: Mutex<Option<PathBuf>>,

    /// Path to the project directory (Ableton-style folder). `None` if unsaved.
    pub project_folder: Mutex<Option<PathBuf>>,

    /// Whether the project has unsaved changes.
    pub is_dirty: Mutex<bool>,

    /// Undo/Redo history.
    pub(crate) undo: Mutex<UndoState>,
    pub(crate) history: Mutex<ProjectHistory>,

    /// Device clipboard — stores a copied DeviceNode for cross-track paste.
    pub device_clipboard: Mutex<Option<DeviceNode>>,
}

impl ProjectState {
    pub(crate) fn new() -> Self {
        Self {
            project: Mutex::new(Project::default()),
            file_path: Mutex::new(None),
            project_folder: Mutex::new(None),
            is_dirty: Mutex::new(false),
            undo: Mutex::new(UndoState::new()),
            history: Mutex::new(ProjectHistory::new()),
            device_clipboard: Mutex::new(None),
        }
    }

    /// Marks the project as dirty and updates the window title with a `*` suffix.
    ///
    /// This is the single choke-point for every mutation that makes the project
    /// "unsaved". The caller must supply the project name (to avoid a double-lock
    /// on `self.project` when the caller already holds it) and an optional
    /// `AppHandle` to update the native title bar.
    pub(crate) fn mark_dirty(
        &self,
        project_name: &str,
        app: Option<&tauri::AppHandle>,
    ) -> Result<(), String> {
        let mut dirty = self.is_dirty.lock().map_err(|e| e.to_string())?;
        let was_dirty = *dirty;
        *dirty = true;
        if !was_dirty
            && let Some(app) = app
            && let Some(window) = app.get_webview_window("main")
        {
            let _ = window.set_title(&format!("Dream DAW — {}*", project_name));
        }
        Ok(())
    }

    /// Clears the dirty flag and updates the window title (removes `*`).
    #[allow(dead_code)]
    pub(crate) fn clear_dirty(
        &self,
        project_name: &str,
        app: Option<&tauri::AppHandle>,
    ) -> Result<(), String> {
        *self.is_dirty.lock().map_err(|e| e.to_string())? = false;
        if let Some(app) = app
            && let Some(window) = app.get_webview_window("main")
        {
            let _ = window.set_title(&format!("Dream DAW — {}", project_name));
        }
        Ok(())
    }

    pub(crate) fn record_history(
        &self,
        kind: impl Into<String>,
        detail: impl Into<String>,
    ) -> Result<(), String> {
        let mut history = self.history.lock().map_err(|e| e.to_string())?;
        history.push(kind, detail);
        Ok(())
    }

    pub(crate) fn history_snapshot(
        &self,
        limit: Option<usize>,
        since_seq: Option<u64>,
    ) -> Result<Vec<ProjectHistoryEvent>, String> {
        let history = self.history.lock().map_err(|e| e.to_string())?;
        Ok(history.snapshot(limit, since_seq))
    }
}
