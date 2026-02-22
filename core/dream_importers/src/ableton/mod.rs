// ═══════════════════════════════════════════════════════════════════════
// Dream DAW — Ableton Live Set (.als) Import
// ═══════════════════════════════════════════════════════════════════════
//
// Submodule index for the Ableton ALS import pipeline.
//
// The import process is decomposed into focused modules:
//   • xml_helpers   — Low-level XML node traversal helpers
//   • color_map     — Ableton 70-color palette → TrackColor mapping
//   • routing       — Output/input routing target parsing
//   • file_resolver — Sample file path resolution
//
// ═══════════════════════════════════════════════════════════════════════

pub mod xml_helpers;
pub mod color_map;
pub mod routing;
pub mod file_resolver;
pub mod normalization;
pub mod plugin_mapper;
pub mod markers;
pub mod clip_parser;
pub mod automation;
pub mod parser;
