// ═══════════════════════════════════════════════════════════════════════
use std::path::{Path, PathBuf};
use std::io::Read;
use std::path::{Path, PathBuf};

use flate2::read::GzDecoder;
use quick_xml::events::{BytesStart, Event};
use quick_xml::Reader;

fn canonical_internal_plugin_for_import(plugin_id: &str, plugin_name: &str) -> Option<(&'static str, &'static str, &'static str)> {
    let merged = format!("{} {}", plugin_id, plugin_name).to_lowercase();
    let compact = merged.replace(|c: char| !c.is_ascii_alphanumeric(), "");

    if compact.contains("originalsimpler") || compact.contains("drift") {
        if compact.contains("originalsimpler") {
            return Some(("internal://instrument/sampler", "Sampler", "instrument"));
        }
        return Some(("internal://instrument/wave-synth", "Wave Synth", "instrument"));
    }

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

    if merged.contains("eq") || merged.contains("channel eq") {
        return Some(("internal://effect/eq-eight", "EQ Eight", "effect"));
    }
    if merged.contains("compressor") || merged.contains("glue") || merged.contains("multiband dynamics") {
        return Some(("internal://effect/compressor", "Compressor", "effect"));
    }
    if merged.contains("delay") || merged.contains("echo") || merged.contains("ping pong") {
        return Some(("internal://effect/delay", "Delay", "effect"));
    }
    if merged.contains("reverb") {
        return Some(("internal://effect/reverb", "Reverb", "effect"));
    }
    if merged.contains("chorus") {
        return Some(("internal://effect/chorus", "Chorus", "effect"));
    }
    if compact.contains("stereogain") {
        return Some(("internal://effect/utility", "Utility", "effect"));
    }
    if compact.contains("autopan") || compact.contains("midipitcher") {
        return Some(("internal://effect/utility", "Utility", "effect"));
    }
    if merged.contains("saturator") {
        return Some(("internal://effect/saturator", "Saturator", "effect"));
    }
    if merged.contains("utility") {
        return Some(("internal://effect/utility", "Utility", "effect"));
    }
    if merged.contains("limiter") {
        return Some(("internal://effect/limiter", "Limiter", "effect"));
    }
    if merged.contains("gate") {
        return Some(("internal://effect/gate", "Gate", "effect"));
    }
    if merged.contains("auto filter") || merged.contains("autofilter") {
        return Some(("internal://effect/auto-filter", "Auto Filter", "effect"));
    }
    if merged.contains("phaser") {
        return Some(("internal://effect/phaser", "Phaser", "effect"));
    }
    if compact.contains("phasernew") {
        return Some(("internal://effect/phaser", "Phaser", "effect"));
    }
    if merged.contains("flanger") {
        return Some(("internal://effect/flanger", "Flanger", "effect"));
    }
    if merged.contains("distortion") || merged.contains("overdrive") || merged.contains("pedal") || merged.contains("cabinet") || merged.contains("amp") {
        return Some(("internal://effect/distortion", "Distortion", "effect"));
    }
    if merged.contains("erosion") || merged.contains("transmute") || merged.contains("vocoder") {
        return Some(("internal://effect/distortion", "Distortion", "effect"));
    }
    if merged.contains("bitcrusher") || merged.contains("redux") {
        return Some(("internal://effect/bitcrusher", "Bitcrusher", "effect"));
    }
    None
}

fn normalize_internal_plugins_for_import(project: &mut Project) {
    for track in &mut project.tracks {
        if let Some(inst) = &mut track.instrument
            && let Some((canonical_id, canonical_name, slot)) =
                canonical_internal_plugin_for_import(&inst.plugin_id, &inst.name)
            && slot == "instrument"
        {
            inst.plugin_id = canonical_id.to_string();
            if inst.name.trim().is_empty() || inst.name.to_lowercase() != canonical_name.to_lowercase() {
                inst.name = canonical_name.to_string();
            }
            if track.sampler.is_none() {
                track.sampler = Some(SamplerConfig::default());
            }
            if canonical_id == "internal://instrument/wave-synth"
                && let Some(cfg) = &mut track.sampler
                && cfg.sample_path.trim().is_empty()
            {
                cfg.sample_path = "internal://waveform/sine".to_string();
            }
        }
        for fx in &mut track.effects {
            if let Some((canonical_id, canonical_name, slot)) =
                canonical_internal_plugin_for_import(&fx.plugin_id, &fx.name)
                && slot == "effect"
            {
                fx.plugin_id = canonical_id.to_string();
                if fx.name.trim().is_empty() || fx.name.to_lowercase() != canonical_name.to_lowercase() {
                    fx.name = canonical_name.to_string();
                }
            }
        }
    }
}

fn parse_bool_value(raw: &str) -> Option<bool> {
    match raw.trim().to_ascii_lowercase().as_str() {
        "1" | "true" | "yes" | "on" => Some(true),
        "0" | "false" | "no" | "off" => Some(false),
        _ => None,
    }
}

fn parse_f64_value(raw: &str) -> Option<f64> {
    raw.trim().parse::<f64>().ok()
}

fn parse_i64_value(raw: &str) -> Option<i64> {
    raw.trim().parse::<i64>().ok()
}

fn beats_to_frames(beats: f64, bpm: f64, sample_rate: f64) -> i64 {
    if !beats.is_finite() || !bpm.is_finite() || !sample_rate.is_finite() || bpm <= 0.0 || sample_rate <= 0.0 {
        return 0;
    }
    ((beats * 60.0 / bpm) * sample_rate).round() as i64
}

fn node_child_value(node: roxmltree::Node<'_, '_>, child_tag: &str) -> Option<String> {
    node.children()
        .find(|c| c.is_element() && c.has_tag_name(child_tag))
        .and_then(|n| n.attribute("Value"))
        .map(|s| s.to_string())
}

