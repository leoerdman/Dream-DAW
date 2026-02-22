use uuid::Uuid;

use dream_models::midi::{MidiClip, MidiNote};
use dream_models::project::ClipEnvelope;

use crate::context::{Command, OrchestratorContext};
use crate::error::{OrchestratorError, OrchestratorResult};

// ═══════════════════════════════════════════════════════════════════════════
// UpdateMidiClipCommand
// ═══════════════════════════════════════════════════════════════════════════

pub struct UpdateMidiClipCommand {
    pub clip_id: Uuid,
    pub notes: Vec<MidiNote>,
}

impl UpdateMidiClipCommand {
    pub fn from_str_id(clip_id: &str, notes: Vec<MidiNote>) -> OrchestratorResult<Self> {
        let uuid = Uuid::parse_str(clip_id).map_err(|e| OrchestratorError::InvalidId {
            field: "clip_id",
            value: clip_id.to_string(),
            source: e,
        })?;
        Ok(Self {
            clip_id: uuid,
            notes,
        })
    }
}

impl Command for UpdateMidiClipCommand {
    type Result = ();

    fn execute(&self, ctx: &OrchestratorContext) -> OrchestratorResult<()> {
        let mut project = ctx.lock_project()?;

        let mut found = false;
        for track in &mut project.tracks {
            if let Some(clip) = track.midi_clips.iter_mut().find(|c| c.id == self.clip_id) {
                clip.notes = self.notes.clone();
                found = true;
                break;
            }
        }

        if !found {
            // Check legacy empty-path audio clips
            for track in &mut project.tracks {
                if let Some(idx) = track
                    .clips
                    .iter()
                    .position(|c| c.id == self.clip_id && c.file_path.trim().is_empty())
                {
                    let legacy = track.clips.remove(idx);
                    let mut migrated =
                        MidiClip::new(&legacy.name, legacy.position, legacy.duration);
                    migrated.id = legacy.id;
                    migrated.notes = self.notes.clone();
                    track.midi_clips.push(migrated);
                    found = true;
                    break;
                }
            }
        }

        if !found {
            return Err(OrchestratorError::NotFound {
                entity: "MIDI clip",
                id: self.clip_id.to_string(),
            });
        }

        Ok(())
    }
}

// ═══════════════════════════════════════════════════════════════════════════
// SetMidiClipEnvelopesCommand
// ═══════════════════════════════════════════════════════════════════════════

pub struct SetMidiClipEnvelopesCommand {
    pub clip_id: Uuid,
    pub envelopes: Vec<ClipEnvelope>,
}

impl SetMidiClipEnvelopesCommand {
    pub fn from_str_id(clip_id: &str, envelopes: Vec<ClipEnvelope>) -> OrchestratorResult<Self> {
        let uuid = Uuid::parse_str(clip_id).map_err(|e| OrchestratorError::InvalidId {
            field: "clip_id",
            value: clip_id.to_string(),
            source: e,
        })?;
        Ok(Self {
            clip_id: uuid,
            envelopes,
        })
    }
}

impl Command for SetMidiClipEnvelopesCommand {
    type Result = ();

    fn execute(&self, ctx: &OrchestratorContext) -> OrchestratorResult<()> {
        let mut project = ctx.lock_project()?;

        let mut found = false;
        for track in &mut project.tracks {
            if let Some(clip) = track.midi_clips.iter_mut().find(|c| c.id == self.clip_id) {
                clip.envelopes = self.envelopes.clone();
                found = true;
                break;
            }
        }

        if !found {
            return Err(OrchestratorError::NotFound {
                entity: "MIDI clip",
                id: self.clip_id.to_string(),
            });
        }

        Ok(())
    }
}
