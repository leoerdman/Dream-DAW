// ═══════════════════════════════════════════════════════════════════════
use std::path::{Path, PathBuf};
use dream_importers::ableton::plugin_mapper::{
    infer_device_display_name as infer_device_display_name_from_importer,
    normalize_internal_plugins_for_import,
    make_missing_plugin_slot,
    normalize_plugin_key,
    ExternalPluginIndex,
};
#[cfg(test)]
use dream_importers::ableton::plugin_mapper::ExternalPluginMeta;
use dream_importers::ableton::device_import::import_track_devices;
use dream_importers::ableton::device_params::{
    upsert_static_import_lane_if_missing,
};
use dream_importers::ableton::markers::{
    parse_project_markers as parse_project_markers_from_importer,
    parse_project_scenes as parse_project_scenes_from_importer,
};
use dream_importers::ableton::parser::{
    apply_live_set_project_metadata as apply_live_set_project_metadata_from_importer,
    apply_live_set_timeline_and_signature_metadata as apply_live_set_timeline_and_signature_metadata_from_importer,
    find_live_set as find_live_set_from_importer,
    parse_als_document as parse_als_document_from_importer,
    parse_imported_sample_rate as parse_imported_sample_rate_from_importer,
    parse_main_tempo as parse_main_tempo_from_importer,
    parse_project_name as parse_project_name_from_importer,
    read_als_xml_text as read_als_xml_text_from_importer,
    resolve_timeline_sample_rate as resolve_timeline_sample_rate_from_importer,
};

use dream_importers::ableton::automation::{
    build_pointee_map_with as build_pointee_map_with_importer,
    build_main_track_mixer_snapshot,
    consolidate_automation_lanes as consolidate_automation_lanes_from_importer,
    import_track_automation_with as import_track_automation_with_importer,
};
use dream_importers::ableton::color_map::{
    ableton_color_index_to_hex,
    ableton_color_to_track_color,
    extract_ableton_color_index,
};
use dream_importers::ableton::routing::{
    choose_preferred_output_target,
    classify_output_routing_target,
    collapse_split_stereo_pan,
    normalize_input_routing_target,
    parse_output_target,
    OutputRoutingTarget,
};

use dream_importers::ableton::xml_helpers::{
    maybe_parse_bool_manual,
    maybe_parse_f64_manual,
    node_child_value,
    parse_bool_value,
    parse_i64_value,
    parse_track_bool_flag_legacy as parse_track_bool_flag,
    parse_track_i64_value_legacy as parse_track_i64_value,
    parse_track_key_note_target_legacy as parse_track_key_note_target,
    parse_track_send_manual_values,
};

#[cfg(test)]
use dream_importers::ableton::clip_parser::parse_clip_grid;
#[cfg(test)]
use dream_importers::ableton::automation::plugin_param_lane_key_with as plugin_param_lane_key_with_importer;
#[cfg(test)]
use dream_importers::ableton::xml_helpers::{
    first_child_bool, first_child_f64, first_child_i32, first_child_value, parse_live_set_bool,
    parse_live_set_i32, parse_root_midi_editor_lanes, parse_view_states_bool,
};

fn parse_project_markers(
    live_set: roxmltree::Node<'_, '_>,
) -> Vec<dream_models::project::ProjectMarker> {
    parse_project_markers_from_importer(live_set)
}

fn parse_project_scenes(
    live_set: roxmltree::Node<'_, '_>,
) -> Vec<dream_models::project::ProjectScene> {
    parse_project_scenes_from_importer(live_set)
}

// Functions extracted to dream_importers::ableton::device_parser:
// make_missing_plugin_slot, make_missing_external_plugin_slot_with_metadata,
// ExternalPluginMeta, parse_external_plugin_meta, apply_external_plugin_meta,
// ExternalPluginIndex, normalize_plugin_key, encode_missing_meta

#[cfg(test)]
mod project_management_als_import_tests;


// ═══════════════════════════════════════════════════════════════════════
// Production functions extracted to core/dream_importers/src/ableton/:
//   • infer_device_display_name          → plugin_mapper.rs
//   • import_track_clips                 → track_import.rs
//   • resolve_overlapping_audio/midi     → track_import.rs
//   • upsert_static_import_lane[_if_missing] → device_params.rs
//   • PendingMacroMapping + parse_als_rack*  → rack_parser.rs
//   • collect_device_manual_params       → device_params.rs
//   • import_internal_device_static_params → device_params.rs
//   • collect_external_plugin_static_lanes → device_params.rs
//   • import_track_devices               → device_import.rs
// ═══════════════════════════════════════════════════════════════════════