fn node_descendant_value(node: roxmltree::Node<'_, '_>, tag: &str) -> Option<String> {
    node.descendants()
        .find(|n| n.is_element() && n.has_tag_name(tag))
        .and_then(|n| n.attribute("Value"))
        .map(|s| s.to_string())
}

fn node_manual_value(node: roxmltree::Node<'_, '_>, param_tag: &str) -> Option<String> {
    node.children()
        .find(|c| c.is_element() && c.has_tag_name(param_tag))
        .and_then(|param| {
            param.children()
                .find(|child| child.is_element() && child.has_tag_name("Manual"))
        })
        .and_then(|manual| manual.attribute("Value"))
        .map(|s| s.to_string())
}

fn maybe_parse_f64_manual(node: roxmltree::Node<'_, '_>, tag: &str) -> Option<f64> {
    node_manual_value(node, tag).as_deref().and_then(parse_f64_value)
}

fn maybe_parse_bool_manual(node: roxmltree::Node<'_, '_>, tag: &str) -> Option<bool> {
    node_manual_value(node, tag).as_deref().and_then(parse_bool_value)
}

fn resolve_als_file_path(
    als_path: &Path,
    absolute_path: Option<&str>,
    relative_path: Option<&str>,
) -> Option<String> {
    if let Some(abs) = absolute_path
        && !abs.trim().is_empty()
    {
        return Some(abs.to_string());
    }
    if let Some(rel) = relative_path
        && !rel.trim().is_empty()
    {
        let rel_path = PathBuf::from(rel);
        if rel_path.is_absolute() {
            return Some(rel_path.to_string_lossy().to_string());
        }
        let parent = als_path.parent().unwrap_or_else(|| Path::new("."));
        return Some(parent.join(rel_path).to_string_lossy().to_string());
    }
    None
}

fn make_missing_plugin_slot(kind: &str, ableton_name: &str) -> PluginSlot {
    let normalized = ableton_name
        .chars()
        .map(|ch| {
            if ch.is_ascii_alphanumeric() {
                ch.to_ascii_lowercase()
            } else {
                '-'
            }
        })
        .collect::<String>()
        .split('-')
        .filter(|part| !part.is_empty())
        .collect::<Vec<_>>()
        .join("-");
    let slug = if normalized.is_empty() {
        "unknown".to_string()
    } else {
        normalized
    };
    PluginSlot::new(
        format!("Plugin Not Found: {}", ableton_name.trim()),
        format!("missing://{kind}/{slug}"),
    )
}

struct ExternalPluginIndex {
    by_name: std::collections::HashMap<String, String>,
    by_stem: std::collections::HashMap<String, String>,
}

impl ExternalPluginIndex {
    fn build() -> Self {
        let mut by_name = std::collections::HashMap::new();
        let mut by_stem = std::collections::HashMap::new();

        for desc in dream_plugins::PluginScanner::new().scan_all() {
            let path_str = desc.path.to_string_lossy().to_string();
            let name_key = desc.name.to_lowercase();
            by_name.entry(name_key).or_insert_with(|| path_str.clone());

            let stem_key = desc
                .path
                .file_stem()
                .and_then(|s| s.to_str())
                .unwrap_or_default()
                .to_lowercase();
            if !stem_key.is_empty() {
                by_stem.entry(stem_key).or_insert(path_str);
            }
        }

        Self { by_name, by_stem }
    }

    fn resolve_by_name(&self, name: &str) -> Option<String> {
        let key = name.trim().to_lowercase();
        if key.is_empty() {
            return None;
        }
        self.by_name
            .get(&key)
            .cloned()
            .or_else(|| self.by_stem.get(&key).cloned())
    }
}

fn collect_track_devices(track_node: roxmltree::Node<'_, '_>) -> Vec<roxmltree::Node<'_, '_>> {
    track_node
        .descendants()
        .filter(|n| {
            n.is_element()
                && n.parent()
                    .map(|p| p.is_element() && p.has_tag_name("Devices"))
                    .unwrap_or(false)
        })
        .collect()
}

