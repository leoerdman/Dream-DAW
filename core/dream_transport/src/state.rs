// ═══════════════════════════════════════════════════════════════════════════
// Dream DAW — Transport State + Commands
// ═══════════════════════════════════════════════════════════════════════════
//
// Defines the transport state machine and the command vocabulary
// for controlling playback from the UI thread.
//
// State transitions:
//   Stopped → Playing   (Play command)
//   Stopped → Recording (Record command)
//   Playing → Stopped   (Stop command)
//   Playing → Seeking   (Seek command, auto-resumes)
//   Recording → Stopped (Stop command)
//   Any → Stopped       (Panic command)
//
// ═══════════════════════════════════════════════════════════════════════════

/// The current state of the transport.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub enum TransportState {
    /// Playhead is stationary. Audio callback produces silence.
    #[default]
    Stopped,

    /// Playhead is advancing. Audio callback renders clips.
    Playing,

    /// Playhead is advancing AND input is being recorded.
    Recording,
}

/// Commands sent from the UI thread to the audio thread.
///
/// These are enqueued into a lock-free ring buffer (rtrb)
/// and consumed at the start of each audio callback.
#[derive(Debug, Clone, Copy)]
pub enum TransportCommand {
    /// Start playback from the current playhead position.
    Play,

    /// Stop playback / recording. Playhead stays at current position.
    Stop,

    /// Stop and return playhead to position 0.
    ReturnToZero,

    /// Jump to a specific sample frame position.
    Seek { position: i64 },

    /// Start recording from the current position.
    Record,

    /// Set the tempo (BPM). Used for live tempo changes.
    SetTempo { bpm: f64 },

    /// Enable/disable the loop region.
    SetLoopEnabled { enabled: bool },

    /// Set the loop region boundaries.
    SetLoopRegion { start: i64, end: i64 },

    /// Enable/disable the metronome click.
    SetMetronomeEnabled { enabled: bool },

    /// Master panic: stop everything, reset state.
    Panic,
}

/// Transport state machine that processes commands.
///
/// Lives on the audio thread. Receives commands from the UI
/// and updates state accordingly. The `Playhead` reads this state
/// to determine whether to advance.
#[derive(Debug)]
pub struct TransportController {
    /// Current state.
    state: TransportState,

    /// Whether metronome is enabled.
    metronome_enabled: bool,

    /// Current tempo in BPM.
    bpm: f64,
}

impl TransportController {
    /// Creates a new transport controller.
    pub fn new(initial_bpm: f64) -> Self {
        Self {
            state: TransportState::Stopped,
            metronome_enabled: false,
            bpm: initial_bpm,
        }
    }

    /// Returns the current state.
    #[inline]
    pub fn state(&self) -> TransportState {
        self.state
    }

    /// Whether the transport is actively advancing.
    #[inline]
    pub fn is_playing(&self) -> bool {
        matches!(
            self.state,
            TransportState::Playing | TransportState::Recording
        )
    }

    /// Whether recording is active.
    #[inline]
    pub fn is_recording(&self) -> bool {
        self.state == TransportState::Recording
    }

    /// Current tempo.
    #[inline]
    pub fn bpm(&self) -> f64 {
        self.bpm
    }

    /// Whether metronome is on.
    #[inline]
    pub fn metronome_enabled(&self) -> bool {
        self.metronome_enabled
    }

