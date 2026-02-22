// ═══════════════════════════════════════════════════════════════════════════
// Dream DAW — Orchestrator Context (Tauri-Free Abstraction Layer)
// ═══════════════════════════════════════════════════════════════════════════
//
// The OrchestratorContext trait defines everything the orchestrator needs
// from its host environment WITHOUT importing Tauri. This is the key
// decoupling point that enables headless operation.
//
// The Tauri layer implements this trait by delegating to its managed state.
// A test harness implements it with mock/in-memory state.
//
// ═══════════════════════════════════════════════════════════════════════════

use std::sync::{Arc, Mutex, MutexGuard};

use dream_clip_engine::pool::{ClipAudio, ClipPool};
use dream_models::project::Project;

use crate::error::{OrchestratorError, OrchestratorResult};

// ── Snapshot Rebuilder Trait ───────────────────────────────────────────

/// Abstraction over the lock-free snapshot synchronization between
/// the UI thread and the audio thread.
///
/// The Tauri layer holds `SharedClipSnapshot`, `SharedMidiSnapshot`, etc.
/// This trait lets the orchestrator trigger rebuilds without knowing
/// the concrete types.
pub trait SnapshotRebuilder: Send + Sync {
    /// Rebuild clip-only snapshots (positions/durations changed, no routing change).
    fn rebuild_clips_only(&self, project: &Project);

    /// Full rebuild: clips + routing + DAG + sidechains + external FX.
    fn rebuild_full(&self, project: &Project);

    /// Rebuild MIDI track snapshots for the audio thread.
    fn rebuild_midi(&self, project: &Project);

    /// Rebuild automation snapshots for the audio thread.
    fn rebuild_automation(&self, project: &Project);

    /// Rebuild sampler sample assignments.
    fn rebuild_samplers(&self, project: &Project);

    /// Evict clips from pool that are no longer referenced by any track.
    fn evict_unused_clips(&self, project: &Project);
}

// ── Undo Manager Trait ─────────────────────────────────────────────────

/// Abstraction over the undo/redo stack.
///
/// The concrete implementation lives in `desktop_host/src/snapshot.rs`.
/// The orchestrator only needs to push snapshots before mutations.
pub trait UndoManager: Send + Sync {
    /// Capture the current project state onto the undo stack.
    /// Must be called BEFORE any mutation.
    fn push_undo(&self, project: &Project) -> OrchestratorResult<()>;

    /// Coalesced undo for rapid sequential operations (drag, resize).
    /// Replaces the top of the stack if within the coalesce window.
    fn push_undo_coalesced(&self, project: &Project) -> OrchestratorResult<()>;
}

// ── Clip Pool Access ───────────────────────────────────────────────────

/// Read-only access to the decoded audio clip pool.
///
/// Used by commands that need to look up source durations, channel counts, etc.
pub trait ClipPoolAccess: Send + Sync {
    /// Get a clone of the clip audio metadata for a given file path.
    fn get_clip_audio(&self, file_path: &str) -> Option<Arc<ClipAudio>>;

    /// Insert decoded audio into the pool.
    fn insert_clip_audio(&self, audio: ClipAudio) -> OrchestratorResult<()>;

    /// Lock the pool for batch operations. Returns a guard.
    fn lock_pool(&self) -> OrchestratorResult<MutexGuard<'_, ClipPool>>;
}

// ── Dirty Flag / Title Update ──────────────────────────────────────────

/// Marks the project as having unsaved changes.
///
/// On Tauri, this also updates the window title bar with a `*` suffix.
/// In headless mode, this is a no-op or sets an internal flag.
pub trait DirtyMarker: Send + Sync {
    fn mark_dirty(&self, project_name: &str) -> OrchestratorResult<()>;
}

// ── History Recorder ───────────────────────────────────────────────────

/// Records project mutation history for the timeline/activity log.
pub trait HistoryRecorder: Send + Sync {
    fn record(&self, kind: &str, detail: &str) -> OrchestratorResult<()>;
}

// ── The Orchestrator Context ───────────────────────────────────────────

/// The central dependency container for ALL orchestrator operations.
///
/// Every command receives `&OrchestratorContext` and uses its trait objects
/// to interact with the host environment. This is the **only** interface
/// between the orchestrator and the outside world.
///
/// # Lifetime
/// Created once at app startup. Lives for the duration of the process.
/// All fields are `Arc`-wrapped for cheap cloning across async boundaries.
pub struct OrchestratorContext {
    /// The currently loaded project (thread-safe, single writer).
    pub project: Arc<Mutex<Project>>,

    /// Undo/redo management.
    pub undo: Arc<dyn UndoManager>,

    /// Lock-free snapshot synchronization with the audio thread.
    pub snapshots: Arc<dyn SnapshotRebuilder>,

    /// Decoded audio clip pool.
    pub clip_pool: Arc<dyn ClipPoolAccess>,