fn infer_device_display_name(
    device: roxmltree::Node<'_, '_>,
    fallback_tag: &str,
) -> String {
    infer_device_display_name_from_importer(device, fallback_tag)
}

/// Thin delegator: bridges the imported `track_import::import_track_clips`
/// with the local `build_pointee_map` callback.
fn import_track_clips(
    track_node: roxmltree::Node<'_, '_>,
    track: &mut Track,
    als_path: &Path,
    bpm: f64,
    sample_rate: f64,
) {
    dream_importers::ableton::track_import::import_track_clips(
        track_node,
        track,
        als_path,
        bpm,
        sample_rate,
        build_pointee_map,
    );
}

// ── Automation Envelope Import ───────────────────────────────────────────
//
// Ableton stores automation targets as numeric `PointeeId`s inside `Mixer`
// and device `AutomationTarget Id="N"` nodes. The matching envelopes live
// in `<AutomationEnvelopes>/<Envelopes>/<AutomationEnvelope>` with a
// `<EnvelopeTarget>/<PointeeId Value="N"/>` linking back to the target.
//
// We build a PointeeId → param_id map, then parse FloatEvent envelopes.

fn build_pointee_map(track_node: roxmltree::Node<'_, '_>) -> std::collections::HashMap<String, String> {
    build_pointee_map_with_importer(track_node, infer_device_display_name, normalize_plugin_key)
}

#[cfg(test)]
fn plugin_param_lane_key(
    dev_idx: usize,
    plugin_name: &str,
    param_name: &str,
    param_id: &str,
) -> String {
    plugin_param_lane_key_with_importer(
        dev_idx,
        plugin_name,
        param_name,
        param_id,
        normalize_plugin_key,
    )
}

fn import_track_automation(
    track_node: roxmltree::Node<'_, '_>,
    track: &mut Track,
) {
    import_track_automation_with_importer(
        track_node,
        track,
        infer_device_display_name,
        normalize_plugin_key,
        upsert_static_import_lane_if_missing,
    );
}

fn import_main_track_mixer_snapshot(
    main_track_node: roxmltree::Node<'_, '_>,
    master_track: &mut Track,
) {
    let snapshot = build_main_track_mixer_snapshot(main_track_node);
    if let Some(volume) = snapshot.volume {
        master_track.volume = volume;
    }
    if let Some(pan) = snapshot.pan {
        master_track.pan = pan;
    }
    for (param_id, value) in snapshot.static_mixer_values {
        upsert_static_import_lane_if_missing(master_track, &param_id, value);
    }
}

fn consolidate_automation_lanes(track: &mut Track) {
    consolidate_automation_lanes_from_importer(track);
}

#[cfg(test)]
fn import_als_project(file_path: &Path) -> Result<Project, String> {
    import_als_project_with_target_sample_rate(file_path, None)
}

