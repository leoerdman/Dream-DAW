// Project mutators: deterministic timeline operations on `Project`.
use crate::midi::MidiClip;
use crate::project::{AudioClip, Project, TrackType};
use crate::time::AbsoluteTime;
use uuid::Uuid;
mod mutators_helpers;
pub use mutators_helpers::upsert_static_automation_lane;
pub use mutators_helpers::{
    find_and_remove_clip, find_clip_location, find_midi_clip_location, handle_midi_overlaps,
    handle_overlaps,
};
// ── Error Types ───────────────────────────────────────────────────────────
/// Errors from timeline mutation operations.
#[derive(Debug, Clone, PartialEq)]
pub enum MutatorError {
    /// The specified clip was not found in any track.
    ClipNotFound(Uuid),
    /// The target track index is out of range.
    TrackOutOfRange { requested: usize, available: usize },
    /// The split position is outside the clip's bounds.
    SplitOutOfBounds {
        clip_start: i64,
        clip_end: i64,
        split_frame: i64,
    },
    /// The clip is too short to split (would produce a zero-length fragment).
    ClipTooShort {
        clip_duration: i64,
        min_duration: i64,
    },
    /// The requested position is negative (semantically invalid for timeline).
    NegativePosition {
        clip_id: Uuid,
        position: i64,
    },
    /// The requested operation is invalid for the target track type.
    InvalidOperation {
        reason: String,
    },
}
impl std::fmt::Display for MutatorError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::ClipNotFound(id) => write!(f, "Clip not found: {id}"),
            Self::TrackOutOfRange {
                requested,
                available,
            } => write!(f, "Track index {requested} out of range (0..{available})"),
            Self::SplitOutOfBounds {
                clip_start,
                clip_end,
                split_frame,
            } => write!(
                f,
                "Split frame {split_frame} outside clip bounds [{clip_start}, {clip_end})"
            ),
            Self::ClipTooShort {
                clip_duration,
                min_duration,
            } => write!(
                f,
                "Clip too short to split ({clip_duration} frames, minimum {min_duration})"
            ),
            Self::NegativePosition { clip_id, position } => write!(
                f,
                "Clip {clip_id} position cannot be negative: {position}"
            ),
            Self::InvalidOperation { reason } => write!(f, "Invalid operation: {reason}"),
        }
    }
}
impl std::error::Error for MutatorError {}
// ── Minimum Clip Duration ─────────────────────────────────────────────────
/// Minimum clip duration in sample frames after a split.
///
/// At 44.1kHz, 128 frames ≈ 2.9ms — enough for a complete micro-fade cycle
/// (88 frames at 44.1kHz). This prevents degenerate zero-length clips.
const MIN_CLIP_FRAMES: i64 = 128;
#[inline]
fn clamp_f64_to_i64(value: f64) -> i64 {
    if !value.is_finite() {
        return 0;
    }
    if value > i64::MAX as f64 {
        i64::MAX
    } else if value < i64::MIN as f64 {
        i64::MIN
    } else {
        value as i64
    }
}
// ── Move Clip ─────────────────────────────────────────────────────────────
/// Moves a clip to a new track and/or position on the timeline.
///
/// If the target track is the same as the source track and the position
/// hasn't changed, this is a no-op (returns `Ok`).
///
/// # Arguments
/// - `project`: The project to mutate (mutable reference).
/// - `clip_id`: UUID of the clip to move.
/// - `new_track_index`: Target track index.
/// - `new_position`: New timeline position (sample frames).
///
/// # Behavior
/// 1. Finds the clip across all tracks by UUID.
/// 2. Removes it from its current track.
/// 3. Updates its position.
/// 4. Inserts it into the target track, maintaining sorted order by position.
pub fn move_clip(
    project: &mut Project,
    clip_id: Uuid,
    new_track_index: usize,
    new_position: AbsoluteTime,
) -> Result<(), MutatorError> {
    // Validate target track
    if new_track_index >= project.tracks.len() {
        return Err(MutatorError::TrackOutOfRange {
            requested: new_track_index,
            available: project.tracks.len(),
        });
    }
    if project.tracks[new_track_index].track_type == TrackType::Group {
        return Err(MutatorError::InvalidOperation {
            reason: "Cannot place clips on a group track".into(),
        });
    }
    // Find and remove the clip from its current track
    let (_source_track_idx, mut clip) = find_and_remove_clip(project, clip_id)?;
    // Update position
    clip.position = new_position;
    // Insert into target track (sorted by position for efficient scheduling)
    let target_track = &mut project.tracks[new_track_index];
    // Handle overlaps before final insertion
    handle_overlaps(target_track, &clip, &[]);
    let insert_pos = target_track
        .clips
        .binary_search_by(|c| c.position.cmp(&clip.position))
        .unwrap_or_else(|i| i);
    target_track.clips.insert(insert_pos, clip);
    Ok(())
}

