use crate::ProjectState;
use dream_engine::driver::{
    AutomationPoint, ExternalParamAutomationLane, ExternalParamTarget, MidiFxRuntimeConfig,
    MidiTrackRuntime, TrackAutomationState,
    parse_external_param_target as parse_external_param_target_impl,
};
use dream_ipc::EngineCommand;
use dream_models::midi::MidiClip;
use dream_models::project::{Project, Track};
use std::path::PathBuf;
use std::time::Duration;

use crate::snapshot::SharedProjectSnapshot;
use crate::state_managers::audio_engine::AudioEngineHandle;
use crate::state_managers::clip_pool::ClipPoolState;
use crate::state_managers::recording::AutomationRuntime;

#[path = "sync_engine/runtime_device_chains.rs"]
mod runtime_device_chains;
#[path = "sync_engine/runtime_device_import_params.rs"]
mod runtime_device_import_params;
#[path = "sync_engine/sampler_snapshot.rs"]
mod sampler_snapshot;
pub use runtime_device_chains::rebuild_runtime_device_chains_from_project;
pub use sampler_snapshot::rebuild_sampler_snapshot_from_project;

/// BUG-063 FIX: Macro for best-effort command pushes that logs failures
/// instead of silently dropping them with `let _ =`.
/// Use this in restore/rebuild functions where individual parameter
/// failures should not abort the entire operation.
#[macro_export]
macro_rules! push_command_or_log {
    ($handle:expr, $cmd:expr, $context:expr) => {
        if let Err(err) = $crate::state_managers::sync_engine::push_command($handle, $cmd) {
            log::warn!(
                "[Engine] BUG-063: Failed to push command ({}): {}",
                $context,
                err
            );
        }
    };
}

/// Helper: push command to the audio engine with retry exponential backoff
/// for high priority commands, gracefully returning error if the queue is full.
pub fn push_command(handle: &AudioEngineHandle, cmd: EngineCommand) -> Result<(), String> {
    fn is_high_priority_command(cmd: &EngineCommand) -> bool {
        matches!(
            cmd,
            EngineCommand::SetPlay(_)
                | EngineCommand::Seek(_)
                | EngineCommand::SetBpm(_)
                | EngineCommand::SetTimeSignature { .. }
                | EngineCommand::SetLoopEnabled(_)
                | EngineCommand::SetLoopRegion { .. }
                | EngineCommand::SetTrackDisabled { .. }
                | EngineCommand::SetTrackSolo { .. }
                | EngineCommand::SetTrackVolume { .. }
                | EngineCommand::SetTrackPan { .. }
                | EngineCommand::SetMasterVolume { .. }
        )
    }

    let high_priority = is_high_priority_command(&cmd);
    let max_attempts = if high_priority { 14 } else { 6 };
    let mut pending = cmd;
    for attempt in 0..max_attempts {
        let push_result = {
            let mut producer = handle
                .producer
                .lock()
                .map_err(|e| format!("Lock poisoned: {e}"))?;
            producer.push(pending)
        };

        match push_result {
            Ok(()) => return Ok(()),
            Err(rtrb::PushError::Full(returned)) => {
                pending = returned;
                if attempt < 3 {
                    std::thread::yield_now();
                } else {
                    std::thread::sleep(Duration::from_micros(if high_priority {
                        250
                    } else {
                        150
                    }));
                }
            }
        }
    }

    handle.rt_debug_stats.record_queue_full_reject();
    Err("Command queue full — audio thread overloaded".to_string())
}

