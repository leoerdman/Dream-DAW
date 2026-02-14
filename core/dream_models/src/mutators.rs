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
    ClipTooShort { clip_duration: i64, min_duration: i64 },
}

impl std::fmt::Display for MutatorError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::ClipNotFound(id) => write!(f, "Clip not found: {id}"),
            Self::TrackOutOfRange {
                requested,
                available,
            } => write!(
                f,
                "Track index {requested} out of range (0..{available})"
            ),
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

    // Update bounds
    clip.position = new_position;
    clip.duration = new_duration;

    // Re-insert into the same track (sorted)
    let track = &mut project.tracks[track_idx];
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
        name: original.name.clone(),
        file_path: original.file_path.clone(),
        position: original.position,
        duration: AbsoluteTime::new(left_duration),
        source_offset: original.source_offset,
        gain: original.gain,
        fade_in_frames: original.fade_in_frames,
        fade_out_frames: 0,
        is_offline: original.is_offline,
        is_selected: original.is_selected,
        is_muted: original.is_muted,
        color_override: original.color_override,
    };

    // Right half: new UUID, starts at split point, offset adjusted
    let right_source_offset =
        original.source_offset.sample_frame + (split_frame - clip_start);

    let right = AudioClip {
        id: Uuid::new_v4(),
        name: format!("{} (split)", original.name),
        file_path: original.file_path.clone(),
        position: AbsoluteTime::new(split_frame),
        duration: AbsoluteTime::new(right_duration),
        source_offset: AbsoluteTime::new(right_source_offset),
        gain: original.gain,
        fade_in_frames: 0,
        fade_out_frames: original.fade_out_frames,
        is_offline: original.is_offline,
        is_selected: false,
        is_muted: original.is_muted,
        color_override: original.color_override,
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

// ── Internal Helpers ──────────────────────────────────────────────────────

/// Finds a clip's location (track_idx, clip_idx) by UUID.
///
/// Scans all tracks linearly. For typical project sizes (< 100 tracks,
/// < 1000 clips), this is negligible vs. the cost of snapshot rebuild.
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

        move_clip(
            &mut project,
            clip_id,
            0,
            AbsoluteTime::new(22050),
        )
        .unwrap();

        assert_eq!(project.tracks[0].clips.len(), 2);
        let moved = project.tracks[0].clips.iter().find(|c| c.id == clip_id).unwrap();
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
        let left = project.tracks[0].clips.iter().find(|c| c.id == result.left_id).unwrap();
        assert_eq!(left.position.sample_frame, 0);
        assert_eq!(left.duration.sample_frame, 22050);
        assert_eq!(left.source_offset.sample_frame, 0);

        // Right half
        let right = project.tracks[0].clips.iter().find(|c| c.id == result.right_id).unwrap();
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

        let right = project.tracks[0].clips.iter().find(|c| c.id == result.right_id).unwrap();
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

        let left = project.tracks[0].clips.iter().find(|c| c.id == result.left_id).unwrap();
        let right = project.tracks[0].clips.iter().find(|c| c.id == result.right_id).unwrap();
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
}
