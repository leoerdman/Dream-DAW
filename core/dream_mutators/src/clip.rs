use dream_models::project::Project;
use uuid::Uuid;

/// Returns `(found, changed)` for a requested mute state.
pub fn clip_mute_status(project: &Project, clip_id: Uuid, muted: bool) -> (bool, bool) {
    for track in &project.tracks {
        if let Some(clip) = track.clips.iter().find(|c| c.id == clip_id) {
            return (true, clip.is_muted != muted);
        }
    }
    for track in &project.tracks {
        if let Some(clip) = track.midi_clips.iter().find(|c| c.id == clip_id) {
            return (true, clip.is_muted != muted);
        }
    }
    (false, false)
}

/// Applies mute state to an audio or MIDI clip and returns `(found, changed)`.
pub fn apply_clip_mute(project: &mut Project, clip_id: Uuid, muted: bool) -> (bool, bool) {
    for track in &mut project.tracks {
        if let Some(clip) = track.clips.iter_mut().find(|c| c.id == clip_id) {
            let changed = clip.is_muted != muted;
            if changed {
                clip.is_muted = muted;
            }
            return (true, changed);
        }
    }

    for track in &mut project.tracks {
        if let Some(clip) = track.midi_clips.iter_mut().find(|c| c.id == clip_id) {
            let changed = clip.is_muted != muted;
            if changed {
                clip.is_muted = muted;
            }
            return (true, changed);
        }
    }

    (false, false)
}

#[cfg(test)]
mod tests {
    use super::*;
    use dream_models::midi::MidiClip;
    use dream_models::project::{AudioClip, Track};
    use dream_models::time::AbsoluteTime;

    #[test]
    fn status_reports_audio_clip_changes() {
        let mut project = Project::new("test", 120.0, 44_100.0);
        let mut track = Track::new("A");
        let clip = AudioClip::new(
            "clip",
            "/tmp/clip.wav",
            AbsoluteTime::new(0),
            AbsoluteTime::new(100),
        );
        let clip_id = clip.id;
        track.clips.push(clip);
        project.tracks.push(track);

        assert_eq!(clip_mute_status(&project, clip_id, false), (true, false));
        assert_eq!(clip_mute_status(&project, clip_id, true), (true, true));
    }

    #[test]
    fn apply_works_for_midi_clips() {
        let mut project = Project::new("test", 120.0, 44_100.0);
        let mut track = Track::new("M");
        let clip = MidiClip::new("midi", AbsoluteTime::new(0), AbsoluteTime::new(100));
        let clip_id = clip.id;
        track.midi_clips.push(clip);
        project.tracks.push(track);

        assert_eq!(apply_clip_mute(&mut project, clip_id, true), (true, true));
        assert_eq!(clip_mute_status(&project, clip_id, true), (true, false));
        assert_eq!(apply_clip_mute(&mut project, clip_id, true), (true, false));
    }
}
