use crate::context::{Command, OrchestratorContext};
use crate::error::{OrchestratorError, OrchestratorResult};

// ═══════════════════════════════════════════════════════════════════════════
// SetTrackArmedCommand
// ═══════════════════════════════════════════════════════════════════════════

pub struct SetTrackArmedCommand {
    pub track_index: usize,
    pub armed: bool,
}

impl Command for SetTrackArmedCommand {
    type Result = ();

    fn execute(&self, ctx: &OrchestratorContext) -> OrchestratorResult<()> {
        let mut project = ctx.lock_project()?;
        let total = project.tracks.len();
        let track =
            project
                .tracks
                .get_mut(self.track_index)
                .ok_or(OrchestratorError::TrackOutOfRange {
                    requested: self.track_index,
                    total,
                })?;
        track.is_armed = self.armed;
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::context::OrchestratorContext;
    use dream_models::project::{Project, Track};

    #[test]
    fn sets_track_armed_flag_by_index() {
        let mut project = Project::default();
        project.tracks.push(Track::new("Track 1"));
        let ctx = OrchestratorContext::new(project);

        let cmd = SetTrackArmedCommand {
            track_index: 0,
            armed: true,
        };
        cmd.execute(&ctx).expect("execute");

        let project = ctx.lock_project().expect("lock");
        assert!(project.tracks[0].is_armed);
    }

    #[test]
    fn set_track_armed_returns_range_error() {
        let project = Project::default();
        let out_of_range = project.tracks.len() + 5;
        let ctx = OrchestratorContext::new(project);
        let cmd = SetTrackArmedCommand {
            track_index: out_of_range,
            armed: true,
        };

        let err = cmd.execute(&ctx).expect_err("must fail");
        match err {
            OrchestratorError::TrackOutOfRange { requested, total } => {
                assert_eq!(requested, out_of_range);
                assert!(requested >= total);
            }
            other => panic!("unexpected error: {other}"),
        }
    }
}
