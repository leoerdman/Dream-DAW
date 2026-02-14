// ═══════════════════════════════════════════════════════════════════════

/// Open plugin native GUI window.
///
/// Current implementation delegates lifecycle to the backend plugin host.
/// If host-side windowing is not wired yet, this call is a no-op with logging.
#[tauri::command]
fn open_plugin_window(
    plugin_id: String,
    plugin_host_state: tauri::State<'_, PluginHostState>,
) -> Result<(), String> {
    if let Some(instance_id) = plugin_host_state
        .loaded_by_key
        .lock()
        .map_err(|e| e.to_string())?
        .get(&plugin_id)
        .copied()
    {
        let mut host = plugin_host_state.host.lock().map_err(|e| e.to_string())?;
        host.open_editor(instance_id)
            .map_err(|e| format!("Failed to open existing plugin editor: {e}"))?;
        log::info!("[IPC] open_plugin_window({plugin_id}) -> reuse instance {instance_id}");
        return Ok(());
    }

    let descriptor = plugin_host_state.resolve_descriptor(&plugin_id)?;
    let mut host = plugin_host_state.host.lock().map_err(|e| e.to_string())?;
    let instance_id = host
        .load_vst3(descriptor.clone())
        .map_err(|e| format!("Failed to load plugin '{}': {e}", descriptor.name))?;
    if let Err(err) = host.open_editor(instance_id) {
        // Roll back loaded instance on editor-open failure to avoid leaked/ghost instances.
        let _ = host.remove(instance_id);
        return Err(format!("Plugin loaded but editor failed to open: {err}"));
    }
    drop(host);

    plugin_host_state
        .loaded_by_key
        .lock()
        .map_err(|e| e.to_string())?
        .insert(plugin_id.clone(), instance_id);

    log::info!(
        "[IPC] open_plugin_window({plugin_id}) -> loaded VST instance {} ({})",
        instance_id,
        descriptor.path.display()
    );
    Ok(())
}

#[tauri::command]
fn can_open_plugin_editor(
    plugin_id: String,
    plugin_host_state: tauri::State<'_, PluginHostState>,
) -> Result<PluginEditorCapability, String> {
    if let Some(instance_id) = plugin_host_state
        .loaded_by_key
        .lock()
        .map_err(|e| e.to_string())?
        .get(&plugin_id)
        .copied()
    {
        let mut host = plugin_host_state.host.lock().map_err(|e| e.to_string())?;
        let supported = host
            .supports_editor(instance_id)
            .map_err(|e| format!("Failed to check editor capability: {e}"))?;
        return Ok(PluginEditorCapability {
            supported,
            reason: if supported {
                None
            } else {
                Some("Native plugin editor host bridge is not implemented yet for this instance.".to_string())
            },
        });
    }

    let descriptor = plugin_host_state.resolve_descriptor(&plugin_id)?;
    if descriptor.format != PluginFormat::VST3 {
        let reason = match descriptor.format {
            PluginFormat::VST3 => None,
            PluginFormat::CLAP => Some("CLAP plugin editor is not supported by this host build.".to_string()),
            PluginFormat::AudioUnit => Some("AudioUnit editor is not supported by this host build.".to_string()),
        };
        return Ok(PluginEditorCapability {
            supported: false,
            reason,
        });
    }

    // Probe capability by loading the plugin and querying the live instance.
    // The probe instance is removed immediately to avoid changing chain state.
    let mut host = plugin_host_state.host.lock().map_err(|e| e.to_string())?;
    let probe_id = host
        .load_vst3(descriptor.clone())
        .map_err(|e| format!("Failed to load plugin '{}': {e}", descriptor.name))?;
    let supported = host
        .supports_editor(probe_id)
        .map_err(|e| format!("Failed to check editor capability: {e}"))?;
    let _ = host.remove(probe_id);

    Ok(PluginEditorCapability {
        supported,
        reason: if supported {
            None
        } else {
            Some("Plugin does not expose a host-openable editor in this build.".to_string())
        },
    })
}

/// Close plugin native GUI window.
#[tauri::command]
fn close_plugin_window(
    plugin_id: String,
    plugin_host_state: tauri::State<'_, PluginHostState>,
) -> Result<(), String> {
    let maybe_instance = plugin_host_state
        .loaded_by_key
        .lock()
        .map_err(|e| e.to_string())?
        .remove(&plugin_id);

    if let Some(instance_id) = maybe_instance {
        let mut host = plugin_host_state.host.lock().map_err(|e| e.to_string())?;
        if let Err(err) = host.close_editor(instance_id) {
            log::warn!(
                "[IPC] close_plugin_window({plugin_id}) editor close failed for {instance_id}: {err}"
            );
        }
        host.remove(instance_id)
            .map_err(|e| format!("Failed to unload plugin instance {instance_id}: {e}"))?;
        log::info!("[IPC] close_plugin_window({plugin_id}) -> removed instance {instance_id}");
    } else {
        log::info!("[IPC] close_plugin_window({plugin_id}) -> no loaded instance");
    }
    Ok(())
}

