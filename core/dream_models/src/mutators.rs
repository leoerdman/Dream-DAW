// ═══════════════════════════════════════════════════════════════════════════
// Dream DAW — Project Mutators (Enterprise-Grade Timeline Editing)
// ═══════════════════════════════════════════════════════════════════════════
//
// Pure functions that transform a `Project` in response to user actions.
//
// DESIGN PRINCIPLES:
//   1. All mutations are deterministic — same input always gives same output.
//   2. No thread-safety concerns — caller handles locking (Tauri command layer).
//   3. Every mutation returns a `Result` for robust error propagation.
//   4. UUID-based addressing — clips are found by ID, not index (safe across
//      concurrent UI updates).
//   5. Split preserves source_offset semantics — left half keeps the original
//      offset, right half adjusts offset to point at the split position.
//
// These functions are designed to be called from the IPC layer:
//   lock project → call mutator → mark dirty → rebuild snapshot → unlock.
//
// ═══════════════════════════════════════════════════════════════════════════

use uuid::Uuid;

use crate::midi::MidiClip;
use crate::project::{AudioClip, Project};
use crate::time::AbsoluteTime;

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

    // Find and remove the clip from its current track
    let (_source_track_idx, mut clip) = find_and_remove_clip(project, clip_id)?;

    // Update position
    clip.position = new_position;

    // Insert into target track (sorted by position for efficient scheduling)
    let target_track = &mut project.tracks[new_track_index];

    // Handle overlaps before final insertion
    handle_overlaps(target_track, &clip);

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

    // BUG-C4 FIX: Adjust source_offset when left edge moves.
    // If the clip starts later than before, we're trimming the start —
    // the source_offset must advance by the same amount.
    let left_edge_delta = new_position.sample_frame - clip.position.sample_frame;
    if left_edge_delta != 0 {
        clip.source_offset =
            AbsoluteTime::new((clip.source_offset.sample_frame + left_edge_delta).max(0));
    }

    // Update bounds
    clip.position = new_position;
    clip.duration = new_duration;

    // Clamp fades to not exceed the new duration
    let max_fade = (clip.duration.sample_frame / 2).max(0);
    clip.fade_in_frames = clip.fade_in_frames.min(max_fade);
    clip.fade_out_frames = clip.fade_out_frames.min(max_fade);

    // Re-insert into the same track (sorted)
    let track = &mut project.tracks[track_idx];

    // Handle overlaps before final insertion
    handle_overlaps(track, &clip);

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

    // Left half: keeps original UUID, same position, truncated duration
    let left = AudioClip {
        id: original.id,
        duration: AbsoluteTime::new(left_duration),
        fade_out_frames: 0,
        // BUG-H7 FIX: Clamp inherited fade_in to not exceed new left duration
        fade_in_frames: original.fade_in_frames.min(left_duration / 2),
        // BUG-C3 FIX: Proportionally split warp_source_duration_frames
        warp_source_duration_frames: if original.warp_source_duration_frames > 0 {
            let ratio = left_duration as f64 / original.duration.sample_frame.max(1) as f64;
            (original.warp_source_duration_frames as f64 * ratio).round() as i64
        } else {
            0
        },
        ..original.clone()
    };

    // Right half: new UUID, starts at split point, offset adjusted
    let right_source_offset = original.source_offset.sample_frame + (split_frame - clip_start);

    let right = AudioClip {
        id: Uuid::new_v4(),
        name: format!("{} (split)", original.name),
        position: AbsoluteTime::new(split_frame),
        duration: AbsoluteTime::new(right_duration),
        source_offset: AbsoluteTime::new(right_source_offset),
        fade_in_frames: 0,
        // BUG-H7 FIX: Clamp inherited fade_out to not exceed new right duration
        fade_out_frames: original.fade_out_frames.min(right_duration / 2),
        is_selected: false,
        // BUG-C3 FIX: Proportionally split warp_source_duration_frames
        warp_source_duration_frames: if original.warp_source_duration_frames > 0 {
            let ratio = right_duration as f64 / original.duration.sample_frame.max(1) as f64;
            (original.warp_source_duration_frames as f64 * ratio).round() as i64
        } else {
            0
        },
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

    let track = &mut project.tracks[track_idx];

    // Handle overlaps before final insertion
    handle_overlaps(track, &dup);

    let insert_pos = track
        .clips
        .binary_search_by(|c| c.position.cmp(&dup.position))
        .unwrap_or_else(|i| i);
    track.clips.insert(insert_pos, dup.clone());

    Ok(dup)
}

