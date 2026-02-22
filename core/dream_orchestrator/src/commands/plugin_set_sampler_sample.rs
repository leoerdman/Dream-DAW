use uuid::Uuid;

use dream_models::project::SamplerConfig;

use crate::context::{Command, OrchestratorContext};
use crate::error::{OrchestratorError, OrchestratorResult};

#[derive(Debug, Clone)]
pub struct SetSamplerSampleCommand {
    pub track_id: Uuid,
    pub sample_path: String,
    pub root_note: Option<u8>,
}

#[derive(Debug, Clone)]
pub struct SetSamplerSampleResult {
    pub track_index: usize,
    pub sampler_cfg: SamplerConfig,
}

impl SetSamplerSampleCommand {
    pub fn from_str_track_id(
        track_id: &str,
        sample_path: String,
        root_note: Option<u8>,
    ) -> OrchestratorResult<Self> {
        let track_id = Uuid::parse_str(track_id).map_err(|e| OrchestratorError::InvalidId {
            field: "track_id",
            value: track_id.to_string(),
            source: e,
        })?;
        Ok(Self {
            track_id,
            sample_path,
            root_note,
        })
    }
}

impl Command for SetSamplerSampleCommand {
    type Result = SetSamplerSampleResult;

    fn execute(&self, ctx: &OrchestratorContext) -> OrchestratorResult<Self::Result> {
        let mut project = ctx.lock_project()?;
        let (track_index, track) = project
            .tracks
            .iter_mut()
            .enumerate()
            .find(|(_, t)| t.id == self.track_id)
            .ok_or_else(|| OrchestratorError::NotFound {
                entity: "Track",
                id: self.track_id.to_string(),
            })?;

        let cfg = track.sampler.get_or_insert_with(SamplerConfig::default);
        cfg.sample_path = self.sample_path.clone();
        if let Some(root) = self.root_note {
            cfg.root_note = root.min(127);
        }

        Ok(SetSamplerSampleResult {
            track_index,
            sampler_cfg: cfg.clone(),
        })
    }
}
