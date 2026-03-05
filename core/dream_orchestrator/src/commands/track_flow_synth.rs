use crate::context::{Command, OrchestratorContext};
use crate::error::{OrchestratorError, OrchestratorResult};
use dream_models::project::FlowSynthConfig;
use uuid::Uuid;

#[derive(Debug, Clone)]
pub struct UpdateTrackFlowSynthConfigResult {
    pub track_id: Uuid,
    pub config: Option<FlowSynthConfig>,
}

pub struct UpdateTrackFlowSynthConfigCommand {
    pub track_index: u16,
    pub config: Option<FlowSynthConfig>,
}

fn resolve_flow_track_index(project: &dream_models::project::Project, requested: u16) -> u16 {
    let track_count = project.tracks.len();
    if track_count == 0 {
        return 0;
    }
    (requested as usize).min(track_count.saturating_sub(1)) as u16
}

impl Command for UpdateTrackFlowSynthConfigCommand {
    type Result = UpdateTrackFlowSynthConfigResult;

    fn execute(&self, ctx: &OrchestratorContext) -> OrchestratorResult<Self::Result> {
        let mut project = ctx.lock_project()?;
        
        let resolved_track_index = resolve_flow_track_index(&project, self.track_index);
        
        let total = project.tracks.len();
        let track = project
            .tracks
            .get_mut(resolved_track_index as usize)
            .ok_or(OrchestratorError::TrackOutOfRange {
                requested: resolved_track_index as usize,
                total,
            })?;
            
        track.flow_synth = self.config.clone();
        
        Ok(UpdateTrackFlowSynthConfigResult {
            track_id: track.id,
            config: self.config.clone(),
        })
    }
}
