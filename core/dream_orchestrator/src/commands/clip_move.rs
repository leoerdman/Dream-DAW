// ═══════════════════════════════════════════════════════════════════════════
// MoveClipCommand — Move a clip to a new track and/or position
// ═══════════════════════════════════════════════════════════════════════════

use uuid::Uuid;

use dream_models::mutators;
use dream_models::time::AbsoluteTime;

use crate::context::{Command, OrchestratorContext};
use crate::error::{OrchestratorError, OrchestratorResult};

/// Move a clip (audio or MIDI) to a new track and/or position.
///
/// Tries audio clip move first, falls back to MIDI clip move.
pub struct MoveClipCommand {
    pub clip_id: Uuid,
    pub new_track_index: usize,
    pub new_position_frames: i64,
}

pub struct MoveClipResult {
    pub old_track_index: usize,
}

impl MoveClipCommand {
    pub fn from_str_id(
        clip_id: &str,
        new_track_index: usize,
        new_position_frames: i64,
    ) -> OrchestratorResult<Self> {
        let uuid = Uuid::parse_str(clip_id).map_err(|e| OrchestratorError::InvalidId {
            field: "clip_id",
            value: clip_id.to_string(),
            source: e,
        })?;
        Ok(Self {
            clip_id: uuid,
            new_track_index,
            new_position_frames,
        })
    }
}

impl Command for MoveClipCommand {
    type Result = MoveClipResult;

    fn execute(&self, ctx: &OrchestratorContext) -> OrchestratorResult<MoveClipResult> {
        let mut project = ctx.lock_project()?;

        if self.new_track_index >= project.tracks.len() {
            return Err(OrchestratorError::TrackOutOfRange {
                requested: self.new_track_index,
                total: project.tracks.len(),
            });
        }

        // BUG-025 FIX: Reject negative positions — i64 field allows them but
        // negative timeline positions are semantically invalid.
        if self.new_position_frames < 0 {
            return Err(OrchestratorError::Other(format!(
                "Clip position cannot be negative: {}",
                self.new_position_frames
            )));
        }

        let new_position = AbsoluteTime::new(self.new_position_frames);
        let old_track_index = project
            .tracks
            .iter()
            .position(|track| {
                track.clips.iter().any(|clip| clip.id == self.clip_id)
                    || track.midi_clips.iter().any(|clip| clip.id == self.clip_id)
            })
            .ok_or_else(|| OrchestratorError::NotFound {
                entity: "Clip",
                id: self.clip_id.to_string(),
            })?;

        if let Err(audio_err) = mutators::move_clip(
            &mut project,
            self.clip_id,
            self.new_track_index,
            new_position,
            None,
        ) {
            // Fall back to MIDI clip move
            if mutators::move_midi_clip(
                &mut project,
                self.clip_id,
                self.new_track_index,
                new_position,
                None,
            )
            .is_err()
            {
                return Err(OrchestratorError::MutatorFailed(audio_err));
            }
        }

        Ok(MoveClipResult { old_track_index })
    }
}

// ═══════════════════════════════════════════════════════════════════════════
// MoveMultipleClipsCommand
// ═══════════════════════════════════════════════════════════════════════════

pub struct MoveMultipleClipsCommand {
    /// List of (clip_id, new_track_index, new_position_frames)
    pub clips: Vec<(Uuid, usize, i64)>,
}

impl Command for MoveMultipleClipsCommand {
    type Result = Vec<(Uuid, MoveClipResult)>;

    fn execute(&self, ctx: &OrchestratorContext) -> OrchestratorResult<Self::Result> {
        let mut project = ctx.lock_project()?;
        let mut results = Vec::with_capacity(self.clips.len());

        // ENTERPRISE FIX: Collect ALL batch clip IDs upfront. When moving
        // multiple clips as a group, each clip's overlap resolution must
        // skip the other clips in the batch. Otherwise, clip A's
        // handle_overlaps would delete clip B that was already placed on
        // the target track by a previous iteration.
        let batch_ids: Vec<Uuid> = self.clips.iter().map(|(id, _, _)| *id).collect();

        let mut clip_track_map = std::collections::HashMap::new();
        for (idx, track) in project.tracks.iter().enumerate() {
            for clip in &track.clips {
                clip_track_map.insert(clip.id, idx);
            }
            for clip in &track.midi_clips {
                clip_track_map.insert(clip.id, idx);
            }
        }

        for (clip_id, new_track_index, new_position_frames) in &self.clips {
            if *new_track_index >= project.tracks.len() {
                continue; // Skip invalid moves instead of failing entire transaction
            }

            if *new_position_frames < 0 {
                continue;
            }

            let new_position = AbsoluteTime::new(*new_position_frames);
            
            let old_track_index = match clip_track_map.get(clip_id) {
                Some(&idx) => idx,
                None => continue,
            };

            let audio_err = mutators::move_clip_with_protected(
                &mut project,
                *clip_id,
                *new_track_index,
                new_position,
                &batch_ids,
                Some(old_track_index),
            );

            if audio_err.is_err()
                && mutators::move_midi_clip_with_protected(
                    &mut project,
                    *clip_id,
                    *new_track_index,
                    new_position,
                    &batch_ids,
                    Some(old_track_index),
                )
                .is_err()
            {
                continue;
            }

            results.push((*clip_id, MoveClipResult { old_track_index }));
        }

        Ok(results)
    }
}