    /// Processes a single transport command.
    ///
    /// Returns `true` if the state changed, `false` if the command
    /// was redundant (e.g., Play while already playing).
    ///
    /// # Real-Time Safety
    /// This is called from the audio callback — no allocations.
    pub fn process_command(&mut self, cmd: TransportCommand) -> bool {
        match cmd {
            TransportCommand::Play => {
                if self.state == TransportState::Stopped {
                    self.state = TransportState::Playing;
                    log::debug!("Transport: Playing");
                    return true;
                }
            }
            TransportCommand::Stop => {
                if self.state != TransportState::Stopped {
                    self.state = TransportState::Stopped;
                    log::debug!("Transport: Stopped");
                    return true;
                }
            }
            TransportCommand::ReturnToZero => {
                self.state = TransportState::Stopped;
                log::debug!("Transport: Return to zero");
                return true;
            }
            TransportCommand::Seek { .. } => {
                // Seek is handled by the Playhead, not the state machine
                return true;
            }
            TransportCommand::Record => {
                // BUG-66 FIX: Allow recording from both Stopped AND Playing states.
                // Professional DAWs support punch-in recording while playing.
                if self.state == TransportState::Stopped
                    || self.state == TransportState::Playing
                {
                    self.state = TransportState::Recording;
                    log::debug!("Transport: Recording");
                    return true;
                }
            }
            TransportCommand::SetTempo { bpm } => {
                // BUG-54 FIX: Enforce minimum 20 BPM (was 0) to prevent division-by-zero
                // in beat-to-sample conversions.
                if (20.0..=999.0).contains(&bpm) {
                    self.bpm = bpm;
                    log::debug!("Transport: Tempo → {bpm} BPM");
                    return true;
                } else {
                    log::warn!("[Transport] Rejected tempo {bpm} BPM (valid: 20–999)");
                }
            }
            TransportCommand::SetMetronomeEnabled { enabled } => {
                self.metronome_enabled = enabled;
                return true;
            }
            TransportCommand::SetLoopEnabled { .. } | TransportCommand::SetLoopRegion { .. } => {
                // Loop commands are handled by the LoopRegion
                return true;
            }
            TransportCommand::Panic => {
                self.state = TransportState::Stopped;
                self.metronome_enabled = false;
                log::warn!("Transport: PANIC — all stopped");
                return true;
            }
        }
        false
    }
}

impl Default for TransportController {
    fn default() -> Self {
        Self::new(120.0)
    }
}

// ═══════════════════════════════════════════════════════════════════════════
// Tests
// ═══════════════════════════════════════════════════════════════════════════

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn initial_state_is_stopped() {
        let tc = TransportController::new(120.0);
        assert_eq!(tc.state(), TransportState::Stopped);
        assert!(!tc.is_playing());
        assert!(!tc.is_recording());
    }

    #[test]
    fn play_from_stopped() {
        let mut tc = TransportController::new(120.0);
        let changed = tc.process_command(TransportCommand::Play);
        assert!(changed);
        assert_eq!(tc.state(), TransportState::Playing);
        assert!(tc.is_playing());
    }

    #[test]
    fn stop_from_playing() {
        let mut tc = TransportController::new(120.0);
        tc.process_command(TransportCommand::Play);
        let changed = tc.process_command(TransportCommand::Stop);
        assert!(changed);
        assert_eq!(tc.state(), TransportState::Stopped);
    }

    #[test]
    fn play_while_playing_is_noop() {
        let mut tc = TransportController::new(120.0);
        tc.process_command(TransportCommand::Play);
        let changed = tc.process_command(TransportCommand::Play);
        assert!(!changed);
    }

    #[test]
    fn stop_while_stopped_is_noop() {
        let mut tc = TransportController::new(120.0);
        let changed = tc.process_command(TransportCommand::Stop);
        assert!(!changed);
    }

    #[test]
    fn record_from_stopped() {
        let mut tc = TransportController::new(120.0);
        let changed = tc.process_command(TransportCommand::Record);
        assert!(changed);
        assert_eq!(tc.state(), TransportState::Recording);
        assert!(tc.is_playing());
        assert!(tc.is_recording());
    }

    #[test]
    fn return_to_zero_stops() {
        let mut tc = TransportController::new(120.0);
        tc.process_command(TransportCommand::Play);
        let changed = tc.process_command(TransportCommand::ReturnToZero);
        assert!(changed);
        assert_eq!(tc.state(), TransportState::Stopped);
    }

    #[test]
    fn set_tempo() {
        let mut tc = TransportController::new(120.0);
        tc.process_command(TransportCommand::SetTempo { bpm: 140.0 });
        assert!((tc.bpm() - 140.0).abs() < 0.01);
    }

    #[test]
    fn set_tempo_rejects_invalid() {
        let mut tc = TransportController::new(120.0);
        let changed = tc.process_command(TransportCommand::SetTempo { bpm: 0.0 });
        assert!(!changed);
        assert!((tc.bpm() - 120.0).abs() < 0.01);
    }

    #[test]
    fn metronome_toggle() {
        let mut tc = TransportController::new(120.0);
        assert!(!tc.metronome_enabled());
        tc.process_command(TransportCommand::SetMetronomeEnabled { enabled: true });
        assert!(tc.metronome_enabled());
    }

    #[test]
    fn panic_stops_everything() {
        let mut tc = TransportController::new(120.0);
        tc.process_command(TransportCommand::Play);
        tc.process_command(TransportCommand::SetMetronomeEnabled { enabled: true });

        tc.process_command(TransportCommand::Panic);

        assert_eq!(tc.state(), TransportState::Stopped);
        assert!(!tc.metronome_enabled());
    }
}
