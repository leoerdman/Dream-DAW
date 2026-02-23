use crate::context::{Command, OrchestratorContext};
use crate::error::{OrchestratorError, OrchestratorResult};
use uuid::Uuid;

#[derive(Debug, Clone, Copy)]
pub struct SetTrackHeightResult {
    pub changed: bool,
    pub height: f64,
}

pub struct SetTrackHeightCommand {
    pub track_id: Uuid,
    pub height: f64,
}

impl SetTrackHeightCommand {
    pub fn from_str_track_id(track_id: &str, height: f64) -> OrchestratorResult<Self> {
        let track_id = Uuid::parse_str(track_id).map_err(|e| OrchestratorError::InvalidId {
            field: "track_id",
            value: track_id.to_string(),
            source: e,
        })?;
        Ok(Self { track_id, height })
    }
}

impl Command for SetTrackHeightCommand {
    type Result = SetTrackHeightResult;

    fn execute(&self, ctx: &OrchestratorContext) -> OrchestratorResult<Self::Result> {
        let mut project = ctx.lock_project()?;
        let track = project
            .tracks
            .iter_mut()
            .find(|t| t.id == self.track_id)
            .ok_or_else(|| OrchestratorError::NotFound {
                entity: "Track",
                id: self.track_id.to_string(),
            })?;

        let clamped = self.height.clamp(24.0, 120.0);
        if (track.height - clamped).abs() < f64::EPSILON {
            return Ok(SetTrackHeightResult {
                changed: false,
                height: clamped,
            });
        }

        track.height = clamped;
        Ok(SetTrackHeightResult {
            changed: true,
            height: clamped,
        })
    }
}
