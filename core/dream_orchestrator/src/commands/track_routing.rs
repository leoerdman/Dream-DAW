use uuid::Uuid;

use crate::context::{Command, OrchestratorContext};
use crate::error::{OrchestratorError, OrchestratorResult};
use dream_models::project::DeviceNode;

#[derive(Debug, Clone, Copy)]
pub struct SetTrackRoutingResult {
    pub changed: bool,
}

pub struct SetTrackRoutingCommand {
    pub track_id: Uuid,
    pub output_destination_id: Option<Uuid>,
}

#[derive(Debug, Clone, Copy)]
pub struct SetTrackInputResult {
    pub changed: bool,
}

pub struct SetTrackInputCommand {
    pub track_id: Uuid,
    pub input_source_id: Option<String>,
}

#[derive(Debug, Clone, Copy)]
pub struct SetPluginSidechainSourceResult {
    pub changed: bool,
}

pub struct SetPluginSidechainSourceCommand {
    pub track_id: Uuid,
    pub slot_id: Uuid,
    pub source_track_id: Option<Uuid>,
}

impl SetTrackRoutingCommand {
    pub fn from_str_ids(track_id: &str, target_id: &str) -> OrchestratorResult<Self> {
        let track_id = Uuid::parse_str(track_id).map_err(|e| OrchestratorError::InvalidId {
            field: "track_id",
            value: track_id.to_string(),
            source: e,
        })?;

        let output_destination_id = if target_id == "master" {
            None
        } else {
            Some(
                Uuid::parse_str(target_id).map_err(|e| OrchestratorError::InvalidId {
                    field: "target_id",
                    value: target_id.to_string(),
                    source: e,
                })?,
            )
        };

        Ok(Self {
            track_id,
            output_destination_id,
        })
    }
}

impl SetTrackInputCommand {
    pub fn from_str_ids(track_id: &str, input_id: &str) -> OrchestratorResult<Self> {
        let track_id = Uuid::parse_str(track_id).map_err(|e| OrchestratorError::InvalidId {
            field: "track_id",
            value: track_id.to_string(),
            source: e,
        })?;
        let input_source_id = if input_id == "none" {
            None
        } else {
            Some(input_id.to_string())
        };
        Ok(Self {
            track_id,
            input_source_id,
        })
    }
}

impl SetPluginSidechainSourceCommand {
    pub fn from_str_ids(
        track_id: &str,
        slot_id: &str,
        source_track_id: &str,
    ) -> OrchestratorResult<Self> {
        let track_id = Uuid::parse_str(track_id).map_err(|e| OrchestratorError::InvalidId {
            field: "track_id",
            value: track_id.to_string(),
            source: e,
        })?;
        let slot_id = Uuid::parse_str(slot_id).map_err(|e| OrchestratorError::InvalidId {
            field: "slot_id",
            value: slot_id.to_string(),
            source: e,
        })?;
        let source_track_id = {
            let normalized = source_track_id.trim();
            if normalized.is_empty() || normalized.eq_ignore_ascii_case("none") {
                None
            } else {
                Some(
                    Uuid::parse_str(normalized).map_err(|e| OrchestratorError::InvalidId {
                        field: "source_track_id",
                        value: normalized.to_string(),
                        source: e,
                    })?,
                )
            }
        };
        Ok(Self {
            track_id,
            slot_id,
            source_track_id,
        })
    }
}

impl Command for SetTrackRoutingCommand {
    type Result = SetTrackRoutingResult;

    fn execute(&self, ctx: &OrchestratorContext) -> OrchestratorResult<Self::Result> {
        let mut project = ctx.lock_project()?;
        if let Some(dest_id) = self.output_destination_id {
            if !project.tracks.iter().any(|t| t.id == dest_id) {
                return Err(OrchestratorError::NotFound {
                    entity: "DestinationTrack",
                    id: dest_id.to_string(),
                });
            }
            if dest_id == self.track_id {
                return Err(OrchestratorError::Other(
                    "Track cannot route to itself".to_string(),
                ));
            }
        }

        let track = project
            .tracks
            .iter_mut()
            .find(|t| t.id == self.track_id)
            .ok_or_else(|| OrchestratorError::NotFound {
                entity: "Track",
                id: self.track_id.to_string(),
            })?;
        if track.output_destination_id == self.output_destination_id {
            return Ok(SetTrackRoutingResult { changed: false });
        }
        track.output_destination_id = self.output_destination_id;
        Ok(SetTrackRoutingResult { changed: true })
    }
}

impl Command for SetTrackInputCommand {
    type Result = SetTrackInputResult;

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
        if track.input_source_id == self.input_source_id {
            return Ok(SetTrackInputResult { changed: false });
        }
        track.input_source_id = self.input_source_id.clone();
        Ok(SetTrackInputResult { changed: true })
    }
}

impl Command for SetPluginSidechainSourceCommand {
    type Result = SetPluginSidechainSourceResult;

