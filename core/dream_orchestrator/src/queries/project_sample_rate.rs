use crate::context::{OrchestratorContext, Query};
use crate::error::OrchestratorResult;

#[derive(Debug, Clone, Copy)]
pub struct ResolveProjectSampleRateQuery;

impl Query for ResolveProjectSampleRateQuery {
    type Result = f64;

    fn execute(&self, ctx: &OrchestratorContext) -> OrchestratorResult<Self::Result> {
        let project = ctx.lock_project()?;
        Ok(project.sample_rate)
    }
}
