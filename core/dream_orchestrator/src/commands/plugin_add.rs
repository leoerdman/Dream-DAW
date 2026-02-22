use uuid::Uuid;

use dream_models::midi::SamplerConfig;
use dream_models::project::{DeviceNode, PluginSlot, TrackType};

use crate::context::{Command, OrchestratorContext};
use crate::error::{OrchestratorError, OrchestratorResult};

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PluginSlotPreference {
    Instrument,
    Effect,
    Auto,
}

impl PluginSlotPreference {
    pub fn parse(value: &str) -> Self {
        match value.to_lowercase().as_str() {
            "instrument" => Self::Instrument,
            "effect" => Self::Effect,
            _ => Self::Auto,
        }
    }
}

#[derive(Debug, Clone)]
pub struct AddPluginToTrackCommand {
    pub track_id: Uuid,
    pub plugin_id: String,
    pub plugin_name: String,
    pub slot_preference: PluginSlotPreference,
    pub canonical_slot_hint: Option<String>, // "instrument" | "effect"
    pub external_audio_inputs: Option<u32>,
    pub external_supports_sidechain_input: Option<bool>,
}

#[derive(Debug, Clone, Copy)]
pub struct AddPluginToTrackResult {
    pub slot_id: Uuid,
    pub placed_as_instrument: bool,
    pub runtime_effect_slot_index: Option<u8>,
    pub runtime_waveform_code: Option<u8>,
}

impl AddPluginToTrackCommand {
    pub fn from_str_track_id(
        track_id: &str,
        plugin_id: String,
        plugin_name: String,
        slot_preference: &str,
        canonical_slot_hint: Option<&str>,
        external_audio_inputs: Option<u32>,
        external_supports_sidechain_input: Option<bool>,
    ) -> OrchestratorResult<Self> {
        let track_id = Uuid::parse_str(track_id).map_err(|e| OrchestratorError::InvalidId {
            field: "track_id",
            value: track_id.to_string(),
            source: e,
        })?;
        Ok(Self {
            track_id,
            plugin_id,
            plugin_name,
            slot_preference: PluginSlotPreference::parse(slot_preference),
            canonical_slot_hint: canonical_slot_hint.map(|s| s.to_string()),
            external_audio_inputs,
            external_supports_sidechain_input,
        })
    }
}

impl Command for AddPluginToTrackCommand {
    type Result = AddPluginToTrackResult;

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

        let use_instrument = if track.track_type != TrackType::Midi {
            false
        } else {
            match self.slot_preference {
                PluginSlotPreference::Instrument => true,
                PluginSlotPreference::Effect => false,
                PluginSlotPreference::Auto => {
                    self.canonical_slot_hint.as_deref() == Some("instrument")
                        || track.instrument.is_none()
                }
            }
        };

        let plugin_id_lower = self.plugin_id.to_lowercase();
        let is_sampler_instrument = plugin_id_lower.starts_with("internal://instrument/sampler");
        let is_wave_synth_instrument = plugin_id_lower
            .starts_with("internal://instrument/wave-synth")
            || plugin_id_lower.starts_with("internal://instrument/simple-sine-synth");

        let mut slot_data = PluginSlot::new(self.plugin_name.clone(), self.plugin_id.clone());
        if !self.plugin_id.starts_with("internal://") {
            slot_data.external_audio_inputs = self.external_audio_inputs;
            slot_data.supports_sidechain_input = self.external_supports_sidechain_input;
        }

        let slot_id = slot_data.id;
        let plugin_slot = DeviceNode::Single(slot_data);
        let mut runtime_effect_slot_index = None;
        let mut runtime_waveform_code = None;

        if use_instrument {
            track.instrument = Some(plugin_slot);
            if (is_sampler_instrument || is_wave_synth_instrument) && track.sampler.is_none() {
                track.sampler = Some(SamplerConfig::default());
            }
            if is_wave_synth_instrument {
                let cfg = track.sampler.get_or_insert_with(SamplerConfig::default);
                if cfg.sample_path.trim().is_empty() {
                    cfg.sample_path = "internal://waveform/sine".to_string();
                }
                runtime_waveform_code = Some(
                    dream_graph::routing::device_chain::waveform_code_from_token(&cfg.sample_path),
                );
            }
        } else {
            runtime_effect_slot_index =
                dream_graph::routing::device_chain::DeviceChain::insert_effect(
                    track,
                    plugin_slot,
                    None,
                );
        }

        Ok(AddPluginToTrackResult {
            slot_id,
            placed_as_instrument: use_instrument,
            runtime_effect_slot_index,
            runtime_waveform_code,
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::context::OrchestratorContext;
    use dream_models::project::{Project, Track};

    #[test]
    fn add_instrument_to_midi_track_places_in_instrument_slot() {
        let mut project = Project::new("t", 120.0, 44100.0);
        let mut track = Track::new("midi");
        track.track_type = TrackType::Midi;
        let track_id = track.id;
        project.tracks.push(track);

        let ctx = OrchestratorContext::new(project);
        let cmd = AddPluginToTrackCommand {
            track_id,
            plugin_id: "internal://instrument/wave-synth".to_string(),
            plugin_name: "Wave Synth".to_string(),
            slot_preference: PluginSlotPreference::Auto,
            canonical_slot_hint: Some("instrument".to_string()),
            external_audio_inputs: None,
            external_supports_sidechain_input: None,
        };
        let result = ctx.execute(&cmd).unwrap();

        assert!(result.placed_as_instrument);
        assert!(ctx.lock_project().unwrap().tracks[0].instrument.is_some());
    }

    #[test]
    fn add_effect_to_audio_track_places_in_effect_chain() {
        let mut project = Project::new("t", 120.0, 44100.0);
        let track = Track::new("audio");
        let track_id = track.id;
        project.tracks.push(track);

        let ctx = OrchestratorContext::new(project);
        let cmd = AddPluginToTrackCommand {
            track_id,
            plugin_id: "internal://effect/eq8".to_string(),
            plugin_name: "EQ8".to_string(),
            slot_preference: PluginSlotPreference::Effect,
            canonical_slot_hint: Some("effect".to_string()),
            external_audio_inputs: None,
            external_supports_sidechain_input: None,
        };
        let result = ctx.execute(&cmd).unwrap();
        assert!(!result.placed_as_instrument);
        assert_eq!(ctx.lock_project().unwrap().tracks[0].effects.len(), 1);
    }
}
