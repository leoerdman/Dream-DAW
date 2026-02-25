use uuid::Uuid;

use dream_models::project::{DeviceNode, SamplerConfig, TrackType};

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

        let has_sampler_instrument = track
            .instrument
            .as_ref()
            .and_then(DeviceNode::as_single)
            .map(|slot| {
                let pid = slot.plugin_id.to_ascii_lowercase();
                pid.starts_with("internal://instrument/sampler")
                    || pid.starts_with("internal://instrument/wave-synth")
            })
            .unwrap_or(false);
        if track.track_type != TrackType::Midi && !has_sampler_instrument {
            return Err(OrchestratorError::Other(
                "Sampler sample can only be set on a MIDI/sampler track".to_string(),
            ));
        }

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

#[cfg(test)]
mod tests {
    use super::*;
    use crate::context::OrchestratorContext;
    use dream_models::project::{Project, Track};

    #[test]
    fn set_sampler_sample_rejects_plain_audio_track() {
        let mut project = Project::new("t", 120.0, 44_100.0);
        let track = Track::new("Audio");
        let track_id = track.id;
        project.tracks.push(track);
        let ctx = OrchestratorContext::new(project);

        let cmd = SetSamplerSampleCommand {
            track_id,
            sample_path: "/tmp/kick.wav".to_string(),
            root_note: Some(60),
        };
        let err = ctx
            .execute(&cmd)
            .expect_err("audio track without sampler should be rejected");
        assert!(
            err.to_string()
                .contains("Sampler sample can only be set on a MIDI/sampler track"),
            "unexpected error: {err}"
        );
    }

    #[test]
    fn set_sampler_sample_accepts_midi_track() {
        let mut project = Project::new("t", 120.0, 44_100.0);
        let mut track = Track::new("MIDI");
        track.track_type = TrackType::Midi;
        let track_id = track.id;
        project.tracks.push(track);
        let ctx = OrchestratorContext::new(project);

        let cmd = SetSamplerSampleCommand {
            track_id,
            sample_path: "/tmp/snare.wav".to_string(),
            root_note: Some(64),
        };
        let result = ctx.execute(&cmd).expect("midi track should accept sampler sample");
        assert_eq!(result.track_index, 0);
        assert_eq!(result.sampler_cfg.sample_path, "/tmp/snare.wav");
        assert_eq!(result.sampler_cfg.root_note, 64);
    }
}