/// Duplicates a MIDI clip, optionally at a specific destination position.
pub fn duplicate_midi_clip(
    project: &mut Project,
    clip_id: Uuid,
    new_position: Option<AbsoluteTime>,
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

    let track = &mut project.tracks[track_idx];

    // Handle overlaps before final insertion
    handle_midi_overlaps(track, &dup);

    let insert_pos = track
        .midi_clips
        .binary_search_by(|c| c.position.cmp(&dup.position))
        .unwrap_or_else(|i| i);
    track.midi_clips.insert(insert_pos, dup.clone());

    Ok(dup)
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
    handle_midi_overlaps(target, &clip);

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
            clip.position = new_position;
            clip.duration = new_duration;
            extracted = Some(clip);
            source_track_idx = Some(track_idx);
            break;
        }
    }

    let clip = extracted.ok_or(MutatorError::ClipNotFound(clip_id))?;
    let track_idx = source_track_idx.ok_or(MutatorError::ClipNotFound(clip_id))?;
    let target = &mut project.tracks[track_idx];

    // Handle overlaps before re-insertion
    handle_midi_overlaps(target, &clip);

    let insert_pos = target
        .midi_clips
        .binary_search_by(|c| c.position.cmp(&clip.position))
        .unwrap_or_else(|i| i);
    target.midi_clips.insert(insert_pos, clip);
    Ok(())
}
// ── Automation Lane Upsert ────────────────────────────────────────────────

/// Upserts a static (single-point) automation lane on a track.
///
/// If a lane with the given `param_id` already exists, its points are replaced
/// with the supplied `value`. Otherwise a new lane is created.
pub fn upsert_static_automation_lane(
    track: &mut crate::project::Track,
    param_id: &str,
    value: f64,
) {
    if let Some(existing) = track
        .automation_lanes
        .iter_mut()
        .find(|lane| lane.param_id.eq_ignore_ascii_case(param_id))
    {
        existing.points = vec![crate::project::AutomationPoint {
            beat: 0.0,
            value,
            curve_type: "linear".to_string(),
            tension: None,
            bezier_cp1x: None,
            bezier_cp1y: None,
            bezier_cp2x: None,
            bezier_cp2y: None,
        }];
        existing.param_id = param_id.to_string();
        return;
    }

    track.automation_lanes.push(crate::project::AutomationLane {
        param_id: param_id.to_string(),
        points: vec![crate::project::AutomationPoint {
            beat: 0.0,
            value,
            curve_type: "linear".to_string(),
            tension: None,
            bezier_cp1x: None,
            bezier_cp1y: None,
            bezier_cp2x: None,
            bezier_cp2y: None,
        }],
    });
}

// ── Internal Helpers ──────────────────────────────────────────────────────

fn find_clip_location(project: &Project, clip_id: Uuid) -> Result<(usize, usize), MutatorError> {
    for (track_idx, track) in project.tracks.iter().enumerate() {
        for (clip_idx, clip) in track.clips.iter().enumerate() {
            if clip.id == clip_id {
                return Ok((track_idx, clip_idx));
            }
        }
    }
    Err(MutatorError::ClipNotFound(clip_id))
}

/// Finds a MIDI clip's location (track_idx, clip_idx) by UUID.
fn find_midi_clip_location(
    project: &Project,
    clip_id: Uuid,
) -> Result<(usize, usize), MutatorError> {
    for (track_idx, track) in project.tracks.iter().enumerate() {
        if let Some(clip_idx) = track.midi_clips.iter().position(|c| c.id == clip_id) {
            return Ok((track_idx, clip_idx));
        }
    }
    Err(MutatorError::ClipNotFound(clip_id))
}

/// Finds and removes a clip from its track, returning (source_track_idx, clip).
fn find_and_remove_clip(
    project: &mut Project,
    clip_id: Uuid,
) -> Result<(usize, AudioClip), MutatorError> {
    for (track_idx, track) in project.tracks.iter_mut().enumerate() {
        if let Some(clip_idx) = track.clips.iter().position(|c| c.id == clip_id) {
            let clip = track.clips.remove(clip_idx);
            return Ok((track_idx, clip));
        }
    }
    Err(MutatorError::ClipNotFound(clip_id))
}

