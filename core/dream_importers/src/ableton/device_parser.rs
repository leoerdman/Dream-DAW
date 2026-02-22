// ═══════════════════════════════════════════════════════════════════════
// Device Parser — Track device chain and rack parsing from ALS XML
// ═══════════════════════════════════════════════════════════════════════
//
// Parses Ableton device nodes into Dream DAW DeviceNode/DeviceRack
// structures, including external plugin metadata, rack chains, and
// zone settings.
//
// This module will be fully populated during Phase 1A extraction.
// ═══════════════════════════════════════════════════════════════════════

#![allow(unused_imports)]

use crate::ableton::xml_helpers::*;
use dream_models::project::{self, DeviceNode, DeviceRack, RackChain, PluginSlot, Track};
use std::path::Path;

// ── Stub: to be populated with full extraction from project_management.rs ──
// Functions to extract:
// - parse_track_send_manual_values (L736-L764)
// - parse_output_target (L766-L818)
// - choose_preferred_output_target (L860-L872)
// - classify_output_routing_target (L891-L910)
// - resolve_als_file_path (L950-L1046)
// - make_missing_plugin_slot (L1048-L1072)
// - make_missing_external_plugin_slot_with_metadata (L1086-L1167)
// - ExternalPluginMeta + parse_external_plugin_meta (L1177-L1354)
// - ExternalPluginIndex (L1356-L1500)
// - collect_devices_in_container / collect_track_devices (L1502-L1557)
// - parse_als_rack / parse_als_rack_chains (L4044-L4492)
// - import_track_devices (L5139-L5428)
// - import_track_clips (L3598-L3909)
// - infer_device_display_name (L3518-L3567)
// - collect_device_manual_params (L4536-L4550)
// - import_internal_device_static_params (L4567-L5072)