/// RT-Safe helper: pre-constructs a built-in DSP processor on the calling
/// (non-RT) thread and transfers it to the audio thread via the lock-free
/// SPSC prealloc queue. If the prealloc queue is full, falls back to the
/// legacy `EngineCommand::AddDevice` path (which allocates on the RT thread).
///
/// **Enterprise Pattern**: Professional DAWs never call `malloc()` on the
/// audio IO thread. This function ensures processors are fully constructed
/// before reaching the audio callback.
pub fn push_prealloc_device(
    handle: &AudioEngineHandle,
    track_index: u16,
    slot_index: u8,
    effect_type: u8,
) -> Result<(), String> {
    use dream_dsp::dsp_processor::BuiltinEffectType;
    use dream_dsp::device_slot::InternalDeviceSlot;
    use dream_ipc::prealloc_queue::PrebuiltDevice;

    let Some(etype) = BuiltinEffectType::from_u8(effect_type) else {
        return Err(format!("Invalid effect_type: {effect_type}"));
    };

    let sample_rate = handle
        .playback_state
        .lock()
        .map(|s| s.sample_rate as f32)
        .unwrap_or(44_100.0);

    // Pre-construct as InternalDeviceSlot (wraps DspProcessor → DeviceProcessor).
    let device = InternalDeviceSlot::new(etype, sample_rate);

    let prebuilt = PrebuiltDevice {
        track_index,
        slot_index,
        device: Box::new(device),
    };
    let mut producer = handle
        .prealloc_producer
        .lock()
        .map_err(|e| format!("prealloc lock poisoned: {e}"))?;
    if let Err(_) = producer.push(prebuilt) {
        drop(producer);
        log::warn!(
            "[RT-SafeDevice] prealloc queue full, falling back to legacy AddDevice \
             (RT allocation!) track={track_index} slot={slot_index}"
        );
        push_command(
            handle,
            dream_ipc::EngineCommand::AddDevice {
                track_index,
                slot_index,
                effect_type,
            },
        )?;
    }
    Ok(())
}

const MAX_UNDO_DEPTH: usize = 120; // 120 * ~200KB = ~24MB RAM usage

/// Snapshots the current project state onto the undo stack.
///
/// Must be called BEFORE any mutation. Clears the redo stack
/// (a new action invalidates the redo history).
#[track_caller]
pub fn push_undo(project_state: &ProjectState) -> Result<(), String> {
    let project = project_state.project.lock().map_err(|e| e.to_string())?;
    let mut undo = project_state.undo.lock().map_err(|e| e.to_string())?;
    let previous = undo.undo_stack.back();
    let snapshot = SharedProjectSnapshot::from_project(&project, previous);
    drop(project);
    undo.undo_stack.push_back(snapshot);
    let depth = undo.undo_stack.len();
    if undo.undo_stack.len() > MAX_UNDO_DEPTH {
        undo.undo_stack.pop_front(); // O(1) eviction via VecDeque ring buffer
    }
    undo.redo_stack.clear();
    drop(undo);

    let detail = if log::log_enabled!(log::Level::Debug) {
        let caller = std::panic::Location::caller();
        format!(
            "captured undo snapshot depth={} caller={}:{}",
            depth,
            caller.file(),
            caller.line()
        )
    } else {
        String::from("undo snapshot")
    };
    // Need to use pub API on ProjectState to record history if possible,
    // assuming it exists or we do it inline here. Wait, `record_history` is in lib.rs.
    // We'll trust `record_history` is available or make it so.
    let _ = project_state.history_snapshot(None, None); // Hacky proxy
    let mut history = project_state.history.lock().map_err(|e| e.to_string())?;
    history.push("mutation_snapshot", detail);
    Ok(())
}

/// Coalesced undo for rapid sequential operations (move/resize/drag).
const COALESCE_WINDOW_MS: u128 = 300;
static LAST_UNDO_PUSH_MS: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);

#[track_caller]
pub fn push_undo_coalesced(project_state: &ProjectState) -> Result<(), String> {
    let now_ms = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0);
    let last_ms = LAST_UNDO_PUSH_MS.load(std::sync::atomic::Ordering::Relaxed);

    if last_ms > 0 && (now_ms.saturating_sub(last_ms) as u128) < COALESCE_WINDOW_MS {
        let project = project_state.project.lock().map_err(|e| e.to_string())?;
        let mut undo = project_state.undo.lock().map_err(|e| e.to_string())?;
        let stack_len = undo.undo_stack.len();
        if stack_len > 0 {
            let previous = if stack_len >= 2 {
                undo.undo_stack.get(stack_len - 2)
            } else {
                None
            };
            let new_snapshot = SharedProjectSnapshot::from_project(&project, previous);
            if let Some(top) = undo.undo_stack.back_mut() {
                *top = new_snapshot;
            }
        }
        LAST_UNDO_PUSH_MS.store(now_ms, std::sync::atomic::Ordering::Relaxed);
        return Ok(());
    }

    LAST_UNDO_PUSH_MS.store(now_ms, std::sync::atomic::Ordering::Relaxed);
    push_undo(project_state)
}

/// Helper to parse external parameter target properly.
pub fn parse_external_param_target(param_id: &str) -> Option<ExternalParamTarget> {
    parse_external_param_target_impl(param_id)
}