fn import_als_project_with_target_sample_rate(
    file_path: &Path,
    target_sample_rate: Option<f64>,
) -> Result<Project, String> {
    let xml_text = read_als_xml_text_from_importer(file_path)?;
    let doc = parse_als_document_from_importer(&xml_text)?;
    let live_set = find_live_set_from_importer(&doc)?;

    let tempo = parse_main_tempo_from_importer(live_set);
    let project_name = parse_project_name_from_importer(file_path);
    let imported_sample_rate = parse_imported_sample_rate_from_importer(live_set);
    let sample_rate =
        resolve_timeline_sample_rate_from_importer(imported_sample_rate, target_sample_rate);
    log::info!(
        "[ALS Import] Sample rate: imported={} Hz, timeline={} Hz",
        imported_sample_rate,
        sample_rate,
    );
    let mut project = Project::new(project_name, tempo, sample_rate);
    project.tracks.clear();
    project.markers = parse_project_markers(live_set);
    project.session_scenes = parse_project_scenes(live_set);
    apply_live_set_project_metadata_from_importer(&mut project, live_set);

    apply_live_set_timeline_and_signature_metadata_from_importer(
        &mut project,
        live_set,
        tempo,
        sample_rate,
    );

    let external_plugins = ExternalPluginIndex::build();

    let tracks_node = live_set
        .children()
        .find(|n| n.is_element() && n.has_tag_name("Tracks"))
        .or_else(|| live_set.descendants().find(|n| n.is_element() && n.has_tag_name("Tracks")))
        .ok_or("ALS parse error: <Tracks> node not found")?;

    let mut xml_id_to_uuid = std::collections::HashMap::<String, Uuid>::new();
    let mut pending_group_refs = Vec::<(Uuid, String)>::new();
    let mut pending_output_refs = Vec::<(Uuid, String)>::new();
    let mut pending_group_output_fallback = Vec::<Uuid>::new();

    for (index, track_node) in tracks_node.children().filter(|n| n.is_element()).enumerate() {
        let tag = track_node.tag_name().name();
        // ── Component 3: ReturnTrack imported as Audio ──────────────────
        let track_type = match tag {
            "AudioTrack" | "ReturnTrack" => TrackType::Audio,
            "MidiTrack" => TrackType::Midi,
            "GroupTrack" => TrackType::Group,
            _ => continue,
        };
        let is_return_track = tag == "ReturnTrack";

        let track_name = track_node
            .children()
            .find(|n| n.is_element() && n.has_tag_name("Name"))
            .and_then(|name| {
                name.descendants()
                    .find(|n| n.is_element() && n.has_tag_name("EffectiveName"))
                    .and_then(|n| n.attribute("Value"))
            })
            .map(|s| s.trim().to_string())
            .filter(|s| !s.is_empty())
            .unwrap_or_else(|| format!("{tag} {}", index + 1));

        // Prefix return tracks for clarity
        let track_name = if is_return_track && !track_name.starts_with("(Return)") {
            format!("(Return) {track_name}")
        } else {
            track_name
        };

        let mut track = Track::with_type(track_name, track_type, index);
        let mut static_send_values = Vec::<(usize, f64)>::new();
        let mut static_mixer_values = Vec::<(String, f64)>::new();

        // ── Component 4: Ableton Color Index Mapping ──────────────────
        if let Some(color_value) = extract_ableton_color_index(track_node) {
            track.color = ableton_color_to_track_color(color_value, index);
            // Store exact Ableton hex color for 1:1 visual fidelity
            track.color_hex = ableton_color_index_to_hex(color_value).map(|s| s.to_string());
        }

        if let Some(mixer) = track_node
            .children()
            .find(|n| n.is_element() && n.has_tag_name("DeviceChain"))
            .and_then(|dc| dc.children().find(|n| n.is_element() && n.has_tag_name("Mixer")))
        {
            let split_pan_l = maybe_parse_f64_manual(mixer, "SplitStereoPanL");
            let split_pan_r = maybe_parse_f64_manual(mixer, "SplitStereoPanR");

            if let Some(volume) = maybe_parse_f64_manual(mixer, "Volume") {
                track.volume = volume.clamp(0.0, 2.0);
                static_mixer_values.push(("volume".to_string(), track.volume));
            }
            let pan_manual = maybe_parse_f64_manual(mixer, "Pan");
            if let Some(pan) = pan_manual {
                track.pan = pan.clamp(-1.0, 1.0);
                static_mixer_values.push(("pan".to_string(), track.pan));
            }
            // Prefer Live's main Pan value when present.
            // SplitStereoPanL/R is only a fallback for sessions that omit Pan.
            if pan_manual.is_none()
                && let Some(collapsed_pan) = collapse_split_stereo_pan(split_pan_l, split_pan_r)
            {
                track.pan = collapsed_pan;
                static_mixer_values.push(("pan".to_string(), collapsed_pan));
            }
            let on = maybe_parse_bool_manual(mixer, "On");
            let speaker = maybe_parse_bool_manual(mixer, "Speaker");
            track.is_mute = on == Some(false) || speaker == Some(false);
            let solo = maybe_parse_bool_manual(mixer, "Solo")
                .or_else(|| node_child_value(mixer, "SoloSink").as_deref().and_then(parse_bool_value))
                .unwrap_or(false);
            let armed = maybe_parse_bool_manual(mixer, "Arm").unwrap_or(false);
            track.is_solo = solo;
            track.is_armed = armed;
            if let Some(on) = on {
                static_mixer_values.push(("mixer.on".to_string(), if on { 1.0 } else { 0.0 }));
            }
            if let Some(speaker) = speaker {
                static_mixer_values.push(("mixer.speaker".to_string(), if speaker { 1.0 } else { 0.0 }));
            }
            static_mixer_values.push(("mixer.solo".to_string(), if solo { 1.0 } else { 0.0 }));
            static_mixer_values.push(("mixer.arm".to_string(), if armed { 1.0 } else { 0.0 }));
            if let Some(crossfade_state) = maybe_parse_f64_manual(mixer, "CrossFadeState") {
                static_mixer_values.push((
                    "mixer.crossfade_state".to_string(),
                    crossfade_state.clamp(0.0, 2.0),
                ));
            }
            if let Some(v) = split_pan_l {
                static_mixer_values.push(("mixer.pan_left".to_string(), v.clamp(-1.0, 1.0)));
            }
            if let Some(v) = split_pan_r {
                static_mixer_values.push(("mixer.pan_right".to_string(), v.clamp(-1.0, 1.0)));
            }
            static_send_values = parse_track_send_manual_values(mixer);
        }
        if let Some(monitoring_mode) = node_child_value(track_node, "MonitoringEnum")
            .or_else(|| {
                track_node
                    .descendants()
                    .find(|n| n.is_element() && n.has_tag_name("MonitoringEnum"))
                    .and_then(|n| n.attribute("Value"))
                    .map(ToString::to_string)
            })
            .as_deref()
            .and_then(parse_i64_value)
            .map(|v| v.clamp(0, 2) as u8)
        {
            track.monitoring_mode = Some(monitoring_mode);
            static_mixer_values.push(("mixer.monitoring_mode".to_string(), monitoring_mode as f64));
        }
        if let Some(v) = parse_track_bool_flag(track_node, "IsAutoSelectEnabled") {
            static_mixer_values.push((
                "mixer.is_auto_select_enabled".to_string(),
                if v { 1.0 } else { 0.0 },
            ));
        }
        if let Some(v) = parse_track_bool_flag(track_node, "KeepRecordMonitoringLatency") {
            static_mixer_values.push((
                "mixer.keep_record_monitoring_latency".to_string(),
                if v { 1.0 } else { 0.0 },
            ));
        }
        if track_type == TrackType::Midi {
            if let Some(v) = parse_track_i64_value(track_node, "PitchbendRange") {
                static_mixer_values.push(("midi.pitchbend_range".to_string(), v as f64));
            }
            if let Some(v) = parse_track_bool_flag(track_node, "IsTuned") {
                static_mixer_values.push(("midi.is_tuned".to_string(), if v { 1.0 } else { 0.0 }));
            }
        }

        let preferred_input_target = if track_type == TrackType::Midi {
            parse_output_target(track_node, "MidiInputRouting")
                .or_else(|| parse_output_target(track_node, "AudioInputRouting"))
        } else {
            parse_output_target(track_node, "AudioInputRouting")
                .or_else(|| parse_output_target(track_node, "MidiInputRouting"))
        };
        track.input_source_id = preferred_input_target
            .as_deref()
            .and_then(normalize_input_routing_target);

        import_track_devices(track_node, &mut track, &external_plugins, file_path);
        import_track_clips(track_node, &mut track, file_path, tempo, sample_rate);
        import_track_automation(track_node, &mut track);
        if track_type == TrackType::Midi
            && let Some(root_note) = parse_track_key_note_target(track_node)
            && !track
                .automation_lanes
                .iter()
                .any(|lane| lane.param_id.eq_ignore_ascii_case("sampler.root_note"))
        {
            track
                .sampler
                .get_or_insert_with(SamplerConfig::default)
                .root_note = root_note;
            upsert_static_import_lane_if_missing(&mut track, "sampler.root_note", root_note as f64);
        }
        for (send_idx, send_value) in static_send_values {
            if send_idx >= 26 {
                continue;
            }
            let send_letter = (b'A' + send_idx as u8) as char;
            upsert_static_import_lane_if_missing(&mut track, &format!("send.{send_letter}"), send_value);
        }

        if let Some(xml_id) = track_node.attribute("Id")
            && !xml_id.trim().is_empty()
        {
            xml_id_to_uuid.insert(xml_id.to_string(), track.id);
        }

        if let Some(group_ref) = node_child_value(track_node, "TrackGroupId")
            && !group_ref.trim().is_empty()
            && group_ref.trim() != "-1"
            && group_ref.trim() != "0"
        {
            pending_group_refs.push((track.id, group_ref));
        }

        let preferred_output_target = choose_preferred_output_target(
            track_type,
            parse_output_target(track_node, "AudioOutputRouting"),
            parse_output_target(track_node, "MidiOutputRouting"),
        );
        if let Some(target) = preferred_output_target {
            match classify_output_routing_target(&target) {
                OutputRoutingTarget::TrackXmlId(xml_target_id) => {
                    pending_output_refs.push((track.id, xml_target_id));
                    static_mixer_values.push(("mixer.output_enabled".to_string(), 1.0));
                }
                OutputRoutingTarget::GroupFallback => {
                    pending_group_output_fallback.push(track.id);
                    static_mixer_values.push(("mixer.output_enabled".to_string(), 1.0));
                }
                OutputRoutingTarget::Master => {
                    // `None` output_destination_id already means "to master" in model.
                    static_mixer_values.push(("mixer.output_enabled".to_string(), 1.0));
                }
                OutputRoutingTarget::None => {
                    // Preserve explicit "no output" (distinct from "to master").
                    static_mixer_values.push(("mixer.output_enabled".to_string(), 0.0));
                    // Ensure runtime strip gate matches ALS "No Output" behavior.
                    // The current engine model uses mute/solo output gating;
                    // without this, tracks with AudioOut/None can still reach master.
                    track.is_mute = true;
                }
                OutputRoutingTarget::Unknown => {
                    // Unknown token may still be a valid external/hardware output.
                    static_mixer_values.push(("mixer.output_enabled".to_string(), 1.0));
                }
            }
        }

        for (param_id, value) in static_mixer_values {
            upsert_static_import_lane_if_missing(&mut track, &param_id, value);
        }
        consolidate_automation_lanes(&mut track);

        if track_type == TrackType::Midi && track.instrument.is_none() {
            track.instrument = Some(make_missing_plugin_slot("instrument", "Ableton Instrument"));
            if track.sampler.is_none() {
                track.sampler = Some(SamplerConfig::default());
            }
        }

        project.add_track(track);
    }

    for (child_id, parent_xml_id) in pending_group_refs {
        let Some(parent_id) = xml_id_to_uuid.get(parent_xml_id.trim()).copied() else {
            continue;
        };
        if let Some(child_track) = project.find_track_mut(child_id) {
            child_track.parent_track_id = Some(parent_id);
        }
        if let Some(parent_track) = project.find_track_mut(parent_id)
            && !parent_track.child_track_ids.contains(&child_id)
        {
            parent_track.child_track_ids.push(child_id);
        }
    }

    for (track_id, output_xml_id) in pending_output_refs {
        let Some(dest_id) = xml_id_to_uuid.get(output_xml_id.trim()).copied() else {
            continue;
        };
        if let Some(track) = project.find_track_mut(track_id) {
            track.output_destination_id = Some(dest_id);
        }
    }
    for track_id in pending_group_output_fallback {
        let parent_id = project.find_track(track_id).and_then(|t| t.parent_track_id);
        if let Some(parent_id) = parent_id
            && let Some(track) = project.find_track_mut(track_id)
            && track.output_destination_id.is_none()
        {
            track.output_destination_id = Some(parent_id);
        }
    }

    if let Some(main_track) = live_set.descendants().find(|n| n.is_element() && n.has_tag_name("MainTrack")) {
        import_main_track_mixer_snapshot(main_track, &mut project.master_track);
        import_track_devices(main_track, &mut project.master_track, &external_plugins, file_path);
        import_track_automation(main_track, &mut project.master_track);
        consolidate_automation_lanes(&mut project.master_track);
    }

    normalize_internal_plugins_for_import(&mut project);

    dream_importers::ableton::file_resolver::consolidate_project_samples_for_als_import(
        &mut project,
        file_path,
    );

    Ok(project)
}

