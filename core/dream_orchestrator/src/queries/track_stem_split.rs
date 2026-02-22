use std::collections::HashSet;

use dream_models::project::TrackType;
use uuid::Uuid;

use crate::context::{OrchestratorContext, Query};
use crate::error::{OrchestratorError, OrchestratorResult};

#[derive(Debug, Clone)]
pub struct StemSplitPlan {
    pub source_track_name: String,
    pub included_track_ids: Vec<Uuid>,
    pub start_frame: i64,
    pub end_frame: i64,
}

pub struct PrepareStemSplitQuery {
    pub track_id: Uuid,
}

impl Query for PrepareStemSplitQuery {
    type Result = StemSplitPlan;

    fn execute(&self, ctx: &OrchestratorContext) -> OrchestratorResult<Self::Result> {
        let project = ctx.lock_project()?;
        let source_track = project
            .tracks
            .iter()
            .find(|t| t.id == self.track_id)
            .ok_or_else(|| OrchestratorError::Other("Track not found".to_string()))?;

        let mut included_ids: HashSet<Uuid> = HashSet::new();
        included_ids.insert(source_track.id);

        if source_track.track_type == TrackType::Group {
            loop {
                let mut changed = false;
                for track in &project.tracks {
                    if let Some(parent_id) = track.parent_track_id
                        && included_ids.contains(&parent_id)
                        && included_ids.insert(track.id)
                    {
                        changed = true;
                    }
                }
                if !changed {
                    break;
                }
            }
        }

        let mut start_frame = i64::MAX;
        let mut end_frame = i64::MIN;
        for track in &project.tracks {
            if !included_ids.contains(&track.id) {
                continue;
            }
            for clip in &track.clips {
                start_frame = start_frame.min(clip.position.sample_frame);
                end_frame = end_frame.max(clip.position.sample_frame + clip.duration.sample_frame);
            }
            for clip in &track.midi_clips {
                start_frame = start_frame.min(clip.position.sample_frame);
                end_frame = end_frame.max(clip.position.sample_frame + clip.duration.sample_frame);
            }
        }

        if start_frame == i64::MAX || end_frame == i64::MIN || end_frame <= start_frame {
            return Err(OrchestratorError::Other(
                "Track has no content to split into stems".to_string(),
            ));
        }

        Ok(StemSplitPlan {
            source_track_name: source_track.name.clone(),
            included_track_ids: included_ids.into_iter().collect(),
            start_frame,
            end_frame,
        })
    }
}