fn import_track_clips(
    track_node: roxmltree::Node<'_, '_>,
    track: &mut Track,
    als_path: &Path,
    bpm: f64,
    sample_rate: f64,
) {
    for clip_node in track_node.descendants().filter(|n| n.is_element() && n.has_tag_name("AudioClip")) {
        let start_beats = node_child_value(clip_node, "CurrentStart")
            .as_deref()
            .and_then(parse_f64_value)
            .unwrap_or(0.0);
        let end_beats = node_child_value(clip_node, "CurrentEnd")
            .as_deref()
            .and_then(parse_f64_value)
            .unwrap_or(start_beats);
        let duration_beats = (end_beats - start_beats).max(0.0);
        if duration_beats <= 0.0 {
            continue;
        }

        let clip_name = node_child_value(clip_node, "Name")
            .filter(|v| !v.trim().is_empty())
            .unwrap_or_else(|| "Audio Clip".to_string());

        let absolute_path = clip_node
            .descendants()
            .find(|n| n.is_element() && n.has_tag_name("Path"))
            .and_then(|n| n.attribute("Value"));
        let relative_path = clip_node
            .descendants()
            .find(|n| n.is_element() && n.has_tag_name("RelativePath"))
            .and_then(|n| n.attribute("Value"));
        let source_path = resolve_als_file_path(als_path, absolute_path, relative_path)
            .unwrap_or_default();

        let mut clip = AudioClip::new(
            clip_name,
            source_path,
            AbsoluteTime::new(beats_to_frames(start_beats, bpm, sample_rate)),
            AbsoluteTime::new(beats_to_frames(duration_beats, bpm, sample_rate).max(1)),
        );

        if let Some(start_relative_beats) = clip_node
            .descendants()
            .find(|n| n.is_element() && n.has_tag_name("StartRelative"))
            .and_then(|n| n.attribute("Value"))
            .and_then(parse_f64_value)
        {
            clip.source_offset = AbsoluteTime::new(beats_to_frames(start_relative_beats, bpm, sample_rate).max(0));
        }

        if let Some(disabled) = node_child_value(clip_node, "Disabled")
            .as_deref()
            .and_then(parse_bool_value)
        {
            clip.is_muted = disabled;
        }

        track.clips.push(clip);
    }

    for clip_node in track_node.descendants().filter(|n| n.is_element() && n.has_tag_name("MidiClip")) {
        let start_beats = node_child_value(clip_node, "CurrentStart")
            .as_deref()
            .and_then(parse_f64_value)
            .unwrap_or(0.0);
        let end_beats = node_child_value(clip_node, "CurrentEnd")
            .as_deref()
            .and_then(parse_f64_value)
            .unwrap_or(start_beats);
        let duration_beats = (end_beats - start_beats).max(0.0);
        if duration_beats <= 0.0 {
            continue;
        }

        let mut clip = MidiClip::new(
            node_child_value(clip_node, "Name")
                .filter(|v| !v.trim().is_empty())
                .unwrap_or_else(|| "MIDI Clip".to_string()),
            AbsoluteTime::new(beats_to_frames(start_beats, bpm, sample_rate)),
            AbsoluteTime::new(beats_to_frames(duration_beats, bpm, sample_rate).max(1)),
        );

        if let Some(disabled) = node_child_value(clip_node, "Disabled")
            .as_deref()
            .and_then(parse_bool_value)
        {
            clip.is_muted = disabled;
        }

        for key_track in clip_node.descendants().filter(|n| n.is_element() && n.has_tag_name("KeyTrack")) {
            let pitch = key_track
                .children()
                .find(|n| n.is_element() && n.has_tag_name("MidiKey"))
                .and_then(|n| n.attribute("Value"))
                .and_then(parse_i64_value)
                .map(|v| v.clamp(0, 127) as u8);
            let Some(pitch) = pitch else { continue };

            for note in key_track.descendants().filter(|n| n.is_element() && n.has_tag_name("MidiNoteEvent")) {
                let time_beats = note.attribute("Time").and_then(parse_f64_value).unwrap_or(0.0);
                let duration_note_beats = note.attribute("Duration").and_then(parse_f64_value).unwrap_or(0.0);
                let velocity = note
                    .attribute("Velocity")
                    .and_then(parse_i64_value)
                    .map(|v| v.clamp(1, 127) as u8)
                    .unwrap_or(100);
                let start_frame = beats_to_frames(time_beats, bpm, sample_rate).max(0);
                let duration_frames = beats_to_frames(duration_note_beats, bpm, sample_rate).max(1);
                clip.add_note(MidiNote::new(pitch, velocity, start_frame, duration_frames));
            }
        }

        track.midi_clips.push(clip);
    }
}

fn import_track_devices(
    track_node: roxmltree::Node<'_, '_>,
    track: &mut Track,
    external_plugins: &ExternalPluginIndex,
) {
    let container_tags = [
        "AudioEffectGroupDevice",
        "InstrumentGroupDevice",
        "DrumGroupDevice",
        "MidiEffectGroupDevice",
    ];

    for device in collect_track_devices(track_node) {
        let tag = device.tag_name().name();
        if container_tags.contains(&tag) {
            continue;
        }

        if tag == "PluginDevice" {
            let user_name = node_child_value(device, "UserName").unwrap_or_default();
            let vst3_name = device
                .descendants()
                .find(|n| n.is_element() && n.has_tag_name("Vst3PluginInfo"))
                .and_then(|vst3| {
                    vst3.children()
                        .find(|n| n.is_element() && n.has_tag_name("Name"))
                        .and_then(|n| n.attribute("Value"))
                })
                .unwrap_or_default()
                .to_string();
            let vst2_name = device
                .descendants()
                .find(|n| n.is_element() && n.has_tag_name("VstPluginInfo"))
                .and_then(|vst2| {
                    vst2.children()
                        .find(|n| n.is_element() && n.has_tag_name("PlugName"))
                        .and_then(|n| n.attribute("Value"))
                })
                .unwrap_or_default()
                .to_string();
            let vst2_path = device
                .descendants()
                .find(|n| n.is_element() && n.has_tag_name("VstPluginInfo"))
                .and_then(|vst2| {
                    vst2.children()
                        .find(|n| n.is_element() && n.has_tag_name("Path"))
                        .and_then(|n| n.attribute("Value"))
                })
                .unwrap_or_default()
                .to_string();

            let preferred_name = if !user_name.trim().is_empty() {
                user_name.trim().to_string()
            } else if !vst3_name.trim().is_empty() {
                vst3_name.trim().to_string()
            } else if !vst2_name.trim().is_empty() {
                vst2_name.trim().to_string()
            } else {
                "Unknown Plugin".to_string()
            };

            let resolved_plugin_id = if !vst2_path.trim().is_empty() && Path::new(vst2_path.trim()).exists() {
                Some(vst2_path.trim().to_string())
            } else if !vst3_name.trim().is_empty() {
                external_plugins.resolve_by_name(&vst3_name)
            } else if !vst2_name.trim().is_empty() {
                external_plugins.resolve_by_name(&vst2_name)
            } else {
                None
            };

            let is_instrument_slot = track.track_type == TrackType::Midi && track.instrument.is_none();
            let slot = if let Some(plugin_id) = resolved_plugin_id {
                PluginSlot::new(preferred_name, plugin_id)
            } else {
                make_missing_plugin_slot("external", &preferred_name)
            };

            if is_instrument_slot {
                track.instrument = Some(slot);
            } else {
                track.effects.push(slot);
            }
            continue;
        }

        let display_name = node_child_value(device, "UserName")
            .filter(|v| !v.trim().is_empty())
            .unwrap_or_else(|| tag.to_string());

        let canonical = canonical_internal_plugin_for_import(tag, &display_name);
        let is_instrument_slot = track.track_type == TrackType::Midi && track.instrument.is_none();
        if let Some((plugin_id, plugin_name, slot_kind)) = canonical {
            let slot = PluginSlot::new(plugin_name, plugin_id);
            if slot_kind == "instrument" && is_instrument_slot {
                track.instrument = Some(slot);
                if track.sampler.is_none() {
                    track.sampler = Some(SamplerConfig::default());
                }
                if plugin_id == "internal://instrument/wave-synth"
                    && let Some(cfg) = &mut track.sampler
                    && cfg.sample_path.trim().is_empty()
                {
                    cfg.sample_path = "internal://waveform/sine".to_string();
                }
            } else {
                track.effects.push(slot);
            }
        } else {
            let slot = make_missing_plugin_slot("ableton-device", &display_name);
            if is_instrument_slot {
                track.instrument = Some(slot);
            } else {
                track.effects.push(slot);
            }
        }
    }
}

