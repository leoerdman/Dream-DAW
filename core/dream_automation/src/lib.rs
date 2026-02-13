// ═══════════════════════════════════════════════════════════════════════════
// Dream DAW — Automation System
// ═══════════════════════════════════════════════════════════════════════════
//
// Breakpoint-based automation curves for parameter control.
//
// Architecture:
//   AutomationCurve → breakpoint keyframes + interpolation
//   AutomationMode → Read / Write / Touch / Latch behavior
//   AutomationLane → curve + target parameter binding
//
// ═══════════════════════════════════════════════════════════════════════════

pub mod curve;
pub mod mode;
pub mod lane;

pub use curve::{AutomationCurve, AutomationPoint, InterpolationMode};
pub use mode::AutomationMode;
pub use lane::AutomationLane;
