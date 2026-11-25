use crate::context::{Command, OrchestratorContext};
use crate::error::OrchestratorResult;
use dream_models::project::{AudioClip, Track};
use dream_models::time::AbsoluteTime;

// ═══════════════════════════════════════════════════════════════════════════
// InsertRecordedClipCommand
// ═══════════════════════════════════════════════════════════════════════════

pub struct InsertRecordedClipCommand {
    // BUG-029 FIX: Use track UUID instead of index for topology-safe recording.
    pub track_id: String,
    pub clip_name: String,
    pub file_path: String,
    pub start_frame: i64,
    pub source_total_frames: i64,
    pub source_sample_rate: u32,
}

impl Command for InsertRecordedClipCommand {
    type Result = ();

    fn execute(&self, ctx: &OrchestratorContext) -> OrchestratorResult<()> {
        let mut project = ctx.lock_project()?;

        // BUG-029 FIX: Find track by UUID instead of indexing by position.
        // If the track was deleted during recording, create a new one as fallback.
        let track_index = project
            .tracks
            .iter()
            .position(|t| t.id.to_string() == self.track_id)
            .unwrap_or_else(|| {
                let idx = project.tracks.len();
                project.add_track(Track::new(format!("Recording Track {}", idx + 1)));
                idx
            });

        let project_sr = project.sample_rate.max(1.0);
        let source_sr = self.source_sample_rate.max(1) as f64;
        let timeline_frames =
            ((self.source_total_frames.max(1) as f64) * (project_sr / source_sr)).round() as i64;

        let mut clip = AudioClip::new(
            &self.clip_name,
            &self.file_path,
            AbsoluteTime::new(self.start_frame),
            AbsoluteTime::new(timeline_frames.max(1)),
        );
        clip.sample_rate = Some(self.source_sample_rate.max(1));
        clip.set_source_bounds(self.source_total_frames.max(1));

        project.tracks[track_index].clips.push(clip);
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::context::OrchestratorContext;
    use dream_models::project::Project;

    #[test]
    fn inserts_recording_on_existing_track_by_id() {
        let mut project = Project::default();
        let track = Track::new("Target Track".to_string());
        let target_id = track.id.to_string();
        project.add_track(track);

        let ctx = OrchestratorContext::new(project);
        let cmd = InsertRecordedClipCommand {
            track_id: target_id.clone(),
            clip_name: "Recording".to_string(),
            file_path: "/tmp/recorded.wav".to_string(),
            start_frame: 256,
            source_total_frames: 48_000,
            source_sample_rate: 48_000,
        };

        cmd.execute(&ctx).expect("execute");

        let project = ctx.lock_project().expect("lock");
        // Verify clip went to the correct track (matched by UUID)
        let target_track = project
            .tracks
            .iter()
            .find(|t| t.id.to_string() == target_id)
            .expect("target track");
        let clip = target_track.clips.last().expect("clip");
        assert_eq!(clip.file_path, "/tmp/recorded.wav");
        assert_eq!(clip.position.sample_frame, 256);
        assert_eq!(clip.warp_source_duration_frames, 48_000);
    }

    #[test]
    fn creates_fallback_track_if_id_not_found() {
        let project = Project::default();
        let initial_count = project.tracks.len();
        let ctx = OrchestratorContext::new(project);
        let cmd = InsertRecordedClipCommand {
            track_id: "nonexistent-uuid".to_string(),
            clip_name: "Recording".to_string(),
            file_path: "/tmp/recorded.wav".to_string(),
            start_frame: 0,
            source_total_frames: 44_100,
            source_sample_rate: 44_100,
        };

        cmd.execute(&ctx).expect("execute");

        let project = ctx.lock_project().expect("lock");
        // A new fallback track should have been created
        assert_eq!(project.tracks.len(), initial_count + 1);
        assert_eq!(project.tracks.last().unwrap().clips.len(), 1);
    }
}
