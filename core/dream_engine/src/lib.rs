// ═══════════════════════════════════════════════════════════════════════════
// Dream DAW — Real-Time Audio Engine
// ═══════════════════════════════════════════════════════════════════════════
//
// This crate initializes the platform audio subsystem via `cpal` and runs
// the real-time audio callback. The callback is THE HOT PATH.
//
//   ❌ NO heap allocations (no String, no Vec::new(), no Box::new())
//   ❌ NO mutex locks (no Mutex, no RwLock, no condvar)
//   ❌ NO I/O (no println!, no file access, no network)
//   ❌ NO panics (no unwrap(), no expect(), no array bounds violations)
//   ✅ Only: atomic reads, rtrb pops, f32 math, buffer writes
//
// ═══════════════════════════════════════════════════════════════════════════

pub mod driver;
pub mod external_device_slot;
pub mod offline_bounce;
mod offline_bounce_types;
pub mod recording;
pub mod render_callback;

// ── Instrument Core ────────────────────────────────────────────────────
// Shared types for all internal instrument engines (ADSR, voice constants).
pub mod instrument_core;
// Synth-specific types (Waveform, SynthFilterType, LfoTarget).
pub mod synth_types;
// PolyBLEP oscillator functions for synthesis engines.
mod oscillator;

// ── Instrument Engines ─────────────────────────────────────────────────
// Sample-playback engine (SamplerEngine, SampleRackEngine).
pub mod sampler;
// Subtractive synthesizer engine (EssenceSynthEngine).
pub mod essence_synth;
