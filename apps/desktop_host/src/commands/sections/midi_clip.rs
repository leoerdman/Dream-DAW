// ═══════════════════════════════════════════════════════════════════════

/// Response from creating a MIDI clip.
#[derive(Debug, Serialize, Deserialize)]
struct CreateMidiClipResponse {
    clip_id: String,
    clip_name: String,
    position_frames: i64,
    duration_frames: i64,
}

#[derive(Debug, Serialize, Deserialize)]
struct CreateMidiClipWithDeltasResponse {
    clip_id: String,
    clip_name: String,
    position_frames: i64,
    duration_frames: i64,
    deltas: Vec<dream_models::delta::ProjectDelta>,
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
    app: tauri::AppHandle,
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

        let project_name = project.name.clone();
        rebuild_midi_snapshot_from_project(&project, &handle);
        drop(project);
        project_state.mark_dirty(&project_name, Some(&app))?;
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

#[tauri::command]
async fn create_midi_clip_with_deltas_cmd(
    track_index: u32,
    position_frames: i64,
    duration_frames: i64,
    name: Option<String>,
    project_state: tauri::State<'_, ProjectState>,
    handle: tauri::State<'_, AudioEngineHandle>,
    app: tauri::AppHandle,
) -> Result<CreateMidiClipWithDeltasResponse, String> {
    let response = create_midi_clip_cmd(
        track_index,
        position_frames,
        duration_frames,
        name,
        project_state.clone(),
        handle.clone(),
        app,
    )
    .await?;

    let clip_uuid = Uuid::parse_str(&response.clip_id)
        .map_err(|_| format!("Invalid MIDI clip UUID: {}", response.clip_id))?;
    let resolved_track_index = {
        let project = project_state.project.lock().map_err(|e| e.to_string())?;
        project
            .tracks
            .iter()
            .position(|t| t.midi_clips.iter().any(|c| c.id == clip_uuid))
            .ok_or_else(|| {
                format!(
                    "Delta invariant violated: created MIDI clip {} not found",
                    response.clip_id
                )
            })?
    };

    Ok(CreateMidiClipWithDeltasResponse {
        clip_id: response.clip_id.clone(),
        clip_name: response.clip_name.clone(),
        position_frames: response.position_frames,
        duration_frames: response.duration_frames,
        deltas: vec![dream_models::delta::ProjectDelta::ClipAdded {
            clip_id: clip_uuid,
            track_index: resolved_track_index,
            name: response.clip_name,
            clip_type: "midi".to_string(),
            file_path: None,
            position: response.position_frames,
            duration: response.duration_frames,
        }],
    })
}

#[derive(Debug, Clone, Deserialize)]
struct MidiNotePayload {
    pitch: u8,
    velocity: u8,
    start_frames: i64,
    duration_frames: i64,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
struct MidiEnvelopePointPayload {
    beat: f64,
    value: f64,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
struct MidiClipEnvelopePayload {
    param_id: String,
    points: Vec<MidiEnvelopePointPayload>,
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
    normalized.sort_by(|a, b| {
        a.start_frame
            .cmp(&b.start_frame)
            .then_with(|| a.pitch.cmp(&b.pitch))
            .then_with(|| a.duration_frames.cmp(&b.duration_frames))
            .then_with(|| a.velocity.cmp(&b.velocity))
    });

    // Canonicalize accidental duplicates: same pitch + same start frame.
    // Keep the strongest/longest representative.
    if normalized.len() > 1 {
        let mut write = 0usize;
        for read in 0..normalized.len() {
            if write > 0 {
                let prev = normalized[write - 1];
                let curr = normalized[read];
                if prev.pitch == curr.pitch && prev.start_frame == curr.start_frame {
                    normalized[write - 1].duration_frames = prev.duration_frames.max(curr.duration_frames);
                    normalized[write - 1].velocity = prev.velocity.max(curr.velocity);
                    continue;
                }
            }
            if write != read {
                normalized[write] = normalized[read];
            }
            write += 1;
        }
        normalized.truncate(write);
    }

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
    #[serde(rename = "clipName")]
    _clip_name: String,
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

    // Use the model from the request, then from settings, then hard-default to
    // Claude Sonnet 4.5 via OpenRouter (same model as the chat assistant panel).
    let model = request
        .model
        .as_deref()
        .map(str::trim)
        .filter(|m| !m.is_empty())
        .map(|m| m.to_string())
        .or_else(|| (!default_model.is_empty()).then_some(default_model.clone()))
        .unwrap_or_else(|| "anthropic/claude-sonnet-4-5".to_string());

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

