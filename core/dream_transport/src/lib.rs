// ═══════════════════════════════════════════════════════════════════════════
// Dream DAW — Transport State Machine
// ═══════════════════════════════════════════════════════════════════════════
//
// The transport controls the timeline playhead:
//   - Play / Stop / Record / Seek
//   - Loop regions with seamless looping
//   - Playhead position tracking (sample-accurate)
//   - Pre-roll / count-in
//
// The transport is the bridge between the UI and the audio engine.
// It sends commands via lock-free queues to the audio callback.
//
// ═══════════════════════════════════════════════════════════════════════════

pub mod loop_region;
pub mod playhead;
pub mod state;

pub use loop_region::LoopRegion;
pub use playhead::Playhead;
pub use state::{TransportCommand, TransportState};