/// Trims or removes audio clips in the track that overlap with the given target clip.
pub fn handle_overlaps(track: &mut crate::project::Track, target: &AudioClip) {
    let target_start = target.position.sample_frame;
    let target_end = target.end_position().sample_frame;

    let mut i = 0;
    while i < track.clips.len() {
        // Skip the target clip itself if it's already in the track
        if track.clips[i].id == target.id {
            i += 1;
            continue;
        }

        let clip_start = track.clips[i].position.sample_frame;
        let clip_end = track.clips[i].end_position().sample_frame;

        // Optimization: track.clips is sorted by position. If current clip starts
        // after the target ends, no subsequent clips can overlap.
        if clip_start >= target_end {
            break;
        }

        // Check for overlap
        if clip_end > target_start {
            // Case 1: Clip is completely covered by target
            if clip_start >= target_start && clip_end <= target_end {
                track.clips.remove(i);
                continue; // Don't increment i
            }
            // Case 2: Target is in the middle of the clip (split underlying)
            else if clip_start < target_start && clip_end > target_end {
                let mut right_half = track.clips[i].clone();

                // Trim left half (ends at target_start)
                track.clips[i].duration = AbsoluteTime::new(target_start - clip_start);

                // Configure right half (starts at target_end)
                let right_start_frame = target_end;
                let right_duration = clip_end - target_end;
                let source_delta = target_end - clip_start;

                right_half.id = Uuid::new_v4();
                right_half.position = AbsoluteTime::new(right_start_frame);
                right_half.duration = AbsoluteTime::new(right_duration);
                right_half.source_offset =
                    AbsoluteTime::new(right_half.source_offset.sample_frame + source_delta);

                track.clips.insert(i + 1, right_half);
                i += 2;
                continue;
            }
            // Case 3: Overlap at the start of the clip
            else if clip_start >= target_start && clip_start < target_end {
                let delta = target_end - clip_start;
                track.clips[i].position = AbsoluteTime::new(target_end);
                track.clips[i].duration = AbsoluteTime::new(clip_end - target_end);
                track.clips[i].source_offset =
                    AbsoluteTime::new(track.clips[i].source_offset.sample_frame + delta);
            }
            // Case 4: Overlap at the end of the clip
            else if clip_end > target_start && clip_end <= target_end {
                track.clips[i].duration = AbsoluteTime::new(target_start - clip_start);
            }

            // Remove clip if it became too short
            if track.clips[i].duration.sample_frame < MIN_CLIP_FRAMES {
                track.clips.remove(i);
                continue;
            }
        }
        i += 1;
    }
}

/// Trims or removes MIDI clips in the track that overlap with the given target clip.
pub fn handle_midi_overlaps(track: &mut crate::project::Track, target: &crate::midi::MidiClip) {
    let target_start = target.position.sample_frame;
    let target_end = target.end_position().sample_frame;

    let mut i = 0;
    while i < track.midi_clips.len() {
        if track.midi_clips[i].id == target.id {
            i += 1;
            continue;
        }

        let clip_start = track.midi_clips[i].position.sample_frame;
        let clip_end = track.midi_clips[i].end_position().sample_frame;

        // Optimization: sorted clip list
        if clip_start >= target_end {
            break;
        }

        if clip_end > target_start {
            if clip_start >= target_start && clip_end <= target_end {
                track.midi_clips.remove(i);
                continue;
            } else if clip_start < target_start && clip_end > target_end {
                let mut right_half = track.midi_clips[i].clone();
                track.midi_clips[i].duration = AbsoluteTime::new(target_start - clip_start);

                let right_duration = clip_end - target_end;
                right_half.id = Uuid::new_v4();
                right_half.position = AbsoluteTime::new(target_end);
                right_half.duration = AbsoluteTime::new(right_duration);

                track.midi_clips.insert(i + 1, right_half);
                i += 2;
                continue;
            } else if clip_start >= target_start && clip_start < target_end {
                track.midi_clips[i].position = AbsoluteTime::new(target_end);
                track.midi_clips[i].duration = AbsoluteTime::new(clip_end - target_end);
            } else if clip_end > target_start && clip_end <= target_end {
                track.midi_clips[i].duration = AbsoluteTime::new(target_start - clip_start);
            }

            if track.midi_clips[i].duration.sample_frame < MIN_CLIP_FRAMES {
                track.midi_clips.remove(i);
                continue;
            }
        }
        i += 1;
    }
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
        project.tracks[0].clips[0].gain = 0.75;
        let clip_id = project.tracks[0].clips[0].id;

        let result = split_clip(&mut project, clip_id, 22050).unwrap();

        let left = project.tracks[0]
            .clips
            .iter()
            .find(|c| c.id == result.left_id)
            .unwrap();
        let right = project.tracks[0]
            .clips
            .iter()
            .find(|c| c.id == result.right_id)
            .unwrap();
        assert!((left.gain - 0.75).abs() < f64::EPSILON);
        assert!((right.gain - 0.75).abs() < f64::EPSILON);
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
    fn resize_clip_covers_and_deletes_existing() {
        let mut project = make_test_project();

        // Clip A: [0, 1s]
        // Clip B: [2s, 3s]
        let clip_a_id = project.tracks[0].clips[0].id;

        // Resize Clip A to 3s -> Should cover and delete Clip B
        resize_clip(
            &mut project,
            clip_a_id,
            AbsoluteTime::new(0),
            AbsoluteTime::new(44100 * 3),
        )
        .unwrap();

        assert_eq!(project.tracks[0].clips.len(), 1);
        assert_eq!(project.tracks[0].clips[0].id, clip_a_id);
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
        let dup = duplicate_clip(&mut project, clip_a_id, Some(target_pos)).unwrap();

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
        duplicate_midi_clip(&mut project, clip_id, Some(AbsoluteTime::new(22050))).unwrap();

        // We expect MIDI B to be deleted
        assert_eq!(project.tracks[0].midi_clips.len(), 2);
        assert!(
            project.tracks[0]
                .midi_clips
                .iter()
                .all(|c| c.name != "MIDI B")
        );
    }
}