    let bars = (clip_duration_beats / request.beats_per_bar.max(1) as f64).ceil() as u32;
    let instrument_hint = request.track_context.instrument_name
        .as_deref()
        .unwrap_or("unknown instrument");
    let track_name_hint = request.track_context.track_name.as_str();
    let sampler_hint = request.track_context.sampler_sample_path
        .as_deref()
        .filter(|s| !s.is_empty())
        .map(|s| format!(" (sampler: {})", s.split('/').next_back().unwrap_or(s)))
        .unwrap_or_default();

    let system_prompt = "You are an expert music composer and MIDI programmer embedded in a professional DAW.\n\
        Your task: given a MIDI clip, produce a creative but musically coherent variation.\n\
        IMPORTANT: respond with ONLY a raw JSON object — no markdown, no code fences, no explanation.\n\
        The JSON must have exactly one key \"notes\" containing an array of note objects.\n\
        Each note object must have: pitch (int 0-127), velocity (int 1-127), startBeat (float ≥ 0), durationBeats (float > 0).\n\
        All notes must fit within clipDurationBeats. Do not exceed clip length.";

    let user_prompt = format!(
        "Generate a musical variation of this {bars}-bar MIDI clip.\n\
        Track: \"{track_name_hint}\"{sampler_hint}, instrument: {instrument_hint}\n\
        BPM: {bpm}, beatsPerBar: {beats_per_bar}, clipDurationBeats: {dur:.3}\n\n\
        Source notes ({n} notes):\n{notes_json}\n\n\
        Rules:\n\
        - Preserve the general feel, tempo and style\n\
        - Vary rhythm, pitch or velocity creatively — not a copy\n\
        - All startBeat values must be in [0, {dur:.3})\n\
        - All startBeat + durationBeats must be ≤ {dur:.3}\n\
        - Return at least 1 note, at most {max_notes} notes\n\n\
        Respond with ONLY the JSON object, example: {{\"notes\":[{{\"pitch\":60,\"velocity\":100,\"startBeat\":0.0,\"durationBeats\":0.5}}]}}",
        bars = bars,
        track_name_hint = track_name_hint,
        sampler_hint = sampler_hint,
        instrument_hint = instrument_hint,
        bpm = request.bpm,
        beats_per_bar = request.beats_per_bar.max(1),
        dur = clip_duration_beats,
        n = seed_notes.len(),
        notes_json = serde_json::to_string(&seed_notes).unwrap_or_default(),
        max_notes = (seed_notes.len() * 3).max(32),
    );