/// Unified frontend error logger (ErrorBoundary -> backend log).
#[tauri::command]
fn log_frontend_error(module: String, error: String, stack: Option<String>) -> Result<(), String> {
    if let Some(stack_trace) = stack {
        log::error!("[FrontendError] module={} error={} stack={}", module, error, stack_trace);
    } else {
        log::error!("[FrontendError] module={} error={}", module, error);
    }
    Ok(())
}

/// Return valid routing targets for a track.
#[tauri::command]
fn get_routing_targets(
    track_id: String,
    project_state: tauri::State<'_, ProjectState>,
) -> Result<Vec<RoutingTarget>, String> {
    let source_id = Uuid::parse_str(&track_id).map_err(|_| format!("Invalid track_id: {track_id}"))?;
    let project = project_state.project.lock().map_err(|e| e.to_string())?;

    let mut targets = Vec::new();
    for t in &project.tracks {
        if t.id == source_id {
            continue;
        }
        targets.push(RoutingTarget {
            track_id: t.id.to_string(),
            track_name: t.name.clone(),
            track_type: format!("{:?}", t.track_type),
        });
    }
    Ok(targets)
}

/// Set output routing destination for a track.
///
/// `target_id` can be another track UUID or "master" to route directly
/// to the master bus. The project model is updated atomically.
#[tauri::command]
fn set_track_routing_cmd(
    track_id: String,
    target_id: String,
    project_state: tauri::State<'_, ProjectState>,
    clip_pool_state: tauri::State<'_, ClipPoolState>,
) -> Result<(), String> {
    let source_id = Uuid::parse_str(&track_id).map_err(|_| format!("Invalid track_id: {track_id}"))?;
    let destination = if target_id == "master" {
        None
    } else {
        Some(Uuid::parse_str(&target_id).map_err(|_| format!("Invalid target_id: {target_id}"))?)
    };

    push_undo(&project_state)?;
    let mut project = project_state.project.lock().map_err(|e| e.to_string())?;

    if let Some(dest_id) = destination {
        let dest_exists = project.tracks.iter().any(|t| t.id == dest_id);
        if !dest_exists {
            return Err(format!("Routing target not found: {target_id}"));
        }
    }

    let track = project
        .tracks
        .iter_mut()
        .find(|t| t.id == source_id)
        .ok_or_else(|| format!("Track not found: {track_id}"))?;
    track.output_destination_id = destination;

    *project_state.is_dirty.lock().map_err(|e| e.to_string())? = true;
    clip_pool_state.rebuild_snapshot(&project);
    log::info!("[IPC] set_track_routing_cmd({track_id} -> {target_id})");
    Ok(())
}

/// Set track audio input source (placeholder hook for sidechain/input matrix).
#[tauri::command]
fn set_track_input_cmd(track_id: String, input_id: String) -> Result<(), String> {
    log::info!("[IPC] set_track_input_cmd({track_id} <- {input_id})");
    Ok(())
}

