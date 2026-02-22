// ═══════════════════════════════════════════════════════════════════════════
// Dream DAW — Orchestrator Error Types
// ═══════════════════════════════════════════════════════════════════════════

use std::fmt;

/// Unified error type for all orchestrator operations.
///
/// Replaces the ad-hoc `Result<T, String>` pattern scattered across Tauri handlers.
/// Each variant carries structured context for logging and user-facing messages.
#[derive(Debug)]
pub enum OrchestratorError {
    /// A UUID string could not be parsed.
    InvalidId {
        field: &'static str,
        value: String,
        source: uuid::Error,
    },

    /// The requested entity was not found (clip, track, plugin slot, etc.).
    NotFound { entity: &'static str, id: String },

    /// A parameter is out of its valid range.
    OutOfRange {
        param: &'static str,
        value: f64,
        min: f64,
        max: f64,
    },

    /// Track index exceeds the project's track count.
    TrackOutOfRange { requested: usize, total: usize },

    /// A project-level mutator operation failed.
    MutatorFailed(dream_models::mutators::MutatorError),

    /// A lock (Mutex) was poisoned — indicates a prior panic.
    LockPoisoned(String),

    /// Audio I/O error (file read, decode, etc.).
    AudioIo(String),

    /// Engine command queue is full.
    CommandQueueFull,

    /// Generic error with a message (escape hatch for migration).
    Other(String),
}

impl fmt::Display for OrchestratorError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::InvalidId {
                field,
                value,
                source,
            } => {
                write!(f, "Invalid {field} '{value}': {source}")
            }
            Self::NotFound { entity, id } => {
                write!(f, "{entity} not found: {id}")
            }
            Self::OutOfRange {
                param,
                value,
                min,
                max,
            } => {
                write!(f, "{param} value {value} out of range [{min}, {max}]")
            }
            Self::TrackOutOfRange { requested, total } => {
                write!(
                    f,
                    "Track out of range: requested {requested} but project has {total} tracks"
                )
            }
            Self::MutatorFailed(e) => write!(f, "Mutator error: {e:?}"),
            Self::LockPoisoned(ctx) => write!(f, "Lock poisoned: {ctx}"),
            Self::AudioIo(msg) => write!(f, "Audio I/O error: {msg}"),
            Self::CommandQueueFull => write!(f, "Command queue full — audio thread overloaded"),
            Self::Other(msg) => write!(f, "{msg}"),
        }
    }
}

impl std::error::Error for OrchestratorError {}

impl From<dream_models::mutators::MutatorError> for OrchestratorError {
    fn from(e: dream_models::mutators::MutatorError) -> Self {
        Self::MutatorFailed(e)
    }
}

/// Convenience alias used across the orchestrator.
pub type OrchestratorResult<T> = Result<T, OrchestratorError>;

/// Convert OrchestratorError to String for Tauri IPC compatibility.
///
/// Tauri command handlers require `Result<T, String>`. This impl allows
/// the transport layer to use `orchestrator.execute(cmd)?` with `?` operator
/// and automatic conversion.
impl From<OrchestratorError> for String {
    fn from(e: OrchestratorError) -> String {
        e.to_string()
    }
}