/// Same as `move_clip`, but with a `protected_ids` set for batch operations.
/// Clips whose IDs are in `protected_ids` will NOT be deleted/trimmed by
/// overlap resolution — they are being moved in the same batch.
pub fn move_clip_protected(
    project: &mut Project,
    clip_id: Uuid,
    new_track_index: usize,
    new_position: AbsoluteTime,
    protected_ids: &[Uuid],
) -> Result<(), MutatorError> {
    if new_track_index >= project.tracks.len() {
        return Err(MutatorError::TrackOutOfRange {
            requested: new_track_index,
            available: project.tracks.len(),
        });
    }
    if project.tracks[new_track_index].track_type == TrackType::Group {
        return Err(MutatorError::InvalidOperation {
            reason: "Cannot place clips on a group track".into(),
        });
    }
    // ENTERPRISE FIX: Clamp negative positions to frame 0 instead of erroring.
    // Returning Err here caused clips to vanish — find_and_remove_clip() removes
    // the clip from its source track, so if we error after that the clip is lost.
    let new_position = if new_position.sample_frame < 0 {
        AbsoluteTime::new(0)
    } else {
        new_position
    };
    let (_source_track_idx, mut clip) = find_and_remove_clip(project, clip_id)?;
    clip.position = new_position;
    let target_track = &mut project.tracks[new_track_index];
    handle_overlaps(target_track, &clip, protected_ids);
    let insert_pos = target_track
        .clips
        .binary_search_by(|c| c.position.cmp(&clip.position))
        .unwrap_or_else(|i| i);
    target_track.clips.insert(insert_pos, clip);
    Ok(())
}
// ── Resize Clip ──────────────────────────────────────────────────────────
/// Resizes a clip by updating its position and duration on the timeline.
///
/// # Arguments
/// - `project`: The project to mutate.
/// - `clip_id`: UUID of the clip to resize.
/// - `new_position`: New timeline position (sample frames).
/// - `new_duration`: New duration (sample frames).
pub fn resize_clip(
    project: &mut Project,
    clip_id: Uuid,
    new_position: AbsoluteTime,
    new_duration: AbsoluteTime,
    allow_stretch: bool,
) -> Result<(), MutatorError> {
    // Validate duration
    if new_duration.sample_frame < MIN_CLIP_FRAMES {
        return Err(MutatorError::ClipTooShort {
            clip_duration: new_duration.sample_frame,
            min_duration: MIN_CLIP_FRAMES,
        });
    }
    // Find and remove the clip
    let (track_idx, mut clip) = find_and_remove_clip(project, clip_id)?;

    // ── Capture IMMUTABLE originals BEFORE any mutation ──────────────
    let original_duration = clip.duration.sample_frame.max(MIN_CLIP_FRAMES);
    let original_warp_source = clip.warp_source_duration_frames.max(MIN_CLIP_FRAMES);
    // ENTERPRISE FIX (RATCHET BUG): Use source_file_total_frames as the absolute
    // upper bound. This field is set once at import and NEVER modified by resize.
    // Fallback: if source_file_total_frames is 0 (legacy clips), use the old heuristic.
    let source_file_total = if clip.source_file_total_frames > 0 {
        clip.source_file_total_frames
    } else {
        // Legacy fallback for clips created before this field existed
        clip.warp_source_duration_frames
            .max(clip.duration.sample_frame)
            .max(MIN_CLIP_FRAMES)
    };

    // Left-edge move semantics:
    // - trim (allow_stretch=false): advance source_offset, waveform stays static
    // - stretch (allow_stretch=true): keep source_offset fixed, timeline duration changes
    let left_edge_delta = new_position.sample_frame - clip.position.sample_frame;

    if left_edge_delta != 0 && !allow_stretch {
        // ENTERPRISE FIX (LEFT-EDGE COMPRESSION): For warped clips, source offset
        // advancement must be scaled by the warp ratio to match the actual
        // source-domain distance, not the timeline-domain distance.
        if clip.is_warped && original_duration > 0 {
            let warp_ratio = original_warp_source as f64 / original_duration as f64;
            let source_delta = (left_edge_delta as f64 * warp_ratio).round() as i64;
            clip.source_offset =
                AbsoluteTime::new((clip.source_offset.sample_frame + source_delta).max(0));
        } else {
            clip.source_offset =
                AbsoluteTime::new((clip.source_offset.sample_frame + left_edge_delta).max(0));
        }
    }

    // Update position
    clip.position = new_position;
    let mut next_duration = new_duration.sample_frame;

    // ── Stretch mode (Shift-resize) ─────────────────────────────────
    if allow_stretch {
        clip.is_warped = true;
        if clip.warp_mode.is_none() {
            clip.warp_mode = Some(0);
        }
        clip.warp_base_bpm = project
            .pulse_map
            .bpm_at(new_position.sample_frame)
            .max(1e-6);
        if clip.warp_source_duration_frames <= 0 {
            clip.warp_source_duration_frames = clip.duration.sample_frame.max(MIN_CLIP_FRAMES);
        }
        clip.warp_markers.clear();
    }

    // ── Trim mode (default, no stretch) ─────────────────────────────
    if !allow_stretch {
        // Clamp source_offset to valid range using immutable source_file_total
        let max_source_offset = source_file_total.saturating_sub(MIN_CLIP_FRAMES).max(0);
        clip.source_offset =
            AbsoluteTime::new(clip.source_offset.sample_frame.clamp(0, max_source_offset));

        // Clear warp markers if left edge moved (they're anchored to clip timeline 0)
        if left_edge_delta != 0 && clip.is_warped {
            clip.warp_markers.clear();
        }

        if clip.is_warped && original_warp_source > 0 && original_duration > 0 {
            // ENTERPRISE FIX (DRIFT BUG): Compute ratio from ORIGINAL pre-mutation
            // values only. This prevents cumulative floating-point error.
            let source_per_timeline =
                original_warp_source as f64 / original_duration as f64;

            // Clamp timeline duration to available source after offset
            let source_available = (source_file_total
                - clip.source_offset.sample_frame.max(0))
            .max(MIN_CLIP_FRAMES);
            let max_duration_by_source = clamp_f64_to_i64(
                (source_available as f64 / source_per_timeline.max(1e-9)).floor(),
            );
            next_duration = next_duration.min(max_duration_by_source.max(MIN_CLIP_FRAMES));

            // Recompute warp_source_duration_frames for the new timeline duration
            let consumed_source = clamp_f64_to_i64(
                (next_duration.max(MIN_CLIP_FRAMES) as f64 * source_per_timeline).round(),
            );
            clip.warp_source_duration_frames = consumed_source.max(MIN_CLIP_FRAMES);
        } else {
            // Non-warped: clamp to raw available source frames
            let available_frames =
                (source_file_total - clip.source_offset.sample_frame).max(MIN_CLIP_FRAMES);
            next_duration = next_duration.min(available_frames);
        }
    }

    clip.duration = AbsoluteTime::new(next_duration.max(MIN_CLIP_FRAMES));

    // Clamp fades
    let max_single_fade = (clip.duration.sample_frame / 2).max(0);
    clip.fade_in_frames = clip.fade_in_frames.min(max_single_fade);
    clip.fade_out_frames = clip.fade_out_frames.min(max_single_fade);
    let total_fade = clip.fade_in_frames.saturating_add(clip.fade_out_frames);
    if total_fade > clip.duration.sample_frame && total_fade > 0 {
        let ratio = clip.duration.sample_frame as f64 / total_fade as f64;
        clip.fade_in_frames = clamp_f64_to_i64((clip.fade_in_frames as f64 * ratio).floor());
        clip.fade_out_frames = clamp_f64_to_i64((clip.fade_out_frames as f64 * ratio).floor());
    }

    // Re-insert into the same track (sorted)
    let track = &mut project.tracks[track_idx];
    handle_overlaps(track, &clip, &[]);
    let insert_pos = track
        .clips
        .binary_search_by(|c| c.position.cmp(&clip.position))
        .unwrap_or_else(|i| i);
    track.clips.insert(insert_pos, clip);
    Ok(())
}

