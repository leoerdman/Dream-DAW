// ═══════════════════════════════════════════════════════════════════════
// Dream DAW — Ableton Live Set (.als) Import
// ═══════════════════════════════════════════════════════════════════════
//
// Submodule index for the Ableton ALS import pipeline.
//
// The import process is decomposed into focused modules:
//   • xml_helpers    — Low-level XML node traversal helpers
//   • color_map      — Ableton 70-color palette → TrackColor mapping
//   • routing        — Output/input routing target parsing
//   • file_resolver  — Sample file path resolution
//   • normalization  — Internal plugin normalization
//   • plugin_mapper  — Canonical plugin ID resolution, ExternalPluginIndex
//   • markers        — Project markers and scenes
//   • clip_parser    — Clip music feature parsers
//   • automation     — Pointee map, envelope import, consolidation
//   • rack_parser    — Recursive ALS rack parsing, macro mappings
//   • device_params  — Internal device static params, sampler config
//   • device_parser  — Additional device parsing helpers
//   • parser         — Top-level ALS document parsing
//
// ═══════════════════════════════════════════════════════════════════════

pub mod automation;
pub mod clip_parser;
pub mod color_map;
pub mod device_import;
pub mod device_params;
pub mod file_resolver;
pub mod markers;
pub mod normalization;
pub mod parser;
pub mod plugin_mapper;
pub mod project_import;
pub mod rack_parser;
pub mod routing;
pub mod track_import;
pub mod xml_helpers;
