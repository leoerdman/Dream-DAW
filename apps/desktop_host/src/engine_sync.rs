// ═══════════════════════════════════════════════════════════════════════════
// Engine Sync — Project → Audio Engine State Reconciliation
// ═══════════════════════════════════════════════════════════════════════════
//
// This file contains all functions that synchronise the project data model
// to the real-time audio engine state:
//
//   - refresh_offline_flags        — marks clips whose files are missing
//   - rebuild_automation_snapshot  — pushes automation lane data to the engine
//   - rebuild_midi_snapshot        — pushes MIDI clip data to the engine
//   - rebuild_sampler_snapshot     — pushes sampler/wave-synth settings
//   - rebuild_runtime_device_chains — rebuilds internal effect slot topology
//   - sync_transport_from_project  — syncs BPM, loop, playhead
//   - sync_track_mix_state         — syncs volume/pan/mute/solo per track
//
// Included into lib.rs via `include!("engine_sync.rs")`.
// Inherits the full `use` scope of lib.rs — no separate imports needed.
// ═══════════════════════════════════════════════════════════════════════════

/// BUG-009 FIX: Cache seen file paths to avoid redundant `Path::exists()` syscalls.
/// With 100 clips sharing 10 unique files, this reduces I/O from 100 to 10 calls.
fn refresh_offline_flags(project: &mut Project) {
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

fn rebuild_automation_snapshot_from_project(
    project: &Project,
    automation_runtime: &AutomationRuntime,
) {
    fn normalize_pan_value(raw: f32) -> f32 {
        // Track pan in the project/import model is bipolar [-1..1].
        // Treating [0..1] as a separate domain is ambiguous and maps 0.0
        // (center in many projects) to -1.0 (hard-left), which collapses
        // stereo image after ALS import.
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

fn rebuild_midi_snapshot_from_project(project: &Project, handle: &AudioEngineHandle) {
    fn sanitize_runtime_clip(mut clip: MidiClip) -> MidiClip {
        // Canonicalize notes for deterministic scheduling and guard against
        // accidental duplicate note entries produced by rapid editor edits.
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

    fn first_lane_value(track: &Track, keys: &[&str], default: f32) -> f32 {
        for key in keys {
            if let Some(lane) = track
                .automation_lanes
                .iter()
                .find(|lane| lane.param_id.eq_ignore_ascii_case(key))
                && let Some(point) = lane.points.first()
            {
                return point.value as f32;
            }
        }
        default
    }

    let tracks: Vec<MidiTrackRuntime> = project
        .tracks
        .iter()
        .map(|track| {
            let has_pitch = track.effects.iter().any(|fx| {
                fx.plugin_id()
                    .eq_ignore_ascii_case("internal://midi-fx/pitch")
            });
            let has_scale = track.effects.iter().any(|fx| {
                fx.plugin_id()
                    .eq_ignore_ascii_case("internal://midi-fx/scale")
            });
            let has_velocity = track.effects.iter().any(|fx| {
                fx.plugin_id()
                    .eq_ignore_ascii_case("internal://midi-fx/velocity")
            });
            let has_random = track.effects.iter().any(|fx| {
                fx.plugin_id()
                    .eq_ignore_ascii_case("internal://midi-fx/random")
            });

            let fx = MidiFxRuntimeConfig {
                pitch_enabled: has_pitch,
                pitch_semitones: first_lane_value(
                    track,
                    &["midi.pitch.semitones", "midifx.pitch.semitones"],
                    0.0,
                )
                .round()
                .clamp(-48.0, 48.0) as i8,
                scale_enabled: has_scale,
                scale_root: first_lane_value(track, &["midi.scale.root", "midifx.scale.root"], 0.0)
                    .round()
                    .rem_euclid(12.0) as u8,
                scale_mask: first_lane_value(
                    track,
                    &["midi.scale.mask", "midifx.scale.mask"],
                    4095.0,
                )
                .round()
                .clamp(1.0, 4095.0) as u16,
                velocity_enabled: has_velocity,
                velocity_gain: first_lane_value(
                    track,
                    &["midi.velocity.gain", "midifx.velocity.gain"],
                    1.0,
                )
                .clamp(0.0, 4.0),
                velocity_offset: first_lane_value(
                    track,
                    &["midi.velocity.offset", "midifx.velocity.offset"],
                    0.0,
                )
                .round()
                .clamp(-127.0, 127.0) as i8,
                random_enabled: has_random,
                random_semitones: first_lane_value(
                    track,
                    &["midi.random.semitones", "midifx.random.semitones"],
                    0.0,
                )
                .round()
                .clamp(-24.0, 24.0) as i8,
                random_chance: first_lane_value(
                    track,
                    &["midi.random.chance", "midifx.random.chance"],
                    1.0,
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

fn rebuild_sampler_snapshot_from_project(
    project: &Project,
    clip_pool_state: &ClipPoolState,
    handle: &AudioEngineHandle,
) {
    fn waveform_code_from_token(token: &str) -> u8 {
        let normalized = token.trim().to_lowercase();
        if normalized.contains("triangle") || normalized.ends_with("/tri") {
            return 1;
        }
        if normalized.contains("saw") {
            return 2;
        }
        if normalized.contains("square") || normalized.ends_with("/pulse") {
            return 3;
        }
        0
    }

    let mut samples: Vec<Option<Arc<ClipAudio>>> = vec![None; project.tracks.len()];
    let empty_pad_samples: [Option<Arc<ClipAudio>>; 16] = Default::default();
    let mut rack_samples: Vec<[Option<Arc<ClipAudio>>; 16]> =
        vec![empty_pad_samples; project.tracks.len()];

    struct RackSettings {
        track_idx: u16,
        pad_idx: u8,
        volume: f32,
        attack: f32,
        decay: f32,
        sustain: f32,
        release: f32,
        filter_cutoff: f32,
    }
    let mut rack_settings: Vec<RackSettings> = Vec::new();

    let mut synth_settings: Vec<(
        usize,
        u8,
        u8,
        f32,
        f32,
        f32,
        f32,
        f32,
        u8,
        f32,
        f32,
        u8,
        f32,
    )> = Vec::new();
    if let Ok(pool) = clip_pool_state.pool.lock() {
        for (idx, track) in project.tracks.iter().enumerate() {
            let plugin_id_lower = track
                .instrument
                .as_ref()
                .map(|inst| inst.plugin_id().to_lowercase())
                .unwrap_or_default();
            let is_wave_synth = plugin_id_lower.starts_with("internal://instrument/wave-synth")
                || plugin_id_lower.starts_with("internal://instrument/simple-sine-synth");
            if is_wave_synth {
                let (
                    waveform,
                    osc2,
                    mix,
                    detune,
                    sub,
                    f_cutoff,
                    f_res,
                    f_type,
                    lfo_r,
                    lfo_d,
                    lfo_t,
                    pw,
                ) = track
                    .sampler
                    .as_ref()
                    .map(|cfg| {
                        (
                            waveform_code_from_token(&cfg.sample_path),
                            cfg.osc2_waveform.min(3),
                            cfg.osc_mix.clamp(0.0, 1.0) as f32,
                            cfg.detune_cents.clamp(-50.0, 50.0) as f32,
                            cfg.sub_level.clamp(0.0, 1.0) as f32,
                            cfg.filter_cutoff.clamp(20.0, 20000.0) as f32,
                            cfg.filter_resonance.clamp(0.0, 0.99) as f32,
                            cfg.filter_type.min(3),
                            cfg.lfo_rate.clamp(0.01, 20.0) as f32,
                            cfg.lfo_depth.clamp(0.0, 1.0) as f32,
                            cfg.lfo_target.min(2),
                            cfg.pulse_width.clamp(0.05, 0.95) as f32,
                        )
                    })
                    .unwrap_or((0, 0, 0.35, 0.0, 0.0, 20000.0, 0.0, 0, 1.0, 0.0, 0, 0.5));
                synth_settings.push((
                    idx, waveform, osc2, mix, detune, sub, f_cutoff, f_res, f_type, lfo_r, lfo_d,
                    lfo_t, pw,
                ));
            }
            if let Some(cfg) = &track.sampler
                && !cfg.sample_path.trim().is_empty()
                && !cfg.sample_path.starts_with("internal://")
                && let Some(audio) = pool.get(&cfg.sample_path)
            {
                samples[idx] = Some(audio);
            }

            if let Some(rack) = &track.sample_rack {
                for (p, pad) in rack.pads.iter().enumerate() {
                    rack_settings.push(RackSettings {
                        track_idx: idx as u16,
                        pad_idx: p as u8,
                        volume: pad.volume as f32,
                        attack: pad.attack as f32,
                        decay: pad.decay as f32,
                        sustain: pad.sustain as f32,
                        release: pad.release as f32,
                        filter_cutoff: pad.filter_cutoff as f32,
                    });
                    if !pad.sample_path.trim().is_empty()
                        && let Some(audio) = pool.get(&pad.sample_path)
                    {
                        rack_samples[idx][p] = Some(audio);
                    }
                }
            }
        }
    }
    handle.sampler_samples.swap(samples);
    handle.sample_rack_samples.swap(rack_samples);

    for (
        track_idx,
        waveform,
        osc2,
        mix,
        detune,
        sub,
        f_cutoff,
        f_res,
        f_type,
        lfo_r,
        lfo_d,
        lfo_t,
        pw,
    ) in synth_settings
    {
        if let Err(err) = push_command(
            handle,
            EngineCommand::SetSamplerWaveform {
                track_index: track_idx as u16,
                waveform,
            },
        ) {
            log::warn!(
                "[Sampler] Failed to restore waveform for track {}: {}",
                track_idx,
                err
            );
        }
        // BUG-063 FIX: Use push_command_or_log! instead of `let _ =` to ensure
        // queue-full conditions are visible in logs during sampler state restore.
        push_command_or_log!(
            handle,
            EngineCommand::SetSamplerOsc2Waveform {
                track_index: track_idx as u16,
                waveform: osc2,
            },
            "sampler osc2 waveform"
        );
        push_command_or_log!(
            handle,
            EngineCommand::SetSamplerOscMix {
                track_index: track_idx as u16,
                mix,
            },
            "sampler osc mix"
        );
        push_command_or_log!(
            handle,
            EngineCommand::SetSamplerDetuneCents {
                track_index: track_idx as u16,
                cents: detune,
            },
            "sampler detune"
        );
        push_command_or_log!(
            handle,
            EngineCommand::SetSamplerSubLevel {
                track_index: track_idx as u16,
                level: sub,
            },
            "sampler sub level"
        );
        push_command_or_log!(
            handle,
            EngineCommand::SetSamplerFilterCutoff {
                track_index: track_idx as u16,
                cutoff: f_cutoff,
            },
            "sampler filter cutoff"
        );
        push_command_or_log!(
            handle,
            EngineCommand::SetSamplerFilterResonance {
                track_index: track_idx as u16,
                resonance: f_res,
            },
            "sampler filter resonance"
        );
        push_command_or_log!(
            handle,
            EngineCommand::SetSamplerFilterType {
                track_index: track_idx as u16,
                filter_type: f_type,
            },
            "sampler filter type"
        );
        push_command_or_log!(
            handle,
            EngineCommand::SetSamplerLfoRate {
                track_index: track_idx as u16,
                rate: lfo_r,
            },
            "sampler lfo rate"
        );
        push_command_or_log!(
            handle,
            EngineCommand::SetSamplerLfoDepth {
                track_index: track_idx as u16,
                depth: lfo_d,
            },
            "sampler lfo depth"
        );
        push_command_or_log!(
            handle,
            EngineCommand::SetSamplerLfoTarget {
                track_index: track_idx as u16,
                target: lfo_t,
            },
            "sampler lfo target"
        );
        push_command_or_log!(
            handle,
            EngineCommand::SetSamplerPulseWidth {
                track_index: track_idx as u16,
                width: pw,
            },
            "sampler pulse width"
        );
    }

    for rs in rack_settings {
        push_command_or_log!(
            handle,
            EngineCommand::SetSampleRackPadVolume {
                track_index: rs.track_idx,
                pad_index: rs.pad_idx,
                volume: rs.volume,
            },
            "rack pad volume"
        );

        push_command_or_log!(
            handle,
            EngineCommand::SetSampleRackPadAdsr {
                track_index: rs.track_idx,
                pad_index: rs.pad_idx,
                attack: rs.attack,
                decay: rs.decay,
                sustain: rs.sustain,
                release: rs.release,
            },
            "rack pad adsr"
        );

        push_command_or_log!(
            handle,
            EngineCommand::SetSampleRackPadFilterCutoff {
                track_index: rs.track_idx,
                pad_index: rs.pad_idx,
                cutoff: rs.filter_cutoff,
            },
            "rack pad cutoff"
        );
    }
}

fn builtin_effect_type_from_plugin_id(plugin_id: &str) -> Option<u8> {
    dream_models::project::builtin_effect_type_from_plugin_id(plugin_id)
}

fn rebuild_runtime_device_chains_from_project(
    project: &Project,
    handle: &AudioEngineHandle,
) -> Result<(), String> {
    const MAX_DEVICE_SLOTS: u8 = 16;
    fn first_lane_value(track: &Track, keys: &[&str]) -> Option<f32> {
        for key in keys {
            if let Some(lane) = track
                .automation_lanes
                .iter()
                .find(|lane| lane.param_id.eq_ignore_ascii_case(key))
                && let Some(point) = lane.points.first()
            {
                return Some(point.value as f32);
            }
        }
        None
    }

    fn apply_static_imported_params_for_slot(
        handle: &AudioEngineHandle,
        track_index: u16,
        slot_index: u8,
        plugin_id: &str,
        track: &Track,
    ) -> Result<(), String> {
        let pid = plugin_id.to_ascii_lowercase();

        // UtilityProcessor params:
        // 0 gain dB, 1 pan %, 2 width %, 3 mono
        if pid == "internal://effect/utility" {
            if let Some(gain_lin) = first_lane_value(track, &["plugin.gain"]) {
                let gain_db = if gain_lin <= 0.00001 {
                    -60.0
                } else {
                    (20.0 * gain_lin.log10()).clamp(-60.0, 24.0)
                };
                push_command(
                    handle,
                    EngineCommand::SetDeviceParam {
                        track_index,
                        slot_index,
                        param_index: 0,
                        value: gain_db,
                    },
                )?;
            }
            if let Some(pan) = first_lane_value(track, &["plugin.pan"]) {
                push_command(
                    handle,
                    EngineCommand::SetDeviceParam {
                        track_index,
                        slot_index,
                        param_index: 1,
                        value: (pan * 100.0).clamp(-100.0, 100.0),
                    },
                )?;
            }
            if let Some(width) = first_lane_value(track, &["plugin.width"]) {
                push_command(
                    handle,
                    EngineCommand::SetDeviceParam {
                        track_index,
                        slot_index,
                        param_index: 2,
                        value: width.clamp(0.0, 200.0),
                    },
                )?;
            }
            if let Some(mono) = first_lane_value(track, &["plugin.mono"]) {
                push_command(
                    handle,
                    EngineCommand::SetDeviceParam {
                        track_index,
                        slot_index,
                        param_index: 3,
                        value: if mono >= 0.5 { 1.0 } else { 0.0 },
                    },
                )?;
            }
            return Ok(());
        }

        // EqProcessor param 32 = output gain dB.
        if pid == "internal://effect/eq-eight" {
            if let Some(out_gain) = first_lane_value(track, &["effect.eq.global_gain"]) {
                push_command(
                    handle,
                    EngineCommand::SetDeviceParam {
                        track_index,
                        slot_index,
                        param_index: 32,
                        value: out_gain.clamp(-24.0, 24.0),
                    },
                )?;
            }
            for band in 0..8u8 {
                if let Some(v) = first_lane_value(track, &[&format!("effect.eq.band{band}.freq")]) {
                    push_command(
                        handle,
                        EngineCommand::SetDeviceParam {
                            track_index,
                            slot_index,
                            param_index: band * 4,
                            value: v.clamp(20.0, 20_000.0),
                        },
                    )?;
                }
                if let Some(v) = first_lane_value(track, &[&format!("effect.eq.band{band}.gain")]) {
                    push_command(
                        handle,
                        EngineCommand::SetDeviceParam {
                            track_index,
                            slot_index,
                            param_index: band * 4 + 1,
                            value: v.clamp(-24.0, 24.0),
                        },
                    )?;
                }
                if let Some(v) = first_lane_value(track, &[&format!("effect.eq.band{band}.q")]) {
                    push_command(
                        handle,
                        EngineCommand::SetDeviceParam {
                            track_index,
                            slot_index,
                            param_index: band * 4 + 2,
                            value: v.clamp(0.1, 18.0),
                        },
                    )?;
                }
                if let Some(v) = first_lane_value(track, &[&format!("effect.eq.band{band}.on")]) {
                    push_command(
                        handle,
                        EngineCommand::SetDeviceParam {
                            track_index,
                            slot_index,
                            param_index: band * 4 + 3,
                            value: if v >= 0.5 { 1.0 } else { 0.0 },
                        },
                    )?;
                }
            }
            return Ok(());
        }

        // AutoFilterProcessor:
        // 0 cutoff, 1 resonance %, 5 filter type, 8 drive dB.
        if pid == "internal://effect/auto-filter" {
            if let Some(cutoff) = first_lane_value(track, &["effect.auto_filter.cutoff"]) {
                push_command(
                    handle,
                    EngineCommand::SetDeviceParam {
                        track_index,
                        slot_index,
                        param_index: 0,
                        value: cutoff.clamp(20.0, 20_000.0),
                    },
                )?;
            }
            if let Some(res) = first_lane_value(track, &["effect.auto_filter.resonance"]) {
                push_command(
                    handle,
                    EngineCommand::SetDeviceParam {
                        track_index,
                        slot_index,
                        param_index: 1,
                        value: (res * 100.0).clamp(0.0, 100.0),
                    },
                )?;
            }
            if let Some(ft) = first_lane_value(track, &["effect.auto_filter.type"]) {
                push_command(
                    handle,
                    EngineCommand::SetDeviceParam {
                        track_index,
                        slot_index,
                        param_index: 5,
                        value: ft.round().clamp(0.0, 3.0),
                    },
                )?;
            }
            if let Some(drive) = first_lane_value(track, &["effect.auto_filter.drive"]) {
                push_command(
                    handle,
                    EngineCommand::SetDeviceParam {
                        track_index,
                        slot_index,
                        param_index: 8,
                        value: drive.clamp(0.0, 24.0),
                    },
                )?;
            }
            if let Some(v) = first_lane_value(track, &["effect.auto_filter.lfo.rate"]) {
                push_command(
                    handle,
                    EngineCommand::SetDeviceParam {
                        track_index,
                        slot_index,
                        param_index: 2,
                        value: v.clamp(0.01, 20.0),
                    },
                )?;
            }
            if let Some(v) = first_lane_value(track, &["effect.auto_filter.lfo.depth"]) {
                push_command(
                    handle,
                    EngineCommand::SetDeviceParam {
                        track_index,
                        slot_index,
                        param_index: 3,
                        value: (v * 100.0).clamp(0.0, 100.0),
                    },
                )?;
            }
            if let Some(v) = first_lane_value(track, &["effect.auto_filter.env.amount"]) {
                push_command(
                    handle,
                    EngineCommand::SetDeviceParam {
                        track_index,
                        slot_index,
                        param_index: 4,
                        value: (v * 100.0).clamp(-100.0, 100.0),
                    },
                )?;
            }
            if let Some(v) = first_lane_value(track, &["effect.auto_filter.mix"]) {
                push_command(
                    handle,
                    EngineCommand::SetDeviceParam {
                        track_index,
                        slot_index,
                        param_index: 6,
                        value: (v * 100.0).clamp(0.0, 100.0),
                    },
                )?;
            }
            if let Some(v) = first_lane_value(track, &["effect.auto_filter.lfo.shape"]) {
                push_command(
                    handle,
                    EngineCommand::SetDeviceParam {
                        track_index,
                        slot_index,
                        param_index: 7,
                        value: v.round().clamp(0.0, 5.0),
                    },
                )?;
            }
            if let Some(v) = first_lane_value(track, &["effect.auto_filter.env.speed_ms"]) {
                push_command(
                    handle,
                    EngineCommand::SetDeviceParam {
                        track_index,
                        slot_index,
                        param_index: 9,
                        value: v.clamp(1.0, 200.0),
                    },
                )?;
            }
            return Ok(());
        }

        // CompressorProcessor:
        // 0 threshold, 1 ratio, 2 attack, 3 release, 4 knee, 5 makeup, 6 mix%.
        if pid == "internal://effect/compressor" {
            if let Some(v) = first_lane_value(track, &["effect.compressor.threshold"]) {
                push_command(
                    handle,
                    EngineCommand::SetDeviceParam {
                        track_index,
                        slot_index,
                        param_index: 0,
                        value: v.clamp(-60.0, 0.0),
                    },
                )?;
            }
            if let Some(v) = first_lane_value(track, &["effect.compressor.ratio"]) {
                push_command(
                    handle,
                    EngineCommand::SetDeviceParam {
                        track_index,
                        slot_index,
                        param_index: 1,
                        value: v.clamp(1.0, 20.0),
                    },
                )?;
            }
            if let Some(v) = first_lane_value(track, &["effect.compressor.attack"]) {
                push_command(
                    handle,
                    EngineCommand::SetDeviceParam {
                        track_index,
                        slot_index,
                        param_index: 2,
                        value: v.clamp(0.1, 100.0),
                    },
                )?;
            }
            if let Some(v) = first_lane_value(track, &["effect.compressor.release"]) {
                push_command(
                    handle,
                    EngineCommand::SetDeviceParam {
                        track_index,
                        slot_index,
                        param_index: 3,
                        value: v.clamp(10.0, 1000.0),
                    },
                )?;
            }
            if let Some(v) = first_lane_value(track, &["effect.compressor.knee"]) {
                push_command(
                    handle,
                    EngineCommand::SetDeviceParam {
                        track_index,
                        slot_index,
                        param_index: 4,
                        value: v.clamp(0.0, 24.0),
                    },
                )?;
            }
            if let Some(v) = first_lane_value(track, &["effect.compressor.makeup"]) {
                push_command(
                    handle,
                    EngineCommand::SetDeviceParam {
                        track_index,
                        slot_index,
                        param_index: 5,
                        value: v.clamp(-12.0, 24.0),
                    },
                )?;
            }
            if let Some(v) = first_lane_value(track, &["effect.compressor.mix"]) {
                push_command(
                    handle,
                    EngineCommand::SetDeviceParam {
                        track_index,
                        slot_index,
                        param_index: 6,
                        value: (v * 100.0).clamp(0.0, 100.0),
                    },
                )?;
            }
            return Ok(());
        }

        // ReverbProcessor:
        // 0 size%, 1 damping%, 2 mix%, 3 predelay ms, 4 width%, 5 low_damp%.
        if pid == "internal://effect/reverb" {
            if let Some(v) = first_lane_value(track, &["effect.reverb.size"]) {
                push_command(
                    handle,
                    EngineCommand::SetDeviceParam {
                        track_index,
                        slot_index,
                        param_index: 0,
                        value: (v * 100.0).clamp(0.0, 100.0),
                    },
                )?;
            }
            if let Some(v) = first_lane_value(track, &["effect.reverb.damping"]) {
                push_command(
                    handle,
                    EngineCommand::SetDeviceParam {
                        track_index,
                        slot_index,
                        param_index: 1,
                        value: (v * 100.0).clamp(0.0, 100.0),
                    },
                )?;
            }
            if let Some(v) = first_lane_value(track, &["effect.reverb.mix"]) {
                push_command(
                    handle,
                    EngineCommand::SetDeviceParam {
                        track_index,
                        slot_index,
                        param_index: 2,
                        value: (v * 100.0).clamp(0.0, 100.0),
                    },
                )?;
            }
            if let Some(v) = first_lane_value(track, &["effect.reverb.predelay"]) {
                push_command(
                    handle,
                    EngineCommand::SetDeviceParam {
                        track_index,
                        slot_index,
                        param_index: 3,
                        value: v.clamp(0.0, 200.0),
                    },
                )?;
            }
            if let Some(v) = first_lane_value(track, &["effect.reverb.width"]) {
                push_command(
                    handle,
                    EngineCommand::SetDeviceParam {
                        track_index,
                        slot_index,
                        param_index: 4,
                        value: (v * 100.0).clamp(0.0, 100.0),
                    },
                )?;
            }
            if let Some(v) = first_lane_value(track, &["effect.reverb.low_damp"]) {
                push_command(
                    handle,
                    EngineCommand::SetDeviceParam {
                        track_index,
                        slot_index,
                        param_index: 5,
                        value: (v * 100.0).clamp(0.0, 100.0),
                    },
                )?;
            }
            return Ok(());
        }

        // DelayProcessor:
        // 0 time L ms, 1 time R ms, 2 feedback%, 3 mix%.
        if pid == "internal://effect/delay" {
            if let Some(v) = first_lane_value(track, &["effect.delay.time"]) {
                let ms = v.clamp(1.0, 2000.0);
                push_command(
                    handle,
                    EngineCommand::SetDeviceParam {
                        track_index,
                        slot_index,
                        param_index: 0,
                        value: ms,
                    },
                )?;
                push_command(
                    handle,
                    EngineCommand::SetDeviceParam {
                        track_index,
                        slot_index,
                        param_index: 1,
                        value: ms,
                    },
                )?;
            }
            if let Some(v) = first_lane_value(track, &["effect.delay.feedback"]) {
                push_command(
                    handle,
                    EngineCommand::SetDeviceParam {
                        track_index,
                        slot_index,
                        param_index: 2,
                        value: (v * 100.0).clamp(0.0, 95.0),
                    },
                )?;
            }
            if let Some(v) = first_lane_value(track, &["effect.delay.mix"]) {
                push_command(
                    handle,
                    EngineCommand::SetDeviceParam {
                        track_index,
                        slot_index,
                        param_index: 3,
                        value: (v * 100.0).clamp(0.0, 100.0),
                    },
                )?;
            }
            return Ok(());
        }

        Ok(())
    }

    fn selected_runtime_chain(
        rack: &dream_models::project::DeviceRack,
    ) -> Option<&dream_models::project::RackChain> {
        let has_solo = rack.chains.iter().any(|c| c.is_solo);
        if has_solo {
            rack.chains.iter().find(|c| c.is_solo && !c.is_mute)
        } else {
            rack.chains.iter().find(|c| !c.is_mute)
        }
    }

    fn collect_runtime_internal_effects(
        nodes: &[DeviceNode],
        parent_bypassed: bool,
        out: &mut Vec<(String, bool)>,
    ) {
        for node in nodes {
            match node {
                DeviceNode::Single(slot) => {
                    if slot.plugin_id.starts_with("internal://") {
                        out.push((slot.plugin_id.clone(), parent_bypassed || slot.is_bypassed));
                    }
                }
                DeviceNode::Rack(rack) => {
                    let rack_bypassed = parent_bypassed || rack.is_bypassed;
                    // Runtime chain in dream_dsp is currently serial.
                    // For rack nodes (parallel topology), choose one audible chain
                    // deterministically and use the same strategy everywhere.
                    if let Some(chain) = selected_runtime_chain(rack) {
                        collect_runtime_internal_effects(&chain.devices, rack_bypassed, out);
                    }
                }
            }
        }
    }

    // Reset current runtime chains for known tracks/slots.
    for track_index in 0..project.tracks.len() {
        let track_index = track_index as u16;
        for slot_index in 0..MAX_DEVICE_SLOTS {
            push_command(
                handle,
                EngineCommand::RemoveDevice {
                    track_index,
                    slot_index,
                },
            )?;
        }
    }

    // Rebuild from persisted internal effect slots.
    for (track_index, track) in project.tracks.iter().enumerate() {
        let mut internal_effects: Vec<(String, bool)> = Vec::new();
        collect_runtime_internal_effects(&track.effects, false, &mut internal_effects);
        if internal_effects.len() > MAX_DEVICE_SLOTS as usize {
            log::warn!(
                "[RuntimeChain] track '{}' has {} internal effects; truncating to {} slots",
                track.name,
                internal_effects.len(),
                MAX_DEVICE_SLOTS
            );
        }
        for (slot_index, (plugin_id, bypassed)) in internal_effects
            .into_iter()
            .take(MAX_DEVICE_SLOTS as usize)
            .enumerate()
        {
            if let Some(effect_type) = builtin_effect_type_from_plugin_id(&plugin_id) {
                push_command(
                    handle,
                    EngineCommand::AddDevice {
                        track_index: track_index as u16,
                        slot_index: slot_index.min(u8::MAX as usize) as u8,
                        effect_type,
                    },
                )?;
                if bypassed {
                    push_command(
                        handle,
                        EngineCommand::BypassDevice {
                            track_index: track_index as u16,
                            slot_index: slot_index.min(u8::MAX as usize) as u8,
                            bypassed: true,
                        },
                    )?;
                }
                apply_static_imported_params_for_slot(
                    handle,
                    track_index as u16,
                    slot_index.min(u8::MAX as usize) as u8,
                    &plugin_id,
                    track,
                )?;
            }
        }
    }

    // ── Master track internal FX (CRITICAL FIX) ────────────────────────
    // The master track's internal effects (EQ, compressor, etc.) were never
    // sent to the engine because this function only iterated project.tracks.
    // Use MASTER_TRACK_INDEX (u16::MAX) as the track_index sentinel value
    // so the driver routes these commands to master_device_chain.
    {
        const MASTER_TRACK_INDEX: u16 = u16::MAX;
        let master = &project.master_track;

        // Collect internal effects with their params for startup sync
        struct MasterFxEntry {
            plugin_id: String,
            bypassed: bool,
            params: Option<Vec<f32>>,
        }
        fn collect_master_internal_effects(
            node: &DeviceNode,
            parent_bypassed: bool,
            out: &mut Vec<MasterFxEntry>,
        ) {
            match node {
                DeviceNode::Single(slot) => {
                    if slot.plugin_id.starts_with("internal://effect/") {
                        out.push(MasterFxEntry {
                            plugin_id: slot.plugin_id.clone(),
                            bypassed: parent_bypassed || slot.is_bypassed,
                            params: slot.params.clone(),
                        });
                    }
                }
                DeviceNode::Rack(rack) => {
                    let rack_bypassed = parent_bypassed || rack.is_bypassed;
                    if let Some(chain) = selected_runtime_chain(rack) {
                        for child in &chain.devices {
                            collect_master_internal_effects(child, rack_bypassed, out);
                        }
                    }
                }
            }
        }

        let mut master_internal_effects: Vec<MasterFxEntry> = Vec::new();
        for node in &master.effects {
            collect_master_internal_effects(node, false, &mut master_internal_effects);
        }

        for (slot_index, entry) in master_internal_effects
            .into_iter()
            .take(MAX_DEVICE_SLOTS as usize)
            .enumerate()
        {
            if let Some(effect_type) = builtin_effect_type_from_plugin_id(&entry.plugin_id) {
                push_command(
                    handle,
                    EngineCommand::AddDevice {
                        track_index: MASTER_TRACK_INDEX,
                        slot_index: slot_index.min(u8::MAX as usize) as u8,
                        effect_type,
                    },
                )?;
                if entry.bypassed {
                    push_command(
                        handle,
                        EngineCommand::BypassDevice {
                            track_index: MASTER_TRACK_INDEX,
                            slot_index: slot_index.min(u8::MAX as usize) as u8,
                            bypassed: true,
                        },
                    )?;
                }
                // BUG-R4 FIX: Sync stored params to engine at startup.
                // Without this, master EQ always starts with flat/default
                // settings regardless of what the user configured.
                if let Some(ref params) = entry.params {
                    for (param_idx, &value) in params.iter().enumerate() {
                        if value != 0.0 || param_idx < 33 {
                            // Always sync EQ bands (0..32) + output gain (32)
                            push_command(
                                handle,
                                EngineCommand::SetDeviceParam {
                                    track_index: MASTER_TRACK_INDEX,
                                    slot_index: slot_index.min(u8::MAX as usize) as u8,
                                    param_index: param_idx.min(u8::MAX as usize) as u8,
                                    value,
                                },
                            )?;
                        }
                    }
                }
            }
        }
    }

    Ok(())
}

fn sync_transport_from_project(
    project: &Project,
    handle: &AudioEngineHandle,
) -> Result<(), String> {
    let bpm = project_initial_transport_bpm(project);
    let timeline_sample_rate = project.sample_rate.max(1.0);
    let loop_enabled = project.is_looping;
    let loop_start = project.loop_start_frames.unwrap_or(0);
    let loop_end = project.loop_end_frames.unwrap_or(0);
    let playhead = project.playhead_position_frames.max(0);

    // Keep UI mirror state in sync.
    {
        let mut state = handle.playback_state.lock().map_err(|e| e.to_string())?;
        state.bpm = bpm;
        state.sample_rate = timeline_sample_rate;
        state.loop_enabled = loop_enabled;
        state.loop_start = loop_start;
        state.loop_end = loop_end;
        // Project load/new always starts from stopped transport.
        state.is_playing = false;
    }

    // Keep realtime transport in sync.
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

fn project_initial_transport_bpm(project: &Project) -> f64 {
    let base_bpm = project.pulse_map.initial_bpm();
    let automated_start_bpm = project
        .tempo_automation_events
        .iter()
        .filter(|e| e.beat.is_finite() && e.bpm.is_finite() && e.bpm > 0.0 && e.beat <= 0.0001)
        .min_by(|a, b| a.beat.total_cmp(&b.beat))
        .map(|e| e.bpm);
    automated_start_bpm.unwrap_or(base_bpm).clamp(10.0, 999.0)
}

pub(crate) fn sync_track_mix_state_from_project(
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
            EngineCommand::SetTrackMute {
                track_index: idx,
                muted: track.effective_mute_from_model(),
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