// ── Split Clip ────────────────────────────────────────────────────────────
/// Result of a successful clip split operation.
#[derive(Debug, Clone)]
pub struct SplitResult {
    /// The left (first) half of the split clip. Keeps the original UUID.
    pub left_id: Uuid,
    /// The right (second) half of the split clip. Gets a new UUID.
    pub right_id: Uuid,
}
/// Splits a clip at the given sample frame position.
///
/// The split produces two clips:
/// - **Left half**: keeps the original UUID, spans [clip_start, split_frame).
/// - **Right half**: gets a new UUID, spans [split_frame, clip_end).
///
/// Both halves preserve the correct `source_offset` so that audio playback
/// is seamless across the split point (minus micro-fades at boundaries).
///
/// # Arguments
/// - `project`: The project to mutate.
/// - `clip_id`: UUID of the clip to split.
/// - `split_frame`: Absolute sample frame at which to split.
///
/// # Errors
/// - `ClipNotFound` if the clip doesn't exist.
/// - `SplitOutOfBounds` if `split_frame` is outside the clip.
/// - `ClipTooShort` if either resulting half would be < `MIN_CLIP_FRAMES`.
pub fn split_clip(
    project: &mut Project,
    clip_id: Uuid,
    split_frame: i64,
) -> Result<SplitResult, MutatorError> {
    // Find the clip (without removing — we need to validate first)
    let (track_idx, clip_idx) = find_clip_location(project, clip_id)?;
    let clip = &project.tracks[track_idx].clips[clip_idx];
    let clip_start = clip.position.sample_frame;
    let clip_end = clip.end_position().sample_frame;
    // Validate split position is strictly inside the clip
    if split_frame <= clip_start || split_frame >= clip_end {
        return Err(MutatorError::SplitOutOfBounds {
            clip_start,
            clip_end,
            split_frame,
        });
    }
    // Calculate resulting durations
    let left_duration = split_frame - clip_start;
    let right_duration = clip_end - split_frame;
    // Validate both halves are long enough
    if left_duration < MIN_CLIP_FRAMES || right_duration < MIN_CLIP_FRAMES {
        return Err(MutatorError::ClipTooShort {
            clip_duration: clip.duration.sample_frame,
            min_duration: MIN_CLIP_FRAMES * 2,
        });
    }
    // ── Create the two halves ──────────────────────────────────────
    let original = &project.tracks[track_idx].clips[clip_idx];
    
    // ENTERPRISE FIX: Calculate correct source offset proportion based on warp/pitch parameters.
    // If a clip is stretched 2x (is_warped), 10 timeline frames = 5 source frames.
    // If we just added 10 to right_source_offset, it would incorrectly skip 10 source frames.
    let source_start = original.source_offset.sample_frame;
    let source_total = original.warp_source_duration_frames.max(original.duration.sample_frame).max(MIN_CLIP_FRAMES);
    let timeline_total = original.duration.sample_frame.max(MIN_CLIP_FRAMES);
    
    // Pitch shift acts as a fixed playback rate scalar even for unwarped clips in the engine.
    let pitch_multiplier = if original.pitch_shift_semitones != 0.0 {
        2.0_f64.powf(original.pitch_shift_semitones.clamp(-36.0, 36.0) / 12.0)
    } else {
        1.0
    };

    let consumed_source_frames = if original.is_warped {
        // Precise fractional source-to-timeline warp ratio for warped clips
        let warp_ratio = source_total as f64 / timeline_total as f64;
        (left_duration as f64 * warp_ratio).round() as i64
    } else {
        // Unwarped clips move through source linearly but scaled by pitch
        (left_duration as f64 * pitch_multiplier).round() as i64
    };

    // Allocate source frames to left and right halves. 
    // This perfectly partitions the clip so that `linear_warp_rate` in audio_thread_runner 
    // remains absolutely perfectly identical for both clip fragments!
    // NOTE: `warp_source_duration_frames` represents the amount of source that spans `duration`.
    // It does NOT mean "end position in source".
    
    let left_warp_source = consumed_source_frames;
    let right_source_start = source_start + consumed_source_frames;
    let right_warp_source = source_total - consumed_source_frames;

    // Left half: keeps original UUID, same position, truncated duration
    let left = AudioClip {
        id: original.id,
        duration: AbsoluteTime::new(left_duration),
        fade_out_frames: 0,
        // BUG-H7 FIX: Clamp inherited fade_in to not exceed new left duration
        fade_in_frames: original.fade_in_frames.min(left_duration / 2),
        warp_source_duration_frames: if original.is_warped { left_warp_source.max(MIN_CLIP_FRAMES) } else { original.warp_source_duration_frames },
        warp_markers: original.warp_markers.clone(),
        ..original.clone()
    };
    
    // Right half: new UUID, starts at split point, offset adjusted exactly using ratio
    let right = AudioClip {
        id: Uuid::new_v4(),
        name: format!("{} (split)", original.name),
        position: AbsoluteTime::new(split_frame),
        duration: AbsoluteTime::new(right_duration),
        source_offset: AbsoluteTime::new(right_source_start.max(0)),
        fade_in_frames: 0,
        // BUG-H7 FIX: Clamp inherited fade_out to not exceed new right duration
        fade_out_frames: original.fade_out_frames.min(right_duration / 2),
        is_selected: false,
        warp_source_duration_frames: if original.is_warped { right_warp_source.max(MIN_CLIP_FRAMES) } else { original.warp_source_duration_frames },
        warp_markers: if original.is_warped { vec![] } else { original.warp_markers.clone() },
        ..original.clone()
    };
    let result = SplitResult {
        left_id: left.id,
        right_id: right.id,
    };
    // Replace original clip with left half, insert right half after
    let track = &mut project.tracks[track_idx];
    track.clips[clip_idx] = left;
    track.clips.insert(clip_idx + 1, right);
    Ok(result)
}
// ── Split MIDI Clip ──────────────────────────────────────────────────────
/// Splits a MIDI clip at the given sample frame position.
///
/// The split produces two MIDI clips:
/// - **Left half**: keeps the original UUID, spans [clip_start, split_frame).
///   Notes that start before the split point are kept. Notes spanning the
///   split boundary are truncated (duration reduced to end at split point).
/// - **Right half**: gets a new UUID, spans [split_frame, clip_end).
///   Notes that start at or after the split point are moved, with their
///   `start_frame` adjusted relative to the new clip start.
///
/// Both halves preserve all clip metadata (envelopes, groove, loop, etc.).
pub fn split_midi_clip(
    project: &mut Project,
    clip_id: Uuid,
    split_frame: i64,
) -> Result<SplitResult, MutatorError> {
    let (track_idx, clip_idx) = find_midi_clip_location(project, clip_id)?;
    let clip = &project.tracks[track_idx].midi_clips[clip_idx];
    let clip_start = clip.position.sample_frame;
    let clip_end = clip.end_position().sample_frame;
    // Validate split position is strictly inside the clip
    if split_frame <= clip_start || split_frame >= clip_end {
        return Err(MutatorError::SplitOutOfBounds {
            clip_start,
            clip_end,
            split_frame,
        });
    }
    let left_duration = split_frame - clip_start;
    let right_duration = clip_end - split_frame;
    if left_duration < MIN_CLIP_FRAMES || right_duration < MIN_CLIP_FRAMES {
        return Err(MutatorError::ClipTooShort {
            clip_duration: clip.duration.sample_frame,
            min_duration: MIN_CLIP_FRAMES * 2,
        });
    }
    // ── Partition notes ───────────────────────────────────────────────
    // Notes are relative to clip start. The split boundary in clip-local
    // coordinates is: split_local = split_frame - clip_start.
    let split_local = split_frame - clip_start;
    let original = &project.tracks[track_idx].midi_clips[clip_idx];
    let mut left_notes: Vec<crate::midi::MidiNote> = Vec::new();
    let mut right_notes: Vec<crate::midi::MidiNote> = Vec::new();
    for note in &original.notes {
        if note.start_frame >= split_local {
            // Note starts at or after split → goes to right half
            right_notes.push(crate::midi::MidiNote {
                start_frame: note.start_frame - split_local,
                ..*note
            });
        } else if note.end_frame() <= split_local {
            // Note ends before or at split → goes entirely to left half
            left_notes.push(*note);
        } else {
            // Note spans the split boundary → truncate in left half
            left_notes.push(crate::midi::MidiNote {
                duration_frames: split_local - note.start_frame,
                ..*note
            });
        }
    }
    // ── Create the two halves ─────────────────────────────────────────
    let left = MidiClip {
        id: original.id,
        duration: AbsoluteTime::new(left_duration),
        fade_out_frames: 0,
        notes: left_notes,
        ..original.clone()
    };
    let right = MidiClip {
        id: Uuid::new_v4(),
        name: format!("{} (split)", original.name),
        position: AbsoluteTime::new(split_frame),
        duration: AbsoluteTime::new(right_duration),
        fade_in_frames: 0,
        is_selected: false,
        notes: right_notes,
        ..original.clone()
    };
    let result = SplitResult {
        left_id: left.id,
        right_id: right.id,
    };
    let track = &mut project.tracks[track_idx];
    track.midi_clips[clip_idx] = left;
    track.midi_clips.insert(clip_idx + 1, right);
    Ok(result)
}
// ── Delete Clip ───────────────────────────────────────────────────────────
/// Removes a clip from the project by UUID.
///
/// Returns the removed clip for potential undo operations.
///
/// # Arguments
/// - `project`: The project to mutate.
/// - `clip_id`: UUID of the clip to delete.
pub fn delete_clip(project: &mut Project, clip_id: Uuid) -> Result<AudioClip, MutatorError> {
    let (_, clip) = find_and_remove_clip(project, clip_id)?;
    Ok(clip)
}
// ── Duplicate Clip ───────────────────────────────────────────────────────
/// Duplicates a clip, optionally at a specific destination position.
///
/// If `new_position` is `None`, the duplicate is placed immediately after
/// the original clip. Overlaps are handled automatically.
pub fn duplicate_clip(
    project: &mut Project,
    clip_id: Uuid,
    new_position: Option<AbsoluteTime>,
    target_track_idx: Option<usize>,
) -> Result<AudioClip, MutatorError> {
    let (track_idx, clip_idx) = find_clip_location(project, clip_id)?;
    // Prepare duplicate
    let mut dup = project.tracks[track_idx].clips[clip_idx].clone();
    dup.id = Uuid::new_v4();
    if let Some(pos) = new_position {
        dup.position = pos;
    } else {
        dup.position = project.tracks[track_idx].clips[clip_idx].end_position();
    }
    dup.is_selected = true;
    // Deselect original
    project.tracks[track_idx].clips[clip_idx].is_selected = false;
    let target_idx = target_track_idx.unwrap_or(track_idx);
    if target_idx >= project.tracks.len() {
        return Err(MutatorError::TrackOutOfRange { requested: target_idx, available: project.tracks.len() });
    }
    if project.tracks[target_idx].track_type == TrackType::Group {
        return Err(MutatorError::InvalidOperation {
            reason: "Cannot place clips on a group track".into(),
        });
    }
    let track = &mut project.tracks[target_idx];
    // Handle overlaps before final insertion
    handle_overlaps(track, &dup, &[]);
    let insert_pos = track
        .clips
        .binary_search_by(|c| c.position.cmp(&dup.position))
        .unwrap_or_else(|i| i);
    // DUP-06 FIX: Clone for return before move-insert to avoid extra alloc.
    let ret = dup.clone();
    track.clips.insert(insert_pos, dup);
    Ok(ret)
}

