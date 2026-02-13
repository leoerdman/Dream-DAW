// ═══════════════════════════════════════════════════════════════════════════
// Dream DAW — Mixer Engine
// ═══════════════════════════════════════════════════════════════════════════
//
// Real-time audio mixer for the DAW:
//   - Volume fader with dB-linear gain
//   - Stereo panning (constant-power pan law)
//   - Solo/mute logic (with implicit solo handling)
//   - VU metering (peak + RMS with ballistics)
//   - Summing bus for track → master mixing
//
// All processing functions are REAL-TIME SAFE:
//   No allocations, no locks, no I/O, bounded execution.
//
// ═══════════════════════════════════════════════════════════════════════════

pub mod gain;
pub mod pan;
pub mod meter;
pub mod bus;

pub use gain::{db_to_linear, linear_to_db, apply_gain};
pub use pan::{PanLaw, apply_pan};
pub use meter::VuMeter;
pub use bus::SummingBus;