    let req_payload = serde_json::json!({
        "model": model,
        "temperature": 0.85,
        "max_tokens": 2048,
        "messages": [
            { "role": "system", "content": system_prompt },
            { "role": "user",   "content": user_prompt }
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
    push_undo_step: Option<bool>,
    project_state: tauri::State<'_, ProjectState>,
    clip_pool_state: tauri::State<'_, ClipPoolState>,
    handle: tauri::State<'_, AudioEngineHandle>,
    app: tauri::AppHandle,
) -> Result<(), String> {
    let uuid = Uuid::parse_str(&clip_id).map_err(|e| format!("Invalid clip ID: {e}"))?;

    // 1. Get clip duration for normalization, and check for Noop
    let (clip_duration_frames, is_noop, is_legacy, project_name) = {
        let project = project_state.project.lock().map_err(|e| e.to_string())?;
        let mut dur = 0;
        let mut is_noop = false;
        let mut is_legacy = false;
        
        for track in &project.tracks {
            if let Some(c) = track.midi_clips.iter().find(|c| c.id == uuid) {
                dur = c.duration.sample_frame;
                let normalized = normalize_note_payloads(&notes, dur);
                is_noop = c.notes == normalized;
                break;
            }
            if let Some(c) = track.clips.iter().find(|c| c.id == uuid && c.file_path.trim().is_empty()) {
                dur = c.duration.sample_frame;
                is_legacy = true;
                break;
            }
        }
        if dur == 0 {
            return Err(format!("MIDI clip not found: {clip_id}"));
        }
        (dur, is_noop, is_legacy, project.name.clone())
    };

    if is_noop {
        return Ok(());
    }

    if push_undo_step.unwrap_or(true) {
        push_undo(&project_state)?;
    }

    let normalized = normalize_note_payloads(&notes, clip_duration_frames);
    let cmd = dream_orchestrator::commands::UpdateMidiClipCommand::from_str_id(&clip_id, normalized)
        .map_err(|e| e.to_string())?;

    execute_orchestrator_command(&project_state, &cmd)?;

    let project = project_state.project.lock().map_err(|e| e.to_string())?;
    if is_legacy {
        clip_pool_state.rebuild_snapshot(&project);
    }
    rebuild_midi_snapshot_from_project(&project, &handle);
    drop(project);
    project_state.mark_dirty(&project_name, Some(&app))?;
    Ok(())
}

fn collect_midi_note_deltas_for_clip(
    project: &dream_models::project::Project,
    clip_id: Uuid,
) -> Vec<dream_models::delta::MidiNoteDelta> {
    let Some(clip) = project
        .tracks
        .iter()
        .flat_map(|t| t.midi_clips.iter())
        .find(|clip| clip.id == clip_id)
    else {
        return Vec::new();
    };

    let clip_start = clip.position.sample_frame;
    let clip_start_beat = project.pulse_map.beats(clip_start);

    clip.notes
        .iter()
        .map(|note| {
            let note_start_abs = clip_start + note.start_frame;
            let note_end_abs = note_start_abs + note.duration_frames;
            let note_start_beat = project.pulse_map.beats(note_start_abs) - clip_start_beat;
            let note_duration_beats =
                (project.pulse_map.beats(note_end_abs) - project.pulse_map.beats(note_start_abs)).max(0.0);
            dream_models::delta::MidiNoteDelta {
                pitch: note.pitch,
                velocity: note.velocity,
                start_beat: note_start_beat.max(0.0),
                duration_beats: note_duration_beats,
            }
        })
        .collect()
}

#[tauri::command]
async fn update_midi_clip_with_deltas_cmd(
    clip_id: String,
    notes: Vec<MidiNotePayload>,
    push_undo_step: Option<bool>,
    project_state: tauri::State<'_, ProjectState>,
    clip_pool_state: tauri::State<'_, ClipPoolState>,
    handle: tauri::State<'_, AudioEngineHandle>,
    app: tauri::AppHandle,
) -> Result<DeltaMutationResponse, String> {
    update_midi_clip_cmd(
        clip_id.clone(),
        notes,
        push_undo_step,
        project_state.clone(),
        clip_pool_state,
        handle,
        app,
    )
    .await?;

    let clip_uuid = Uuid::parse_str(&clip_id).map_err(|e| format!("Invalid clip ID: {e}"))?;
    let note_deltas = {
        let project = project_state.project.lock().map_err(|e| e.to_string())?;
        collect_midi_note_deltas_for_clip(&project, clip_uuid)
    };

    Ok(DeltaMutationResponse {
        deltas: vec![dream_models::delta::ProjectDelta::MidiClipNotesReplaced {
            clip_id: clip_uuid,
            notes: note_deltas,
        }],
    })
}

#[tauri::command]
async fn set_midi_clip_envelopes_cmd(
    clip_id: String,
    envelopes: Vec<MidiClipEnvelopePayload>,
    push_undo_step: Option<bool>,
    project_state: tauri::State<'_, ProjectState>,
    handle: tauri::State<'_, AudioEngineHandle>,
    app: tauri::AppHandle,
) -> Result<(), String> {
    let mut normalized: Vec<dream_models::project::ClipEnvelope> = envelopes
        .iter()
        .filter(|env| !env.param_id.trim().is_empty())
        .map(|env| {
            let mut points: Vec<dream_models::project::AutomationPoint> = env
                .points
                .iter()
                .map(|p| dream_models::project::AutomationPoint {
                    beat: p.beat.max(0.0),
                    value: p.value.clamp(0.0, 1.0),
                    curve_type: "linear".to_string(),
                    tension: None,
                    bezier_cp1x: None,
                    bezier_cp1y: None,
                    bezier_cp2x: None,
                    bezier_cp2y: None,
                })
                .collect();
            points.sort_by(|a, b| a.beat.total_cmp(&b.beat));
            dream_models::project::ClipEnvelope {
                pointee_id: 0,
                param_id: env.param_id.clone(),
                points,
            }
        })
        .collect();
    normalized.sort_by(|a, b| a.param_id.cmp(&b.param_id));

    if push_undo_step.unwrap_or(true) {
        push_undo(&project_state)?;
    }

    let cmd = dream_orchestrator::commands::SetMidiClipEnvelopesCommand::from_str_id(&clip_id, normalized)
        .map_err(|e| e.to_string())?;

    execute_orchestrator_command(&project_state, &cmd)?;

    let project = project_state.project.lock().map_err(|e| e.to_string())?;
    let project_name = project.name.clone();
    rebuild_midi_snapshot_from_project(&project, &handle);
    drop(project);
    project_state.mark_dirty(&project_name, Some(&app))?;
    Ok(())
}
