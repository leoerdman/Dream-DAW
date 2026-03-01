// ═══════════════════════════════════════════════════════════════════════════
// DuplicateClipCommand — Duplicate a clip at optional position
// ═══════════════════════════════════════════════════════════════════════════

use uuid::Uuid;

use dream_models::mutators;
use dream_models::time::AbsoluteTime;

use crate::context::{Command, OrchestratorContext};
use crate::error::{OrchestratorError, OrchestratorResult};

/// Result of a duplicate operation.
pub struct DuplicateClipResult {
    pub new_id: Uuid,
    pub new_position_frames: i64,
    pub track_index: usize,
    pub new_duration_frames: i64,
}

/// Duplicate a clip (audio or MIDI), optionally at a specific position.
pub struct DuplicateClipCommand {
    pub clip_id: Uuid,
    pub new_position_frames: Option<i64>,
    pub target_track_index: Option<usize>,
}

impl DuplicateClipCommand {
    pub fn from_str_id(
        clip_id: &str,
        new_position_frames: Option<i64>,
        target_track_index: Option<usize>,
    ) -> OrchestratorResult<Self> {
        let uuid = Uuid::parse_str(clip_id).map_err(|e| OrchestratorError::InvalidId {
            field: "clip_id",
            value: clip_id.to_string(),
            source: e,
        })?;
        Ok(Self {
            clip_id: uuid,
            new_position_frames,
            target_track_index,
        })
    }
}

impl Command for DuplicateClipCommand {
    type Result = DuplicateClipResult;

    fn execute(&self, ctx: &OrchestratorContext) -> OrchestratorResult<DuplicateClipResult> {
        let mut project = ctx.lock_project()?;
        let target_pos = self.new_position_frames.map(AbsoluteTime::new);

        let track_index = project
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

        // DUP-03 FIX: Determine clip type explicitly instead of error-swallowing fallback.
        let is_audio_clip = project.tracks[track_index]
            .clips
            .iter()
            .any(|c| c.id == self.clip_id);

        let (new_id, new_position_frames, new_duration_frames) = if is_audio_clip {
            let dup = mutators::duplicate_clip(&mut project, self.clip_id, target_pos, self.target_track_index, None)?;
            (dup.id, dup.position.sample_frame, dup.duration.sample_frame)
        } else {
            let dup = mutators::duplicate_midi_clip(&mut project, self.clip_id, target_pos, self.target_track_index, None)?;
            (dup.id, dup.position.sample_frame, dup.duration.sample_frame)
        };

        Ok(DuplicateClipResult {
            new_id,
            new_position_frames,
            track_index: self.target_track_index.unwrap_or(track_index),
            new_duration_frames,
        })
    }
}

// ═══════════════════════════════════════════════════════════════════════════
// DuplicateMultipleClipsCommand
// ═══════════════════════════════════════════════════════════════════════════

pub struct DuplicateMultipleClipsCommand {
    pub clips: Vec<(Uuid, Option<i64>, Option<usize>)>,
}

impl Command for DuplicateMultipleClipsCommand {
    type Result = Vec<DuplicateClipResult>;

    fn execute(&self, ctx: &OrchestratorContext) -> OrchestratorResult<Self::Result> {
        let mut project = ctx.lock_project()?;
        let mut results = Vec::with_capacity(self.clips.len());

        // ENTERPRISE FIX: Progressive protected_ids — as each clip is
        // duplicated, its new ID is added to the protected set. This
        // prevents clip N+1's overlap resolution from deleting clip N's
        // newly-created duplicate. Source clip IDs are also protected
        // since they should never be affected by sibling duplicates.
        let source_ids: Vec<Uuid> = self.clips.iter().map(|(id, _, _)| *id).collect();
        let mut protected_ids: Vec<Uuid> = source_ids.clone();

        let mut clip_track_map = std::collections::HashMap::new();
        for (idx, track) in project.tracks.iter().enumerate() {
            for clip in &track.clips {
                clip_track_map.insert(clip.id, idx);
            }
            for clip in &track.midi_clips {
                clip_track_map.insert(clip.id, idx);
            }
        }

        for (clip_id, dest_pos, dest_track) in &self.clips {
            let target_pos = dest_pos.map(AbsoluteTime::new);
            
            let track_index = match clip_track_map.get(clip_id) {
                Some(&idx) => idx,
                None => continue,
            };

            let is_audio_clip = project.tracks[track_index]
                .clips
                .iter()
                .any(|c| c.id == *clip_id);

            if is_audio_clip {
                if let Ok(dup) = mutators::duplicate_clip_with_protected(
                    &mut project, *clip_id, target_pos, *dest_track, &protected_ids, Some(track_index),
                ) {
                    // Add the new ID to protected set for subsequent iterations
                    protected_ids.push(dup.id);
                    results.push(DuplicateClipResult {
                        new_id: dup.id,
                        new_position_frames: dup.position.sample_frame,
                        track_index: dest_track.unwrap_or(track_index),
                        new_duration_frames: dup.duration.sample_frame,
                    });
                }
            } else if let Ok(dup) = mutators::duplicate_midi_clip_with_protected(
                &mut project, *clip_id, target_pos, *dest_track, &protected_ids, Some(track_index),
            ) {
                // Add the new ID to protected set for subsequent iterations
                protected_ids.push(dup.id);
                results.push(DuplicateClipResult {
                    new_id: dup.id,
                    new_position_frames: dup.position.sample_frame,
                    track_index: dest_track.unwrap_or(track_index),
                    new_duration_frames: dup.duration.sample_frame,
                });
            }
        }

        Ok(results)
    }
}
