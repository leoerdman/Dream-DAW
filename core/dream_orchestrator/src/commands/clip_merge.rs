// ═══════════════════════════════════════════════════════════════════════════
// MergeClipsCommand — Merge multiple clips into one on the same track
// ═══════════════════════════════════════════════════════════════════════════

use uuid::Uuid;

use dream_models::midi::MidiClip;

use dream_models::time::AbsoluteTime;

use crate::context::{Command, OrchestratorContext};
use crate::error::{OrchestratorError, OrchestratorResult};

/// Result of a merge operation.
pub struct MergeClipsResult {
    pub new_id: Uuid,
}

/// Merge multiple clips (all audio OR all MIDI) on one track into a single clip.
///
/// The merged clip spans from the earliest start to the latest end of all
/// selected clips. For MIDI, notes are repositioned relative to the merged start.
pub struct MergeClipsCommand {
    pub clip_ids: Vec<Uuid>,
}

impl MergeClipsCommand {
    pub fn from_str_ids(clip_ids: &[String]) -> OrchestratorResult<Self> {
        if clip_ids.is_empty() {
            return Err(OrchestratorError::Other("No clips selected".to_string()));
        }
        let ids: Result<Vec<Uuid>, _> = clip_ids
            .iter()
            .map(|id| {
                Uuid::parse_str(id).map_err(|e| OrchestratorError::InvalidId {
                    field: "clip_id",
                    value: id.clone(),
                    source: e,
                })
            })
            .collect();
        Ok(Self { clip_ids: ids? })
    }
}

impl Command for MergeClipsCommand {
    type Result = MergeClipsResult;

    fn execute(&self, ctx: &OrchestratorContext) -> OrchestratorResult<MergeClipsResult> {
        let mut project = ctx.lock_project()?;
        let ids = &self.clip_ids;

        // Find the single track containing ALL selected clips.
        let mut selected_track_idx: Option<usize> = None;
        for (ti, track) in project.tracks.iter().enumerate() {
            let audio_hits = ids
                .iter()
                .filter(|id| track.clips.iter().any(|c| c.id == **id))
                .count();
            let midi_hits = ids
                .iter()
                .filter(|id| track.midi_clips.iter().any(|c| c.id == **id))
                .count();
            if audio_hits == ids.len() || midi_hits == ids.len() {
                selected_track_idx = Some(ti);
                break;
            }
        }
        let ti = selected_track_idx.ok_or_else(|| {
            OrchestratorError::Other("Selected clips must be on one track".to_string())
        })?;
        let track = &mut project.tracks[ti];

        let audio_selected: Vec<_> = track
            .clips
            .iter()
            .filter(|c| ids.contains(&c.id))
            .cloned()
            .collect();
        let midi_selected: Vec<_> = track
            .midi_clips
            .iter()
            .filter(|c| ids.contains(&c.id))
            .cloned()
            .collect();

        if !audio_selected.is_empty() {
            return Err(OrchestratorError::Other(
                "Audio clips cannot be merged non-destructively. Use Bounce Selection instead.".to_string(),
            ));
        }
        if midi_selected.len() < 2 {
            return Err(OrchestratorError::Other(
                "Select at least two MIDI clips to merge".to_string(),
            ));
        }

        let new_id = Uuid::new_v4();

        let start = midi_selected
            .iter()
            .map(|c| c.position.sample_frame)
            .min()
            .ok_or_else(|| OrchestratorError::Other("No MIDI clips selected".to_string()))?;
        let end = midi_selected
            .iter()
            .map(|c| c.end_position().sample_frame)
            .max()
            .ok_or_else(|| OrchestratorError::Other("No MIDI clips selected".to_string()))?;

        let mut merged = MidiClip::new(
            "Merged Clip",
            AbsoluteTime::new(start),
            AbsoluteTime::new((end - start).max(1)),
        );
        merged.id = new_id;
        for clip in &midi_selected {
            let clip_offset = clip.position.sample_frame - start;
            for note in &clip.notes {
                let mut moved = *note;
                moved.start_frame = (note.start_frame + clip_offset).max(0);
                merged.add_note(moved);
            }
        }
        // DUP-07 FIX: Deduplicate notes at same pitch+start, keeping the longer one.
        // Notes are already sorted by start_frame (via add_note), so dedup_by works.
        merged.notes.dedup_by(|b, a| {
            if a.pitch == b.pitch && a.start_frame == b.start_frame {
                // Keep whichever has the longer duration in slot `a` (the survivor).
                if b.duration_frames > a.duration_frames {
                    a.duration_frames = b.duration_frames;
                }
                true
            } else {
                false
            }
        });

        track.midi_clips.retain(|c| !ids.contains(&c.id));
        let insert_at = track
            .midi_clips
            .binary_search_by(|c| c.position.cmp(&merged.position))
            .unwrap_or_else(|i| i);
        track.midi_clips.insert(insert_at, merged);

        Ok(MergeClipsResult { new_id })
    }
}

/// Consolidate a region on a MIDI track into a single MIDI clip.
pub struct ConsolidateMidiRegionCommand {
    pub track_index: usize,
    pub start_frame: i64,
    pub duration_frames: i64,
}

impl Command for ConsolidateMidiRegionCommand {
    type Result = MergeClipsResult;

    fn execute(&self, ctx: &OrchestratorContext) -> OrchestratorResult<MergeClipsResult> {
        let mut project = ctx.lock_project()?;
        let clip = dream_models::mutators::consolidate_midi_region(
            &mut project,
            self.track_index,
            AbsoluteTime::new(self.start_frame),
            AbsoluteTime::new(self.duration_frames),
        )
        .map_err(|e| OrchestratorError::Other(e.to_string()))?;
        Ok(MergeClipsResult { new_id: clip.id })
    }
}
