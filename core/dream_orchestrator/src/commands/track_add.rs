use crate::context::{Command, OrchestratorContext};
use crate::error::{OrchestratorError, OrchestratorResult};
use dream_models::project::{Track, TrackColor, TrackType};
use uuid::Uuid;

#[derive(Debug, Clone)]
pub struct AddTrackResult {
    pub track_id: Uuid,
    pub track_index: usize,
    pub name: String,
    pub track_type: TrackType,
}

pub struct AddTrackCommand {
    pub name: Option<String>,
    pub track_type: Option<String>,
    pub insert_after_index: Option<usize>,
    pub inherit_from_track_id: Option<String>,
}

impl Command for AddTrackCommand {
    type Result = AddTrackResult;

    fn execute(&self, ctx: &OrchestratorContext) -> OrchestratorResult<Self::Result> {
        let mut project = ctx.lock_project()?;

        if project.tracks.len() >= 256 {
            return Err(OrchestratorError::Other(
                "Maximum track count (256) reached. Remove existing tracks to add more."
                    .to_string(),
            ));
        }

        let normalized_type = self
            .track_type
            .clone()
            .unwrap_or_else(|| "audio".to_string())
            .to_ascii_lowercase();
        let resolved_type = match normalized_type.as_str() {
            "audio" => TrackType::Audio,
            "midi" => TrackType::Midi,
            "group" => TrackType::Group,
            other => {
                return Err(OrchestratorError::Other(format!(
                    "Unsupported track type: {other}"
                )));
            }
        };

        let track_num = match resolved_type {
            TrackType::Audio => {
                project
                    .tracks
                    .iter()
                    .filter(|t| t.track_type == TrackType::Audio)
                    .count()
                    + 1
            }
            TrackType::Midi => {
                project
                    .tracks
                    .iter()
                    .filter(|t| t.track_type == TrackType::Midi)
                    .count()
                    + 1
            }
            TrackType::Group => {
                project
                    .tracks
                    .iter()
                    .filter(|t| t.track_type == TrackType::Group)
                    .count()
                    + 1
            }
            TrackType::Master => project.tracks.len() + 1,
        };
        let default_prefix = match resolved_type {
            TrackType::Audio => "Audio",
            TrackType::Midi => "MIDI",
            TrackType::Group => "Group",
            TrackType::Master => "Track",
        };
        let track_name = self
            .name
            .clone()
            .unwrap_or_else(|| format!("{default_prefix} {track_num}"));

        let inherited_track_id = self
            .inherit_from_track_id
            .as_deref()
            .filter(|raw| !raw.trim().is_empty() && *raw != "master")
            .map(|raw| {
                Uuid::parse_str(raw).map_err(|e| OrchestratorError::InvalidId {
                    field: "inherit_from_track_id",
                    value: raw.to_string(),
                    source: e,
                })
            })
            .transpose()?;

        let inherited_parent_group = inherited_track_id
            .and_then(|inherited_id| {
                project
                    .tracks
                    .iter()
                    .find(|t| t.id == inherited_id)
                    .map(|t| {
                        if t.track_type == TrackType::Group {
                            Some(t.id)
                        } else {
                            t.parent_track_id
                        }
                    })
            })
            .flatten();

        let inherited_group_color = inherited_parent_group.and_then(|gid| {
            project
                .tracks
                .iter()
                .find(|t| t.id == gid)
                .map(|t| (t.color, t.color_hex.clone()))
        });

        let insert_index = self
            .insert_after_index
            .map(|idx| idx.saturating_add(1))
            .unwrap_or(project.tracks.len())
            .min(project.tracks.len());

        let mut track = Track::with_type(&track_name, resolved_type, insert_index);
        track.parent_track_id = inherited_parent_group;
        track.output_destination_id = inherited_parent_group;
        match inherited_group_color {
            Some((color_enum, color_hex)) => {
                track.color = color_enum;
                track.color_hex = color_hex;
            }
            None => {
                track.color = TrackColor::for_index(insert_index);
            }
        }
        let track_id = track.id;
        project.tracks.insert(insert_index, track);

        Ok(AddTrackResult {
            track_id,
            track_index: insert_index,
            name: track_name,
            track_type: resolved_type,
        })
    }
}