/// Add a plugin slot to a track (instrument/effect) from frontend DnD.
#[tauri::command]
fn add_plugin_to_track_cmd(
    payload: AddPluginToTrackPayload,
    project_state: tauri::State<'_, ProjectState>,
    clip_pool_state: tauri::State<'_, ClipPoolState>,
    handle: tauri::State<'_, AudioEngineHandle>,
) -> Result<(), String> {
    fn canonical_internal_plugin(plugin_id: &str, plugin_name: &str) -> Option<(&'static str, &'static str, &'static str)> {
        let merged = format!("{} {}", plugin_id, plugin_name).to_lowercase();
        let compact = merged.replace(|c: char| !c.is_ascii_alphanumeric(), "");

        // Instruments
        if merged.contains("operator")
            || merged.contains("analog")
            || merged.contains("wavetable")
            || compact.contains("simplesinesynth")
            || merged.contains("wave synth")
            || compact.contains("wavesynth")
        {
            return Some(("internal://instrument/wave-synth", "Wave Synth", "instrument"));
        }
        if merged.contains("sampler") || merged.contains("simpler") {
            return Some(("internal://instrument/sampler", "Sampler", "instrument"));
        }

        // Effects
        if merged.contains("eq eight") || merged.contains("eq eight") || merged.contains("eq3") || merged.contains("eq three") || merged.contains("channel eq") {
            return Some(("internal://effect/eq-eight", "EQ Eight", "effect"));
        }
        if merged.contains("glue compressor") || merged.contains("multiband dynamics") {
            return Some(("internal://effect/compressor", "Compressor", "effect"));
        }
        if merged.contains("simple delay") || merged.contains("ping pong delay") || merged.contains("echo") {
            return Some(("internal://effect/delay", "Delay", "effect"));
        }
        if merged.contains("hybrid reverb") {
            return Some(("internal://effect/reverb", "Reverb", "effect"));
        }
        if merged.contains("chorus-ensemble") || merged.contains("chorus ensemble") {
            return Some(("internal://effect/chorus", "Chorus", "effect"));
        }
        if merged.contains("auto filter") || merged.contains("autofilter") {
            return Some(("internal://effect/auto-filter", "Auto Filter", "effect"));
        }
        if merged.contains("auto pan") || merged.contains("autopan") {
            return Some(("internal://effect/auto-pan", "Auto Pan", "effect"));
        }
        if merged.contains("midipitcher") || merged.contains("midi pitch") {
            return Some(("internal://midi-fx/pitch", "MIDI Pitch", "effect"));
        }
        if merged.contains("mxdevicescale") || merged.contains("midi scale") {
            return Some(("internal://midi-fx/scale", "MIDI Scale", "effect"));
        }
        if merged.contains("mxdevicevelocity") || merged.contains("midi velocity") {
            return Some(("internal://midi-fx/velocity", "MIDI Velocity", "effect"));
        }
        if merged.contains("mxdevicerandom") || merged.contains("midi random") {
            return Some(("internal://midi-fx/random", "MIDI Random", "effect"));
        }
        if merged.contains("spectrum") {
            return Some(("internal://effect/spectrum", "Spectrum", "effect"));
        }
        if merged.contains("phaser-flanger") || merged.contains("phaser flanger") {
            return Some(("internal://effect/phaser", "Phaser", "effect"));
        }
        if merged.contains("redux") {
            return Some(("internal://effect/bitcrusher", "Bitcrusher", "effect"));
        }
        if merged.contains("overdrive") || merged.contains("pedal") || merged.contains("cabinet") || merged.contains("amp") {
            return Some(("internal://effect/distortion", "Distortion", "effect"));
        }

        None
    }

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

    fn builtin_effect_type_from_plugin_id(plugin_id: &str) -> Option<u8> {
        // Must match dream_dsp::dsp_processor::BuiltinEffectType discriminants.
        const FX_EQ: u8 = 0;
        const FX_COMPRESSOR: u8 = 1;
        const FX_DELAY: u8 = 2;
        const FX_REVERB: u8 = 3;
        const FX_CHORUS: u8 = 4;
        const FX_UTILITY: u8 = 5;
        const FX_SATURATOR: u8 = 6;
        const FX_LIMITER: u8 = 7;
        const FX_GATE: u8 = 8;
        const FX_AUTO_FILTER: u8 = 9;
        const FX_PHASER: u8 = 10;
        const FX_FLANGER: u8 = 11;
        const FX_DISTORTION: u8 = 12;
        const FX_BITCRUSHER: u8 = 13;
        const FX_NOISE_MACHINE: u8 = 14;
        const FX_AUTO_PAN: u8 = 15;

        let key = plugin_id.to_lowercase();

        // ── Exact internal:// prefix matches (highest priority) ──────
        if key.starts_with("internal://effect/") {
            return match key.as_str() {
                "internal://effect/eq-eight" => Some(FX_EQ),
                "internal://effect/compressor" => Some(FX_COMPRESSOR),
                "internal://effect/delay" => Some(FX_DELAY),
                "internal://effect/reverb" => Some(FX_REVERB),
                "internal://effect/chorus" => Some(FX_CHORUS),
                "internal://effect/utility" => Some(FX_UTILITY),
                "internal://effect/saturator" => Some(FX_SATURATOR),
                "internal://effect/limiter" => Some(FX_LIMITER),
                "internal://effect/gate" => Some(FX_GATE),
                "internal://effect/auto-filter" => Some(FX_AUTO_FILTER),
                "internal://effect/phaser" => Some(FX_PHASER),
                "internal://effect/flanger" => Some(FX_FLANGER),
                "internal://effect/distortion" => Some(FX_DISTORTION),
                "internal://effect/bitcrusher" => Some(FX_BITCRUSHER),
                "internal://effect/noise-machine" => Some(FX_NOISE_MACHINE),
                "internal://effect/auto-pan" => Some(FX_AUTO_PAN),
                _ => None,
            };
        }

        // ── Keyword fallbacks (Ableton device names, aliases) ────────
        if key.contains("eq eight") || key.contains("eq8") || key.contains("eq3") || key.contains("channel eq") || key.contains("eq") {
            return Some(FX_EQ);
        }
        if key.contains("compressor") || key.contains("glue") || key.contains("multiband dynamics") {
            return Some(FX_COMPRESSOR);
        }
        if key.contains("delay") || key.contains("echo") || key.contains("ping pong") {
            return Some(FX_DELAY);
        }
        if key.contains("reverb") || key.contains("hybrid reverb") {
            return Some(FX_REVERB);
        }
        if key.contains("chorus") || key.contains("chorus-ensemble") {
            return Some(FX_CHORUS);
        }
        if key.contains("saturator") {
            return Some(FX_SATURATOR);
        }
        if key.contains("limiter") {
            return Some(FX_LIMITER);
        }
        if key.contains("auto-filter") || key.contains("autofilter") || key.contains("auto filter") {
            return Some(FX_AUTO_FILTER);
        }
        if key.contains("auto-pan") || key.contains("autopan") || key.contains("auto pan") {
            return Some(FX_AUTO_PAN);
        }
        if key.contains("noise-machine") || key.contains("noisemachine") || key.contains("noise machine") {
            return Some(FX_NOISE_MACHINE);
        }
        if key.contains("phaser") || key.contains("phaser-flanger") {
            return Some(FX_PHASER);
        }
        if key.contains("flanger") {
            return Some(FX_FLANGER);
        }
        if key.contains("distortion") || key.contains("overdrive") || key.contains("pedal") || key.contains("cabinet") || key.contains("amp") {
            return Some(FX_DISTORTION);
        }
        if key.contains("bitcrusher") || key.contains("bit-crusher") || key.contains("redux") {
            return Some(FX_BITCRUSHER);
        }
        if key.contains("utility") {
            return Some(FX_UTILITY);
        }
        if key.contains("gate") {
            return Some(FX_GATE);
        }
        None
    }

    let track_uuid = Uuid::parse_str(&payload.track_id)
        .map_err(|_| format!("Invalid track_id: {}", payload.track_id))?;

    push_undo(&project_state)?;
    let mut project = project_state.project.lock().map_err(|e| e.to_string())?;
    let track = project
        .tracks
        .iter_mut()
        .find(|t| t.id == track_uuid)
        .ok_or_else(|| format!("Track not found: {}", payload.track_id))?;

    let slot = payload.slot.to_lowercase();
    let canonical = canonical_internal_plugin(&payload.plugin_id, &payload.plugin_name);
    let effective_plugin_id = canonical.map(|v| v.0.to_string()).unwrap_or_else(|| payload.plugin_id.clone());
    let effective_plugin_name = canonical.map(|v| v.1.to_string()).unwrap_or_else(|| payload.plugin_name.clone());
    let canonical_slot_hint = canonical.map(|v| v.2);
    let use_instrument = match slot.as_str() {
        "instrument" => true,
        "effect" => false,
        "auto" => canonical_slot_hint == Some("instrument")
            || (track.track_type == TrackType::Midi && track.instrument.is_none()),
        _ => track.track_type == TrackType::Midi && track.instrument.is_none(),
    };

    let plugin_id_lower = effective_plugin_id.to_lowercase();
    let is_sampler_instrument = plugin_id_lower.starts_with("internal://instrument/sampler");
    let is_wave_synth_instrument = plugin_id_lower.starts_with("internal://instrument/wave-synth")
        || plugin_id_lower.starts_with("internal://instrument/simple-sine-synth");
    let plugin_slot = PluginSlot::new(effective_plugin_name.clone(), effective_plugin_id.clone());
    let mut runtime_add: Option<(Uuid, u8, u8)> = None;
    let mut runtime_waveform: Option<(Uuid, u8)> = None;
    if use_instrument {
        track.instrument = Some(plugin_slot);
        if (is_sampler_instrument || is_wave_synth_instrument) && track.sampler.is_none() {
            track.sampler = Some(SamplerConfig::default());
        }
        if is_wave_synth_instrument {
            let cfg = track.sampler.get_or_insert_with(SamplerConfig::default);
            if cfg.sample_path.trim().is_empty() {
                cfg.sample_path = "internal://waveform/sine".to_string();
            }
            runtime_waveform = Some((track.id, waveform_code_from_token(&cfg.sample_path)));
        }
    } else {
        track.effects.push(plugin_slot);
        if effective_plugin_id.starts_with("internal://")
            && let Some(effect_type) = builtin_effect_type_from_plugin_id(&effective_plugin_id)
        {
            let slot_index = (track.effects.len().saturating_sub(1)).min(u8::MAX as usize) as u8;
            runtime_add = Some((track.id, slot_index, effect_type));
        }
    }

    *project_state.is_dirty.lock().map_err(|e| e.to_string())? = true;
    clip_pool_state.rebuild_snapshot(&project);
    if let Some((track_id, slot_index, effect_type)) = runtime_add {
        // Map project UUID track ordering to runtime track index.
        if let Some(runtime_track_index) = project.tracks.iter().position(|t| t.id == track_id) {
            push_command(&handle, EngineCommand::AddDevice {
                track_index: runtime_track_index as u16,
                slot_index,
                effect_type,
            })?;
        }
    }
    if let Some((track_id, waveform)) = runtime_waveform {
        if let Some(runtime_track_index) = project.tracks.iter().position(|t| t.id == track_id) {
            push_command(&handle, EngineCommand::SetSamplerWaveform {
                track_index: runtime_track_index as u16,
                waveform,
            })?;
        }
    }
    log::info!(
        "[IPC] add_plugin_to_track_cmd(track={}, plugin='{}', slot={})",
        payload.track_id,
        effective_plugin_name,
        if use_instrument { "instrument" } else { "effect" }
    );
    Ok(())
}

