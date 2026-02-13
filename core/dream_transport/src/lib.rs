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

pub mod state;
pub mod playhead;
pub mod loop_region;

pub use state::{TransportState, TransportCommand};
pub use playhead::Playhead;
pub use loop_region::LoopRegion;
