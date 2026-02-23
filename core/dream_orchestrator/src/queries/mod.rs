pub mod armed_track_index;
pub mod audio_clip_state;
pub mod device_node_on_track;
pub mod plugin_external_param_target;
pub mod plugin_external_slots;
pub mod plugin_param_hints;
pub mod plugin_slot_state;
pub mod plugin_slots_by_plugin_id;
pub mod project_sample_rate;
pub mod track_clip_colors;
pub mod track_stem_split;

pub use armed_track_index::ResolveArmedTrackIndexQuery;
pub use audio_clip_state::{AudioClipState, ResolveAudioClipStateQuery};
pub use device_node_on_track::ResolveDeviceNodeOnTrackQuery;
pub use plugin_external_param_target::{
    ExternalPluginParamTarget, ResolveExternalPluginParamTargetQuery,
};
pub use plugin_external_slots::ListExternalPluginSlotsQuery;
pub use plugin_param_hints::{PluginParamHints, ResolvePluginParamHintsQuery};
pub use plugin_slot_state::{PluginSlotState, ResolvePluginSlotStateQuery};
pub use plugin_slots_by_plugin_id::ResolvePluginSlotsByPluginIdQuery;
pub use project_sample_rate::ResolveProjectSampleRateQuery;
pub use track_clip_colors::ResolveTrackClipColorsQuery;
pub use track_stem_split::{PrepareStemSplitQuery, StemSplitPlan};