/// Imports an Ableton `.als` project and installs it as the active session.
#[tauri::command]
fn import_ableton_project(
    path: String,
    project_state: tauri::State<'_, ProjectState>,
    clip_pool_state: tauri::State<'_, ClipPoolState>,
    automation_runtime: tauri::State<'_, AutomationRuntime>,
    handle: tauri::State<'_, AudioEngineHandle>,
    plugin_host_state: tauri::State<'_, PluginHostState>,
    app: tauri::AppHandle,
) -> Result<Project, String> {
    open_project(
        path,
        project_state,
        clip_pool_state,
        automation_runtime,
        handle,
        plugin_host_state,
        app,
    )
}

/// Creates a new empty project and replaces the current one.
#[tauri::command]
fn new_project(
    project_state: tauri::State<'_, ProjectState>,
    clip_pool_state: tauri::State<'_, ClipPoolState>,
    automation_runtime: tauri::State<'_, AutomationRuntime>,
    handle: tauri::State<'_, AudioEngineHandle>,
    plugin_host_state: tauri::State<'_, PluginHostState>,
    app: tauri::AppHandle,
) -> Result<Project, String> {
    let mut new = Project::default();
    refresh_offline_flags(&mut new);
    *project_state.project.lock().map_err(|e| e.to_string())? = new.clone();
    *project_state.file_path.lock().map_err(|e| e.to_string())? = None;
    *project_state.project_folder.lock().map_err(|e| e.to_string())? = None;
    *project_state.is_dirty.lock().map_err(|e| e.to_string())? = false;
    *project_state.undo.lock().map_err(|e| e.to_string())? = UndoState::new();
    *project_state.history.lock().map_err(|e| e.to_string())? = ProjectHistory::new();
    project_state.record_history("new_project", format!("created '{}'", new.name))?;
    let _ = plugin_host_state.unload_all_instances();
    clip_pool_state.rebuild_snapshot(&new);
    clip_pool_state.rebuild_external_fx_snapshot(&new, plugin_host_state.slot_instance_snapshot().as_ref());
    plugin_host_state.publish_registry();
    rebuild_automation_snapshot_from_project(&new, &automation_runtime);
    rebuild_midi_snapshot_from_project(&new, &handle);
    rebuild_sampler_snapshot_from_project(&new, &clip_pool_state, &handle);
    rebuild_runtime_device_chains_from_project(&new, &handle)?;
    sync_transport_from_project(&new, &handle)?;
    sync_track_mix_state_from_project(&new, &handle)?;

    // Update window title
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.set_title(&format!("Dream DAW — {}", new.name));
    }

    log::info!("New project created: '{}'", new.name);
    Ok(new)
}

