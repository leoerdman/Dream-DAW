use crate::context::{OrchestratorContext, Query};
use crate::error::{OrchestratorError, OrchestratorResult};

#[derive(Debug, Clone, Copy)]
pub struct ResolveArmedTrackIndexQuery;

impl Query for ResolveArmedTrackIndexQuery {
    type Result = usize;

    fn execute(&self, ctx: &OrchestratorContext) -> OrchestratorResult<Self::Result> {
        let project = ctx.lock_project()?;
        project
            .tracks
            .iter()
            .position(|track| track.is_armed)
            .ok_or_else(|| OrchestratorError::Other("No armed tracks".to_string()))
    }
}