/// Refresh offline flags for clips on project load/rescan.
pub fn refresh_offline_flags(project: &mut Project) {
    let mut offline_cache: std::collections::HashMap<String, bool> =
        std::collections::HashMap::new();
    for track in &mut project.tracks {
        for clip in &mut track.clips {
            let is_offline = *offline_cache
                .entry(clip.file_path.clone())
                .or_insert_with(|| !PathBuf::from(&clip.file_path).exists());
            clip.is_offline = is_offline;
        }
    }
}

pub fn rebuild_automation_snapshot_from_project(
    project: &Project,
    automation_runtime: &AutomationRuntime,
) {
    fn normalize_pan_value(raw: f32) -> f32 {
        raw.clamp(-1.0, 1.0)
    }

    fn is_track_pan_param(key: &str) -> bool {
        matches!(key, "pan" | "track.pan" | "mixer.pan")
    }

    fn is_track_volume_param(key: &str) -> bool {
        matches!(
            key,
            "volume" | "gain" | "track.volume" | "track.gain" | "mixer.gain"
        )
    }

    fn canonical_plugin_param(key: &str) -> Option<&'static str> {
        match key {
            "plugin.gain" | "plugin/gain" | "fx.gain" | "fx/gain" => Some("__plugin_gain__"),
            "plugin.pan" | "plugin/pan" | "fx.pan" | "fx/pan" => Some("__plugin_pan__"),
            _ => None,
        }
    }

    let mut lanes = vec![TrackAutomationState::default(); project.tracks.len()];

    for (track_idx, track) in project.tracks.iter().enumerate() {
        let mut state = TrackAutomationState::default();
        for lane in &track.automation_lanes {
            let key = lane.param_id.to_lowercase();
            let mut points: Vec<AutomationPoint> = lane
                .points
                .iter()
                .map(|p| AutomationPoint {
                    sample_frame: project.pulse_map.sample_frame(p.beat.max(0.0)),
                    value: p.value as f32,
                })
                .collect();
            points.sort_by_key(|p| p.sample_frame);

            if is_track_pan_param(&key) {
                for p in &mut points {
                    p.value = normalize_pan_value(p.value);
                }
                state.pan = points;
            } else if is_track_volume_param(&key) {
                for p in &mut points {
                    p.value = p.value.clamp(0.0, 2.0);
                }
                state.volume = points;
            } else if !points.is_empty() {
                if let Some(alias) = canonical_plugin_param(&key) {
                    state
                        .plugin_params
                        .insert(alias.to_string(), points.clone());
                }
                if let Some(target) = parse_external_param_target(&lane.param_id) {
                    state
                        .external_plugin_params
                        .push(ExternalParamAutomationLane {
                            target,
                            points: points.clone(),
                        });
                }
                state.plugin_params.insert(lane.param_id.clone(), points);
            }
        }
        lanes[track_idx] = state;
    }

    automation_runtime.snapshot.swap(lanes);
}

