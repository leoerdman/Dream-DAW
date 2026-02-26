use std::path::PathBuf;
use std::sync::Mutex;

use dream_models::project::{DeviceNode, Project};
use tauri::{Emitter, Manager};
use uuid::Uuid;

use crate::snapshot::{ProjectHistory, ProjectHistoryEvent, UndoState};

// ═══════════════════════════════════════════════════════════════════════
// Safe Window Title Setter
// ═══════════════════════════════════════════════════════════════════════
//
// `NSWindow::setTitle` goes through `NSAttributedString` intent resolution
// on macOS 26+ which calls `objc_getAssociatedObject`. When third-party
// VST plugins (e.g. Slate Digital's SlateCore) corrupt the ObjC runtime's
// associated-objects hash map, this path triggers a SIGILL / Data Abort.
//
// This wrapper function:
//  1. Emits a Tauri event so the frontend can update `document.title`
//     (safe — does not touch AppKit / ObjC).
//  2. Calls `window.set_title()` inside `catch_unwind` so that any panic
//     (or poisoned state) is absorbed without taking down the process.
//
// SIGILL itself is a signal and cannot be caught by `catch_unwind`.
// To fully isolate, the native title update is deferred to a dedicated
// thread with a small stack, so a potential stack probe crash stays
// contained to that thread.
// ═══════════════════════════════════════════════════════════════════════

/// Sets the window title safely, absorbing any ObjC runtime crash.
///
/// This is the ONLY function in the codebase that should call
/// `window.set_title()`.  All other call sites must go through here.
pub(crate) fn safe_set_window_title(app: &tauri::AppHandle, title: &str) {
    // 1. Always emit to the frontend so it can update `document.title`.
    //    This path never touches AppKit and is always safe.
    let _ = app.emit("__internal_set_title", title);

    // 2. Update the native title bar — isolated via catch_unwind + thread.
    let title_owned = title.to_string();
    if let Some(window) = app.get_webview_window("main") {
        // Spawn a detached thread specifically for the native title update.
        // If the ObjC runtime is corrupted, the SIGILL will kill only
        // this thread instead of the entire process.
        let _ = std::thread::Builder::new()
            .name("set-title-guard".into())
            .stack_size(64 * 1024) // small stack — title setting is trivial
            .spawn(move || {
                let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
                    let _ = window.set_title(&title_owned);
                }));
                if let Err(err) = result {
                    log::error!(
                        "[Window] set_title panicked (likely ObjC runtime corruption from VST plugin): {:?}",
                        err
                    );
                }
            });
    }
}

/// Thread-safe handle to the current project's state.
/// The project is independently managed from the audio engine.
/// Changes to the project trigger serialization and engine re-sync.
pub struct ProjectState {
    /// Unique identifier for this specific project instance in memory.
    pub id: Uuid,

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
            id: Uuid::new_v4(),
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
        {
            safe_set_window_title(app, &format!("Dream DAW — {}*", project_name));
        }
        Ok(())
    }

    pub(crate) fn mark_dirty_current(&self, app: Option<&tauri::AppHandle>) -> Result<(), String> {
        let project_name = self.project.lock().map_err(|e| e.to_string())?.name.clone();
        self.mark_dirty(&project_name, app)
    }

    /// Clears the dirty flag and updates the window title (removes `*`).
    #[allow(dead_code)]
    pub(crate) fn clear_dirty(
        &self,
        project_name: &str,
        app: Option<&tauri::AppHandle>,
    ) -> Result<(), String> {
        *self.is_dirty.lock().map_err(|e| e.to_string())? = false;
        if let Some(app) = app {
            safe_set_window_title(app, &format!("Dream DAW — {}", project_name));
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

