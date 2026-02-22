use dream_models::project::{AudioClip, Track};
use dream_models::time::AbsoluteTime;

use crate::context::{Command, OrchestratorContext};
use crate::error::OrchestratorResult;

// ═══════════════════════════════════════════════════════════════════════════
// InsertBouncedClipCommand
// ═══════════════════════════════════════════════════════════════════════════

pub struct InsertBouncedClipCommand {
    pub file_path: String,
    pub clip_name: String,
    pub start_frame: i64,
    pub timeline_duration_frames: i64,
    pub source_duration_frames: i64,
    pub new_track_name: String,
    pub insert_after_index: Option<usize>,
}

impl Command for InsertBouncedClipCommand {
    type Result = ();

    fn execute(&self, ctx: &OrchestratorContext) -> OrchestratorResult<()> {
        let mut project = ctx.lock_project()?;

        let new_track = Track::new(&self.new_track_name);
        let new_track_index = if let Some(after_idx) = self.insert_after_index {
            let insert_pos = (after_idx + 1).min(project.tracks.len());
            project.tracks.insert(insert_pos, new_track);
            insert_pos
        } else {
            project.add_track(new_track);
            project.tracks.len().saturating_sub(1)
        };

        let mut clip = AudioClip::new(
            &self.clip_name,
            &self.file_path,
            AbsoluteTime::new(self.start_frame.max(0)),
            AbsoluteTime::new(self.timeline_duration_frames.max(1)),
        );
        clip.warp_source_duration_frames = self.source_duration_frames.max(1);

        if let Some(track) = project.tracks.get_mut(new_track_index) {
            track.clips.push(clip);
        }

        Ok(())
    }
}

// ═══════════════════════════════════════════════════════════════════════════
// InsertStemClipsCommand
// ═══════════════════════════════════════════════════════════════════════════

pub struct StemMetaInput {
    pub file_path: String,
    pub track_name: String,
    pub timeline_duration_frames: i64,
    pub source_duration_frames: i64,
}

pub struct InsertStemClipsCommand {
    pub start_frame: i64,
    pub stems: Vec<StemMetaInput>,
}

impl Command for InsertStemClipsCommand {
    type Result = ();

    fn execute(&self, ctx: &OrchestratorContext) -> OrchestratorResult<()> {
        let mut project = ctx.lock_project()?;

        for stem in &self.stems {
            project.add_track(Track::new(&stem.track_name));
            let new_track_index = project.tracks.len().saturating_sub(1);

            let mut clip = AudioClip::new(
                &stem.track_name,
                &stem.file_path,
                AbsoluteTime::new(self.start_frame.max(0)),
                AbsoluteTime::new(stem.timeline_duration_frames.max(1)),
            );
            clip.warp_source_duration_frames = stem.source_duration_frames.max(1);

            if let Some(track) = project.tracks.get_mut(new_track_index) {
                track.clips.push(clip);
            }
        }

        Ok(())
    }
}