/// Remove a plugin slot from a track (instrument/effect) by slot UUID.
#[tauri::command]
fn remove_plugin_from_track_cmd(
    payload: RemovePluginFromTrackPayload,
    project_state: tauri::State<'_, ProjectState>,
    clip_pool_state: tauri::State<'_, ClipPoolState>,
    handle: tauri::State<'_, AudioEngineHandle>,
) -> Result<(), String> {
    let track_uuid = Uuid::parse_str(&payload.track_id)
        .map_err(|_| format!("Invalid track_id: {}", payload.track_id))?;
    let slot_uuid = Uuid::parse_str(&payload.slot_id)
        .map_err(|_| format!("Invalid slot_id: {}", payload.slot_id))?;

    push_undo(&project_state)?;
    let mut project = project_state.project.lock().map_err(|e| e.to_string())?;
    let track = project
        .tracks
        .iter_mut()
        .find(|t| t.id == track_uuid)
        .ok_or_else(|| format!("Track not found: {}", payload.track_id))?;

    let mut removed = false;
    let mut runtime_remove_slot: Option<u8> = None;
    if let Some(inst) = &track.instrument
        && inst.id == slot_uuid
    {
        let removed_plugin_id = inst.plugin_id.clone();
        track.instrument = None;
        let removed_lower = removed_plugin_id.to_lowercase();
        if removed_lower.starts_with("internal://instrument/sampler")
            || removed_lower.starts_with("internal://instrument/wave-synth")
            || removed_lower.starts_with("internal://instrument/simple-sine-synth")
        {
            track.sampler = None;
        }
        removed = true;
    }

    if !removed {
        if let Some(effect_idx) = track.effects.iter().position(|slot| slot.id == slot_uuid) {
            runtime_remove_slot = Some(effect_idx.min(u8::MAX as usize) as u8);
            track.effects.remove(effect_idx);
            removed = true;
        }
    }

    if !removed {
        return Err(format!(
            "Plugin slot not found on track {}: {}",
            payload.track_id, payload.slot_id
        ));
    }

    *project_state.is_dirty.lock().map_err(|e| e.to_string())? = true;
    clip_pool_state.rebuild_snapshot(&project);
    if let Some(slot_index) = runtime_remove_slot
        && let Some(runtime_track_index) = project.tracks.iter().position(|t| t.id == track_uuid)
    {
        push_command(&handle, EngineCommand::RemoveDevice {
            track_index: runtime_track_index as u16,
            slot_index,
        })?;
    }
    log::info!(
        "[IPC] remove_plugin_from_track_cmd(track={}, slot={})",
        payload.track_id,
        payload.slot_id
    );
    Ok(())
}