    /// Dirty flag management (title bar updates on Tauri).
    pub dirty: Arc<dyn DirtyMarker>,

    /// Project history recording.
    pub history: Arc<dyn HistoryRecorder>,
}

// ── Command Trait (CQRS Pattern) ───────────────────────────────────────

/// The CQRS Command trait.
///
/// Every project mutation is modeled as a command struct implementing this trait.
/// The transport layer (Tauri, CLI) constructs the command and calls
/// `ctx.execute(&cmd)`. The orchestrator handles undo, snapshots, dirty marking.
pub trait Command {
    /// The result type produced by executing this command.
    type Result;

    /// Execute the command's business logic.
    ///
    /// Implementations receive an `&OrchestratorContext` and use its traits
    /// to interact with project state, undo, snapshots, etc.
    fn execute(&self, ctx: &OrchestratorContext) -> OrchestratorResult<Self::Result>;
}

impl OrchestratorContext {
    /// Lock the project mutex, mapping poison errors to OrchestratorError.
    pub fn lock_project(&self) -> OrchestratorResult<MutexGuard<'_, Project>> {
        self.project
            .lock()
            .map_err(|e| OrchestratorError::LockPoisoned(e.to_string()))
    }

    /// Convenience: push undo using current project state.
    pub fn push_undo(&self) -> OrchestratorResult<()> {
        let project = self.lock_project()?;
        self.undo.push_undo(&project)
    }

    /// Convenience: push coalesced undo using current project state.
    pub fn push_undo_coalesced(&self) -> OrchestratorResult<()> {
        let project = self.lock_project()?;
        self.undo.push_undo_coalesced(&project)
    }

    /// Convenience: mark project dirty using name from locked project.
    pub fn mark_dirty_from_project(&self, project: &Project) -> OrchestratorResult<()> {
        self.dirty.mark_dirty(&project.name)
    }

    /// Execute any command via the CQRS dispatcher.
    ///
    /// This is the primary entry point for the transport layer:
    /// ```ignore
    /// let result = ctx.execute(&SplitClipCommand { clip_id, split_frame })?;
    /// ```
    pub fn execute<C: Command>(&self, cmd: &C) -> OrchestratorResult<C::Result> {
        cmd.execute(self)
    }

    /// Create a test/headless context with noop implementations.
    ///
    /// Used for unit testing commands without Tauri or audio engine.
    pub fn new(project: Project) -> Self {
        Self {
            project: Arc::new(Mutex::new(project)),
            undo: Arc::new(NoopUndoManager),
            snapshots: Arc::new(NoopSnapshotRebuilder),
            clip_pool: Arc::new(NoopClipPoolAccess),
            dirty: Arc::new(NoopDirtyMarker),
            history: Arc::new(NoopHistoryRecorder),
        }
    }
}

// ═══════════════════════════════════════════════════════════════════════════
// No-op implementations for headless / test mode
// ═══════════════════════════════════════════════════════════════════════════

/// No-op undo manager — used in tests and headless mode.
struct NoopUndoManager;
impl UndoManager for NoopUndoManager {
    fn push_undo(&self, _project: &Project) -> OrchestratorResult<()> { Ok(()) }
    fn push_undo_coalesced(&self, _project: &Project) -> OrchestratorResult<()> { Ok(()) }
}

/// No-op snapshot rebuilder — used in tests and headless mode.
struct NoopSnapshotRebuilder;
impl SnapshotRebuilder for NoopSnapshotRebuilder {
    fn rebuild_clips_only(&self, _project: &Project) {}
    fn rebuild_full(&self, _project: &Project) {}
    fn rebuild_midi(&self, _project: &Project) {}
    fn rebuild_automation(&self, _project: &Project) {}
    fn rebuild_samplers(&self, _project: &Project) {}
    fn evict_unused_clips(&self, _project: &Project) {}
}

/// No-op clip pool access — used in tests and headless mode.
struct NoopClipPoolAccess;
impl ClipPoolAccess for NoopClipPoolAccess {
    fn get_clip_audio(&self, _file_path: &str) -> Option<Arc<ClipAudio>> { None }
    fn insert_clip_audio(&self, _audio: ClipAudio) -> OrchestratorResult<()> { Ok(()) }
    fn lock_pool(&self) -> OrchestratorResult<MutexGuard<'_, ClipPool>> {
        Err(OrchestratorError::Other("NoopClipPoolAccess has no pool".to_string()))
    }
}

/// No-op dirty marker — used in tests and headless mode.
struct NoopDirtyMarker;
impl DirtyMarker for NoopDirtyMarker {
    fn mark_dirty(&self, _project_name: &str) -> OrchestratorResult<()> { Ok(()) }
}

/// No-op history recorder — used in tests and headless mode.
struct NoopHistoryRecorder;
impl HistoryRecorder for NoopHistoryRecorder {
    fn record(&self, _kind: &str, _detail: &str) -> OrchestratorResult<()> { Ok(()) }
}