/// Same as `duplicate_clip`, but with `protected_ids` for batch operations.
/// Clips whose IDs are in `protected_ids` will NOT be deleted/trimmed by
/// overlap resolution — they are being duplicated in the same batch.
pub fn duplicate_clip_protected(
    project: &mut Project,
    clip_id: Uuid,
    new_position: Option<AbsoluteTime>,
    target_track_idx: Option<usize>,
    protected_ids: &[Uuid],
) -> Result<AudioClip, MutatorError> {
    let (track_idx, clip_idx) = find_clip_location(project, clip_id)?;
    let mut dup = project.tracks[track_idx].clips[clip_idx].clone();
    dup.id = Uuid::new_v4();
    if let Some(pos) = new_position {
        dup.position = pos;
    } else {
        dup.position = project.tracks[track_idx].clips[clip_idx].end_position();
    }
    dup.is_selected = true;
    project.tracks[track_idx].clips[clip_idx].is_selected = false;
    let target_idx = target_track_idx.unwrap_or(track_idx);
    if target_idx >= project.tracks.len() {
        return Err(MutatorError::TrackOutOfRange { requested: target_idx, available: project.tracks.len() });
    }
    if project.tracks[target_idx].track_type == TrackType::Group {
        return Err(MutatorError::InvalidOperation {
            reason: "Cannot place clips on a group track".into(),
        });
    }
    let track = &mut project.tracks[target_idx];
    handle_overlaps(track, &dup, protected_ids);
    let insert_pos = track
        .clips
        .binary_search_by(|c| c.position.cmp(&dup.position))
        .unwrap_or_else(|i| i);
    let ret = dup.clone();
    track.clips.insert(insert_pos, dup);
    Ok(ret)
}

/// Duplicates a MIDI clip, optionally at a specific destination position.
pub fn duplicate_midi_clip(
    project: &mut Project,
    clip_id: Uuid,
    new_position: Option<AbsoluteTime>,
    target_track_idx: Option<usize>,
) -> Result<MidiClip, MutatorError> {
    let (track_idx, clip_idx) = find_midi_clip_location(project, clip_id)?;
    // Prepare duplicate
    let mut dup = project.tracks[track_idx].midi_clips[clip_idx].clone();
    dup.id = Uuid::new_v4();
    if let Some(pos) = new_position {
        dup.position = pos;
    } else {
        dup.position = project.tracks[track_idx].midi_clips[clip_idx].end_position();
    }
    dup.is_selected = true;
    // Deselect original
    project.tracks[track_idx].midi_clips[clip_idx].is_selected = false;
    let target_idx = target_track_idx.unwrap_or(track_idx);
    if target_idx >= project.tracks.len() {
        return Err(MutatorError::TrackOutOfRange { requested: target_idx, available: project.tracks.len() });
    }
    if project.tracks[target_idx].track_type == TrackType::Group {
        return Err(MutatorError::InvalidOperation {
            reason: "Cannot place clips on a group track".into(),
        });
    }
    let track = &mut project.tracks[target_idx];
    // Handle overlaps before final insertion
    handle_midi_overlaps(track, &dup, &[]);
    let insert_pos = track
        .midi_clips
        .binary_search_by(|c| c.position.cmp(&dup.position))
        .unwrap_or_else(|i| i);
    // DUP-06 FIX: Clone for return before move-insert to avoid extra alloc.
    let ret = dup.clone();
    track.midi_clips.insert(insert_pos, dup);
    Ok(ret)
}

/// Same as `duplicate_midi_clip`, but with `protected_ids` for batch operations.
pub fn duplicate_midi_clip_protected(
    project: &mut Project,
    clip_id: Uuid,
    new_position: Option<AbsoluteTime>,
    target_track_idx: Option<usize>,
    protected_ids: &[Uuid],
) -> Result<MidiClip, MutatorError> {
    let (track_idx, clip_idx) = find_midi_clip_location(project, clip_id)?;
    let mut dup = project.tracks[track_idx].midi_clips[clip_idx].clone();
    dup.id = Uuid::new_v4();
    if let Some(pos) = new_position {
        dup.position = pos;
    } else {
        dup.position = project.tracks[track_idx].midi_clips[clip_idx].end_position();
    }
    dup.is_selected = true;
    project.tracks[track_idx].midi_clips[clip_idx].is_selected = false;
    let target_idx = target_track_idx.unwrap_or(track_idx);
    if target_idx >= project.tracks.len() {
        return Err(MutatorError::TrackOutOfRange { requested: target_idx, available: project.tracks.len() });
    }
    let track = &mut project.tracks[target_idx];
    if track.track_type == TrackType::Group {
        return Err(MutatorError::InvalidOperation {
            reason: "Cannot place clips on a group track".into(),
        });
    }
    handle_midi_overlaps(track, &dup, protected_ids);
    let insert_pos = track
        .midi_clips
        .binary_search_by(|c| c.position.cmp(&dup.position))
        .unwrap_or_else(|i| i);
    let ret = dup.clone();
    track.midi_clips.insert(insert_pos, dup);
    Ok(ret)
}

// ── Move MIDI Clip ───────────────────────────────────────────────────────
/// Moves a MIDI clip to a new track and/or position on the timeline.
///
/// Overlap handling is applied on the target track. The clip is re-inserted
/// in sorted order by position.
pub fn move_midi_clip(
    project: &mut Project,
    clip_id: Uuid,
    new_track_index: usize,
    new_position: AbsoluteTime,
) -> Result<(), MutatorError> {
    if new_track_index >= project.tracks.len() {
        return Err(MutatorError::TrackOutOfRange {
            requested: new_track_index,
            available: project.tracks.len(),
        });
    }
    if project.tracks[new_track_index].track_type == TrackType::Group {
        return Err(MutatorError::InvalidOperation {
            reason: "Cannot place clips on a group track".into(),
        });
    }
    // Find and remove the MIDI clip from its current track
    let mut extracted = None;
    for track in &mut project.tracks {
        if let Some(idx) = track.midi_clips.iter().position(|c| c.id == clip_id) {
            let mut clip = track.midi_clips.remove(idx);
            clip.position = new_position;
            extracted = Some(clip);
            break;
        }
    }
    let clip = extracted.ok_or(MutatorError::ClipNotFound(clip_id))?;
    let target = &mut project.tracks[new_track_index];
    // Handle overlaps before insertion
    handle_midi_overlaps(target, &clip, &[]);
    let insert_pos = target
        .midi_clips
        .binary_search_by(|c| c.position.cmp(&clip.position))
        .unwrap_or_else(|i| i);
    target.midi_clips.insert(insert_pos, clip);
    Ok(())
}

