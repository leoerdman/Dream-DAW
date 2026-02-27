use dream_models::midi::SamplerConfig;
use dream_models::project::{Project, Track, TrackType};
use std::path::Path;
use uuid::Uuid;

// ═══════════════════════════════════════════════════════════════════════
use crate::ableton::device_import::import_track_devices;
use crate::ableton::device_params::upsert_static_import_lane_if_missing;
use crate::ableton::markers::{
    parse_project_markers as parse_project_markers_from_importer,
    parse_project_scenes as parse_project_scenes_from_importer,
};
use crate::ableton::parser::{
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
use crate::ableton::plugin_mapper::{
    ExternalPluginIndex, infer_device_display_name as infer_device_display_name_from_importer,
    make_missing_plugin_slot, normalize_internal_plugins_for_import, normalize_plugin_key,
};

use crate::ableton::automation::{
    build_main_track_mixer_snapshot, build_pointee_map_with as build_pointee_map_with_importer,
    consolidate_automation_lanes as consolidate_automation_lanes_from_importer,
    import_track_automation_with as import_track_automation_with_importer,
};
use crate::ableton::color_map::{
    ableton_color_index_to_hex, ableton_color_to_track_color, extract_ableton_color_index,
};
use crate::ableton::routing::{
    OutputRoutingTarget, choose_preferred_output_target, classify_output_routing_target,
    collapse_split_stereo_pan, normalize_input_routing_target, parse_output_target,
};

use crate::ableton::xml_helpers::{
    ableton_volume_to_linear_gain, maybe_parse_bool_manual, maybe_parse_f64_manual,
    node_child_value, parse_bool_value, parse_i64_value,
    parse_track_bool_flag_legacy as parse_track_bool_flag,
    parse_track_i64_value_legacy as parse_track_i64_value,
    parse_track_key_note_target_legacy as parse_track_key_note_target,
    parse_track_send_manual_values,
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

fn infer_device_display_name(device: roxmltree::Node<'_, '_>, fallback_tag: &str) -> String {
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
    crate::ableton::track_import::import_track_clips(
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

fn build_pointee_map(
    track_node: roxmltree::Node<'_, '_>,
) -> std::collections::HashMap<String, String> {
    build_pointee_map_with_importer(track_node, infer_device_display_name, normalize_plugin_key)
}

fn import_track_automation(track_node: roxmltree::Node<'_, '_>, track: &mut Track) {
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
pub fn import_als_project(file_path: &Path) -> Result<Project, String> {
    import_als_project_with_target_sample_rate(file_path, None)
}

pub fn import_als_project_with_target_sample_rate(
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
        .or_else(|| {
            live_set
                .descendants()
                .find(|n| n.is_element() && n.has_tag_name("Tracks"))
        })
        .ok_or("ALS parse error: <Tracks> node not found")?;

    let mut xml_id_to_uuid = std::collections::HashMap::<String, Uuid>::new();
    let mut pending_group_refs = Vec::<(Uuid, String)>::new();
    let mut pending_output_refs = Vec::<(Uuid, String)>::new();
    let mut pending_group_output_fallback = Vec::<Uuid>::new();

    for (index, track_node) in tracks_node
        .children()
        .filter(|n| n.is_element())
        .enumerate()
    {
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
            .find(|n| n.is_element() && n.has_tag_name("InsertEffectsChain"))
            .and_then(|dc| {
                dc.children()
                    .find(|n| n.is_element() && n.has_tag_name("Mixer"))
            })
        {
            let split_pan_l = maybe_parse_f64_manual(mixer, "SplitStereoPanL");
            let split_pan_r = maybe_parse_f64_manual(mixer, "SplitStereoPanR");

            if let Some(volume) = maybe_parse_f64_manual(mixer, "Volume") {
                track.volume = ableton_volume_to_linear_gain(volume);
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
            track.is_disabled = on == Some(false) || speaker == Some(false);
            let solo = maybe_parse_bool_manual(mixer, "Solo")
                .or_else(|| {
                    node_child_value(mixer, "SoloSink")
                        .as_deref()
                        .and_then(parse_bool_value)
                })
                .unwrap_or(false);
            let armed = maybe_parse_bool_manual(mixer, "Arm").unwrap_or(false);
            track.is_solo = solo;
            track.is_armed = armed;
            if let Some(on) = on {
                static_mixer_values.push(("mixer.on".to_string(), if on { 1.0 } else { 0.0 }));
            }
            if let Some(speaker) = speaker {
                static_mixer_values
                    .push(("mixer.speaker".to_string(), if speaker { 1.0 } else { 0.0 }));
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
            upsert_static_import_lane_if_missing(
                &mut track,
                &format!("send.{send_letter}"),
                send_value,
            );
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
                    track.is_disabled = true;
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
            // ── Extract real plugin names from PluginDevice nodes in this track ──
            // Before falling back to a generic label, scan the XML for external
            // plugin metadata so the Missing Plugins panel shows actionable names
            // (e.g. "Serum 2" instead of "Ableton Instrument").
            let inferred_name = track_node
                .descendants()
                .filter(|n| n.is_element() && n.has_tag_name("PluginDevice"))
                .find_map(|pd| {
                    // Try Vst3PluginInfo > Name
                    let vst3 = pd
                        .descendants()
                        .find(|n| n.is_element() && n.has_tag_name("Vst3PluginInfo"))
                        .and_then(|v| {
                            v.children()
                                .find(|n| n.is_element() && n.has_tag_name("Name"))
                                .and_then(|n| n.attribute("Value"))
                        })
                        .filter(|s| !s.trim().is_empty());
                    if let Some(name) = vst3 {
                        return Some(name.trim().to_string());
                    }
                    // Try VstPluginInfo > PlugName
                    let vst2 = pd
                        .descendants()
                        .find(|n| n.is_element() && n.has_tag_name("VstPluginInfo"))
                        .and_then(|v| {
                            v.children()
                                .find(|n| n.is_element() && n.has_tag_name("PlugName"))
                                .and_then(|n| n.attribute("Value"))
                        })
                        .filter(|s| !s.trim().is_empty());
                    if let Some(name) = vst2 {
                        return Some(name.trim().to_string());
                    }
                    // Try AuPluginInfo > Name
                    let au = pd
                        .descendants()
                        .find(|n| n.is_element() && n.has_tag_name("AuPluginInfo"))
                        .and_then(|v| {
                            v.children()
                                .find(|n| n.is_element() && n.has_tag_name("Name"))
                                .and_then(|n| n.attribute("Value"))
                        })
                        .filter(|s| !s.trim().is_empty());
                    if let Some(name) = au {
                        return Some(name.trim().to_string());
                    }
                    // Try UserName
                    node_child_value(pd, "UserName")
                        .filter(|s| !s.trim().is_empty())
                        .map(|s| s.trim().to_string())
                })
                .unwrap_or_else(|| "Unknown Instrument".to_string());
            log::warn!(
                "[ALS Import] MIDI track '{}' has no instrument assigned. Inferred name: '{}'",
                track.name,
                inferred_name
            );
            track.instrument = Some(make_missing_plugin_slot("instrument", &inferred_name));
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

    if let Some(main_track) = live_set
        .descendants()
        .find(|n| n.is_element() && n.has_tag_name("MainTrack"))
    {
        import_main_track_mixer_snapshot(main_track, &mut project.master_track);
        import_track_devices(
            main_track,
            &mut project.master_track,
            &external_plugins,
            file_path,
        );
        import_track_automation(main_track, &mut project.master_track);
        consolidate_automation_lanes(&mut project.master_track);
    }

    normalize_internal_plugins_for_import(&mut project);

    // Import must stay responsive even on large projects with huge sample libraries.
    // Sample consolidation can copy gigabytes and block UI command completion,
    // so keep it opt-in for now.
    let consolidate_on_import = std::env::var("DREAM_DAW_ALS_CONSOLIDATE")
        .ok()
        .map(|v| {
            let s = v.trim().to_ascii_lowercase();
            matches!(s.as_str(), "1" | "true" | "yes" | "on")
        })
        .unwrap_or(false);
    if consolidate_on_import {
        crate::ableton::file_resolver::consolidate_project_samples_for_als_import(
            &mut project,
            file_path,
        );
    } else {
        log::info!(
            "[ALS Import] Sample consolidation skipped (set DREAM_DAW_ALS_CONSOLIDATE=1 to enable)."
        );
    }

    Ok(project)
}

// #[cfg(test)]
// mod project_import_tests;