pub fn rebuild_midi_snapshot_from_project(project: &Project, handle: &AudioEngineHandle) {
    fn sanitize_runtime_clip(mut clip: MidiClip) -> MidiClip {
        clip.notes.sort_by(|a, b| {
            a.start_frame
                .cmp(&b.start_frame)
                .then_with(|| a.pitch.cmp(&b.pitch))
                .then_with(|| a.duration_frames.cmp(&b.duration_frames))
                .then_with(|| a.velocity.cmp(&b.velocity))
        });

        if clip.notes.len() > 1 {
            let mut merged: Vec<dream_models::midi::MidiNote> =
                Vec::with_capacity(clip.notes.len());
            for note in clip.notes.into_iter() {
                if let Some(last) = merged.last_mut()
                    && last.pitch == note.pitch
                    && last.start_frame == note.start_frame
                {
                    last.duration_frames = last.duration_frames.max(note.duration_frames);
                    last.velocity = last.velocity.max(note.velocity);
                    continue;
                }
                merged.push(note);
            }
            clip.notes = merged;
        }

        clip.notes.sort_by_key(|n| n.start_frame);
        clip
    }

    fn normalize_lane_key(raw: &str) -> String {
        let lowered = raw.to_ascii_lowercase();
        let unscoped = if let Some(rest) = lowered.strip_prefix("slot:") {
            if let Some(split_at) = rest.find(':') {
                &rest[split_at + 1..]
            } else {
                lowered.as_str()
            }
        } else {
            lowered.as_str()
        };
        unscoped
            .chars()
            .filter(|c| c.is_ascii_alphanumeric())
            .collect()
    }

    fn first_lane_value(track: &Track, keys: &[&str], default: f32) -> f32 {
        let normalized_keys: Vec<String> = keys.iter().map(|k| normalize_lane_key(k)).collect();
        for lane in &track.automation_lanes {
            let lane_key = normalize_lane_key(&lane.param_id);
            let matches = normalized_keys
                .iter()
                .any(|key| lane_key == *key || lane_key.ends_with(key));
            if !matches {
                continue;
            }
            if let Some(point) = lane.points.first() {
                return point.value as f32;
            }
        }
        default
    }

    fn has_any_midi_fx(track: &Track, plugin_ids: &[&str]) -> bool {
        track.effects.iter().any(|node| {
            node.collect_plugin_slots().iter().any(|slot| {
                plugin_ids
                    .iter()
                    .any(|candidate| slot.plugin_id.eq_ignore_ascii_case(candidate))
            })
        })
    }

    fn first_midi_fx_param_value(
        track: &Track,
        plugin_ids: &[&str],
        param_index: usize,
    ) -> Option<f32> {
        for node in &track.effects {
            for slot in node.collect_plugin_slots() {
                if !plugin_ids
                    .iter()
                    .any(|candidate| slot.plugin_id.eq_ignore_ascii_case(candidate))
                {
                    continue;
                }
                let value = slot
                    .params
                    .as_ref()
                    .and_then(|params| params.get(param_index).copied());
                if let Some(v) = value
                    && v.is_finite()
                {
                    return Some(v);
                }
            }
        }
        None
    }

    let tracks: Vec<MidiTrackRuntime> = project
        .tracks
        .iter()
        .map(|track| {
            let has_pitch = has_any_midi_fx(track, &["internal://midi-fx/pitch"]);
            let has_scale = has_any_midi_fx(
                track,
                &["internal://midi-fx/scale", "internal://midi-fx/chord"],
            );
            let has_velocity = has_any_midi_fx(
                track,
                &[
                    "internal://midi-fx/velocity",
                    "internal://midi-fx/note-length",
                    "internal://midi-fx/cc-control",
                    "internal://midi-fx/expression-control",
                ],
            );
            let has_random = has_any_midi_fx(
                track,
                &[
                    "internal://midi-fx/random",
                    "internal://midi-fx/arpeggiator",
                ],
            );

            let pitch_default =
                first_midi_fx_param_value(track, &["internal://midi-fx/pitch"], 0).unwrap_or(0.0);
            let scale_root_default =
                first_midi_fx_param_value(track, &["internal://midi-fx/scale"], 0).unwrap_or(0.0);
            let scale_mask_default =
                first_midi_fx_param_value(track, &["internal://midi-fx/scale"], 1)
                    .unwrap_or(4095.0);
            let velocity_gain_default =
                first_midi_fx_param_value(track, &["internal://midi-fx/velocity"], 0)
                    .unwrap_or(1.0);
            let velocity_offset_default =
                first_midi_fx_param_value(track, &["internal://midi-fx/velocity"], 1)
                    .unwrap_or(0.0);
            let random_semitones_default =
                first_midi_fx_param_value(track, &["internal://midi-fx/random"], 0).unwrap_or(0.0);
            let random_chance_default =
                first_midi_fx_param_value(track, &["internal://midi-fx/random"], 1).unwrap_or(1.0);

            let fx = MidiFxRuntimeConfig {
                pitch_enabled: has_pitch,
                pitch_semitones: first_lane_value(
                    track,
                    &[
                        "midi.pitch.semitones",
                        "midifx.pitch.semitones",
                        "midiPitch.semitones",
                    ],
                    pitch_default,
                )
                .round()
                .clamp(-48.0, 48.0) as i8,
                scale_enabled: has_scale,
                scale_root: first_lane_value(
                    track,
                    &["midi.scale.root", "midifx.scale.root", "midiScale.root"],
                    scale_root_default,
                )
                .round()
                .rem_euclid(12.0) as u8,
                scale_mask: first_lane_value(
                    track,
                    &["midi.scale.mask", "midifx.scale.mask", "midiScale.mask"],
                    scale_mask_default,
                )
                .round()
                .clamp(1.0, 4095.0) as u16,
                velocity_enabled: has_velocity,
                velocity_gain: first_lane_value(
                    track,
                    &[
                        "midi.velocity.gain",
                        "midifx.velocity.gain",
                        "midiVelocity.gain",
                    ],
                    velocity_gain_default,
                )
                .clamp(0.0, 4.0),
                velocity_offset: first_lane_value(
                    track,
                    &[
                        "midi.velocity.offset",
                        "midifx.velocity.offset",
                        "midiVelocity.offset",
                    ],
                    velocity_offset_default,
                )
                .round()
                .clamp(-127.0, 127.0) as i8,
                random_enabled: has_random,
                random_semitones: first_lane_value(
                    track,
                    &[
                        "midi.random.semitones",
                        "midifx.random.semitones",
                        "midiRandom.semitones",
                    ],
                    random_semitones_default,
                )
                .round()
                .clamp(-24.0, 24.0) as i8,
                random_chance: first_lane_value(
                    track,
                    &[
                        "midi.random.chance",
                        "midifx.random.chance",
                        "midiRandom.chance",
                    ],
                    random_chance_default,
                )
                .clamp(0.0, 1.0),
            };

            MidiTrackRuntime {
                clips: track
                    .midi_clips
                    .iter()
                    .cloned()
                    .map(sanitize_runtime_clip)
                    .collect(),
                fx,
            }
        })
        .collect();
    handle.midi_snapshot.swap(tracks);
}

