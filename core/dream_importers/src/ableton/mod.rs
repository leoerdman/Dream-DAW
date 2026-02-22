// ═══════════════════════════════════════════════════════════════════════
// Ableton Live Set (.als) Importer
// ═══════════════════════════════════════════════════════════════════════
//
// Parses Ableton `.als` files (gzip-compressed XML) into a Dream DAW
// `Project`. This module is the single source of truth for all ALS
// parsing logic — no parsing code should live in the Tauri layer.
//
// Architecture:
//   xml_helpers  — Low-level roxmltree value extraction utilities
//   clip_parser  — Audio/MIDI clip parsing (warp markers, envelopes, etc.)
//   markers      — Locator/CuePoint/Scene parsing
//   device_parser — Track device chain and rack parsing
//   automation   — Track automation envelope import
//   normalization — Plugin ID canonicalization
//   color        — Ableton 70-color palette mapping
//   parser       — Top-level orchestrator (import_als_project)
//
// ═══════════════════════════════════════════════════════════════════════

mod xml_helpers;
mod clip_parser;
mod markers;
mod device_parser;
mod automation;
mod normalization;
mod color;
mod parser;

// Re-export the public API
pub use parser::import_als_project;
pub use parser::import_als_project_with_target_sample_rate;
pub use normalization::normalize_internal_plugins_for_import;
