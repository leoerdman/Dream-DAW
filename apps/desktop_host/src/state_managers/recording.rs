// ═══════════════════════════════════════════════════════════════════════════
// Dream DAW — Recording, Automation & MIDI Input Runtime State Managers
// ═══════════════════════════════════════════════════════════════════════════
//
// Three lightweight runtime state containers that are registered as
// Tauri managed state at startup:
//
//   RecordingRuntime   — active recording session + armed track
//   AutomationRuntime  — lock-free automation snapshot for the audio thread
//   MidiInputRuntime   — MIDI input device connection state
// ═══════════════════════════════════════════════════════════════════════════

use std::sync::{Arc, Mutex};

use dream_engine::driver::SharedAutomationSnapshot;
use dream_engine::recording::RecordingSession;

/// Runtime state for live recording sessions.
pub(crate) struct RecordingRuntime {
    pub(crate) session: Mutex<Option<RecordingSession>>,
    pub(crate) armed_track_index: Mutex<Option<usize>>,
}

impl RecordingRuntime {
    pub(crate) fn new() -> Self {
        Self {
            session: Mutex::new(None),
            armed_track_index: Mutex::new(None),
        }
    }
}

/// Runtime automation snapshot shared with the audio thread.
pub(crate) struct AutomationRuntime {
    pub(crate) snapshot: Arc<SharedAutomationSnapshot>,
}

impl AutomationRuntime {
    pub(crate) fn new() -> Self {
        Self {
            snapshot: Arc::new(SharedAutomationSnapshot::new()),
        }
    }
}

/// Runtime MIDI input connection state.
pub(crate) struct MidiInputRuntime {
    pub(crate) connection: Mutex<Option<midir::MidiInputConnection<()>>>,
    pub(crate) connected_port: Mutex<Option<String>>,
}

impl MidiInputRuntime {
    pub(crate) fn new() -> Self {
        Self {
            connection: Mutex::new(None),
            connected_port: Mutex::new(None),
        }
    }
}