/// Saves the current project to its existing path (or fails if unsaved).
#[tauri::command]
async fn save_project(
    project_state: tauri::State<'_, ProjectState>,
    plugin_host_state: tauri::State<'_, PluginHostState>,
    app: tauri::AppHandle,
) -> Result<String, String> {
    let (snapshot, path, project_name) = {
        let mut project = project_state.project.lock().map_err(|e| e.to_string())?;

        // ── Capture live plugin state into the project model ──
        // This ensures all knob positions, preset selections, and internal
        // plugin state are persisted before serialization.
        if let Err(e) = plugin_host_state.capture_plugin_states_into_project(&mut project) {
            log::warn!("[Save] Plugin state capture failed (non-fatal): {e}");
        }

        let file_path_guard = project_state.file_path.lock().map_err(|e| e.to_string())?;
        let path = file_path_guard
            .as_ref()
            .ok_or("No file path set. Use Save As first.")?
            .clone();

        let mut snapshot = project.clone();

        // Keep serialized project name aligned with the active file name.
        if let Some(stem) = path.file_stem().and_then(|s| s.to_str()) {
            let normalized = stem.trim_end_matches(".dream").trim();
            if !normalized.is_empty() && snapshot.name != normalized {
                snapshot.name = normalized.to_string();
            }
        }

        (snapshot.clone(), path, snapshot.name.clone())
    };

    let save_path = path.clone();
    tauri::async_runtime::spawn_blocking(move || ProjectFile::save(&snapshot, &save_path))
        .await
        .map_err(|e| format!("Save task join error: {e}"))?
        .map_err(|e| e.to_string())?;

    {
        let mut project = project_state.project.lock().map_err(|e| e.to_string())?;
        project.name = project_name.clone();
    }

    *project_state.is_dirty.lock().map_err(|e| e.to_string())? = false;
    project_state.record_history("save", format!("saved to {}", path.display()))?;

    // Update window title (also clears any dirty marker left from mark_dirty_cmd).
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.set_title(&format!("Dream DAW — {}", project_name));
    }

    log::info!("Project saved: '{}' → {}", project_name, path.display());
    Ok(path.display().to_string())
}

