// ═══════════════════════════════════════════════════════════════════════════
// Dream DAW — WebGPU Timeline & Waveform Renderer
// ═══════════════════════════════════════════════════════════════════════════
//
// This crate handles all GPU rendering for the DAW timeline:
//   - Instanced clip rendering (10K+ clips at 120fps)
//   - Waveform peak visualization (GPU-side interpolation)
//   - SDF rounded rectangles with Liquid Glass aesthetics
//   - MIDI note overlays
//
// All rendering uses `wgpu` (WebGPU) for cross-platform GPU access.
// The shaders are written in WGSL and embedded at compile time.
//
// Architecture:
//   CPU: Prepares ClipInstance buffer → GPU: Draws all clips in 1 draw call
//
// ═══════════════════════════════════════════════════════════════════════════

pub mod gpu_types;
pub mod viewport;
pub mod timeline;

pub use gpu_types::*;
pub use viewport::Viewport;
pub use timeline::TimelineRenderer;