fn import_als_project(file_path: &Path) -> Result<Project, String> {
    use std::io::Read;

    let bytes = std::fs::read(file_path).map_err(|e| format!("Failed to read ALS file '{}': {e}", file_path.display()))?;
    let xml_bytes = {
        let mut decoder = flate2::read::GzDecoder::new(&bytes[..]);
        let mut inflated = Vec::new();
        match decoder.read_to_end(&mut inflated) {
            Ok(_) if !inflated.is_empty() => inflated,
            _ => bytes,
        }
    };
    let xml_text = std::str::from_utf8(&xml_bytes)
        .map_err(|e| format!("ALS is not valid UTF-8 XML: {e}"))?;
    let doc = roxmltree::Document::parse(xml_text)
        .map_err(|e| format!("Failed to parse ALS XML: {e}"))?;

    let live_set = doc
        .descendants()
        .find(|n| n.is_element() && n.has_tag_name("LiveSet"))
        .ok_or("ALS parse error: <LiveSet> node not found")?;

    let tempo = live_set
        .descendants()
        .find(|n| n.is_element() && n.has_tag_name("MainTrack"))
        .and_then(|main_track| {
            main_track
                .descendants()
                .find(|n| n.is_element() && n.has_tag_name("Tempo"))
        })
        .and_then(|tempo_node| {
            tempo_node
                .children()
                .find(|n| n.is_element() && n.has_tag_name("Manual"))
                .and_then(|manual| manual.attribute("Value"))
                .and_then(parse_f64_value)
        })
        .unwrap_or(120.0);

    let project_name = file_path
        .file_stem()
        .and_then(|s| s.to_str())
        .map(|s| s.trim())
        .filter(|s| !s.is_empty())
        .unwrap_or("Imported Ableton Project")
        .to_string();
    let sample_rate = 44100.0;
    let mut project = Project::new(project_name, tempo, sample_rate);
    project.tracks.clear();

    let external_plugins = ExternalPluginIndex::build();

    let tracks_node = live_set
        .children()
        .find(|n| n.is_element() && n.has_tag_name("Tracks"))
        .or_else(|| live_set.descendants().find(|n| n.is_element() && n.has_tag_name("Tracks")))
        .ok_or("ALS parse error: <Tracks> node not found")?;

    let mut xml_id_to_uuid = std::collections::HashMap::<String, Uuid>::new();
    let mut pending_group_refs = Vec::<(Uuid, String)>::new();

    for (index, track_node) in tracks_node.children().filter(|n| n.is_element()).enumerate() {
        let tag = track_node.tag_name().name();
        let track_type = match tag {
            "AudioTrack" => TrackType::Audio,
            "MidiTrack" => TrackType::Midi,
            "GroupTrack" => TrackType::Group,
            _ => continue,
        };

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

        let mut track = Track::with_type(track_name, track_type, index);

        if let Some(mixer) = track_node
            .children()
            .find(|n| n.is_element() && n.has_tag_name("DeviceChain"))
            .and_then(|dc| dc.children().find(|n| n.is_element() && n.has_tag_name("Mixer")))
        {
            if let Some(volume) = maybe_parse_f64_manual(mixer, "Volume") {
                track.volume = volume.clamp(0.0, 2.0);
            }
            if let Some(pan) = maybe_parse_f64_manual(mixer, "Pan") {
                track.pan = pan.clamp(-1.0, 1.0);
            }
            let on = maybe_parse_bool_manual(mixer, "On");
            let speaker = maybe_parse_bool_manual(mixer, "Speaker");
            track.is_mute = on == Some(false) || speaker == Some(false);
        }

        import_track_devices(track_node, &mut track, &external_plugins);
        import_track_clips(track_node, &mut track, file_path, tempo, sample_rate);

        if track_type == TrackType::Midi && track.instrument.is_none() {
            track.instrument = Some(make_missing_plugin_slot("instrument", "Ableton Instrument"));
            if track.sampler.is_none() {
                track.sampler = Some(SamplerConfig::default());
            }
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

    if let Some(main_track) = live_set.descendants().find(|n| n.is_element() && n.has_tag_name("MainTrack")) {
        import_track_devices(main_track, &mut project.master_track, &external_plugins);
    }

    normalize_internal_plugins_for_import(&mut project);
    Ok(project)
}

#[derive(Debug, Default)]
struct ImportedAudioClip {
    name: String,
    start_beats: f64,
    end_beats: f64,
    file_path: Option<String>,
}

#[derive(Debug, Default)]
struct ImportedMidiNote {
    pitch: u8,
    start_beats: f64,
    duration_beats: f64,
    velocity: u8,
}

#[derive(Debug, Default)]
struct ImportedMidiClip {
    name: String,
    start_beats: f64,
    end_beats: f64,
    notes: Vec<ImportedMidiNote>,
}

#[derive(Debug)]
enum ImportedTrackKind {
    Audio,
    Midi,
}

#[derive(Debug, Default)]
struct ImportedTrack {
    name: String,
    kind: Option<ImportedTrackKind>,
    audio_clips: Vec<ImportedAudioClip>,
    midi_clips: Vec<ImportedMidiClip>,
}

#[derive(Debug)]
struct AbletonImportData {
    bpm: f64,
    time_signature: dream_models::project::TimeSignature,
    tracks: Vec<ImportedTrack>,
}

impl Default for AbletonImportData {
    fn default() -> Self {
        Self {
            bpm: 120.0,
            time_signature: dream_models::project::TimeSignature::default(),
            tracks: Vec::new(),
        }
    }
}

fn attr_value(tag: &BytesStart<'_>, key: &[u8]) -> Option<String> {
    for attr in tag.attributes().flatten() {
        if attr.key.as_ref() == key {
            return Some(String::from_utf8_lossy(attr.value.as_ref()).to_string());
        }
    }
    None
}

fn parse_f64_attr(tag: &BytesStart<'_>, key: &[u8]) -> Option<f64> {
    attr_value(tag, key).and_then(|v| v.parse::<f64>().ok())
}

fn parse_u8_attr(tag: &BytesStart<'_>, key: &[u8]) -> Option<u8> {
    attr_value(tag, key).and_then(|v| v.parse::<u8>().ok())
}

fn resolve_sample_path(raw: &str, als_path: &Path) -> String {
    let trimmed = raw.trim();
    if trimmed.is_empty() {
        return String::new();
    }
    let candidate = PathBuf::from(trimmed);
    if candidate.is_absolute() {
        return candidate.to_string_lossy().to_string();
    }
    if let Some(parent) = als_path.parent() {
        let joined = parent.join(candidate);
        return joined.to_string_lossy().to_string();
    }
    trimmed.to_string()
}

fn parse_ableton_als(path: &Path) -> Result<AbletonImportData, String> {
    let file = std::fs::File::open(path).map_err(|e| format!("Unable to open ALS file: {}", e))?;
    let mut gz = GzDecoder::new(file);
    let mut xml = String::new();
    gz.read_to_string(&mut xml)
        .map_err(|e| format!("Unable to decompress ALS file: {}", e))?;

    let mut reader = Reader::from_str(&xml);
    reader.config_mut().trim_text(true);

    let mut data = AbletonImportData::default();
    let mut stack: Vec<String> = Vec::new();

    let mut current_track: Option<ImportedTrack> = None;
    let mut current_audio_clip: Option<ImportedAudioClip> = None;
    let mut current_midi_clip: Option<ImportedMidiClip> = None;
    let mut pending_keytrack_notes: Vec<(f64, f64, u8)> = Vec::new();

    let mut in_tempo = false;
    let mut in_global_time_sig = false;
    let mut pending_num: Option<u8> = None;
    let mut pending_den: Option<u8> = None;

    let mut in_audio_sample_ref = false;

    loop {
        match reader.read_event() {
            Ok(Event::Start(tag)) => {
                let name = String::from_utf8_lossy(tag.local_name().as_ref()).to_string();
                stack.push(name.clone());

                match name.as_str() {
                    "AudioTrack" => {
                        let mut t = ImportedTrack::default();
                        t.kind = Some(ImportedTrackKind::Audio);
                        current_track = Some(t);
                    }
                    "MidiTrack" => {
                        let mut t = ImportedTrack::default();
                        t.kind = Some(ImportedTrackKind::Midi);
                        current_track = Some(t);
                    }
                    "AudioClip" => {
                        current_audio_clip = Some(ImportedAudioClip {
                            start_beats: parse_f64_attr(&tag, b"Time").unwrap_or(0.0),
                            end_beats: 0.0,
                            ..ImportedAudioClip::default()
                        });
                    }
                    "MidiClip" => {
                        current_midi_clip = Some(ImportedMidiClip {
                            start_beats: parse_f64_attr(&tag, b"Time").unwrap_or(0.0),
                            end_beats: 0.0,
                            ..ImportedMidiClip::default()
                        });
                    }
                    "Tempo" => {
                        if current_track.is_none() && current_audio_clip.is_none() && current_midi_clip.is_none() {
                            in_tempo = true;
                        }
                    }
                    "TimeSignature" => {
                        if current_track.is_none() && current_audio_clip.is_none() && current_midi_clip.is_none() {
                            in_global_time_sig = true;
                            pending_num = None;
                            pending_den = None;
                        }
                    }
                    "SampleRef" => {
                        if current_audio_clip.is_some() {
                            in_audio_sample_ref = true;
                        }
                    }
                    "MidiNoteEvent" => {
                        if current_midi_clip.is_some() {
                            let start = parse_f64_attr(&tag, b"Time").unwrap_or(0.0);
                            let duration = parse_f64_attr(&tag, b"Duration").unwrap_or(0.25);
                            let velocity = parse_u8_attr(&tag, b"Velocity").unwrap_or(100).clamp(1, 127);
                            pending_keytrack_notes.push((start, duration.max(0.001), velocity));
                        }
                    }
                    "MidiKey" => {
                        if let Some(clip) = current_midi_clip.as_mut() {
                            let pitch = parse_u8_attr(&tag, b"Value").unwrap_or(60).min(127);
                            for (start, duration, velocity) in pending_keytrack_notes.drain(..) {
                                clip.notes.push(ImportedMidiNote {
                                    pitch,
                                    start_beats: start,
                                    duration_beats: duration,
                                    velocity,
                                });
                            }
                        }
                    }
                    _ => {}
                }
            }
            Ok(Event::Empty(tag)) => {
                let name = String::from_utf8_lossy(tag.local_name().as_ref()).to_string();
                match name.as_str() {
                    "Manual" => {
                        if in_tempo && let Some(v) = parse_f64_attr(&tag, b"Value") && (20.0..=400.0).contains(&v) {
                            data.bpm = v;
                        }
                    }
                    "Numerator" => {
                        if in_global_time_sig {
                            pending_num = parse_u8_attr(&tag, b"Value");
                        }
                    }
                    "Denominator" => {
                        if in_global_time_sig {
                            pending_den = parse_u8_attr(&tag, b"Value");
                        }
                    }
                    "CurrentStart" => {
                        if let Some(c) = current_audio_clip.as_mut()
                            && let Some(v) = parse_f64_attr(&tag, b"Value")
                        {
                            c.start_beats = v;
                        }
                        if let Some(c) = current_midi_clip.as_mut()
                            && let Some(v) = parse_f64_attr(&tag, b"Value")
                        {
                            c.start_beats = v;
                        }
                    }
                    "CurrentEnd" => {
                        if let Some(c) = current_audio_clip.as_mut()
                            && let Some(v) = parse_f64_attr(&tag, b"Value")
                        {
                            c.end_beats = v;
                        }
                        if let Some(c) = current_midi_clip.as_mut()
                            && let Some(v) = parse_f64_attr(&tag, b"Value")
                        {
                            c.end_beats = v;
                        }
                    }
                    "Name" => {
                        if let Some(value) = attr_value(&tag, b"Value") {
                            if let Some(c) = current_audio_clip.as_mut() {
                                c.name = value;
                            } else if let Some(c) = current_midi_clip.as_mut() {
                                c.name = value;
                            }
                        }
                    }
                    "EffectiveName" => {
                        if let Some(t) = current_track.as_mut()
                            && let Some(value) = attr_value(&tag, b"Value")
                            && !value.trim().is_empty()
                        {
                            t.name = value;
                        }
                    }
                    "Path" => {
                        if in_audio_sample_ref
                            && let Some(c) = current_audio_clip.as_mut()
                            && let Some(value) = attr_value(&tag, b"Value")
                            && !value.trim().is_empty()
                        {
                            c.file_path = Some(resolve_sample_path(&value, path));
                        }
                    }
                    "RelativePath" => {
                        if in_audio_sample_ref
                            && let Some(c) = current_audio_clip.as_mut()
                            && c.file_path.as_deref().unwrap_or("").is_empty()
                            && let Some(value) = attr_value(&tag, b"Value")
                            && !value.trim().is_empty()
                        {
                            c.file_path = Some(resolve_sample_path(&value, path));
                        }
                    }
                    _ => {}
                }
            }
            Ok(Event::End(tag)) => {
                let name = String::from_utf8_lossy(tag.local_name().as_ref()).to_string();
                match name.as_str() {
                    "Tempo" => in_tempo = false,
                    "TimeSignature" => {
                        if in_global_time_sig {
                            if let (Some(n), Some(d)) = (pending_num, pending_den)
                                && n > 0
                                && d > 0
                            {
                                data.time_signature = dream_models::project::TimeSignature {
                                    numerator: n,
                                    denominator: d,
                                };
                            }
                            in_global_time_sig = false;
                        }
                    }
                    "SampleRef" => in_audio_sample_ref = false,
                    "AudioClip" => {
                        if let Some(track) = current_track.as_mut()
                            && let Some(mut clip) = current_audio_clip.take()
                        {
                            if clip.end_beats <= clip.start_beats {
                                clip.end_beats = clip.start_beats + 1.0;
                            }
                            if clip.name.trim().is_empty() {
                                clip.name = "Audio Clip".to_string();
                            }
                            if clip.file_path.as_deref().unwrap_or("").trim().is_empty() {
                                clip.file_path = None;
                            }
                            track.audio_clips.push(clip);
                        }
                    }
                    "MidiClip" => {
                        if let Some(track) = current_track.as_mut()
                            && let Some(mut clip) = current_midi_clip.take()
                        {
                            if clip.end_beats <= clip.start_beats {
                                clip.end_beats = clip.start_beats + 1.0;
                            }
                            if clip.name.trim().is_empty() {
                                clip.name = "MIDI Clip".to_string();
                            }
                            track.midi_clips.push(clip);
                        }
                    }
                    "AudioTrack" | "MidiTrack" => {
                        if let Some(mut t) = current_track.take() {
                            if t.name.trim().is_empty() {
                                t.name = if matches!(t.kind, Some(ImportedTrackKind::Audio)) {
                                    "Audio Track".to_string()
                                } else {
                                    "MIDI Track".to_string()
                                };
                            }
                            data.tracks.push(t);
                        }
                    }
                    "KeyTrack" => {
                        pending_keytrack_notes.clear();
                    }
                    _ => {}
                }
                let _ = stack.pop();
            }
            Ok(Event::Eof) => break,
            Err(err) => return Err(format!("Failed to parse ALS XML: {}", err)),
            _ => {}
        }
    }

    Ok(data)
}

fn build_project_from_ableton_import(path: &Path, parsed: AbletonImportData) -> Result<Project, String> {
    let project_name = path
        .file_stem()
        .and_then(|s| s.to_str())
        .unwrap_or("Imported Ableton Project")
        .trim();
    let sr = 44_100.0;
    let bpm = parsed.bpm.clamp(20.0, 400.0);
    let mut project = Project::new(project_name, bpm, sr);
    project.time_signature = parsed.time_signature;

    let beats_per_second = bpm / 60.0;
    let to_frames = |beats: f64| -> i64 {
        ((beats.max(0.0) / beats_per_second) * sr).round() as i64
    };

    for (idx, imported_track) in parsed.tracks.into_iter().enumerate() {
        let track_type = match imported_track.kind.unwrap_or(ImportedTrackKind::Audio) {
            ImportedTrackKind::Audio => TrackType::Audio,
            ImportedTrackKind::Midi => TrackType::Midi,
        };
        let mut track = Track::with_type(imported_track.name, track_type, idx);

        for imported in imported_track.audio_clips {
            let Some(file_path) = imported.file_path else { continue };
            let start = to_frames(imported.start_beats);
            let end = to_frames(imported.end_beats);
            let duration_frames = (end - start).max(1);
            let mut clip = AudioClip::new(
                imported.name,
                file_path,
                AbsoluteTime::new(start),
                AbsoluteTime::new(duration_frames),
            );
            clip.source_offset = AbsoluteTime::ZERO;
            track.clips.push(clip);
        }

        for imported in imported_track.midi_clips {
            let start = to_frames(imported.start_beats);
            let end = to_frames(imported.end_beats);
            let duration_frames = (end - start).max(1);
            let mut clip = dream_models::midi::MidiClip::new(
                imported.name,
                AbsoluteTime::new(start),
                AbsoluteTime::new(duration_frames),
            );
            for note in imported.notes {
                let note_start = to_frames(note.start_beats);
                let note_dur = to_frames(note.duration_beats).max(1);
                clip.notes.push(dream_models::midi::MidiNote::new(
                    note.pitch,
                    note.velocity.clamp(1, 127),
                    note_start.max(0),
                    note_dur,
                ));
            }
            clip.notes.sort_by_key(|n| n.start_frame);
            track.midi_clips.push(clip);
        }

        if !track.clips.is_empty() || !track.midi_clips.is_empty() {
            project.add_track(track);
        }
    }

    if project.tracks.is_empty() {
        return Err("No supported tracks/clips were found in the Ableton project.".to_string());
    }

    refresh_offline_flags(&mut project);
    Ok(project)
}

#[tauri::command]
fn import_ableton_project(
    path: String,
    project_state: tauri::State<'_, ProjectState>,
    clip_pool_state: tauri::State<'_, ClipPoolState>,
    automation_runtime: tauri::State<'_, AutomationRuntime>,
    handle: tauri::State<'_, AudioEngineHandle>,
    app: tauri::AppHandle,
) -> Result<Project, String> {
    let file_path = PathBuf::from(&path);
    if !file_path.exists() {
        return Err(format!("File does not exist: {}", file_path.display()));
    }
    if file_path.extension().and_then(|s| s.to_str()).unwrap_or("").to_lowercase() != "als" {
        return Err("Only .als files can be imported with this command.".to_string());
    }

    let parsed = parse_ableton_als(&file_path)?;
    let mut imported = build_project_from_ableton_import(&file_path, parsed)?;
    normalize_internal_plugins_for_import(&mut imported);

    *project_state.project.lock().map_err(|e| e.to_string())? = imported.clone();
    *project_state.file_path.lock().map_err(|e| e.to_string())? = None;
    *project_state.project_folder.lock().map_err(|e| e.to_string())? = file_path.parent().map(|p| p.to_path_buf());
    *project_state.is_dirty.lock().map_err(|e| e.to_string())? = true;
    *project_state.undo.lock().map_err(|e| e.to_string())? = UndoState::new();
    clip_pool_state.rebuild_snapshot(&imported);
    clip_pool_state.load_project_clips(&imported);
    rebuild_automation_snapshot_from_project(&imported, &automation_runtime);
    rebuild_midi_snapshot_from_project(&imported, &handle);
    rebuild_sampler_snapshot_from_project(&imported, &clip_pool_state, &handle);
    rebuild_runtime_device_chains_from_project(&imported, &handle)?;
    sync_transport_from_project(&imported, &handle)?;

    if let Some(window) = app.get_webview_window("main") {
        let _ = window.set_title(&format!("Dream DAW — {} (Imported)", imported.name));
    }

    log::info!("Ableton project imported from: {}", file_path.display());
    Ok(imported)
}

/// Creates a new empty project and replaces the current one.
#[tauri::command]
fn new_project(
    project_state: tauri::State<'_, ProjectState>,
    clip_pool_state: tauri::State<'_, ClipPoolState>,
    automation_runtime: tauri::State<'_, AutomationRuntime>,
    handle: tauri::State<'_, AudioEngineHandle>,
    app: tauri::AppHandle,
) -> Result<Project, String> {
    let mut new = Project::default();
    refresh_offline_flags(&mut new);
    *project_state.project.lock().map_err(|e| e.to_string())? = new.clone();
    *project_state.file_path.lock().map_err(|e| e.to_string())? = None;
    *project_state.project_folder.lock().map_err(|e| e.to_string())? = None;
    *project_state.is_dirty.lock().map_err(|e| e.to_string())? = false;
    *project_state.undo.lock().map_err(|e| e.to_string())? = UndoState::new();
    clip_pool_state.rebuild_snapshot(&new);
    rebuild_automation_snapshot_from_project(&new, &automation_runtime);
    rebuild_midi_snapshot_from_project(&new, &handle);
    rebuild_sampler_snapshot_from_project(&new, &clip_pool_state, &handle);
    rebuild_runtime_device_chains_from_project(&new, &handle)?;
    sync_transport_from_project(&new, &handle)?;

    // Update window title
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.set_title(&format!("Dream DAW — {}", new.name));
    }

    log::info!("New project created: '{}'", new.name);
    Ok(new)
}

/// Saves the current project to its existing path (or fails if unsaved).
#[tauri::command]
fn save_project(
    project_state: tauri::State<'_, ProjectState>,
    app: tauri::AppHandle,
) -> Result<String, String> {
    let mut project = project_state.project.lock().map_err(|e| e.to_string())?;
    let file_path_guard = project_state.file_path.lock().map_err(|e| e.to_string())?;

    let path = file_path_guard
        .as_ref()
        .ok_or("No file path set. Use Save As first.")?
        .clone();

    // Keep project name aligned with the active file name.
    if let Some(stem) = path.file_stem().and_then(|s| s.to_str()) {
        let normalized = stem.trim_end_matches(".dream").trim();
        if !normalized.is_empty() && project.name != normalized {
            project.name = normalized.to_string();
        }
    }

    ProjectFile::save(&project, &path).map_err(|e| e.to_string())?;

    *project_state.is_dirty.lock().map_err(|e| e.to_string())? = false;

    // Update window title (also clears any dirty marker left from mark_dirty_cmd).
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.set_title(&format!("Dream DAW — {}", project.name));
    }

    log::info!("Project saved: '{}' → {}", project.name, path.display());
    Ok(path.display().to_string())
}