/// Saves the project to a specific path.
#[tauri::command]
async fn save_project_as(
    path: String,
    project_state: tauri::State<'_, ProjectState>,
    plugin_host_state: tauri::State<'_, PluginHostState>,
    app: tauri::AppHandle,
) -> Result<String, String> {
    let file_path = PathBuf::from(&path);
    log::info!("[SaveAs] Received path: {:?}", file_path);
    let (snapshot, project_name) = {
        let mut project = project_state.project.lock().map_err(|e| e.to_string())?;

        // ── Capture live plugin state ──
        if let Err(e) = plugin_host_state.capture_plugin_states_into_project(&mut project) {
            log::warn!("[SaveAs] Plugin state capture failed (non-fatal): {e}");
        }

        let computed_name = file_path
            .file_stem()
            .and_then(|s| s.to_str())
            .unwrap_or(&project.name)
            .trim_end_matches(".dream")
            .to_string();
        let mut snapshot = project.clone();
        if !computed_name.trim().is_empty() {
            snapshot.name = computed_name.trim().to_string();
        }
        (snapshot.clone(), snapshot.name.clone())
    };

    let save_target = file_path.clone();
    let project_name_for_save = project_name.clone();
    let (actual_file_path, folder) = tauri::async_runtime::spawn_blocking(move || -> Result<(PathBuf, PathBuf), String> {
        let parent_dir = save_target.parent().unwrap_or(std::path::Path::new("."));
        let is_proj_dir = ProjectManager::is_project_directory(parent_dir);
        log::info!("[SaveAs] parent_dir={:?}, is_project_dir={}, project_name={}", parent_dir, is_proj_dir, project_name_for_save);
        if is_proj_dir {
            log::info!("[SaveAs] Saving directly to existing project dir: {:?}", save_target);
            ProjectFile::save(&snapshot, &save_target).map_err(|e| e.to_string())?;
            Ok((save_target.clone(), parent_dir.to_path_buf()))
        } else {
            log::info!("[SaveAs] Non-project dir — creating project folder '{}' under {:?}", project_name_for_save, parent_dir);
            let folder = ProjectManager::create_project_folder(parent_dir, &project_name_for_save)
                .map_err(|e| e.to_string())?;
            let saved_path = ProjectManager::save_to_folder(&snapshot, &folder, true)
                .map_err(|e| e.to_string())?;
            log::info!("[SaveAs] Project saved to: {:?}", saved_path);
            Ok((saved_path, folder))
        }
    })
    .await
    .map_err(|e| format!("Save As task join error: {e}"))??;

    {
        let mut project = project_state.project.lock().map_err(|e| e.to_string())?;
        project.name = project_name.clone();
    }

    *project_state.file_path.lock().map_err(|e| e.to_string())? = Some(actual_file_path.clone());
    *project_state.project_folder.lock().map_err(|e| e.to_string())? = Some(folder);
    *project_state.is_dirty.lock().map_err(|e| e.to_string())? = false;
    project_state.record_history("save_as", format!("saved as {}", actual_file_path.display()))?;

    // Track in recent projects
    let result_path = actual_file_path.display().to_string();
    if let Ok(app_data_dir) = app.path().app_data_dir() {
        let mut recent = RecentProjects::load(&app_data_dir);
        recent.add(project_name.clone(), result_path.clone());
        let _ = recent.save(&app_data_dir);
    }

    // Update window title
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.set_title(&format!("Dream DAW — {}", project_name));
    }

    log::info!("Project saved as: '{}' → {}", project_name, actual_file_path.display());
    Ok(result_path)
}

