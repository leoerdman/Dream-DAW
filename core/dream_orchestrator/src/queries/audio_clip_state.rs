use uuid::Uuid;

use crate::context::{OrchestratorContext, Query};
use crate::error::{OrchestratorError, OrchestratorResult};

#[derive(Debug, Clone, Copy)]
pub struct ResolveAudioClipStateQuery {
    pub clip_id: Uuid,
}

#[derive(Debug, Clone)]
pub struct AudioClipState {
    pub clip_id: Uuid,
    pub file_path: String,
    pub is_offline: bool,
    pub source_offset: i64,
    pub fade_in_frames: i64,
    pub fade_out_frames: i64,
    pub is_warped: bool,
    pub warp_mode: Option<i32>,
    pub warp_base_bpm: f64,
    pub warp_source_duration_frames: i64,
}

impl Query for ResolveAudioClipStateQuery {
    type Result = AudioClipState;

    fn execute(&self, ctx: &OrchestratorContext) -> OrchestratorResult<Self::Result> {
        let project = ctx.lock_project()?;
        let clip = project
            .tracks
            .iter()
            .flat_map(|t| t.clips.iter())
            .find(|c| c.id == self.clip_id)
            .ok_or_else(|| OrchestratorError::NotFound {
                entity: "AudioClip",
                id: self.clip_id.to_string(),
            })?;

        Ok(AudioClipState {
            clip_id: clip.id,
            file_path: clip.file_path.clone(),
            is_offline: clip.is_offline,
            source_offset: clip.source_offset.sample_frame,
            fade_in_frames: clip.fade_in_frames,
            fade_out_frames: clip.fade_out_frames,
            is_warped: clip.is_warped,
            warp_mode: clip.warp_mode,
            warp_base_bpm: clip.warp_base_bpm,
            warp_source_duration_frames: clip.warp_source_duration_frames,
        })
    }
}