/// Same as `move_midi_clip`, but with `protected_ids` for batch operations.
pub fn move_midi_clip_protected(
    project: &mut Project,
    clip_id: Uuid,
    new_track_index: usize,
    new_position: AbsoluteTime,
    protected_ids: &[Uuid],
) -> Result<(), MutatorError> {
    if new_track_index >= project.tracks.len() {
        return Err(MutatorError::TrackOutOfRange {
            requested: new_track_index,
            available: project.tracks.len(),
        });
    }
    if project.tracks[new_track_index].track_type == TrackType::Group {
        return Err(MutatorError::InvalidOperation {
            reason: "Cannot place clips on a group track".into(),
        });
    }
    let mut extracted = None;
    for track in &mut project.tracks {
        if let Some(idx) = track.midi_clips.iter().position(|c| c.id == clip_id) {
            let mut clip = track.midi_clips.remove(idx);
            clip.position = new_position;
            extracted = Some(clip);
            break;
        }
    }
    let clip = extracted.ok_or(MutatorError::ClipNotFound(clip_id))?;
    let target = &mut project.tracks[new_track_index];
    handle_midi_overlaps(target, &clip, protected_ids);
    let insert_pos = target
        .midi_clips
        .binary_search_by(|c| c.position.cmp(&clip.position))
        .unwrap_or_else(|i| i);
    target.midi_clips.insert(insert_pos, clip);
    Ok(())
}
// ── Delete MIDI Clip ─────────────────────────────────────────────────────
/// Removes a MIDI clip from the project by UUID.
///
/// Returns the removed clip for potential undo operations.
pub fn delete_midi_clip(project: &mut Project, clip_id: Uuid) -> Result<MidiClip, MutatorError> {
    for track in &mut project.tracks {
        if let Some(idx) = track.midi_clips.iter().position(|c| c.id == clip_id) {
            return Ok(track.midi_clips.remove(idx));
        }
    }
    Err(MutatorError::ClipNotFound(clip_id))
}
// ── Resize MIDI Clip ─────────────────────────────────────────────────────
/// Resizes a MIDI clip by updating its position and duration on the timeline.
///
/// The clip is removed, its bounds updated, overlaps handled, and then
/// re-inserted in sorted order.
pub fn resize_midi_clip(
    project: &mut Project,
    clip_id: Uuid,
    new_position: AbsoluteTime,
    new_duration: AbsoluteTime,
) -> Result<(), MutatorError> {
    if new_duration.sample_frame < MIN_CLIP_FRAMES {
        return Err(MutatorError::ClipTooShort {
            clip_duration: new_duration.sample_frame,
            min_duration: MIN_CLIP_FRAMES,
        });
    }
    // Find and remove the MIDI clip
    let mut extracted = None;
    let mut source_track_idx = None;
    for (track_idx, track) in project.tracks.iter_mut().enumerate() {
        if let Some(idx) = track.midi_clips.iter().position(|c| c.id == clip_id) {
            let mut clip = track.midi_clips.remove(idx);

            // CLIP-001 FIX: When the left edge moves, adjust MIDI note positions
            // so they maintain their absolute timeline position.
            //
            // Notes use clip-local coordinates (start_frame is relative to clip.position).
            // If clip.position moves RIGHT by +delta frames, each note must shift LEFT
            // by -delta frames to stay at the same absolute position.
            //
            // Example: Clip at beat 1, note at start_frame=0 (absolute beat 1).
            //   → User drags left edge to beat 2 (delta = +1 beat in frames).
            //   → Without fix: note stays at start_frame=0 → now plays at beat 2 (WRONG!)
            //   → With fix: note.start_frame -= delta → start_frame becomes negative → removed.
            //     Or if note was at start_frame=44100 (beat 2), after fix: start_frame=0 → still plays at beat 2. ✓
            let left_edge_delta = new_position.sample_frame - clip.position.sample_frame;

            clip.position = new_position;
            clip.duration = new_duration;

            if left_edge_delta != 0 {
                clip.notes.retain_mut(|note| {
                    note.start_frame -= left_edge_delta;
                    // Remove notes that are now entirely before the clip start
                    if note.start_frame + note.duration_frames <= 0 {
                        return false;
                    }
                    // Trim notes that partially extend before clip start
                    if note.start_frame < 0 {
                        let trim = -note.start_frame;
                        note.duration_frames -= trim;
                        note.start_frame = 0;
                        if note.duration_frames < 1 {
                            return false;
                        }
                    }
                    true
                });
            }

            // BUG-B12 FIX: Trim or remove MIDI notes that extend beyond the
            // new clip duration. Without this, notes can reference beats outside
            // the clip bounds, causing playback glitches and visual artifacts.
            let dur = new_duration.sample_frame;
            clip.notes.retain_mut(|note| {
                if note.start_frame >= dur {
                    return false; // Note starts outside clip — remove
                }
                // Truncate notes that span across the new clip end
                let note_end = note.start_frame + note.duration_frames;
                if note_end > dur {
                    note.duration_frames = (dur - note.start_frame).max(1);
                }
                true
            });
            extracted = Some(clip);
            source_track_idx = Some(track_idx);
            break;
        }
    }
    let clip = extracted.ok_or(MutatorError::ClipNotFound(clip_id))?;
    let track_idx = source_track_idx.ok_or(MutatorError::ClipNotFound(clip_id))?;
    let target = &mut project.tracks[track_idx];
    // Handle overlaps before re-insertion
    handle_midi_overlaps(target, &clip, &[]);
    let insert_pos = target
        .midi_clips
        .binary_search_by(|c| c.position.cmp(&clip.position))
        .unwrap_or_else(|i| i);
    target.midi_clips.insert(insert_pos, clip);
    Ok(())
}
/// Consolidates a region of time on a MIDI track into a single MIDI clip,
/// preserving existing notes and trimming/splitting underlying clips.
pub fn consolidate_midi_region(
    project: &mut Project,
    track_index: usize,
    start_time: AbsoluteTime,
    duration: AbsoluteTime,
) -> Result<MidiClip, MutatorError> {
    if track_index >= project.tracks.len() {
        return Err(MutatorError::TrackOutOfRange {
            requested: track_index,
            available: project.tracks.len(),
        });
    }

    let end_time = AbsoluteTime::new(start_time.sample_frame + duration.sample_frame);
    let track = &mut project.tracks[track_index];
    
    // Create new merged clip
    let mut new_clip = MidiClip::new("Consolidated", start_time, duration);
    new_clip.id = Uuid::new_v4();

    // Find all overlapping clips and extract their notes within the region
    for clip in &track.midi_clips {
        let clip_start = clip.position.sample_frame;
        let clip_end = clip.end_position().sample_frame;
        
        if clip_start < end_time.sample_frame && clip_end > start_time.sample_frame {
            for note in &clip.notes {
                let note_abs_start = clip_start + note.start_frame;
                
                // If the note starts within the region, keep it
                if note_abs_start >= start_time.sample_frame && note_abs_start < end_time.sample_frame {
                    let mut moved = *note;
                    moved.start_frame = note_abs_start - start_time.sample_frame;
                    new_clip.add_note(moved);
                }
            }
        }
    }

    // Deduplicate notes by sorting then dedup
    new_clip.notes.sort_by(|a, b| a.start_frame.cmp(&b.start_frame));
    new_clip.notes.dedup_by(|b, a| {
        if a.pitch == b.pitch && a.start_frame == b.start_frame {
            if b.duration_frames > a.duration_frames {
                a.duration_frames = b.duration_frames;
            }
            true
        } else {
            false
        }
    });

    // Rely on centralized overlap resolution to trim underlying clips
    handle_midi_overlaps(track, &new_clip, &[]);

    let insert_pos = track
        .midi_clips
        .binary_search_by(|c| c.position.cmp(&new_clip.position))
        .unwrap_or_else(|i| i);
    track.midi_clips.insert(insert_pos, new_clip.clone());

    Ok(new_clip)
}