/// Opens a project from a file path.
#[tauri::command]
fn open_project(
    path: String,
    project_state: tauri::State<'_, ProjectState>,
    clip_pool_state: tauri::State<'_, ClipPoolState>,
    automation_runtime: tauri::State<'_, AutomationRuntime>,
    handle: tauri::State<'_, AudioEngineHandle>,
    plugin_host_state: tauri::State<'_, PluginHostState>,
    app: tauri::AppHandle,
) -> Result<Project, String> {
    let file_path = PathBuf::from(&path);

    let importing_als = file_path
        .extension()
        .and_then(|s| s.to_str())
        .map(|s| s.eq_ignore_ascii_case("als"))
        .unwrap_or(false);

    let mut loaded = if importing_als {
        let runtime_sample_rate = handle
            .playback_state
            .lock()
            .map_err(|e| e.to_string())?
            .sample_rate;
        import_als_project_with_target_sample_rate(&file_path, Some(runtime_sample_rate))?
    } else {
        let project = ProjectFile::load(&file_path).map_err(|e| e.to_string())?;
        // CRITICAL: Do NOT call normalize_internal_plugins_for_import() here.
        // That normalizer is intended for ALS imports (where plugin names need
        // mapping to internal://). Calling it on native .ddpj projects destroys
        // external VST3 plugin IDs (e.g. ShaperBox3 → Distortion) because the
        // keyword matcher hits on substrings like "shaper" in "ShaperBox".
        project
    };
    if importing_als {
        for track in &mut loaded.tracks {
            track.height = track.height.clamp(24.0, 120.0);
        }
    }
    refresh_offline_flags(&mut loaded);

    let _ = plugin_host_state.unload_all_instances();
    // Do not eagerly activate external plugins while opening a project.
    // Some third-party VSTs can crash on activation/probing; runtime activation
    // is done lazily from the rack (UI/Fix/Open actions).

    clip_pool_state.rebuild_snapshot(&loaded);
    clip_pool_state.rebuild_external_fx_snapshot(&loaded, plugin_host_state.slot_instance_snapshot().as_ref());
    plugin_host_state.publish_registry();
    clip_pool_state.load_project_clips(&loaded);
    rebuild_automation_snapshot_from_project(&loaded, &automation_runtime);
    rebuild_midi_snapshot_from_project(&loaded, &handle);
    rebuild_sampler_snapshot_from_project(&loaded, &clip_pool_state, &handle);
    rebuild_runtime_device_chains_from_project(&loaded, &handle)?;
    sync_transport_from_project(&loaded, &handle)?;
    sync_track_mix_state_from_project(&loaded, &handle)?;

    *project_state.project.lock().map_err(|e| e.to_string())? = loaded.clone();
    *project_state.file_path.lock().map_err(|e| e.to_string())? = if importing_als {
        None
    } else {
        Some(file_path.clone())
    };
    *project_state.is_dirty.lock().map_err(|e| e.to_string())? = importing_als;
    *project_state.undo.lock().map_err(|e| e.to_string())? = UndoState::new();
    *project_state.history.lock().map_err(|e| e.to_string())? = ProjectHistory::new();
    let source_kind = if importing_als { "als_import" } else { "project_open" };
    project_state.record_history(source_kind, format!("loaded '{}'", loaded.name))?;

    // Derive project folder from file path
    let folder = if importing_als {
        file_path.parent().map(|p| p.to_path_buf())
    } else {
        ProjectManager::folder_from_file(&file_path)
    };
    *project_state.project_folder.lock().map_err(|e| e.to_string())? = folder;

    // Track in recent projects
    if let Ok(app_data_dir) = app.path().app_data_dir() {
        let mut recent = RecentProjects::load(&app_data_dir);
        recent.add(loaded.name.clone(), path);
        let _ = recent.save(&app_data_dir);
    }

    // Update window title
    if let Some(window) = app.get_webview_window("main") {
        if importing_als {
            let _ = window.set_title(&format!("Dream DAW — {}*", loaded.name));
        } else {
            let _ = window.set_title(&format!("Dream DAW — {}", loaded.name));
        }
    }

    if importing_als {
        log::info!(
            "Ableton project imported: '{}' ({} tracks) from {}",
            loaded.name,
            loaded.track_count(),
            file_path.display()
        );
    } else {
        log::info!("Project opened: '{}' ({} tracks)", loaded.name, loaded.track_count());
    }
    Ok(loaded)
}

