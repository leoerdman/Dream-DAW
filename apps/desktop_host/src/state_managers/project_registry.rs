use std::sync::{Arc, Mutex};
use std::sync::atomic::{AtomicU64, Ordering};
use dashmap::DashMap;
use arc_swap::ArcSwapOption;
use uuid::Uuid;

use crate::state_managers::ProjectState;
use dream_models::project::{AudioClip, DeviceNode, Track};
use dream_models::midi::MidiClip;

/// ═══════════════════════════════════════════════════════════════════════════
/// Project Registry (Multi-Project Architecture)
/// ═══════════════════════════════════════════════════════════════════════════
///
/// Holds all concurrently open projects in memory.
/// Replaces the old `std::sync::Mutex<ProjectState>` singleton pattern.
pub struct ProjectRegistry {
    /// The visually active project (the tab the user sees in the UI).
    pub active_project_id: Arc<ArcSwapOption<Uuid>>,

    /// The project whose audio is currently being rendered by the engine.
    /// May differ from `active_project_id` during tab switching —
    /// the engine continues playing the old project until the user presses Play.
    pub audio_active_project_id: Arc<ArcSwapOption<Uuid>>,

    /// Thread-safe map containing ALL open projects.
    pub(crate) open_projects: DashMap<Uuid, Arc<ProjectState>>,

    // ── Global Clipboards (cross-project) ──

    /// Serialized clip data for cross-project copy/paste.
    pub global_clip_clipboard: Mutex<Option<GlobalClipData>>,

    /// Full track data for cross-project track copy/paste.
    pub global_track_clipboard: Mutex<Option<Track>>,

    /// Device node for cross-project device copy/paste.
    /// Replaces the per-project `device_clipboard` in `ProjectState`.
    pub global_device_clipboard: Mutex<Option<DeviceNode>>,

    /// Monotonically increasing counter for background swap operations.
    /// Each `switch_project_tab` increments this. Background threads check
    /// their snapshot against the current value and abort if superseded.
    pub swap_generation: AtomicU64,
}

/// Serialized clip data stored in the global clipboard.
/// Contains everything needed to reconstruct clips in a different project.
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
pub struct GlobalClipData {
    pub source_project_id: String,
    pub source_bpm: f64,
    pub source_sample_rate: f64,
    pub clips: Vec<AudioClip>,
    pub midi_clips: Vec<MidiClip>,
}

impl Default for ProjectRegistry {
    fn default() -> Self {
        Self::new()
    }
}

impl ProjectRegistry {
    pub fn new() -> Self {
        Self {
            active_project_id: Arc::new(ArcSwapOption::const_empty()),
            audio_active_project_id: Arc::new(ArcSwapOption::const_empty()),
            open_projects: DashMap::new(),
            global_clip_clipboard: Mutex::new(None),
            global_track_clipboard: Mutex::new(None),
            global_device_clipboard: Mutex::new(None),
            swap_generation: AtomicU64::new(0),
        }
    }

    /// Retrieves an Arc reference to the active project state.
    pub fn get_active_project(&self) -> Option<Arc<ProjectState>> {
        let active_id_guard = self.active_project_id.load();
        if let Some(active_id) = &*active_id_guard {
            self.open_projects.get(active_id).map(|p| p.value().clone())
        } else {
            None
        }
    }

    /// Adds a new project to the registry. Does NOT make it active automatically.
    pub fn add_project(&self, state: Arc<ProjectState>) {
        let id = state.id;
        self.open_projects.insert(id, state);
    }

    /// Atomically swaps the visually-active project ID.
    pub fn set_active_project(&self, id: Uuid) {
        self.active_project_id.store(Some(Arc::new(id)));
    }

    /// Atomically swaps the audio-active project ID.
    pub fn set_audio_active_project(&self, id: Uuid) {
        self.audio_active_project_id.store(Some(Arc::new(id)));
    }

    /// Returns the UUID of the project whose audio is currently rendering.
    pub fn get_audio_active_project_id(&self) -> Option<Uuid> {
        self.audio_active_project_id.load().as_deref().copied()
    }

    /// Returns the Arc<ProjectState> of the audio-active project.
    pub fn get_audio_active_project(&self) -> Option<Arc<ProjectState>> {
        let id_guard = self.audio_active_project_id.load();
        if let Some(id) = &*id_guard {
            self.open_projects.get(id).map(|p| p.value().clone())
        } else {
            None
        }
    }

    /// Returns the number of open projects.
    pub fn project_count(&self) -> usize {
        self.open_projects.len()
    }

    /// Retrieves a specific project by UUID.
    pub fn get_project(&self, id: &Uuid) -> Option<Arc<ProjectState>> {
        self.open_projects.get(id).map(|p| p.value().clone())
    }

    /// Removes a project from the registry by UUID.
    /// Returns the removed project if found.
    pub fn remove_project(&self, id: &Uuid) -> Option<Arc<ProjectState>> {
        self.open_projects.remove(id).map(|(_, v)| v)
    }

    /// Returns lightweight metadata for all open projects.
    /// Used by the frontend to populate tab names and dirty indicators.
    pub fn list_project_infos(&self) -> Vec<ProjectInfo> {
        self.open_projects
            .iter()
            .map(|entry| {
                let state = entry.value();
                let name = state
                    .project
                    .lock()
                    .map(|p| p.name.clone())
                    .unwrap_or_else(|_| "???".to_string());
                let file_path = state
                    .file_path
                    .lock()
                    .ok()
                    .and_then(|fp| fp.as_ref().map(|p| p.display().to_string()));
                let is_dirty = state.is_dirty.lock().map(|d| *d).unwrap_or(false);
                ProjectInfo {
                    id: state.id.to_string(),
                    name,
                    file_path,
                    is_dirty,
                }
            })
            .collect()
    }

    /// Returns any remaining project after a tab close.
    /// Encapsulates DashMap iteration so callers don't need field access.
    pub fn first_remaining(&self) -> Option<Arc<ProjectState>> {
        self.open_projects
            .iter()
            .next()
            .map(|entry| entry.value().clone())
    }

    /// Atomically increments the swap generation counter and returns the new value.
    /// Used by `switch_project_tab` to invalidate any in-flight background swaps.
    pub fn next_swap_generation(&self) -> u64 {
        self.swap_generation.fetch_add(1, Ordering::SeqCst) + 1
    }

    /// Returns the current swap generation.
    pub fn current_swap_generation(&self) -> u64 {
        self.swap_generation.load(Ordering::SeqCst)
    }
}

/// Lightweight project metadata for frontend tab synchronization.
#[derive(Debug, Clone, serde::Serialize)]
pub struct ProjectInfo {
    pub id: String,
    pub name: String,
    #[serde(rename = "filePath")]
    pub file_path: Option<String>,
    #[serde(rename = "isDirty")]
    pub is_dirty: bool,
}

/// Resolves the active project from a `ProjectRegistry`, returning an `Err`
/// if no project is currently active. Returns `Arc<ProjectState>`.
///
/// Usage inside any `#[tauri::command]` function:
/// ```ignore
/// let project = active_project!(project_registry);
/// // `project` is `Arc<ProjectState>`, use `&*project` for `&ProjectState`.
/// ```
macro_rules! active_project {
    ($registry:expr) => {{
        $registry
            .get_active_project()
            .ok_or_else(|| "No active project".to_string())?
    }};
}
pub(crate) use active_project;