// ═══════════════════════════════════════════════════════════════════════════
// Tests
// ═══════════════════════════════════════════════════════════════════════════
#[cfg(test)]
mod tests {
    use super::*;
    use crate::project::Track;
    fn make_test_project() -> Project {
        let mut project = Project::new("Test", 120.0, 44100.0);
        let mut track0 = Track::new("Track 1");
        track0.clips.push(AudioClip::new(
            "Clip A",
            "audio/a.wav",
            AbsoluteTime::new(0),
            AbsoluteTime::new(44100), // 1 second
        ));
        track0.clips.push(AudioClip::new(
            "Clip B",
            "audio/b.wav",
            AbsoluteTime::new(88200), // 2 seconds
            AbsoluteTime::new(44100), // 1 second
        ));
        let track1 = Track::new("Track 2");
        project.add_track(track0);
        project.add_track(track1);
        project
    }
    // ── Move Clip Tests ──────────────────────────────────────────────
    #[test]
    fn move_clip_same_track() {
        let mut project = make_test_project();
        let clip_id = project.tracks[0].clips[0].id;
        move_clip(&mut project, clip_id, 0, AbsoluteTime::new(22050)).unwrap();
        assert_eq!(project.tracks[0].clips.len(), 2);
        let moved = project.tracks[0]
            .clips
            .iter()
            .find(|c| c.id == clip_id)
            .unwrap();
        assert_eq!(moved.position.sample_frame, 22050);
    }
    #[test]
    fn move_clip_to_different_track() {
        let mut project = make_test_project();
        let clip_id = project.tracks[0].clips[0].id;
        move_clip(&mut project, clip_id, 1, AbsoluteTime::new(0)).unwrap();
        assert_eq!(project.tracks[0].clips.len(), 1); // removed from track 0
        assert_eq!(project.tracks[1].clips.len(), 1); // added to track 1
        assert_eq!(project.tracks[1].clips[0].id, clip_id);
    }
    #[test]
    fn move_clip_invalid_track() {
        let mut project = make_test_project();
        let clip_id = project.tracks[0].clips[0].id;
        let result = move_clip(&mut project, clip_id, 99, AbsoluteTime::new(0));
        assert!(matches!(result, Err(MutatorError::TrackOutOfRange { .. })));
    }
    #[test]
    fn move_clip_not_found() {
        let mut project = make_test_project();
        let fake_id = Uuid::new_v4();
        let result = move_clip(&mut project, fake_id, 0, AbsoluteTime::new(0));
        assert!(matches!(result, Err(MutatorError::ClipNotFound(_))));
    }
    #[test]
    fn move_clip_preserves_sort_order() {
        let mut project = make_test_project();
        let clip_b_id = project.tracks[0].clips[1].id;
        // Move clip B to position before clip A
        move_clip(&mut project, clip_b_id, 0, AbsoluteTime::new(0)).unwrap();
        // Clip B should now be first (sorted by position)
        assert_eq!(project.tracks[0].clips[0].id, clip_b_id);
    }
    // ── Split Clip Tests ─────────────────────────────────────────────
    #[test]
    fn split_clip_at_midpoint() {
        let mut project = make_test_project();
        let clip_id = project.tracks[0].clips[0].id;
        let result = split_clip(&mut project, clip_id, 22050).unwrap();
        assert_eq!(project.tracks[0].clips.len(), 3); // 2 original → 3 after split
        // Left half
        let left = project.tracks[0]
            .clips
            .iter()
            .find(|c| c.id == result.left_id)
            .unwrap();
        assert_eq!(left.position.sample_frame, 0);
        assert_eq!(left.duration.sample_frame, 22050);
        assert_eq!(left.source_offset.sample_frame, 0);
        // Right half
        let right = project.tracks[0]
            .clips
            .iter()
            .find(|c| c.id == result.right_id)
            .unwrap();
        assert_eq!(right.position.sample_frame, 22050);
        assert_eq!(right.duration.sample_frame, 22050);
        assert_eq!(right.source_offset.sample_frame, 22050);
    }
    #[test]
    fn split_clip_preserves_source_offset() {
        let mut project = make_test_project();
        // Set source offset to simulate a trimmed clip
        project.tracks[0].clips[0].source_offset = AbsoluteTime::new(10000);
        let clip_id = project.tracks[0].clips[0].id;
        let result = split_clip(&mut project, clip_id, 22050).unwrap();
        let right = project.tracks[0]
            .clips
            .iter()
            .find(|c| c.id == result.right_id)
            .unwrap();
        assert_eq!(right.source_offset.sample_frame, 10000 + 22050);
    }
    #[test]
    fn split_clip_out_of_bounds() {
        let mut project = make_test_project();
        let clip_id = project.tracks[0].clips[0].id;
        // Split at clip start (invalid)
        let result = split_clip(&mut project, clip_id, 0);
        assert!(matches!(result, Err(MutatorError::SplitOutOfBounds { .. })));
        // Split at clip end (invalid)
        let result = split_clip(&mut project, clip_id, 44100);
        assert!(matches!(result, Err(MutatorError::SplitOutOfBounds { .. })));
        // Split past clip end (invalid)
        let result = split_clip(&mut project, clip_id, 100000);
        assert!(matches!(result, Err(MutatorError::SplitOutOfBounds { .. })));
    }
    #[test]
    fn split_clip_too_short() {
        let mut project = make_test_project();
        let clip_id = project.tracks[0].clips[0].id;
        // Split very close to the start → left half too short
        let result = split_clip(&mut project, clip_id, 10);
        assert!(matches!(result, Err(MutatorError::ClipTooShort { .. })));
    }
    #[test]
    fn split_clip_preserves_gain() {
        let mut project = make_test_project();
        let clip_id = project.tracks[0].clips[0].id;
        project.tracks[0].clips[0].gain = 0.5;
        let result = split_clip(&mut project, clip_id, 22050).unwrap();
        
        let left = project.tracks[0].clips.iter().find(|c| c.id == result.left_id).unwrap();
        let right = project.tracks[0].clips.iter().find(|c| c.id == result.right_id).unwrap();
        assert_eq!(left.gain, 0.5);
        assert_eq!(right.gain, 0.5);
    }

    #[test]
    fn split_clip_warped_distributes_source_proportionally() {
        let mut project = make_test_project();
        let clip_id = project.tracks[0].clips[0].id;
        {
            let clip = &mut project.tracks[0].clips[0];
            clip.is_warped = true;
            clip.position = AbsoluteTime::new(0);
            clip.duration = AbsoluteTime::new(44100); // 1 second timeline
            clip.warp_source_duration_frames = 88200; // 2 seconds source (playing 2x fast)
            clip.source_offset = AbsoluteTime::new(0);
        }

        // Split exactly in the middle of timeline
        let result = split_clip(&mut project, clip_id, 22050).unwrap();
        let left = project.tracks[0].clips.iter().find(|c| c.id == result.left_id).unwrap();
        let right = project.tracks[0].clips.iter().find(|c| c.id == result.right_id).unwrap();

        // 22050 / 44100 = 0.5 ratio
        // Left should get 88200 * 0.5 = 44100 source frames
        assert_eq!(left.duration.sample_frame, 22050);
        assert_eq!(left.warp_source_duration_frames, 44100);
        assert_eq!(left.source_offset.sample_frame, 0);

        // Right should start at 44100 source offset and get the remaining 44100
        assert_eq!(right.duration.sample_frame, 22050);
        assert_eq!(right.position.sample_frame, 22050);
        assert_eq!(right.warp_source_duration_frames, 44100); // 44100 + 44100
        assert_eq!(right.source_offset.sample_frame, 44100);
    }