/// Returns the list of recently opened projects.
#[tauri::command]
fn get_recent_projects(
    app: tauri::AppHandle,
) -> Result<Vec<RecentProject>, String> {
    let app_data_dir = app.path().app_data_dir()
        .map_err(|e| e.to_string())?;
    let recent = RecentProjects::load(&app_data_dir);
    Ok(recent.projects)
}

/// Returns the current project state.
#[tauri::command]
fn get_project(
    project_state: tauri::State<'_, ProjectState>,
) -> Result<Project, String> {
    // PERF-FIX: Removed refresh_offline_flags() from this hot path.
    // get_project is called after EVERY UI action (mute, solo, add track, etc.).
    // refresh_offline_flags() does PathBuf::exists() syscalls per clip per track
    // under the project Mutex — creating memory pressure and Mutex contention
    // that can preempt the CoreAudio real-time thread.
    // Offline flags are now only refreshed on project load/open/new where they
    // are actually needed.
    let project = project_state.project.lock().map_err(|e| e.to_string())?;
    Ok(project.clone())
}

/// Returns whether the project has unsaved changes and the current file path.
#[tauri::command]
fn get_project_status(
    project_state: tauri::State<'_, ProjectState>,
) -> Result<serde_json::Value, String> {
    let is_dirty = *project_state.is_dirty.lock().map_err(|e| e.to_string())?;
    let file_path = project_state.file_path.lock().map_err(|e| e.to_string())?;
    let project_folder = project_state.project_folder.lock().map_err(|e| e.to_string())?;
    Ok(serde_json::json!({
        "isDirty": is_dirty,
        "filePath": file_path.as_ref().map(|p| p.display().to_string()),
        "projectFolder": project_folder.as_ref().map(|p| p.display().to_string()),
    }))
}

/// Persists arrangement/editor grid settings in the project.
#[tauri::command]
fn set_arrangement_grid_cmd(
    numerator: u16,
    denominator: u16,
    ntoles: u8,
    snap_to_grid: bool,
    fixed: bool,
    project_state: tauri::State<'_, ProjectState>,
    app: tauri::AppHandle,
) -> Result<(), String> {
    let numerator = numerator.max(1);
    let denominator = denominator.max(1);
    let ntoles = ntoles.max(1);

    let mut project = project_state.project.lock().map_err(|e| e.to_string())?;
    project.arrangement_grid_numerator = numerator;
    project.arrangement_grid_denominator = denominator;
    project.arrangement_grid_ntoles = ntoles;
    project.arrangement_snap_to_grid = snap_to_grid;
    project.arrangement_grid_fixed = fixed;
    let name = project.name.clone();
    drop(project);

    project_state.mark_dirty(&name, Some(&app))?;
    Ok(())
}

#[tauri::command]
fn set_key_signature_cmd(
    enabled: bool,
    tonic: String,
    mode: String,
    project_state: tauri::State<'_, ProjectState>,
    app: tauri::AppHandle,
) -> Result<(), String> {
    let mut project = project_state.project.lock().map_err(|e| e.to_string())?;
    project.key_sig_enabled = enabled;
    project.key_sig_tonic = tonic;
    project.key_sig_mode = mode;
    let name = project.name.clone();
    drop(project);

    project_state.mark_dirty(&name, Some(&app))?;
    Ok(())
}