fn upsert_static_automation_lane(track: &mut Track, param_id: &str, value: f64) {
    if let Some(existing) = track
        .automation_lanes
        .iter_mut()
        .find(|lane| lane.param_id.eq_ignore_ascii_case(param_id))
    {
        existing.points = vec![dream_models::project::AutomationPoint {
            beat: 0.0,
            value,
            curve_type: "linear".to_string(),
            tension: None,
        }];
        existing.param_id = param_id.to_string();
        return;
    }

    track.automation_lanes.push(dream_models::project::AutomationLane {
        param_id: param_id.to_string(),
        points: vec![dream_models::project::AutomationPoint {
            beat: 0.0,
            value,
            curve_type: "linear".to_string(),
            tension: None,
        }],
    });
}

/// Set internal plugin parameter value and route to engine state/snapshots.
#[tauri::command]
fn set_internal_plugin_param_cmd(
    payload: InternalPluginParamPayload,
    project_state: tauri::State<'_, ProjectState>,
    clip_pool_state: tauri::State<'_, ClipPoolState>,
    automation_runtime: tauri::State<'_, AutomationRuntime>,
    handle: tauri::State<'_, AudioEngineHandle>,
) -> Result<(), String> {
    fn waveform_token_and_code(value: f64) -> (&'static str, u8) {
        let idx = value.round().clamp(0.0, 3.0) as u8;
        match idx {
            1 => ("internal://waveform/triangle", 1),
            2 => ("internal://waveform/saw", 2),
            3 => ("internal://waveform/square", 3),
            _ => ("internal://waveform/sine", 0),
        }
    }

    let track_uuid = Uuid::parse_str(&payload.track_id)
        .map_err(|_| format!("Invalid track_id: {}", payload.track_id))?;
    push_undo(&project_state)?;
    let mut project = project_state.project.lock().map_err(|e| e.to_string())?;
    let key = payload.param_id.to_lowercase();
    let mut sampler_command_needed = false;
    let mut sampler_waveform: Option<u8> = None;
    let mut sampler_waveform2: Option<u8> = None;
    let mut sampler_osc_mix: Option<f32> = None;
    let mut sampler_detune_cents: Option<f32> = None;
    let mut sampler_sub_level: Option<f32> = None;
    let mut sampler_filter_cutoff: Option<f32> = None;
    let mut sampler_filter_resonance: Option<f32> = None;
    let mut sampler_filter_type: Option<u8> = None;
    let mut sampler_lfo_rate: Option<f32> = None;
    let mut sampler_lfo_depth: Option<f32> = None;
    let mut sampler_lfo_target: Option<u8> = None;
    let mut sampler_pulse_width: Option<f32> = None;
    let (track_index, sampler_cfg_for_rt) = {
        let (idx, track) = project
            .tracks
            .iter_mut()
            .enumerate()
            .find(|(_, t)| t.id == track_uuid)
            .ok_or_else(|| format!("Track not found: {}", payload.track_id))?;

        match key.as_str() {
            // Utility gain in dB => plugin.gain in linear 0..2
            "gain" | "utility.gain" | "plugin.gain" => {
                let linear = 10.0_f64.powf(payload.value.clamp(-60.0, 12.0) / 20.0).clamp(0.0, 2.0);
                upsert_static_automation_lane(track, "plugin.gain", linear);
            }
            // Utility pan in -100..100 or -1..1 => plugin.pan in -1..1
            "pan" | "utility.pan" | "plugin.pan" => {
                let pan = if payload.value.abs() > 1.0 {
                    (payload.value / 100.0).clamp(-1.0, 1.0)
                } else {
                    payload.value.clamp(-1.0, 1.0)
                };
                upsert_static_automation_lane(track, "plugin.pan", pan);
            }
            "width" | "utility.width" | "plugin.width" => {
                upsert_static_automation_lane(track, "plugin.width", payload.value.clamp(0.0, 200.0));
            }
            "mono" | "utility.mono" | "plugin.mono" => {
                upsert_static_automation_lane(track, "plugin.mono", if payload.value >= 0.5 { 1.0 } else { 0.0 });
            }
            // Sampler parameters
            "sampler.volume" | "volume" => {
                let cfg = track.sampler.get_or_insert_with(SamplerConfig::default);
                cfg.volume = payload.value.clamp(0.0, 2.0);
                sampler_command_needed = true;
            }
            "sampler.attack" | "attack" => {
                let cfg = track.sampler.get_or_insert_with(SamplerConfig::default);
                cfg.attack = payload.value.clamp(0.001, 10.0);
                sampler_command_needed = true;
            }
            "sampler.decay" | "decay" => {
                let cfg = track.sampler.get_or_insert_with(SamplerConfig::default);
                cfg.decay = payload.value.clamp(0.001, 10.0);
                sampler_command_needed = true;
            }
            "sampler.sustain" | "sustain" => {
                let cfg = track.sampler.get_or_insert_with(SamplerConfig::default);
                cfg.sustain = payload.value.clamp(0.0, 1.0);
                sampler_command_needed = true;
            }
            "sampler.release" | "release" => {
                let cfg = track.sampler.get_or_insert_with(SamplerConfig::default);
                cfg.release = payload.value.clamp(0.001, 20.0);
                sampler_command_needed = true;
            }
            "sampler.rootnote" | "rootnote" | "sampler.root_note" => {
                let cfg = track.sampler.get_or_insert_with(SamplerConfig::default);
                cfg.root_note = payload.value.round().clamp(0.0, 127.0) as u8;
                sampler_command_needed = true;
            }
            "synth.waveform" | "waveform" | "sampler.waveform" => {
                let cfg = track.sampler.get_or_insert_with(SamplerConfig::default);
                let (token, code) = waveform_token_and_code(payload.value);
                cfg.sample_path = token.to_string();
                sampler_waveform = Some(code);
            }
            "synth.osc1.waveform" | "synth.osc1.wave" => {
                let cfg = track.sampler.get_or_insert_with(SamplerConfig::default);
                let (token, code) = waveform_token_and_code(payload.value);
                cfg.sample_path = token.to_string();
                sampler_waveform = Some(code);
            }
            "synth.osc2.waveform" | "synth.osc2.wave" => {
                let cfg = track.sampler.get_or_insert_with(SamplerConfig::default);
                let (_, code) = waveform_token_and_code(payload.value);
                cfg.osc2_waveform = code;
                sampler_waveform2 = Some(code);
            }
            "synth.osc.mix" | "synth.oscmix" => {
                let cfg = track.sampler.get_or_insert_with(SamplerConfig::default);
                let mix = payload.value.clamp(0.0, 1.0) as f32;
                cfg.osc_mix = mix as f64;
                sampler_osc_mix = Some(mix);
            }
            "synth.detune" | "synth.detunecents" | "synth.osc2.detune" => {
                let cfg = track.sampler.get_or_insert_with(SamplerConfig::default);
                let cents = payload.value.clamp(-50.0, 50.0) as f32;
                cfg.detune_cents = cents as f64;
                sampler_detune_cents = Some(cents);
            }
            "synth.sub" | "synth.sublevel" => {
                let cfg = track.sampler.get_or_insert_with(SamplerConfig::default);
                let level = payload.value.clamp(0.0, 1.0) as f32;
                cfg.sub_level = level as f64;
                sampler_sub_level = Some(level);
            }
            "synth.filter.cutoff" | "synth.filtercutoff" => {
                let cfg = track.sampler.get_or_insert_with(SamplerConfig::default);
                let cutoff = payload.value.clamp(20.0, 20000.0) as f32;
                cfg.filter_cutoff = cutoff as f64;
                sampler_filter_cutoff = Some(cutoff);
            }
            "synth.filter.resonance" | "synth.filterresonance" | "synth.filter.res" => {
                let cfg = track.sampler.get_or_insert_with(SamplerConfig::default);
                let res = payload.value.clamp(0.0, 0.99) as f32;
                cfg.filter_resonance = res as f64;
                sampler_filter_resonance = Some(res);
            }
            "synth.filter.type" | "synth.filtertype" => {
                let cfg = track.sampler.get_or_insert_with(SamplerConfig::default);
                let ft = payload.value.round().clamp(0.0, 3.0) as u8;
                cfg.filter_type = ft;
                sampler_filter_type = Some(ft);
            }
            "synth.lfo.rate" | "synth.lforate" => {
                let cfg = track.sampler.get_or_insert_with(SamplerConfig::default);
                let rate = payload.value.clamp(0.01, 20.0) as f32;
                cfg.lfo_rate = rate as f64;
                sampler_lfo_rate = Some(rate);
            }
            "synth.lfo.depth" | "synth.lfodepth" => {
                let cfg = track.sampler.get_or_insert_with(SamplerConfig::default);
                let depth = payload.value.clamp(0.0, 1.0) as f32;
                cfg.lfo_depth = depth as f64;
                sampler_lfo_depth = Some(depth);
            }
            "synth.lfo.target" | "synth.lfotarget" => {
                let cfg = track.sampler.get_or_insert_with(SamplerConfig::default);
                let target = payload.value.round().clamp(0.0, 2.0) as u8;
                cfg.lfo_target = target;
                sampler_lfo_target = Some(target);
            }
            "synth.pulse_width" | "synth.pulsewidth" | "synth.pw" => {
                let cfg = track.sampler.get_or_insert_with(SamplerConfig::default);
                let pw = payload.value.clamp(0.05, 0.95) as f32;
                cfg.pulse_width = pw as f64;
                sampler_pulse_width = Some(pw);
            }
            _ => {
                // Keep unknown params round-trippable in automation lanes.
                upsert_static_automation_lane(track, &payload.param_id, payload.value);
            }
        }

        if sampler_command_needed {
            (idx, track.sampler.clone())
        } else {
            (idx, None)
        }
    };

    *project_state.is_dirty.lock().map_err(|e| e.to_string())? = true;
    clip_pool_state.rebuild_snapshot(&project);
    rebuild_automation_snapshot_from_project(&project, &automation_runtime);
    rebuild_sampler_snapshot_from_project(&project, &clip_pool_state, &handle);

    if sampler_command_needed
        && let Some(cfg) = &sampler_cfg_for_rt
    {
        let idx = track_index as u16;
        push_command(&handle, EngineCommand::SetSamplerRootNote {
            track_index: idx,
            root_note: cfg.root_note,
        })?;
        push_command(&handle, EngineCommand::SetSamplerVolume {
            track_index: idx,
            volume: cfg.volume as f32,
        })?;
        push_command(&handle, EngineCommand::SetSamplerAdsr {
            track_index: idx,
            attack: cfg.attack as f32,
            decay: cfg.decay as f32,
            sustain: cfg.sustain as f32,
            release: cfg.release as f32,
        })?;
    }
    if let Some(waveform) = sampler_waveform {
        push_command(&handle, EngineCommand::SetSamplerWaveform {
            track_index: track_index as u16,
            waveform,
        })?;
    }
    if let Some(waveform) = sampler_waveform2 {
        push_command(&handle, EngineCommand::SetSamplerOsc2Waveform {
            track_index: track_index as u16,
            waveform,
        })?;
    }
    if let Some(mix) = sampler_osc_mix {
        push_command(&handle, EngineCommand::SetSamplerOscMix {
            track_index: track_index as u16,
            mix,
        })?;
    }
    if let Some(cents) = sampler_detune_cents {
        push_command(&handle, EngineCommand::SetSamplerDetuneCents {
            track_index: track_index as u16,
            cents,
        })?;
    }
    if let Some(level) = sampler_sub_level {
        push_command(&handle, EngineCommand::SetSamplerSubLevel {
            track_index: track_index as u16,
            level,
        })?;
    }
    if let Some(cutoff) = sampler_filter_cutoff {
        push_command(&handle, EngineCommand::SetSamplerFilterCutoff {
            track_index: track_index as u16,
            cutoff,
        })?;
    }
    if let Some(resonance) = sampler_filter_resonance {
        push_command(&handle, EngineCommand::SetSamplerFilterResonance {
            track_index: track_index as u16,
            resonance,
        })?;
    }
    if let Some(filter_type) = sampler_filter_type {
        push_command(&handle, EngineCommand::SetSamplerFilterType {
            track_index: track_index as u16,
            filter_type,
        })?;
    }
    if let Some(rate) = sampler_lfo_rate {
        push_command(&handle, EngineCommand::SetSamplerLfoRate {
            track_index: track_index as u16,
            rate,
        })?;
    }
    if let Some(depth) = sampler_lfo_depth {
        push_command(&handle, EngineCommand::SetSamplerLfoDepth {
            track_index: track_index as u16,
            depth,
        })?;
    }
    if let Some(target) = sampler_lfo_target {
        push_command(&handle, EngineCommand::SetSamplerLfoTarget {
            track_index: track_index as u16,
            target,
        })?;
    }
    if let Some(width) = sampler_pulse_width {
        push_command(&handle, EngineCommand::SetSamplerPulseWidth {
            track_index: track_index as u16,
            width,
        })?;
    }

    log::debug!(
        "[IPC] set_internal_plugin_param_cmd(track={}, slot={}, param={} value={})",
        payload.track_id,
        payload.slot_id,
        payload.param_id,
        payload.value
    );
    Ok(())
}

