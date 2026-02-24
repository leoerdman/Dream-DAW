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

pub fn find_clip_location(project: &Project, clip_id: Uuid) -> Result<(usize, usize), MutatorError> {
    for (track_idx, track) in project.tracks.iter().enumerate() {
        for (clip_idx, clip) in track.clips.iter().enumerate() {
            if clip.id == clip_id {
                return Ok((track_idx, clip_idx));
            }
        }
    }
    Err(MutatorError::ClipNotFound(clip_id))
}

pub fn find_midi_clip_location(project: &Project, clip_id: Uuid) -> Result<(usize, usize), MutatorError> {
    for (track_idx, track) in project.tracks.iter().enumerate() {
        if let Some(clip_idx) = track.midi_clips.iter().position(|c| c.id == clip_id) {
            return Ok((track_idx, clip_idx));
        }
    }
    Err(MutatorError::ClipNotFound(clip_id))
}

pub fn find_and_remove_clip(project: &mut Project, clip_id: Uuid) -> Result<(usize, AudioClip), MutatorError> {
    for (track_idx, track) in project.tracks.iter_mut().enumerate() {
        if let Some(clip_idx) = track.clips.iter().position(|c| c.id == clip_id) {
            let clip = track.clips.remove(clip_idx);
            return Ok((track_idx, clip));
        }
    }
    Err(MutatorError::ClipNotFound(clip_id))
}

pub fn handle_overlaps(track: &mut Track, target: &AudioClip) {
    let target_start = target.position.sample_frame;
    let target_end = target.end_position().sample_frame;

    let mut i = 0;
    while i < track.clips.len() {
        if track.clips[i].id == target.id {
            i += 1;
            continue;
        }

        let clip_start = track.clips[i].position.sample_frame;
        let clip_end = track.clips[i].end_position().sample_frame;

        if clip_start >= target_end {
            break;
        }

        if clip_end > target_start {
            if clip_start >= target_start && clip_end <= target_end {
                track.clips.remove(i);
                continue;
            } else if clip_start < target_start && clip_end > target_end {
                let mut right_half = track.clips[i].clone();
                track.clips[i].duration = AbsoluteTime::new(target_start - clip_start);

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
            } else if clip_start >= target_start && clip_start < target_end {
                let delta = target_end - clip_start;
                track.clips[i].position = AbsoluteTime::new(target_end);
                track.clips[i].duration = AbsoluteTime::new(clip_end - target_end);
                track.clips[i].source_offset =
                    AbsoluteTime::new(track.clips[i].source_offset.sample_frame + delta);
            } else if clip_end > target_start && clip_end <= target_end {
                track.clips[i].duration = AbsoluteTime::new(target_start - clip_start);
            }

            if track.clips[i].duration.sample_frame < MIN_CLIP_FRAMES {
                track.clips.remove(i);
                continue;
            }
        }
        i += 1;
    }
}

pub fn handle_midi_overlaps(track: &mut Track, target: &MidiClip) {
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