/// Saves the project to a specific path.
#[tauri::command]
fn save_project_as(
    path: String,
    project_state: tauri::State<'_, ProjectState>,
    app: tauri::AppHandle,
) -> Result<String, String> {
    let mut project = project_state.project.lock().map_err(|e| e.to_string())?;
    let file_path = PathBuf::from(&path);

    // Determine if we should create an Ableton-style folder structure.
    // If the user chose a path like "Foo.dream.json", we create:
    //   parent/Foo/Foo.dream.json + Samples/ + Backup/
    let parent_dir = file_path.parent().unwrap_or(std::path::Path::new("."));
    let project_name = file_path
        .file_stem()
        .and_then(|s| s.to_str())
        .unwrap_or(&project.name)
        .trim_end_matches(".dream")
        .to_string();

    // Save As should establish the active project name from chosen filename.
    if !project_name.trim().is_empty() {
        project.name = project_name.trim().to_string();
    }

    let (actual_file_path, folder) = if ProjectManager::is_project_directory(parent_dir) {
        // Already inside a project directory — save in place
        ProjectFile::save(&project, &file_path)
            .map_err(|e| e.to_string())?;
        (file_path.clone(), parent_dir.to_path_buf())
    } else {
        // New location — create Ableton-style folder structure
        let folder = ProjectManager::create_project_folder(parent_dir, &project_name)
            .map_err(|e| e.to_string())?;
        let saved_path = ProjectManager::save_to_folder(&project, &folder, true)
            .map_err(|e| e.to_string())?;
        (saved_path, folder)
    };

    *project_state.file_path.lock().map_err(|e| e.to_string())? = Some(actual_file_path.clone());
    *project_state.project_folder.lock().map_err(|e| e.to_string())? = Some(folder);
    *project_state.is_dirty.lock().map_err(|e| e.to_string())? = false;

    // Track in recent projects
    let result_path = actual_file_path.display().to_string();
    if let Ok(app_data_dir) = app.path().app_data_dir() {
        let mut recent = RecentProjects::load(&app_data_dir);
        recent.add(project.name.clone(), result_path.clone());
        let _ = recent.save(&app_data_dir);
    }

    // Update window title
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.set_title(&format!("Dream DAW — {}", project.name));
    }

    log::info!("Project saved as: '{}' → {}", project.name, actual_file_path.display());
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
    app: tauri::AppHandle,
) -> Result<Project, String> {
    if PathBuf::from(&path)
        .extension()
        .and_then(|s| s.to_str())
        .map(|e| e.eq_ignore_ascii_case("als"))
        .unwrap_or(false)
    {
        return import_ableton_project(
            path,
            project_state,
            clip_pool_state,
            automation_runtime,
            handle,
            app,
        );
    }

    let file_path = PathBuf::from(&path);

    let importing_als = file_path
        .extension()
        .and_then(|s| s.to_str())
        .map(|s| s.eq_ignore_ascii_case("als"))
        .unwrap_or(false);

    let mut loaded = if importing_als {
        import_als_project(&file_path)?
    } else {
        let mut project = ProjectFile::load(&file_path).map_err(|e| e.to_string())?;
        normalize_internal_plugins_for_import(&mut project);
        project
    };
    refresh_offline_flags(&mut loaded);

    *project_state.project.lock().map_err(|e| e.to_string())? = loaded.clone();
    *project_state.file_path.lock().map_err(|e| e.to_string())? = if importing_als {
        None
    } else {
        Some(file_path.clone())
    };
    *project_state.is_dirty.lock().map_err(|e| e.to_string())? = importing_als;
    *project_state.undo.lock().map_err(|e| e.to_string())? = UndoState::new();
    clip_pool_state.rebuild_snapshot(&loaded);
    clip_pool_state.load_project_clips(&loaded);
    rebuild_automation_snapshot_from_project(&loaded, &automation_runtime);
    rebuild_midi_snapshot_from_project(&loaded, &handle);
    rebuild_sampler_snapshot_from_project(&loaded, &clip_pool_state, &handle);
    rebuild_runtime_device_chains_from_project(&loaded, &handle)?;
    sync_transport_from_project(&loaded, &handle)?;

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
    let mut project = project_state.project.lock().map_err(|e| e.to_string())?;
    refresh_offline_flags(&mut project);
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
