use crate::context::{Command, OrchestratorContext};
use crate::error::{OrchestratorError, OrchestratorResult};
use uuid::Uuid;

// ═══════════════════════════════════════════════════════════════════════════
// ResolveMissingClipFileCommand
// ═══════════════════════════════════════════════════════════════════════════

pub struct ResolveMissingClipFileCommand {
    pub clip_id: Uuid,
    pub new_path: String,
}

impl ResolveMissingClipFileCommand {
    pub fn from_str_id(clip_id: &str, new_path: impl Into<String>) -> OrchestratorResult<Self> {
        let uuid = Uuid::parse_str(clip_id).map_err(|e| OrchestratorError::InvalidId {
            field: "clip_id",
            value: clip_id.to_string(),
            source: e,
        })?;

        Ok(Self {
            clip_id: uuid,
            new_path: new_path.into(),
        })
    }
}

impl Command for ResolveMissingClipFileCommand {
    type Result = ();

    fn execute(&self, ctx: &OrchestratorContext) -> OrchestratorResult<()> {
        let mut project = ctx.lock_project()?;

        for track in &mut project.tracks {
            if let Some(clip) = track.clips.iter_mut().find(|c| c.id == self.clip_id) {
                clip.file_path = self.new_path.clone();
                clip.is_offline = false;
                return Ok(());
            }
        }

        Err(OrchestratorError::NotFound {
            entity: "clip",
            id: self.clip_id.to_string(),
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::context::OrchestratorContext;
    use dream_models::project::{AudioClip, Project, Track};
    use dream_models::time::AbsoluteTime;

    #[test]
    fn resolves_offline_clip_path() {
        let mut project = Project::default();
        let mut track = Track::new("Track 1");
        let track_id = track.id;
        let mut clip = AudioClip::new(
            "Clip",
            "/missing.wav",
            AbsoluteTime::new(0),
            AbsoluteTime::new(1024),
        );
        clip.is_offline = true;
        let clip_id = clip.id;
        track.clips.push(clip);
        project.tracks.push(track);

        let ctx = OrchestratorContext::new(project);
        let cmd = ResolveMissingClipFileCommand {
            clip_id,
            new_path: "/resolved.wav".to_string(),
        };
        cmd.execute(&ctx).expect("resolve should succeed");

        let project = ctx.lock_project().expect("project lock");
        let clip = project
            .tracks
            .iter()
            .find(|t| t.id == track_id)
            .and_then(|t| t.clips.iter().find(|c| c.id == clip_id))
            .expect("resolved clip");
        assert_eq!(clip.file_path, "/resolved.wav");
        assert!(!clip.is_offline);
    }

    #[test]
    fn resolve_missing_file_returns_not_found() {
        let ctx = OrchestratorContext::new(Project::default());
        let cmd = ResolveMissingClipFileCommand::from_str_id(
            "11111111-1111-1111-1111-111111111111",
            "/resolved.wav",
        )
        .expect("valid uuid");

        let err = cmd.execute(&ctx).expect_err("must fail");
        match err {
            OrchestratorError::NotFound { entity, .. } => assert_eq!(entity, "clip"),
            other => panic!("unexpected error: {other}"),
        }
    }
}