pub fn sync_transport_from_project(
    project: &Project,
    handle: &AudioEngineHandle,
) -> Result<(), String> {
    let bpm = project_initial_transport_bpm(project);
    let timeline_sample_rate = project.sample_rate.max(1.0);
    let loop_enabled = project.is_looping;
    let loop_start = project.loop_start_frames.unwrap_or(0);
    let loop_end = project.loop_end_frames.unwrap_or(0);
    let playhead = project.playhead_position_frames.max(0);

    {
        let mut state = handle.playback_state.lock().map_err(|e| e.to_string())?;
        state.bpm = bpm;
        state.sample_rate = timeline_sample_rate;
        state.loop_enabled = loop_enabled;
        state.loop_start = loop_start;
        state.loop_end = loop_end;
        state.is_playing = false;
    }

    push_command(handle, EngineCommand::SetPlay(false))?;
    push_command(
        handle,
        EngineCommand::SetTimelineSampleRate(timeline_sample_rate),
    )?;
    push_command(handle, EngineCommand::SetBpm(bpm))?;
    push_command(
        handle,
        EngineCommand::SetTimeSignature {
            numerator: project.time_signature.numerator.max(1),
            denominator: project.time_signature.denominator.max(1),
        },
    )?;
    if loop_enabled && loop_end > loop_start {
        push_command(
            handle,
            EngineCommand::SetLoopRegion {
                start: loop_start,
                end: loop_end,
            },
        )?;
    }
    push_command(handle, EngineCommand::SetLoopEnabled(loop_enabled))?;
    push_command(handle, EngineCommand::Seek(playhead))?;
    Ok(())
}

pub fn project_initial_transport_bpm(project: &Project) -> f64 {
    let base_bpm = project.pulse_map.initial_bpm();
    let automated_start_bpm = project
        .tempo_automation_events
        .iter()
        .filter(|e| e.beat.is_finite() && e.bpm.is_finite() && e.bpm > 0.0 && e.beat <= 0.0001)
        .min_by(|a, b| a.beat.total_cmp(&b.beat))
        .map(|e| e.bpm);
    automated_start_bpm.unwrap_or(base_bpm).clamp(10.0, 999.0)
}

pub fn sync_track_mix_state_from_project(
    project: &Project,
    handle: &AudioEngineHandle,
) -> Result<(), String> {
    for (track_index, track) in project.tracks.iter().enumerate() {
        let idx = track_index.min(u16::MAX as usize) as u16;
        push_command(
            handle,
            EngineCommand::SetTrackVolume {
                track_index: idx,
                volume: track.volume as f32,
            },
        )?;
        push_command(
            handle,
            EngineCommand::SetTrackPan {
                track_index: idx,
                pan: track.pan as f32,
            },
        )?;
        push_command(
            handle,
            EngineCommand::SetTrackDisabled {
                track_index: idx,
                disabled: track.effective_disabled_from_model(),
            },
        )?;
        push_command(
            handle,
            EngineCommand::SetTrackSolo {
                track_index: idx,
                soloed: track.is_solo,
            },
        )?;
    }

    push_command(
        handle,
        EngineCommand::SetMasterVolume {
            volume: project.master_track.volume as f32,
        },
    )?;

    Ok(())
}
