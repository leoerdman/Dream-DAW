use crate::context::{Command, OrchestratorContext};
use crate::error::OrchestratorResult;
use dream_models::project::{AudioClip, Track};
use dream_models::time::AbsoluteTime;

// ═══════════════════════════════════════════════════════════════════════════
// InsertRecordedClipCommand
// ═══════════════════════════════════════════════════════════════════════════

pub struct InsertRecordedClipCommand {
    pub track_index: usize,
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

        while project.tracks.len() <= self.track_index {
            let track_num = project.tracks.len() + 1;
            project.add_track(Track::new(format!("Track {track_num}")));
        }

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
        clip.warp_source_duration_frames = self.source_total_frames.max(1);

        project.tracks[self.track_index].clips.push(clip);
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::context::OrchestratorContext;
    use dream_models::project::Project;

    #[test]
    fn inserts_recording_and_extends_tracks() {
        let ctx = OrchestratorContext::new(Project::default());
        let cmd = InsertRecordedClipCommand {
            track_index: 2,
            clip_name: "Recording".to_string(),
            file_path: "/tmp/recorded.wav".to_string(),
            start_frame: 256,
            source_total_frames: 48_000,
            source_sample_rate: 48_000,
        };

        cmd.execute(&ctx).expect("execute");

        let project = ctx.lock_project().expect("lock");
        assert!(project.tracks.len() > 2);
        let clip = project.tracks[2].clips.last().expect("clip");
        assert_eq!(clip.file_path, "/tmp/recorded.wav");
        assert_eq!(clip.position.sample_frame, 256);
        assert_eq!(clip.warp_source_duration_frames, 48_000);
    }
}
