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

fn normalize_note_payloads(notes: &[MidiNotePayload], clip_len: i64) -> Vec<MidiNote> {
    let bounded_len = clip_len.max(1);
    let mut normalized: Vec<MidiNote> = notes
        .iter()
        .map(|n| {
            let start = n.start_frames.max(0).min(bounded_len.saturating_sub(1));
            let max_duration = (bounded_len - start).max(1);
            MidiNote::new(
                n.pitch,
                n.velocity,
                start,
                n.duration_frames.max(1).min(max_duration),
            )
        })
        .collect();
    normalized.sort_by_key(|n| n.start_frame);
    normalized
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct MidiVariationNotePayload {
    pitch: u8,
    velocity: u8,
    start_beat: f64,
    duration_beats: f64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct MidiVariationTrackContextPayload {
    track_name: String,
    track_type: String,
    instrument_name: Option<String>,
    effect_names: Vec<String>,
    sampler_sample_path: Option<String>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
struct GenerateMidiVariationRequest {
    bpm: f64,
    beats_per_bar: u8,
    clip_name: String,
    clip_duration_beats: f64,
    notes: Vec<MidiVariationNotePayload>,
    track_context: MidiVariationTrackContextPayload,
    model: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct GenerateMidiVariationResponse {
    notes: Vec<MidiVariationNotePayload>,
}

fn extract_json_object(raw: &str) -> Result<String, String> {
    let candidate = raw.trim();
    if candidate.is_empty() {
        return Err("AI response is empty".to_string());
    }

    if let Some(start) = candidate.find("```") {
        let rest = &candidate[start + 3..];
        if let Some(end) = rest.find("```") {
            let mut block = rest[..end].trim();
            if block.starts_with("json") {
                block = block[4..].trim();
            }
            if let (Some(first), Some(last)) = (block.find('{'), block.rfind('}'))
                && last > first
            {
                return Ok(block[first..=last].to_string());
            }
        }
    }

    let first = candidate.find('{').ok_or_else(|| "AI response does not contain JSON object".to_string())?;
    let last = candidate.rfind('}').ok_or_else(|| "AI response does not contain JSON object".to_string())?;
    if last <= first {
        return Err("AI response does not contain JSON object".to_string());
    }
    Ok(candidate[first..=last].to_string())
}

fn json_to_i64(v: Option<&serde_json::Value>, default: i64) -> i64 {
    v.and_then(|x| x.as_i64())
        .or_else(|| v.and_then(|x| x.as_f64().map(|n| n.round() as i64)))
        .unwrap_or(default)
}

fn json_to_f64(v: Option<&serde_json::Value>, default: f64) -> f64 {
    v.and_then(|x| x.as_f64())
        .or_else(|| v.and_then(|x| x.as_i64().map(|n| n as f64)))
        .unwrap_or(default)
}

fn normalize_variation_notes(
    notes: &[serde_json::Value],
    clip_duration_beats: f64,
) -> Vec<MidiVariationNotePayload> {
    let max_beat = clip_duration_beats.max(0.125);
    let mut normalized = Vec::new();

    for item in notes {
        let Some(obj) = item.as_object() else { continue };
        let pitch = json_to_i64(obj.get("pitch"), 60).clamp(0, 127) as u8;
        let velocity = json_to_i64(obj.get("velocity"), 100).clamp(1, 127) as u8;
        let start_beat = json_to_f64(
            obj.get("startBeat").or_else(|| obj.get("start_beat")),
            0.0,
        )
        .clamp(0.0, (max_beat - 0.0625).max(0.0));
        let duration_beats = json_to_f64(
            obj.get("durationBeats").or_else(|| obj.get("duration_beats")),
            0.25,
        )
        .clamp(0.0625, (max_beat - start_beat).max(0.0625));

        if !start_beat.is_finite() || !duration_beats.is_finite() {
            continue;
        }

        normalized.push(MidiVariationNotePayload {
            pitch,
            velocity,
            start_beat,
            duration_beats,
        });
    }

    normalized.sort_by(|a, b| a.start_beat.total_cmp(&b.start_beat));
    normalized
}

/// Generate a MIDI variation by sending clip/track context to OpenRouter.
#[tauri::command]
async fn generate_midi_variation_cmd(
    request: GenerateMidiVariationRequest,
    settings_state: tauri::State<'_, SettingsState>,
) -> Result<GenerateMidiVariationResponse, String> {
    let (api_key, default_model) = {
        let settings = settings_state.settings.lock().map_err(|e| e.to_string())?;
        (
            settings.open_router_api_key.trim().to_string(),
            settings.open_router_model.trim().to_string(),
        )
    };
    if api_key.is_empty() {
        return Err("OpenRouter API key is empty. Set it in Settings → MIDI.".to_string());
    }

    let model = request
        .model
        .as_deref()
        .map(str::trim)
        .filter(|m| !m.is_empty())
        .or_else(|| (!default_model.is_empty()).then_some(default_model.as_str()))
        .unwrap_or("openai/gpt-4o-mini");

    let clip_duration_beats = request.clip_duration_beats.max(0.125);
    let seed_notes: Vec<serde_json::Value> = request
        .notes
        .iter()
        .map(|n| {
            serde_json::json!({
                "pitch": n.pitch.clamp(0, 127),
                "velocity": n.velocity.clamp(1, 127),
                "startBeat": n.start_beat.max(0.0),
                "durationBeats": n.duration_beats.max(0.0625),
            })
        })
        .collect();

    let user_payload = serde_json::json!({
        "task": "Generate a variation of this MIDI clip while preserving musical intent and clip length.",
        "output_format": {
            "description": "Return strictly JSON with notes. No markdown.",
            "example": {
                "notes": [
                    { "pitch": 60, "velocity": 100, "startBeat": 0.0, "durationBeats": 0.5 }
                ]
            }
        },
        "context": {
            "bpm": request.bpm,
            "beatsPerBar": request.beats_per_bar.max(1),
            "clipName": request.clip_name,
            "clipDurationBeats": clip_duration_beats,
            "track": request.track_context,
        },
        "source_clip_mdc": {
            "notes": seed_notes,
        },
        "rules": [
            "Keep notes inside clip boundaries.",
            "Use valid MIDI ranges: pitch 0-127, velocity 1-127.",
            "Keep rhythmic coherence and avoid random noise patterns.",
            "Return at least one note."
        ]
    });

    let req_payload = serde_json::json!({
        "model": model,
        "temperature": 0.8,
        "messages": [
            {
                "role": "system",
                "content": "You are an expert MIDI variation generator for a DAW. Reply with JSON only."
            },
            {
                "role": "user",
                "content": user_payload.to_string()
            }
        ]
    });

    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(45))
        .build()
        .map_err(|e| format!("Failed to build OpenRouter client: {e}"))?;

    let response = client
        .post("https://openrouter.ai/api/v1/chat/completions")
        .bearer_auth(api_key)
        .header("Content-Type", "application/json")
        .json(&req_payload)
        .send()
        .await
        .map_err(|e| format!("OpenRouter request failed: {e}"))?;

    let status = response.status();
    let raw_body = response
        .text()
        .await
        .map_err(|e| format!("Failed to read OpenRouter response: {e}"))?;

    if !status.is_success() {
        let msg = serde_json::from_str::<serde_json::Value>(&raw_body)
            .ok()
            .and_then(|v| {
                v.get("error")
                    .and_then(|e| e.get("message"))
                    .and_then(|m| m.as_str())
                    .map(|s| s.to_string())
            })
            .unwrap_or_else(|| format!("OpenRouter request failed ({status})"));
        return Err(msg);
    }

    let parsed = serde_json::from_str::<serde_json::Value>(&raw_body)
        .map_err(|e| format!("Invalid OpenRouter JSON response: {e}"))?;
    let content_raw = parsed
        .get("choices")
        .and_then(|v| v.as_array())
        .and_then(|arr| arr.first())
        .and_then(|choice| choice.get("message"))
        .and_then(|msg| msg.get("content"))
        .ok_or_else(|| "OpenRouter response missing choices[0].message.content".to_string())?;

    let content = if let Some(s) = content_raw.as_str() {
        s.to_string()
    } else if let Some(parts) = content_raw.as_array() {
        parts
            .iter()
            .filter_map(|p| p.get("text").and_then(|t| t.as_str()))
            .collect::<Vec<_>>()
            .join("\n")
    } else {
        String::new()
    };
    let json_fragment = extract_json_object(&content)?;
    let variation = serde_json::from_str::<serde_json::Value>(&json_fragment)
        .map_err(|e| format!("AI JSON parse failed: {e}"))?;

    let notes_raw = variation
        .get("notes")
        .and_then(|v| v.as_array())
        .or_else(|| variation.get("mdcClip").and_then(|v| v.get("notes")).and_then(|v| v.as_array()))
        .or_else(|| variation.get("mdc_clip").and_then(|v| v.get("notes")).and_then(|v| v.as_array()))
        .cloned()
        .unwrap_or_default();

    let normalized = normalize_variation_notes(&notes_raw, clip_duration_beats);
    if normalized.is_empty() {
        return Err("AI returned empty/invalid notes".to_string());
    }

    Ok(GenerateMidiVariationResponse { notes: normalized })
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
    enum UpdateTarget {
        MidiClip {
            track_index: usize,
            normalized: Vec<MidiNote>,
        },
        LegacyAudioClip {
            track_index: usize,
            normalized: Vec<MidiNote>,
        },
        Noop,
    }

    let target = {
        let project = project_state.project.lock().map_err(|e| e.to_string())?;
        let mut found: Option<UpdateTarget> = None;

        for (track_index, track) in project.tracks.iter().enumerate() {
            if let Some(clip) = track.midi_clips.iter().find(|c| c.id == uuid) {
                let normalized = normalize_note_payloads(&notes, clip.duration.sample_frame);
                if clip.notes == normalized {
                    found = Some(UpdateTarget::Noop);
                } else {
                    found = Some(UpdateTarget::MidiClip { track_index, normalized });
                }
                break;
            }
        }

        if found.is_none() {
            for (track_index, track) in project.tracks.iter().enumerate() {
                if let Some(idx) = track
                    .clips
                    .iter()
                    .position(|c| c.id == uuid && c.file_path.trim().is_empty())
                {
                    let legacy = &track.clips[idx];
                    let normalized = normalize_note_payloads(&notes, legacy.duration.sample_frame);
                    found = Some(UpdateTarget::LegacyAudioClip { track_index, normalized });
                    break;
                }
            }
        }

        found.ok_or_else(|| format!("MIDI clip not found: {clip_id}"))?
    };

    if matches!(target, UpdateTarget::Noop) {
        return Ok(());
    }

    push_undo(&project_state)?;

    let mut project = project_state.project.lock().map_err(|e| e.to_string())?;
    match target {
        UpdateTarget::MidiClip {
            track_index,
            normalized,
        } => {
            let track = project
                .tracks
                .get_mut(track_index)
                .ok_or_else(|| format!("Track not found for MIDI clip: {clip_id}"))?;
            let clip = track
                .midi_clips
                .iter_mut()
                .find(|c| c.id == uuid)
                .ok_or_else(|| format!("MIDI clip disappeared during update: {clip_id}"))?;
            clip.notes = normalized;
        }
        UpdateTarget::LegacyAudioClip {
            track_index,
            normalized,
        } => {
            let track = project
                .tracks
                .get_mut(track_index)
                .ok_or_else(|| format!("Track not found for legacy MIDI clip: {clip_id}"))?;
            let idx = track
                .clips
                .iter()
                .position(|c| c.id == uuid && c.file_path.trim().is_empty())
                .ok_or_else(|| format!("Legacy MIDI clip disappeared during update: {clip_id}"))?;
            let legacy = track.clips.remove(idx);
            track.midi_clips.push(MidiClip {
                id: legacy.id,
                name: legacy.name,
                position: legacy.position,
                duration: legacy.duration,
                notes: normalized,
                is_selected: false,
                is_muted: false,
                fade_in_frames: 0,
                fade_out_frames: 0,
            });
        }
        UpdateTarget::Noop => {}
    }

    *project_state.is_dirty.lock().map_err(|e| e.to_string())? = true;
    clip_pool_state.rebuild_snapshot(&project);
    rebuild_midi_snapshot_from_project(&project, &handle);
    Ok(())
}
