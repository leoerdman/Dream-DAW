// ═══════════════════════════════════════════════════════════════════════════
// Dream DAW — Pure DSP Math Library
// ═══════════════════════════════════════════════════════════════════════════
//
// This crate contains ZERO OS-specific or thread-related code.
// It operates exclusively on `&[f32]` / `&mut [f32]` buffers.
//
// Modules:
//   fades      — Hann-window micro-fades for click-free clip boundaries
//   resampler  — Polyphase sinc resampler via `rubato` (studio-grade)
//
// All functions are designed to be called from the audio hot path
// after pre-allocation. No heap allocations during processing.
//
// ═══════════════════════════════════════════════════════════════════════════

pub mod biquad;
pub mod fades;
pub mod resampler;
pub mod spectrum_analyzer;
pub mod svf;

// ── Device Chain DSP (Sprint: Insert FX Pipeline) ──────────────────────
pub mod device_chain;
pub mod dsp_processor;
pub mod processors;

#[cfg(test)]
mod stress_tests;