    fn execute(&self, ctx: &OrchestratorContext) -> OrchestratorResult<Self::Result> {
        let mut project = ctx.lock_project()?;

        if let Some(source_id) = self.source_track_id {
            let source_exists = project.tracks.iter().any(|t| t.id == source_id);
            if !source_exists {
                return Err(OrchestratorError::NotFound {
                    entity: "SourceTrack",
                    id: source_id.to_string(),
                });
            }
            if source_id == self.track_id {
                return Err(OrchestratorError::Other(
                    "Sidechain source cannot be the same track".to_string(),
                ));
            }
        }

        let track = project
            .tracks
            .iter_mut()
            .find(|t| t.id == self.track_id)
            .ok_or_else(|| OrchestratorError::NotFound {
                entity: "Track",
                id: self.track_id.to_string(),
            })?;

        let source_value = self.source_track_id.map(|id| id.to_string());
        let mut updated = false;
        let mut changed = false;

        if let Some(inst) = track.instrument.as_mut()
            && let Some(slot) = inst.as_single_mut()
            && slot.id == self.slot_id
        {
            validate_sidechain_support(slot)?;
            changed = slot.sidechain_source_track_id != source_value;
            slot.sidechain_source_track_id = source_value.clone();
            updated = true;
        }

        if !updated {
            match find_and_set_sidechain(&mut track.effects, self.slot_id, &source_value) {
                Ok(Some(slot_changed)) => {
                    changed = slot_changed;
                    updated = true;
                }
                Ok(None) => {}
                Err(e) => return Err(e),
            }
        }

        if !updated {
            return Err(OrchestratorError::NotFound {
                entity: "PluginSlot",
                id: self.slot_id.to_string(),
            });
        }

        Ok(SetPluginSidechainSourceResult { changed })
    }
}

fn validate_sidechain_support(slot: &dream_models::project::PluginSlot) -> OrchestratorResult<()> {
    if slot.supports_sidechain_input == Some(false) && slot.plugin_id.starts_with("internal://") {
        return Err(OrchestratorError::Other(
            "Plugin does not expose sidechain input".to_string(),
        ));
    }
    Ok(())
}

fn find_and_set_sidechain(
    nodes: &mut [DeviceNode],
    slot_id: Uuid,
    source_value: &Option<String>,
) -> OrchestratorResult<Option<bool>> {
    for node in nodes {
        match node {
            DeviceNode::Single(slot) if slot.id == slot_id => {
                validate_sidechain_support(slot)?;
                let changed = slot.sidechain_source_track_id != *source_value;
                slot.sidechain_source_track_id = source_value.clone();
                return Ok(Some(changed));
            }
            DeviceNode::Rack(rack) => {
                for chain in &mut rack.chains {
                    if let Some(changed) =
                        find_and_set_sidechain(&mut chain.devices, slot_id, source_value)?
                    {
                        return Ok(Some(changed));
                    }
                }
            }
            _ => {}
        }
    }
    Ok(None)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::context::OrchestratorContext;
    use dream_models::project::{PluginSlot, Project, Track};

    #[test]
    fn set_track_routing_updates_destination() {
        let mut project = Project::new("t", 120.0, 44100.0);
        let source = Track::new("A");
        let source_id = source.id;
        let dest = Track::new("B");
        let dest_id = dest.id;
        project.tracks = vec![source, dest];

        let ctx = OrchestratorContext::new(project);
        let cmd = SetTrackRoutingCommand {
            track_id: source_id,
            output_destination_id: Some(dest_id),
        };
        let result = ctx.execute(&cmd).expect("execute");
        assert!(result.changed);

        let project = ctx.lock_project().expect("lock");
        assert_eq!(project.tracks[0].output_destination_id, Some(dest_id));
    }

    #[test]
    fn set_track_input_updates_input_source() {
        let mut project = Project::new("t", 120.0, 44100.0);
        let track = Track::new("A");
        let track_id = track.id;
        project.tracks.push(track);

        let ctx = OrchestratorContext::new(project);
        let cmd = SetTrackInputCommand {
            track_id,
            input_source_id: Some("mic_1".to_string()),
        };
        let result = ctx.execute(&cmd).expect("execute");
        assert!(result.changed);

        let project = ctx.lock_project().expect("lock");
        assert_eq!(project.tracks[0].input_source_id.as_deref(), Some("mic_1"));
    }

    #[test]
    fn set_plugin_sidechain_source_updates_effect_slot() {
        let mut project = Project::new("t", 120.0, 44100.0);
        let mut source_track = Track::new("A");
        let source_track_id = source_track.id;
        let mut effect_slot = PluginSlot::new("Compressor", "internal://compressor");
        effect_slot.supports_sidechain_input = Some(true);
        let slot_id = effect_slot.id;
        source_track.effects.push(DeviceNode::single(effect_slot));

        let carrier_track = Track::new("B");
        let carrier_track_id = carrier_track.id;

        project.tracks = vec![source_track, carrier_track];
        let ctx = OrchestratorContext::new(project);

        let cmd = SetPluginSidechainSourceCommand {
            track_id: source_track_id,
            slot_id,
            source_track_id: Some(carrier_track_id),
        };
        let result = ctx.execute(&cmd).expect("execute");
        assert!(result.changed);

        let project = ctx.lock_project().expect("lock");
        let slot = match &project.tracks[0].effects[0] {
            DeviceNode::Single(slot) => slot,
            DeviceNode::Rack(_) => panic!("expected single slot"),
        };
        let expected = carrier_track_id.to_string();
        assert_eq!(
            slot.sidechain_source_track_id.as_deref(),
            Some(expected.as_str())
        );
    }
}