/// Assign sample file to a track sampler and stream it to the realtime engine.
#[tauri::command]
fn set_sampler_sample_cmd(
    payload: SetSamplerSamplePayload,
    project_state: tauri::State<'_, ProjectState>,
    clip_pool_state: tauri::State<'_, ClipPoolState>,
    handle: tauri::State<'_, AudioEngineHandle>,
) -> Result<(), String> {
    let track_uuid = Uuid::parse_str(&payload.track_id)
        .map_err(|_| format!("Invalid track_id: {}", payload.track_id))?;
    let sample_path = payload.sample_path.clone();
    if !PathBuf::from(&sample_path).exists() {
        return Err(format!("Sample path does not exist: {}", sample_path));
    }

    let decoded = AudioReader::read(PathBuf::from(&sample_path))
        .map_err(|e| format!("Failed to decode sample: {e}"))?;
    let clip_audio = ClipAudio::new(sample_path.clone(), decoded.channels, decoded.sample_rate);

    let sample_arc = {
        let mut pool = clip_pool_state.pool.lock().map_err(|e| e.to_string())?;
        pool.insert(clip_audio);
        pool.get(&sample_path)
            .ok_or_else(|| "Failed to cache decoded sampler sample".to_string())?
    };
    clip_pool_state.sync_pool_to_arc();

    push_undo(&project_state)?;
    let mut project = project_state.project.lock().map_err(|e| e.to_string())?;
    let (track_index, sampler_cfg) = {
        let (idx, track) = project
            .tracks
            .iter_mut()
            .enumerate()
            .find(|(_, t)| t.id == track_uuid)
            .ok_or_else(|| format!("Track not found: {}", payload.track_id))?;

        let cfg = track.sampler.get_or_insert_with(SamplerConfig::default);
        cfg.sample_path = sample_path.clone();
        if let Some(root) = payload.root_note {
            cfg.root_note = root.min(127);
        }
        (idx, cfg.clone())
    };

    *project_state.is_dirty.lock().map_err(|e| e.to_string())? = true;
    clip_pool_state.rebuild_snapshot(&project);
    handle
        .sampler_samples
        .set_track_sample(track_index, Some(sample_arc));

    let idx = track_index as u16;
    push_command(&handle, EngineCommand::SetSamplerRootNote {
        track_index: idx,
        root_note: sampler_cfg.root_note,
    })?;
    push_command(&handle, EngineCommand::SetSamplerVolume {
        track_index: idx,
        volume: sampler_cfg.volume as f32,
    })?;
    push_command(&handle, EngineCommand::SetSamplerAdsr {
        track_index: idx,
        attack: sampler_cfg.attack as f32,
        decay: sampler_cfg.decay as f32,
        sustain: sampler_cfg.sustain as f32,
        release: sampler_cfg.release as f32,
    })?;
    push_command(&handle, EngineCommand::SetSamplerOsc2Waveform {
        track_index: idx,
        waveform: sampler_cfg.osc2_waveform.min(3),
    })?;
    push_command(&handle, EngineCommand::SetSamplerOscMix {
        track_index: idx,
        mix: sampler_cfg.osc_mix.clamp(0.0, 1.0) as f32,
    })?;
    push_command(&handle, EngineCommand::SetSamplerDetuneCents {
        track_index: idx,
        cents: sampler_cfg.detune_cents.clamp(-50.0, 50.0) as f32,
    })?;
    push_command(&handle, EngineCommand::SetSamplerSubLevel {
        track_index: idx,
        level: sampler_cfg.sub_level.clamp(0.0, 1.0) as f32,
    })?;
    push_command(&handle, EngineCommand::SetSamplerFilterCutoff {
        track_index: idx,
        cutoff: sampler_cfg.filter_cutoff.clamp(20.0, 20000.0) as f32,
    })?;
    push_command(&handle, EngineCommand::SetSamplerFilterResonance {
        track_index: idx,
        resonance: sampler_cfg.filter_resonance.clamp(0.0, 0.99) as f32,
    })?;
    push_command(&handle, EngineCommand::SetSamplerFilterType {
        track_index: idx,
        filter_type: sampler_cfg.filter_type.min(3),
    })?;

    log::info!(
        "[IPC] set_sampler_sample_cmd(track={}, path={})",
        payload.track_id,
        sample_path
    );
    Ok(())
}
