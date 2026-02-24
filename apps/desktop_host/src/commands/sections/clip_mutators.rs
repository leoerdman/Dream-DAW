// ═══════════════════════════════════════════════════════════════════════

/// Response type for the split_clip command.
#[derive(Debug, Serialize, Deserialize)]
struct SplitClipResponse {
    left_id: String,
    right_id: String,
}

#[derive(Debug, Serialize, Deserialize)]
struct SplitClipWithDeltasResponse {
    left_id: String,
    right_id: String,
    deltas: Vec<dream_models::delta::ProjectDelta>,
}

#[derive(Debug, Serialize, Deserialize)]
struct DuplicateClipWithDeltasResponse {
    new_id: String,
    deltas: Vec<dream_models::delta::ProjectDelta>,
}

#[derive(Debug, Serialize, Deserialize)]
struct MergeClipsWithDeltasResponse {
    new_id: String,
    deltas: Vec<dream_models::delta::ProjectDelta>,
}

#[derive(Debug, Serialize, Deserialize)]
struct DuplicateClipResponse {
    new_id: String,
}

#[derive(Debug, Serialize, Deserialize)]
struct MergeClipsResponse {
    new_id: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct BounceSelectionPayload {
    #[serde(default)]
    clip_ids: Vec<String>,
    range_start_frames: Option<i64>,
    range_end_frames: Option<i64>,
    start_track_index: Option<usize>,
    end_track_index: Option<usize>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct SplitTrackToStemsPayload {
    track_id: String,
}

#[path = "clip_mutators/helpers.rs"]
mod helpers;
use helpers::{
    build_local_pool_for_project, collect_added_track_and_clip_deltas, place_bounced_file_on_new_track,
    place_stem_files_on_new_tracks,
    rebuild_automation_and_mark_dirty, rebuild_clip_snapshot_and_mark_dirty,
    rebuild_clip_views_and_mark_dirty, rebuild_clips_only_and_mark_dirty, ClipRebuildMode,
};

#[path = "clip_mutators/jobs.rs"]
mod jobs;
use jobs::{
    background_jobs, emit_job_update, finish_job, prune_finished_jobs_locked, set_job_progress,
    start_job, BackgroundJobSnapshot,
};
include!("clip_mutators/basic_edit_commands.rs");
include!("clip_mutators/audio_state_commands.rs");

include!("clip_mutators/advanced_commands.rs");

include!("clip_mutators/recording_commands.rs");

include!("clip_mutators/export_commands.rs");
include!("clip_mutators/export_job_commands.rs");
include!("clip_mutators/bounce_commands.rs");
include!("clip_mutators/split_stems_commands.rs");
