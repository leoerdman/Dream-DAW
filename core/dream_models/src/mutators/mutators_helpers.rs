use crate::midi::MidiClip;
use crate::mutators::{MIN_CLIP_FRAMES, MutatorError};
use crate::project::{AudioClip, Project, Track};
use crate::time::AbsoluteTime;
use uuid::Uuid;

pub fn upsert_static_automation_lane(track: &mut Track, param_id: &str, value: f64) {
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

pub fn find_clip_location(
    project: &Project,
    clip_id: Uuid,
) -> Result<(usize, usize), MutatorError> {
    for (track_idx, track) in project.tracks.iter().enumerate() {
        for (clip_idx, clip) in track.clips.iter().enumerate() {
            if clip.id == clip_id {
                return Ok((track_idx, clip_idx));
            }
        }
    }
    Err(MutatorError::ClipNotFound(clip_id))
}

pub fn find_midi_clip_location(
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

pub fn find_and_remove_clip(
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

fn clamp_audio_fades(clip: &mut AudioClip) {
    let dur = clip.duration.sample_frame.max(0);
    let max_single = (dur / 2).max(0);
    clip.fade_in_frames = clip.fade_in_frames.min(max_single);
    clip.fade_out_frames = clip.fade_out_frames.min(max_single);

    let total = clip.fade_in_frames.saturating_add(clip.fade_out_frames);
    if total > dur && total > 0 {
        let scale = dur as f64 / total as f64;
        clip.fade_in_frames = (clip.fade_in_frames as f64 * scale) as i64;
        clip.fade_out_frames = (clip.fade_out_frames as f64 * scale) as i64;
    }
}

pub fn handle_overlaps(track: &mut Track, target: &AudioClip, protected_ids: &[Uuid]) {
    let target_start = target.position.sample_frame;
    let target_end = target.end_position().sample_frame;

    let mut i = 0;
    while i < track.clips.len() {
        if track.clips[i].id == target.id {
            i += 1;
            continue;
        }

        // ENTERPRISE FIX: Skip clips that are part of the same batch operation.
        // During multi-clip moves, other clips in the batch must not be deleted/trimmed
        // by overlap resolution — they will be moved to their own new positions.
        if protected_ids.contains(&track.clips[i].id) {
            i += 1;
            continue;
        }

        let clip_start = track.clips[i].position.sample_frame;
        let clip_end = track.clips[i].end_position().sample_frame;

        // DUP-04 FIX: Use `continue` instead of `break` to handle unsorted input safely.
        if clip_start >= target_end {
            i += 1;
            continue;
        }

        if clip_end > target_start {
            if clip_start >= target_start && clip_end <= target_end {
                track.clips.remove(i);
                continue;
            } else if clip_start < target_start && clip_end > target_end {
                let right_duration = clip_end - target_end;
                track.clips[i].duration = AbsoluteTime::new(target_start - clip_start);
                clamp_audio_fades(&mut track.clips[i]);

                if right_duration >= MIN_CLIP_FRAMES {
                    let mut right_half = track.clips[i].clone();
                    let source_delta = target_end - clip_start;

                    right_half.id = Uuid::new_v4();
                    right_half.position = AbsoluteTime::new(target_end);
                    right_half.duration = AbsoluteTime::new(right_duration);
                    right_half.source_offset =
                        AbsoluteTime::new(right_half.source_offset.sample_frame + source_delta);
                    clamp_audio_fades(&mut right_half);

                    track.clips.insert(i + 1, right_half);
                }
            } else if clip_start >= target_start && clip_start < target_end {
                let delta = target_end - clip_start;
                track.clips[i].position = AbsoluteTime::new(target_end);
                track.clips[i].duration = AbsoluteTime::new(clip_end - target_end);
                track.clips[i].source_offset =
                    AbsoluteTime::new(track.clips[i].source_offset.sample_frame + delta);
                clamp_audio_fades(&mut track.clips[i]);
            } else if clip_end > target_start && clip_end <= target_end {
                track.clips[i].duration = AbsoluteTime::new(target_start - clip_start);
                clamp_audio_fades(&mut track.clips[i]);
            }

            if track.clips[i].duration.sample_frame < MIN_CLIP_FRAMES {
                track.clips.remove(i);
                continue;
            }
        }
        i += 1;
    }
}

pub fn handle_midi_overlaps(track: &mut Track, target: &MidiClip, protected_ids: &[Uuid]) {
    let target_start = target.position.sample_frame;
    let target_end = target.end_position().sample_frame;

    let mut i = 0;
    while i < track.midi_clips.len() {
        if track.midi_clips[i].id == target.id {
            i += 1;
            continue;
        }

        // ENTERPRISE FIX: Skip clips that are part of the same batch operation.
        if protected_ids.contains(&track.midi_clips[i].id) {
            i += 1;
            continue;
        }

        let clip_start = track.midi_clips[i].position.sample_frame;
        let clip_end = track.midi_clips[i].end_position().sample_frame;

        // DUP-04 FIX: Use `continue` instead of `break` to handle unsorted input safely.
        if clip_start >= target_end {
            i += 1;
            continue;
        }

        if clip_end > target_start {
            if clip_start >= target_start && clip_end <= target_end {
                track.midi_clips.remove(i);
                continue;
            } else if clip_start < target_start && clip_end > target_end {
                let mut right_half = track.midi_clips[i].clone();
                track.midi_clips[i].duration = AbsoluteTime::new(target_start - clip_start);

                // DUP-01 FIX: Trim left half notes — remove/truncate those beyond new boundary.
                let left_boundary = target_start - clip_start;
                track.midi_clips[i].notes.retain_mut(|note| {
                    if note.start_frame >= left_boundary {
                        return false;
                    }
                    let note_end = note.start_frame + note.duration_frames;
                    if note_end > left_boundary {
                        note.duration_frames = (left_boundary - note.start_frame).max(1);
                    }
                    true
                });

                let right_duration = clip_end - target_end;

                if right_duration >= MIN_CLIP_FRAMES {
                    right_half.id = Uuid::new_v4();
                    right_half.position = AbsoluteTime::new(target_end);
                    right_half.duration = AbsoluteTime::new(right_duration);

                    // DUP-01 FIX: Adjust right half notes — shift start_frame and remove notes
                    // that belong entirely to the removed middle section or left half.
                    let right_origin = target_end - clip_start;
                    right_half.notes.retain_mut(|note| {
                        if note.start_frame + note.duration_frames <= right_origin {
                            return false;
                        }
                        if note.start_frame < right_origin {
                            note.duration_frames -= right_origin - note.start_frame;
                            note.start_frame = 0;
                        } else {
                            note.start_frame -= right_origin;
                        }
                        note.duration_frames >= 1
                    });

                    track.midi_clips.insert(i + 1, right_half);
                }
            } else if clip_start >= target_start && clip_start < target_end {
                // DUP-01 FIX: Adjust notes when trimming left edge of MIDI clip.
                let delta = target_end - clip_start;
                track.midi_clips[i].position = AbsoluteTime::new(target_end);
                track.midi_clips[i].duration = AbsoluteTime::new(clip_end - target_end);
                track.midi_clips[i].notes.retain_mut(|note| {
                    if note.start_frame + note.duration_frames <= delta {
                        return false;
                    }
                    if note.start_frame < delta {
                        note.duration_frames -= delta - note.start_frame;
                        note.start_frame = 0;
                    } else {
                        note.start_frame -= delta;
                    }
                    note.duration_frames >= 1
                });
            } else if clip_end > target_start && clip_end <= target_end {
                // DUP-01 FIX: Trim notes when truncating right edge of MIDI clip.
                let new_dur = target_start - clip_start;
                track.midi_clips[i].duration = AbsoluteTime::new(new_dur);
                track.midi_clips[i].notes.retain_mut(|note| {
                    if note.start_frame >= new_dur {
                        return false;
                    }
                    let note_end = note.start_frame + note.duration_frames;
                    if note_end > new_dur {
                        note.duration_frames = (new_dur - note.start_frame).max(1);
                    }
                    true
                });
            }

            if track.midi_clips[i].duration.sample_frame < MIN_CLIP_FRAMES {
                track.midi_clips.remove(i);
                continue;
            }
        }
        i += 1;
    }
}
