// ═══════════════════════════════════════════════════════════════════════════
// Dream DAW — Orchestrator Commands (CQRS Command Side)
// ═══════════════════════════════════════════════════════════════════════════

// ── Clip Commands ───────────────────────────────────────────────────────
pub mod clip_bounce;
pub mod clip_clamp_source_offset;
pub mod clip_color;
pub mod clip_delete;
pub mod clip_duplicate;
pub mod clip_fades;
pub mod clip_merge;
pub mod clip_midi_update;
pub mod clip_move;
pub mod clip_mute;
pub mod clip_pitch;
pub mod clip_resize;
pub mod clip_resolve_missing_file;
pub mod clip_source_offset;
pub mod clip_split;
pub mod clip_warp;
pub mod device_rack;
pub mod internal_device_chain;
pub mod plugin_add;
pub mod plugin_move_effect;
pub mod plugin_paste_device;
pub mod plugin_remove;
pub mod plugin_replace_missing;
pub mod plugin_set_bypass;
pub mod plugin_set_external_param_lane;
pub mod plugin_set_internal_param;
pub mod plugin_set_sampler_sample;
pub mod plugin_update_external_state_blob;
pub mod project_settings;
pub mod recording_insert_clip;
pub mod sample_rack_pad;
pub mod track_add;
pub mod track_delete;
pub mod track_grouping;
pub mod track_mix;
pub mod track_move_to_index;
pub mod track_parenting;
pub mod track_rename;
pub mod track_routing;
pub mod track_set_armed;
pub mod track_set_automation_points;
pub mod track_set_color;
pub mod track_set_height;
pub mod track_topology;

// Re-export all command structs for convenience
pub use clip_bounce::{
    InsertBouncedClipCommand, InsertBouncedClipResult, InsertStemClipsCommand, StemMetaInput,
};
pub use clip_clamp_source_offset::ClampClipSourceOffsetCommand;
pub use clip_color::PaintTrackClipsWithTrackColorCommand;
pub use clip_delete::DeleteClipCommand;
pub use clip_duplicate::{DuplicateClipCommand, DuplicateClipResult, DuplicateMultipleClipsCommand};
pub use clip_fades::{SetClipFadesCommand, SetClipFadesResult};
pub use clip_merge::{MergeClipsCommand, MergeClipsResult};
pub use clip_midi_update::{UpdateMidiClipNotesCommand, UpdateMidiClipNotesResult};
pub use clip_move::{MoveClipCommand, MoveClipResult, MoveMultipleClipsCommand};
pub use clip_mute::{MuteClipCommand, MuteClipsBatchCommand};
pub use clip_pitch::SetClipPitchCommand;
pub use clip_resize::ResizeClipCommand;
pub use clip_resolve_missing_file::ResolveMissingClipFileCommand;
pub use clip_source_offset::SetClipSourceOffsetCommand;
pub use clip_split::SplitClipCommand;
pub use clip_warp::SetClipWarpCommand;
pub use device_rack::{
    AddChainToRackCommand, AddChainToRackResult, AddDeviceToRackChainCommand,
    AddDeviceToRackChainResult, CreateRackFromDevicesCommand, CreateRackFromDevicesResult,
    InsertDeviceNodeIntoTrackCommand, InsertDeviceNodeIntoTrackResult, RemoveDeviceFromRackCommand,
};
pub use internal_device_chain::{
    SetInternalDeviceBypassByTrackIndexCommand, SetInternalDeviceBypassResult,
    SetInternalDeviceParamByTrackIndexCommand, SetInternalDeviceParamResult,
};
pub use plugin_add::{
    AddPluginToTrackCommand, AddPluginToTrackResult, NormalizedPluginTarget, PluginSlotPreference,
    normalize_plugin_target_for_add,
};
pub use plugin_move_effect::{EffectTrackTarget, MoveEffectSlotCommand, MoveEffectSlotResult};
pub use plugin_paste_device::{
    PasteDeviceToTrackCommand, PasteDeviceToTrackResult, RuntimeAddDevice,
};
pub use plugin_remove::{RemovePluginFromTrackCommand, RemovePluginFromTrackResult};
pub use plugin_replace_missing::{ReplaceMissingPluginSlotCommand, ReplaceMissingPluginSlotResult};
pub use plugin_set_bypass::{SetPluginSlotBypassCommand, SetPluginSlotBypassResult};
pub use plugin_set_external_param_lane::SetExternalPluginParamLaneCommand;
pub use plugin_set_internal_param::{SetInternalPluginParamCommand, SetInternalPluginParamResult};
pub use plugin_set_sampler_sample::{SetSamplerSampleCommand, SetSamplerSampleResult};
pub use plugin_update_external_state_blob::UpdatePluginExternalStateBlobCommand;
pub use project_settings::{
    SetArrangementGridCommand, SetArrangementGridResult, SetKeySignatureCommand,
    SetKeySignatureResult,
};
pub use recording_insert_clip::InsertRecordedClipCommand;
pub use sample_rack_pad::{
    SetSampleRackPadAdsrCommand, SetSampleRackPadAdsrResult, SetSampleRackPadFilterCutoffCommand,
    SetSampleRackPadFilterCutoffResult, SetSampleRackPadMuteCommand, SetSampleRackPadMuteResult,
    SetSampleRackPadSamplePathCommand, SetSampleRackPadSampleResult, SetSampleRackPadSoloCommand,
    SetSampleRackPadSoloResult, SetSampleRackPadVolumeCommand, SetSampleRackPadVolumeResult,
};
pub use track_add::{AddTrackCommand, AddTrackResult};
pub use track_delete::{
    DeleteTrackByIndexCommand, DeleteTrackByIndexResult, DeleteTracksByIdsCommand,
    DeleteTracksByIdsResult,
};
pub use track_grouping::{
    CreateGroupCommand, CreateGroupResult, SetGroupExpandedCommand, snapshot_track_order_and_parent,
};
pub use track_mix::{
    SetMasterVolumeCommand, SetTrackDisabledByIndexCommand, SetTrackDisabledResult,
    SetTrackPanByIndexCommand, SetTrackPanResult, SetTrackSendLevelByIndexCommand,
    SetTrackSendLevelResult, SetTrackSoloByIndexCommand, SetTrackSoloResult,
    SetTrackVolumeByIndexCommand, SetTrackVolumeResult,
};
pub use track_move_to_index::{MoveTrackToIndexCommand, MoveTrackToIndexResult};
pub use track_parenting::{
    MoveTrackWithParentCommand, MoveTrackWithParentResult, SetTrackGroupCommand,
};
pub use track_rename::{RenameTrackByIndexCommand, RenameTrackResult};
pub use track_routing::{
    SetPluginSidechainSourceCommand, SetPluginSidechainSourceResult, SetTrackInputCommand,
    SetTrackInputResult, SetTrackRoutingCommand, SetTrackRoutingResult,
};
pub use track_set_armed::SetTrackArmedCommand;
pub use track_set_automation_points::SetTrackAutomationPointsCommand;
pub use track_set_color::{SetTrackColorCommand, SetTrackColorResult};
pub use track_set_height::{SetTrackHeightCommand, SetTrackHeightResult};
pub use track_topology::{
    AddedTrack, DuplicateTracksCommand, DuplicateTracksResult, MoveTrackBlockToIndexCommand,
    MoveTrackBlockToIndexResult, UngroupTrackCommand, UngroupTrackResult,
};

#[cfg(test)]
mod plugin_virtual_scenarios;
