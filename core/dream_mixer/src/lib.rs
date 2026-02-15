// ═══════════════════════════════════════════════════════════════════════════
// Dream DAW — Mixer Engine
// ═══════════════════════════════════════════════════════════════════════════
//
// Real-time audio mixer for the DAW:
//   - Volume fader with dB-linear gain + anti-zipper ramping
//   - Stereo panning (constant-power pan law)
//   - Per-track channel strip (gain → pan → metering in one pass)
//   - Solo/mute resolver (implicit solo, mute-overrides-solo)
//   - VU metering (peak + RMS with ballistics)
//   - Summing bus for track → master mixing
//
// All processing functions are REAL-TIME SAFE:
//   No allocations, no locks, no I/O, bounded execution.
//
// ═══════════════════════════════════════════════════════════════════════════

pub mod bus;
pub mod channel_strip;
pub mod gain;
pub mod meter;
pub mod pan;
pub mod solo;

pub use bus::SummingBus;
pub use channel_strip::ChannelStrip;
pub use gain::{apply_gain, apply_gain_ramp, db_to_linear, linear_to_db};
pub use meter::VuMeter;
pub use pan::{PanLaw, apply_pan};
pub use solo::{ResolvedTrack, SoloResolver, TrackFlags};