    #[test]
    fn split_clip_pitched_distributes_source_proportionally() {
        let mut project = make_test_project();
        let clip_id = project.tracks[0].clips[0].id;
        {
            let clip = &mut project.tracks[0].clips[0];
            clip.is_warped = false;
            clip.position = AbsoluteTime::new(0);
            clip.duration = AbsoluteTime::new(44100);
            clip.source_offset = AbsoluteTime::new(0);
            clip.pitch_shift_semitones = 12.0; // 2x playback speed
        }

        let result = split_clip(&mut project, clip_id, 22050).unwrap();
        let left = project.tracks[0].clips.iter().find(|c| c.id == result.left_id).unwrap();
        let right = project.tracks[0].clips.iter().find(|c| c.id == result.right_id).unwrap();

        assert_eq!(left.duration.sample_frame, 22050);
        assert_eq!(left.source_offset.sample_frame, 0);

        // 22050 frames at 2x speed means consuming 44100 source frames
        assert_eq!(right.duration.sample_frame, 22050);
        assert_eq!(right.source_offset.sample_frame, 44100);
    }
    // ── Delete Clip Tests ────────────────────────────────────────────
    #[test]
    fn delete_clip_removes_from_track() {
        let mut project = make_test_project();
        let clip_id = project.tracks[0].clips[0].id;
        let removed = delete_clip(&mut project, clip_id).unwrap();
        assert_eq!(removed.id, clip_id);
        assert_eq!(project.tracks[0].clips.len(), 1);
        assert!(project.tracks[0].clips.iter().all(|c| c.id != clip_id));
    }
    #[test]
    fn delete_clip_not_found() {
        let mut project = make_test_project();
        let fake_id = Uuid::new_v4();
        let result = delete_clip(&mut project, fake_id);
        assert!(matches!(result, Err(MutatorError::ClipNotFound(_))));
    }
    #[test]
    fn delete_returns_clip_for_undo() {
        let mut project = make_test_project();
        let clip_id = project.tracks[0].clips[0].id;
        let original_name = project.tracks[0].clips[0].name.clone();
        let removed = delete_clip(&mut project, clip_id).unwrap();
        assert_eq!(removed.name, original_name);
        assert_eq!(removed.id, clip_id);
    }
    // ── Overlap Trimming Tests ────────────────────────────────────────
    #[test]
    fn move_clip_overlaps_and_trims_existing() {
        let mut project = make_test_project();
        // Clip A: [0, 1s]
        // Clip B: [2s, 3s]
        let clip_b_id = project.tracks[0].clips[1].id;
        // Move Clip B to [0.5s, 1.5s] -> Should trim Clip A to [0, 0.5s]
        move_clip(&mut project, clip_b_id, 0, AbsoluteTime::new(22050)).unwrap();
        assert_eq!(project.tracks[0].clips.len(), 2);
        let clip_a = project.tracks[0]
            .clips
            .iter()
            .find(|c| c.name == "Clip A")
            .unwrap();
        assert_eq!(clip_a.position.sample_frame, 0);
        assert_eq!(clip_a.duration.sample_frame, 22050); // Trimmed from 44100 to 22050
        let clip_b = project.tracks[0]
            .clips
            .iter()
            .find(|c| c.id == clip_b_id)
            .unwrap();
        assert_eq!(clip_b.position.sample_frame, 22050);
        assert_eq!(clip_b.duration.sample_frame, 44100);
    }
    #[test]
    fn resize_clip_with_stretch_can_cover_and_delete_existing() {
        let mut project = make_test_project();
        // Clip A: [0, 1s]
        // Clip B: [2s, 3s]
        let clip_a_id = project.tracks[0].clips[0].id;
        // Shift-resize Clip A to 3s -> Should cover and delete Clip B
        resize_clip(
            &mut project,
            clip_a_id,
            AbsoluteTime::new(0),
            AbsoluteTime::new(44100 * 3),
            true,
        )
        .unwrap();
        assert_eq!(project.tracks[0].clips.len(), 1);
        assert_eq!(project.tracks[0].clips[0].id, clip_a_id);
    }
    #[test]
    fn resize_clip_without_stretch_trims_to_available_source() {
        let mut project = make_test_project();
        let clip_a_id = project.tracks[0].clips[0].id;
        // Default resize mode (allow_stretch=false) should clamp to source bounds.
        resize_clip(
            &mut project,
            clip_a_id,
            AbsoluteTime::new(0),
            AbsoluteTime::new(44100 * 3),
            false,
        )
        .unwrap();
        let clip_a = project.tracks[0]
            .clips
            .iter()
            .find(|c| c.id == clip_a_id)
            .unwrap();
        assert_eq!(clip_a.duration.sample_frame, 44100);
        assert_eq!(project.tracks[0].clips.len(), 2);
    }
    #[test]
    fn resize_clip_left_trim_advances_source_offset_without_stretch() {
        let mut project = make_test_project();
        let clip_a_id = project.tracks[0].clips[0].id;
        resize_clip(
            &mut project,
            clip_a_id,
            AbsoluteTime::new(22050),
            AbsoluteTime::new(22050),
            false,
        )
        .unwrap();
        let clip_a = project.tracks[0]
            .clips
            .iter()
            .find(|c| c.id == clip_a_id)
            .unwrap();
        assert_eq!(clip_a.position.sample_frame, 22050);
        assert_eq!(clip_a.duration.sample_frame, 22050);
        assert_eq!(clip_a.source_offset.sample_frame, 22050);
    }
    #[test]
    fn resize_clip_left_trim_clamps_source_offset_to_source_tail() {
        let mut project = make_test_project();
        let clip_a_id = project.tracks[0].clips[0].id;
        resize_clip(
            &mut project,
            clip_a_id,
            AbsoluteTime::new(44100 * 10),
            AbsoluteTime::new(22050),
            false,
        )
        .unwrap();
        let clip_a = project.tracks[0]
            .clips
            .iter()
            .find(|c| c.id == clip_a_id)
            .unwrap();
        assert_eq!(clip_a.source_offset.sample_frame, 44100 - 128);
        assert_eq!(clip_a.duration.sample_frame, 128);
    }
    #[test]
    fn resize_clip_left_with_stretch_keeps_source_offset_and_enables_warp() {
        let mut project = make_test_project();
        let clip_a_id = project.tracks[0].clips[0].id;
        let original_warp_source = project.tracks[0].clips[0].warp_source_duration_frames;
        resize_clip(
            &mut project,
            clip_a_id,
            AbsoluteTime::new(22050),
            AbsoluteTime::new(22050),
            true,
        )
        .unwrap();
        let clip_a = project.tracks[0]
            .clips
            .iter()
            .find(|c| c.id == clip_a_id)
            .unwrap();
        assert_eq!(clip_a.position.sample_frame, 22050);
        assert_eq!(clip_a.duration.sample_frame, 22050);
        assert_eq!(clip_a.source_offset.sample_frame, 0);
        assert!(clip_a.is_warped);
        assert!(clip_a.warp_mode.is_some());
        assert!(clip_a.warp_base_bpm > 0.0);
        assert_eq!(clip_a.warp_source_duration_frames, original_warp_source);
    }
    #[test]
    fn resize_clip_right_trim_on_warped_keeps_rate_by_shrinking_warp_window() {
        let mut project = make_test_project();
        let clip_a_id = project.tracks[0].clips[0].id;
        {
            let clip = &mut project.tracks[0].clips[0];
            clip.is_warped = true;
            clip.warp_source_duration_frames = 44100;
            clip.source_offset = AbsoluteTime::new(0);
            clip.duration = AbsoluteTime::new(44100);
        }
        resize_clip(
            &mut project,
            clip_a_id,
            AbsoluteTime::new(0),
            AbsoluteTime::new(22050),
            false,
        )
        .unwrap();
        let clip_a = project.tracks[0]
            .clips
            .iter()
            .find(|c| c.id == clip_a_id)
            .unwrap();
        assert_eq!(clip_a.duration.sample_frame, 22050);
        assert_eq!(clip_a.source_offset.sample_frame, 0);
        assert_eq!(clip_a.warp_source_duration_frames, 22050);
    }
    #[test]
    fn resize_clip_left_trim_on_warped_advances_offset_and_keeps_rate() {
        let mut project = make_test_project();
        let clip_a_id = project.tracks[0].clips[0].id;
        {
            let clip = &mut project.tracks[0].clips[0];
            clip.is_warped = true;
            clip.warp_source_duration_frames = 44100;
            clip.source_offset = AbsoluteTime::new(0);
            clip.duration = AbsoluteTime::new(44100);
        }
        resize_clip(
            &mut project,
            clip_a_id,
            AbsoluteTime::new(22050),
            AbsoluteTime::new(22050),
            false,
        )
        .unwrap();
        let clip_a = project.tracks[0]
            .clips
            .iter()
            .find(|c| c.id == clip_a_id)
            .unwrap();
        assert_eq!(clip_a.duration.sample_frame, 22050);
        assert_eq!(clip_a.source_offset.sample_frame, 22050);
        // BUG-WARP-TRIM FIX: warp_source_duration_frames is now the source WINDOW,
        // not offset + consumed. Original clip had rate = 44100/44100 = 1.0.
        // After left-trim: rate = 22050/22050 = 1.0 (preserved).
        // Old buggy value was 44100 (rate = 44100/22050 = 2.0, broken).
        assert_eq!(clip_a.warp_source_duration_frames, 22050);
    }
    #[test]
    fn move_clip_splits_existing_clip() {
        let mut project = make_test_project();
        // Clip A: [0, 10s]
        project.tracks[0].clips[0].duration = AbsoluteTime::new(44100 * 10);
        // Clip B: [20s, 21s]
        let clip_b_id = project.tracks[0].clips[1].id;
        // Move Clip B to [2s, 3s] -> Should split Clip A into [0, 2s] and [3s, 10s]
        move_clip(&mut project, clip_b_id, 0, AbsoluteTime::new(44100 * 2)).unwrap();
        // We expect 3 clips now: Clip A (left), Clip B, Clip A (right)
        assert_eq!(project.tracks[0].clips.len(), 3);
        // Sorted order:
        // 1. Clip A (left): [0, 2s]
        assert_eq!(project.tracks[0].clips[0].name, "Clip A");
        assert_eq!(project.tracks[0].clips[0].position.sample_frame, 0);
        assert_eq!(project.tracks[0].clips[0].duration.sample_frame, 44100 * 2);
        // 2. Clip B: [2s, 3s]
        assert_eq!(project.tracks[0].clips[1].id, clip_b_id);
        // 3. Clip A (right): [3s, 10s]
        assert_eq!(project.tracks[0].clips[2].name, "Clip A");
        assert_eq!(project.tracks[0].clips[2].position.sample_frame, 44100 * 3);
        assert_eq!(project.tracks[0].clips[2].duration.sample_frame, 44100 * 7);
    }
    // ── Edge Cases ───────────────────────────────────────────────────
    #[test]
    fn operations_on_empty_project() {
        let mut project = Project::new("Empty", 120.0, 44100.0);
        project.add_track(Track::new("Empty Track"));
        let fake_id = Uuid::new_v4();
        assert!(matches!(
            move_clip(&mut project, fake_id, 0, AbsoluteTime::ZERO),
            Err(MutatorError::ClipNotFound(_))
        ));
        assert!(matches!(
            split_clip(&mut project, fake_id, 1000),
            Err(MutatorError::ClipNotFound(_))
        ));
        assert!(matches!(
            delete_clip(&mut project, fake_id),
            Err(MutatorError::ClipNotFound(_))
        ));
    }
    // ── Duplicate Clip Tests ─────────────────────────────────────────────
    #[test]
    fn duplicate_clip_handles_overlaps() {
        let mut project = make_test_project();
        // Clip A: [0, 44100] (1s)
        // Clip B: [88200, 132300] (2s, 3s)
        let clip_a_id = project.tracks[0].clips[0].id;
        // Duplicate Clip A to position [2.5s, 3.5s] -> Should trim Clip B
        let target_pos = AbsoluteTime::new(110250); // 2.5s
        let dup = duplicate_clip(&mut project, clip_a_id, Some(target_pos), None).unwrap();
        assert_eq!(project.tracks[0].clips.len(), 3);
        // Clip B should now be [2s, 2.5s]
        let clip_b = project.tracks[0]
            .clips
            .iter()
            .find(|c| c.name == "Clip B")
            .unwrap();
        assert_eq!(clip_b.position.sample_frame, 88200);
        assert_eq!(clip_b.duration.sample_frame, 22050);
        // New clip should be at 2.5s
        let new_clip = project.tracks[0]
            .clips
            .iter()
            .find(|c| c.id == dup.id)
            .unwrap();
        assert_eq!(new_clip.position.sample_frame, 110250);
    }
    #[test]
    fn duplicate_midi_clip_handles_overlaps() {
        let mut project = make_test_project();
        // Add a MIDI clip
        let midi_clip = MidiClip::new("MIDI A", AbsoluteTime::ZERO, AbsoluteTime::new(44100));
        let clip_id = midi_clip.id;
        project.tracks[0].midi_clips.push(midi_clip);
        // Add an overlapping MIDI clip
        let midi_b = MidiClip::new("MIDI B", AbsoluteTime::new(22050), AbsoluteTime::new(44100));
        project.tracks[0].midi_clips.push(midi_b);
        // Duplicate MIDI A to the same position -> Should delete MIDI B (fully covered)
        duplicate_midi_clip(&mut project, clip_id, Some(AbsoluteTime::new(22050)), None).unwrap();
        // We expect MIDI B to be deleted
        assert_eq!(project.tracks[0].midi_clips.len(), 2);
        assert!(
            project.tracks[0]
                .midi_clips
                .iter()
                .all(|c| c.name != "MIDI B")
        );
    }

