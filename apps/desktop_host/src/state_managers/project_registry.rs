use std::sync::Arc;
use dashmap::DashMap;
use arc_swap::ArcSwapOption;
use uuid::Uuid;
use parking_lot::RwLock;

use crate::state_managers::ProjectState;

/// ═══════════════════════════════════════════════════════════════════════════
/// Project Registry (Multi-Project Architecture)
/// ═══════════════════════════════════════════════════════════════════════════
///
/// Holds all concurrently open projects in memory.
/// Replaces the old `std::sync::Mutex<ProjectState>` singleton pattern.
pub struct ProjectRegistry {
    /// The global ID of the tab the user is currently looking at and listening to.
    /// Loaded atomically by the Audio Thread Multiplexer.
    pub active_project_id: Arc<ArcSwapOption<Uuid>>,

    /// Thread-safe map containing ALL open projects.
    /// Uses `std::sync::RwLock` for fast read/write locks inside the map.
    pub open_projects: DashMap<Uuid, Arc<ProjectState>>,
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
            open_projects: DashMap::new(),
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

    /// Atomically swaps the active project ID.
    pub fn set_active_project(&self, id: Uuid) {
        self.active_project_id.store(Some(Arc::new(id)));
    }
}
