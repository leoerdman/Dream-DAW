use super::*;

// ═══════════════════════════════════════════════════════════════════════

/// Response from creating a MIDI clip.
#[derive(Debug, Serialize, Deserialize)]
struct CreateMidiClipResponse {
    clip_id: String,
    clip_name: String,
    position_frames: i64,
    duration_frames: i64,
}

/// Creates an empty MIDI clip on a track at a specified position.
///
/// Used when the user double-clicks on a MIDI track to create a new
/// 1-bar (or N-bar) MIDI clip for note input.
#[tauri::command]
async fn create_midi_clip_cmd(
    track_index: u32,
    position_frames: i64,
    duration_frames: i64,
    name: Option<String>,
    project_state: tauri::State<'_, ProjectState>,
    handle: tauri::State<'_, AudioEngineHandle>,
) -> Result<CreateMidiClipResponse, String> {
    let clip_name = name.unwrap_or_else(|| "MIDI Clip".to_string());
    log::info!("[IPC] create_midi_clip_cmd: '{}' track={} pos={} dur={}", clip_name, track_index, position_frames, duration_frames);

    push_undo(&project_state)?;

    let clip = MidiClip::new(
        &clip_name,
        AbsoluteTime::new(position_frames),
        AbsoluteTime::new(duration_frames),
    );
    let clip_id = clip.id.to_string();

    {
        let mut project = project_state.project.lock().map_err(|e| e.to_string())?;

        let idx = track_index as usize;
        while project.tracks.len() <= idx {
            let track_num = project.tracks.len() + 1;
            project.add_track(Track::new(format!("Track {track_num}")));
        }

        project.tracks[idx].midi_clips.push(clip);

        *project_state.is_dirty.lock().map_err(|e| e.to_string())? = true;
        rebuild_midi_snapshot_from_project(&project, &handle);
    }

    log::info!(
        "[IPC] create_midi_clip: '{}' → track {} @ frame {} ({} frames)",
        clip_name, track_index, position_frames, duration_frames
    );

    Ok(CreateMidiClipResponse {
        clip_id,
        clip_name,
        position_frames,
        duration_frames,
    })
}

#[derive(Debug, Clone, Deserialize)]
struct MidiNotePayload {
    pitch: u8,
    velocity: u8,
    start_frames: i64,
    duration_frames: i64,
}

/// Replace all notes in a MIDI clip.
#[tauri::command]
async fn update_midi_clip_cmd(
    clip_id: String,
    notes: Vec<MidiNotePayload>,
    project_state: tauri::State<'_, ProjectState>,
    clip_pool_state: tauri::State<'_, ClipPoolState>,
    handle: tauri::State<'_, AudioEngineHandle>,
) -> Result<(), String> {
    let uuid = Uuid::parse_str(&clip_id).map_err(|e| format!("Invalid clip ID: {e}"))?;
    push_undo(&project_state)?;

    let mut project = project_state.project.lock().map_err(|e| e.to_string())?;
    let mut updated = false;

    for track in &mut project.tracks {
        if let Some(clip) = track.midi_clips.iter_mut().find(|c| c.id == uuid) {
            let clip_len = clip.duration.sample_frame.max(1);
            let mut normalized: Vec<MidiNote> = notes
                .iter()
                .map(|n| {
                    let start = n.start_frames.max(0).min(clip_len.saturating_sub(1));
                    let max_duration = (clip_len - start).max(1);
                    MidiNote::new(
                        n.pitch,
                        n.velocity,
                        start,
                        n.duration_frames.max(1).min(max_duration),
                    )
                })
                .collect();
            normalized.sort_by_key(|n| n.start_frame);
            clip.notes = normalized;
            updated = true;
            break;
        }
    }

    // Compatibility path:
    // migrate old "MIDI" clips that were historically written into audio clips with empty path.
    if !updated {
        for track in &mut project.tracks {
            if let Some(idx) = track
                .clips
                .iter()
                .position(|c| c.id == uuid && c.file_path.trim().is_empty())
            {
                let legacy = track.clips.remove(idx);
                let clip_len = legacy.duration.sample_frame.max(1);
                let mut normalized: Vec<MidiNote> = notes
                    .iter()
                    .map(|n| {
                        let start = n.start_frames.max(0).min(clip_len.saturating_sub(1));
                        let max_duration = (clip_len - start).max(1);
                        MidiNote::new(
                            n.pitch,
                            n.velocity,
                            start,
                            n.duration_frames.max(1).min(max_duration),
                        )
                    })
                    .collect();
                normalized.sort_by_key(|n| n.start_frame);

                track.midi_clips.push(MidiClip {
                    id: legacy.id,
                    name: legacy.name,
                    position: legacy.position,
                    duration: legacy.duration,
                    notes: normalized,
                    is_selected: false,
                });
                updated = true;
                break;
            }
        }
    }

    if !updated {
        return Err(format!("MIDI clip not found: {clip_id}"));
    }

    *project_state.is_dirty.lock().map_err(|e| e.to_string())? = true;
    clip_pool_state.rebuild_snapshot(&project);
    rebuild_midi_snapshot_from_project(&project, &handle);
    Ok(())
}