    // ── CLIP-001: MIDI left-edge resize keeps notes in place ─────────────
    #[test]
    fn resize_midi_clip_left_edge_keeps_notes_in_place() {
        let mut project = make_test_project();
        let mut midi_clip = MidiClip::new(
            "MIDI A",
            AbsoluteTime::new(0),      // starts at frame 0
            AbsoluteTime::new(88200),   // 2 seconds
        );
        // Add notes at various positions (clip-local frames):
        // Note 1 at frame 0 (absolute 0) - should be removed when left edge moves to 22050
        // Note 2 at frame 22050 (absolute 22050) - should become frame 0
        // Note 3 at frame 44100 (absolute 44100) - should become frame 22050
        midi_clip.notes.push(crate::midi::MidiNote {
            start_frame: 0,
            duration_frames: 11025,
            pitch: 60,
            velocity: 100,
            off_velocity: 64,
            is_muted: false,
            note_id: None,
        });
        midi_clip.notes.push(crate::midi::MidiNote {
            start_frame: 22050,
            duration_frames: 11025,
            pitch: 64,
            velocity: 100,
            off_velocity: 64,
            is_muted: false,
            note_id: None,
        });
        midi_clip.notes.push(crate::midi::MidiNote {
            start_frame: 44100,
            duration_frames: 11025,
            pitch: 67,
            velocity: 100,
            off_velocity: 64,
            is_muted: false,
            note_id: None,
        });
        let clip_id = midi_clip.id;
        project.tracks[0].midi_clips.push(midi_clip);

        // Resize: move left edge from 0 to 22050 (trim first 0.5s)
        resize_midi_clip(
            &mut project,
            clip_id,
            AbsoluteTime::new(22050),  // new position
            AbsoluteTime::new(66150),  // new duration: 88200 - 22050
        )
        .unwrap();

        let clip = project.tracks[0]
            .midi_clips
            .iter()
            .find(|c| c.id == clip_id)
            .unwrap();

        // Note 1 (was at absolute 0) should be removed (before new start at 22050)
        // Note 2 (was at absolute 22050) should now be at start_frame 0
        // Note 3 (was at absolute 44100) should now be at start_frame 22050
        assert_eq!(clip.notes.len(), 2, "Note 1 should be removed");
        assert_eq!(clip.notes[0].start_frame, 0, "Note 2 should be at frame 0");
        assert_eq!(clip.notes[0].pitch, 64, "Note 2 is pitch 64");
        assert_eq!(clip.notes[1].start_frame, 22050, "Note 3 should be at frame 22050");
        assert_eq!(clip.notes[1].pitch, 67, "Note 3 is pitch 67");
    }

    // ── Regression: Negative Position Clamping ───────────────────────
    #[test]
    fn move_clip_protected_negative_position_clamps_to_zero() {
        let mut project = make_test_project();
        let clip_id = project.tracks[0].clips[0].id;
        let total_clips_before = project.tracks[0].clips.len()
            + project.tracks[1].clips.len();

        // Move to negative position — should clamp to 0, NOT lose the clip
        let result = move_clip_protected(
            &mut project,
            clip_id,
            0,
            AbsoluteTime::new(-10000),
            &[],
        );
        assert!(result.is_ok(), "negative position should clamp, not error");

        let total_clips_after = project.tracks[0].clips.len()
            + project.tracks[1].clips.len();
        assert_eq!(total_clips_before, total_clips_after, "no clips should be lost");

        let clip = project.tracks[0]
            .clips
            .iter()
            .find(|c| c.id == clip_id)
            .expect("clip must still exist after move to negative position");
        assert_eq!(clip.position.sample_frame, 0, "position should be clamped to 0");
    }

    #[test]
    fn move_clip_protected_roundtrip_preserves_clip() {
        let mut project = make_test_project();
        let clip_id = project.tracks[0].clips[0].id;

        // Move to track 1
        move_clip_protected(&mut project, clip_id, 1, AbsoluteTime::new(44100), &[]).unwrap();
        assert_eq!(project.tracks[1].clips.len(), 1);

        // Move back to track 0
        move_clip_protected(&mut project, clip_id, 0, AbsoluteTime::new(0), &[]).unwrap();
        let clip = project.tracks[0]
            .clips
            .iter()
            .find(|c| c.id == clip_id)
            .expect("clip must survive round-trip move");
        assert_eq!(clip.position.sample_frame, 0);
    }
}


