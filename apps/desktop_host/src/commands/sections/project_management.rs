// ═══════════════════════════════════════════════════════════════════════
use std::path::{Path, PathBuf};

fn canonical_internal_plugin_for_import(plugin_id: &str, plugin_name: &str) -> Option<(&'static str, &'static str, &'static str)> {
    let merged = format!("{} {}", plugin_id, plugin_name).to_lowercase();
    let compact = merged.replace(|c: char| !c.is_ascii_alphanumeric(), "");

    if compact.contains("originalsimpler") || compact.contains("drift") || compact.contains("instrumentvector") {
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
        || compact.contains("instrumentvector")
    {
        return Some(("internal://instrument/wave-synth", "Wave Synth", "instrument"));
    }
    if merged.contains("sampler") || merged.contains("simpler") || compact.contains("multisampler") {
        return Some(("internal://instrument/sampler", "Sampler", "instrument"));
    }

    if merged.contains("eq") || merged.contains("channel eq") {
        return Some(("internal://effect/eq-eight", "EQ Eight", "effect"));
    }
    if merged.contains("compressor") || merged.contains("glue") || compact.contains("multibanddynamics") || compact.contains("drumbuss") {
        return Some(("internal://effect/compressor", "Compressor", "effect"));
    }
    if merged.contains("delay") || merged.contains("echo") || merged.contains("ping pong")
        || compact.contains("beatrepeat") || compact.contains("graindelay")
        || compact.contains("filterdelay") || compact.contains("spectraltime")
    {
        return Some(("internal://effect/delay", "Delay", "effect"));
    }
    if merged.contains("reverb") || merged.contains("corpus") || merged.contains("resonators")
        || compact.contains("spectralresonator") || compact.contains("resonator")
        || compact.contains("hybrid")
    {
        return Some(("internal://effect/reverb", "Reverb", "effect"));
    }
    if merged.contains("chorus") {
        return Some(("internal://effect/chorus", "Chorus", "effect"));
    }
    if compact.contains("stereogain") {
        return Some(("internal://effect/utility", "Utility", "effect"));
    }
    if compact.contains("autopan") {
        return Some(("internal://effect/auto-pan", "Auto Pan", "effect"));
    }
    if compact.contains("midipitcher") {
        return Some(("internal://midi-fx/pitch", "MIDI Pitch", "effect"));
    }
    if compact.contains("mxdevicescale") || compact == "scale" {
        return Some(("internal://midi-fx/scale", "MIDI Scale", "effect"));
    }
    if compact.contains("mxdevicevelocity") || compact == "velocity" {
        return Some(("internal://midi-fx/velocity", "MIDI Velocity", "effect"));
    }
    if compact.contains("mxdevicerandom") || compact == "random" || compact.contains("midirandom") {
        return Some(("internal://midi-fx/random", "MIDI Random", "effect"));
    }
    if compact.contains("midinotelength") {
        return Some(("internal://midi-fx/velocity", "MIDI Note Length", "effect"));
    }
    if merged.contains("noise machine") || compact.contains("noisemachine") {
        return Some(("internal://effect/noise-machine", "Noise Machine", "effect"));
    }
    if merged.contains("saturator") || compact.contains("dynamictube") || compact.contains("roar") || compact == "tube" {
        return Some(("internal://effect/saturator", "Saturator", "effect"));
    }
    if merged.contains("spectrum") {
        return Some(("internal://effect/spectrum", "Spectrum", "effect"));
    }
    if merged.contains("utility") || merged.contains("looper") || merged.contains("tuner")
        || compact.contains("frequencyshifter")
        || compact.contains("pitchhack") || compact.contains("spectral")
        || compact.contains("mxdeviceaudioeffect") || compact.contains("mxdevicemidieffect")
    {
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
    if merged.contains("distortion") || merged.contains("overdrive") || merged.contains("pedal")
        || merged.contains("cabinet") || merged.contains("amp") || merged.contains("shaper")
    {
        return Some(("internal://effect/distortion", "Distortion", "effect"));
    }
    if merged.contains("erosion") || merged.contains("transmute") || merged.contains("vocoder")
        || merged.contains("vinyl")
    {
        return Some(("internal://effect/distortion", "Distortion", "effect"));
    }
    if merged.contains("bitcrusher") || merged.contains("redux") || compact.contains("redux2") {
        return Some(("internal://effect/bitcrusher", "Bitcrusher", "effect"));
    }
    None
}

fn normalize_internal_plugins_for_import(project: &mut Project) {
    for track in &mut project.tracks {
        if let Some(inst) = &mut track.instrument {
            let pid = inst.plugin_id();
            let pname = inst.name().to_string();
            if let Some((canonical_id, canonical_name, slot)) =
                canonical_internal_plugin_for_import(&pid, &pname)
                && slot == "instrument"
            {
                inst.set_plugin_id(canonical_id);
                if pname.trim().is_empty() || pname.to_lowercase() != canonical_name.to_lowercase() {
                    inst.set_name(canonical_name);
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
        }
        for fx in &mut track.effects {
            let pid = fx.plugin_id();
            let pname = fx.name().to_string();
            if let Some((canonical_id, canonical_name, slot)) =
                canonical_internal_plugin_for_import(&pid, &pname)
                && slot == "effect"
            {
                fx.set_plugin_id(canonical_id);
                if pname.trim().is_empty() || pname.to_lowercase() != canonical_name.to_lowercase() {
                    fx.set_name(canonical_name);
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

fn direct_manual_value(node: roxmltree::Node<'_, '_>) -> Option<String> {
    node.children()
        .find(|c| c.is_element() && c.has_tag_name("Manual"))
        .and_then(|manual| manual.attribute("Value"))
        .map(|s| s.to_string())
}

fn parse_track_send_manual_values(mixer: roxmltree::Node<'_, '_>) -> Vec<(usize, f64)> {
    let mut sends = Vec::new();
    for (idx, holder) in mixer
        .descendants()
        .filter(|n| n.is_element() && n.has_tag_name("TrackSendHolder"))
        .enumerate()
    {
        let Some(send_node) = holder
            .children()
            .find(|n| n.is_element() && n.has_tag_name("Send"))
        else {
            continue;
        };
        let value = direct_manual_value(send_node)
            .as_deref()
            .and_then(parse_f64_value)
            .unwrap_or(0.0)
            .clamp(0.0, 2.0);
        sends.push((idx, value));
    }
    sends
}

fn parse_audio_output_target(track_node: roxmltree::Node<'_, '_>) -> Option<String> {
    track_node
        .children()
        .find(|n| n.is_element() && n.has_tag_name("DeviceChain"))
        .and_then(|dc| dc.children().find(|n| n.is_element() && n.has_tag_name("AudioOutputRouting")))
        .and_then(|routing| routing.children().find(|n| n.is_element() && n.has_tag_name("Target")))
        .and_then(|target| target.attribute("Value"))
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())
}

fn parse_target_track_xml_id(target: &str) -> Option<String> {
    for segment in target.split('/') {
        let segment = segment.trim();
        let Some((kind, id)) = segment.split_once('.') else {
            continue;
        };
        if !["Track", "AudioTrack", "MidiTrack", "ReturnTrack", "GroupTrack"].contains(&kind) {
            continue;
        }
        let id = id.trim();
        if id.is_empty() || id == "-1" || !id.chars().all(|c| c.is_ascii_digit() || c == '-') {
            continue;
        }
        return Some(id.to_string());
    }
    None
}

fn resolve_als_file_path(
    als_path: &Path,
    absolute_path: Option<&str>,
    relative_path: Option<&str>,
) -> Option<String> {
    fn try_existing_variants(raw: &str) -> Option<String> {
        let trimmed = raw.trim();
        if trimmed.is_empty() {
            return None;
        }

        let candidates = [
            trimmed.to_string(),
            trimmed.replace(" - ", "-"),
            trimmed.replace(" -", "-"),
            trimmed.replace("- ", "-"),
            trimmed.replace("ABLETON - Projects", "ABLETON - Projects"),
            trimmed.replace("160 - 200 BPM", "160-200 BPM"),
        ];
        for candidate in candidates {
            if std::path::Path::new(&candidate).exists() {
                return Some(candidate);
            }
        }
        None
    }

    fn search_near_project(als_path: &Path, raw: &str) -> Option<String> {
        let file_name = std::path::Path::new(raw)
            .file_name()
            .and_then(|s| s.to_str())
            .unwrap_or_default()
            .to_string();
        if file_name.is_empty() {
            return None;
        }
        let root = als_path.parent()?;
        let hot_dirs = [
            root.join("Samples").join("Imported"),
            root.join("Samples").join("Processed"),
            root.join("Samples").join("Recorded"),
            root.join("Samples"),
        ];
        for dir in hot_dirs {
            if !dir.exists() {
                continue;
            }
            if let Ok(entries) = std::fs::read_dir(&dir) {
                for entry in entries.flatten() {
                    let path = entry.path();
                    if path.is_file()
                        && path
                            .file_name()
                            .and_then(|s| s.to_str())
                            .map(|n| n.eq_ignore_ascii_case(&file_name))
                            .unwrap_or(false)
                    {
                        return Some(path.to_string_lossy().to_string());
                    }
                }
            }
        }
        None
    }

    if let Some(abs) = absolute_path
        && !abs.trim().is_empty()
    {
        if let Some(found) = try_existing_variants(abs) {
            return Some(found);
        }
        if let Some(found) = search_near_project(als_path, abs) {
            return Some(found);
        }
        return Some(abs.trim().to_string());
    }
    if let Some(rel) = relative_path
        && !rel.trim().is_empty()
    {
        let rel_path = PathBuf::from(rel);
        if rel_path.is_absolute() {
            if let Some(found) = try_existing_variants(&rel_path.to_string_lossy()) {
                return Some(found);
            }
            return Some(rel_path.to_string_lossy().to_string());
        }
        let parent = als_path.parent().unwrap_or_else(|| Path::new("."));
        let joined = parent.join(rel_path).to_string_lossy().to_string();
        if let Some(found) = try_existing_variants(&joined) {
            return Some(found);
        }
        if let Some(found) = search_near_project(als_path, &joined) {
            return Some(found);
        }
        return Some(joined);
    }
    None
}

fn make_missing_plugin_slot(kind: &str, ableton_name: &str) -> DeviceNode {
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
    DeviceNode::Single(PluginSlot::new(
        format!("Plugin Not Found: {}", ableton_name.trim()),
        format!("missing://{kind}/{slug}"),
    ))
}

fn normalize_plugin_key(raw: &str) -> String {
    raw.chars()
        .filter(|c| c.is_ascii_alphanumeric())
        .map(|c| c.to_ascii_lowercase())
        .collect()
}

struct ExternalPluginIndex {
    by_name: std::collections::HashMap<String, String>,
    by_stem: std::collections::HashMap<String, String>,
    by_file_name: std::collections::HashMap<String, String>,
    by_normalized: std::collections::HashMap<String, String>,
}

impl ExternalPluginIndex {
    fn build() -> Self {
        let mut by_name = std::collections::HashMap::new();
        let mut by_stem = std::collections::HashMap::new();
        let mut by_file_name = std::collections::HashMap::new();
        let mut by_normalized = std::collections::HashMap::new();

        for desc in dream_plugins::PluginScanner::new().scan_all() {
            let path_str = desc.path.to_string_lossy().to_string();
            let name_key = desc.name.to_lowercase();
            by_name.entry(name_key).or_insert_with(|| path_str.clone());
            let normalized_name = normalize_plugin_key(&desc.name);
            if !normalized_name.is_empty() {
                by_normalized
                    .entry(normalized_name)
                    .or_insert_with(|| path_str.clone());
            }

            let stem_key = desc
                .path
                .file_stem()
                .and_then(|s| s.to_str())
                .unwrap_or_default()
                .to_lowercase();
            if !stem_key.is_empty() {
                by_stem.entry(stem_key).or_insert_with(|| path_str.clone());
                let normalized_stem = normalize_plugin_key(
                    desc.path.file_stem().and_then(|s| s.to_str()).unwrap_or_default(),
                );
                if !normalized_stem.is_empty() {
                    by_normalized
                        .entry(normalized_stem)
                        .or_insert_with(|| path_str.clone());
                }
            }

            let file_key = desc
                .path
                .file_name()
                .and_then(|s| s.to_str())
                .unwrap_or_default()
                .to_lowercase();
            if !file_key.is_empty() {
                by_file_name.entry(file_key).or_insert(path_str);
            }
        }

        Self {
            by_name,
            by_stem,
            by_file_name,
            by_normalized,
        }
    }

    fn resolve_by_name(&self, name: &str) -> Option<String> {
        let key = name.trim().to_lowercase();
        if key.is_empty() {
            return None;
        }
        let normalized = normalize_plugin_key(&key);

        self.by_name
            .get(&key)
            .cloned()
            .or_else(|| self.by_stem.get(&key).cloned())
            .or_else(|| self.by_file_name.get(&key).cloned())
            .or_else(|| self.by_normalized.get(&normalized).cloned())
            .or_else(|| {
                self.by_normalized
                    .iter()
                    .find(|(k, _)| k.contains(&normalized) || normalized.contains(*k))
                    .map(|(_, v)| v.clone())
            })
    }
}

fn collect_devices_in_container<'a, 'input>(
    device_container: roxmltree::Node<'a, 'input>,
    out: &mut Vec<roxmltree::Node<'a, 'input>>,
) {
    for device in device_container.children().filter(|n| n.is_element()) {
        out.push(device);

        // Dive into nested rack/chain device containers.
        // Ableton nests racks as: AudioEffectGroupDevice > Branches >
        // AudioEffectBranch > DeviceChain > AudioToAudioDeviceChain > Devices.
        // We search descendants for any <Devices> node inside a <DeviceChain>
        // to handle intermediary wrappers like AudioToAudioDeviceChain.
        for nested_chain in device
            .descendants()
            .filter(|n| n.is_element() && n.has_tag_name("DeviceChain"))
        {
            // First try direct <Devices> child (simple case)
            if let Some(nested_devices) = nested_chain
                .children()
                .find(|n| n.is_element() && n.has_tag_name("Devices"))
            {
                collect_devices_in_container(nested_devices, out);
            } else {
                // Ableton may wrap in AudioToAudioDeviceChain, MidiToAudioDeviceChain, etc.
                // Search one level deeper for a <Devices> node.
                for wrapper in nested_chain.children().filter(|n| n.is_element()) {
                    if let Some(nested_devices) = wrapper
                        .children()
                        .find(|n| n.is_element() && n.has_tag_name("Devices"))
                    {
                        collect_devices_in_container(nested_devices, out);
                    }
                }
            }
        }
    }
}

fn collect_track_devices<'a, 'input>(
    track_node: roxmltree::Node<'a, 'input>,
) -> Vec<roxmltree::Node<'a, 'input>> {
    let mut devices = Vec::new();
    for chain in track_node
        .children()
        .filter(|n| n.is_element() && n.has_tag_name("DeviceChain"))
    {
        if let Some(root_devices) = chain
            .children()
            .find(|n| n.is_element() && n.has_tag_name("Devices"))
        {
            collect_devices_in_container(root_devices, &mut devices);
        }
    }
    devices
}

fn parse_fade_frames_from_audio_clip(
    clip_node: roxmltree::Node<'_, '_>,
    bpm: f64,
    sample_rate: f64,
) -> (i64, i64) {
    let fade_in_beats = node_child_value(clip_node, "FadeInLength")
        .as_deref()
        .and_then(parse_f64_value)
        .unwrap_or(0.0);
    let fade_out_beats = node_child_value(clip_node, "FadeOutLength")
        .as_deref()
        .and_then(parse_f64_value)
        .unwrap_or(0.0);

    (
        beats_to_frames(fade_in_beats, bpm, sample_rate).max(0),
        beats_to_frames(fade_out_beats, bpm, sample_rate).max(0),
    )
}

fn extract_audio_clip_source_path(
    clip_node: roxmltree::Node<'_, '_>,
    als_path: &Path,
) -> String {
    if let Some(sample_ref) = clip_node
        .descendants()
        .find(|n| n.is_element() && n.has_tag_name("SampleRef"))
    {
        let abs = sample_ref
            .descendants()
            .find(|n| n.is_element() && n.has_tag_name("Path"))
            .and_then(|n| n.attribute("Value"));
        let rel = sample_ref
            .descendants()
            .find(|n| n.is_element() && n.has_tag_name("RelativePath"))
            .and_then(|n| n.attribute("Value"));
        if let Some(path) = resolve_als_file_path(als_path, abs, rel) {
            return path;
        }
    }

    if let Some(file_ref) = clip_node
        .descendants()
        .find(|n| n.is_element() && n.has_tag_name("FileRef"))
    {
        let abs = file_ref
            .descendants()
            .find(|n| n.is_element() && n.has_tag_name("Path"))
            .and_then(|n| n.attribute("Value"));
        let rel = file_ref
            .descendants()
            .find(|n| n.is_element() && n.has_tag_name("RelativePath"))
            .and_then(|n| n.attribute("Value"));
        if let Some(path) = resolve_als_file_path(als_path, abs, rel) {
            return path;
        }
    }

    String::new()
}

fn extract_simpler_sample_path(
    device: roxmltree::Node<'_, '_>,
    als_path: &Path,
) -> Option<String> {
    let sample_ref = device
        .descendants()
        .find(|n| n.is_element() && n.has_tag_name("SampleRef"))?;
    let abs = sample_ref
        .descendants()
        .find(|n| n.is_element() && n.has_tag_name("Path"))
        .and_then(|n| n.attribute("Value"));
    let rel = sample_ref
        .descendants()
        .find(|n| n.is_element() && n.has_tag_name("RelativePath"))
        .and_then(|n| n.attribute("Value"));
    resolve_als_file_path(als_path, abs, rel)
}

#[cfg(test)]
mod als_import_tests {
    use super::*;

    #[test]
    fn nested_device_collector_finds_devices_inside_racks() {
        let xml = r#"
        <Track>
          <DeviceChain>
            <Devices>
              <AudioEffectGroupDevice Id="1">
                <DeviceChain>
                  <Devices>
                    <Eq8 Id="2"/>
                    <PluginDevice Id="3"/>
                  </Devices>
                </DeviceChain>
              </AudioEffectGroupDevice>
              <AutoFilter Id="4"/>
            </Devices>
          </DeviceChain>
        </Track>
        "#;
        let doc = roxmltree::Document::parse(xml).expect("valid xml");
        let track = doc
            .descendants()
            .find(|n| n.is_element() && n.has_tag_name("Track"))
            .expect("track");

        let names: Vec<String> = collect_track_devices(track)
            .into_iter()
            .map(|n| n.tag_name().name().to_string())
            .collect();

        assert!(names.iter().any(|n| n == "AudioEffectGroupDevice"));
        assert!(names.iter().any(|n| n == "Eq8"));
        assert!(names.iter().any(|n| n == "PluginDevice"));
        assert!(names.iter().any(|n| n == "AutoFilter"));
    }

    #[test]
    fn audio_clip_source_path_prefers_sample_ref() {
        let xml = r#"
        <AudioClip>
          <SampleRef>
            <FileRef>
              <RelativePath Value="Samples/Imported/kick.wav"/>
            </FileRef>
          </SampleRef>
        </AudioClip>
        "#;
        let doc = roxmltree::Document::parse(xml).expect("valid xml");
        let clip = doc
            .descendants()
            .find(|n| n.is_element() && n.has_tag_name("AudioClip"))
            .expect("audio clip");

        let als_path = Path::new("/tmp/project/Test.als");
        let source = extract_audio_clip_source_path(clip, als_path);
        assert!(source.ends_with("Samples/Imported/kick.wav"));
    }

    #[test]
    fn parse_track_send_manual_values_reads_track_send_holders() {
        let xml = r#"
        <Mixer>
          <Sends>
            <TrackSendHolder Id="0">
              <Send>
                <Manual Value="0.25"/>
              </Send>
            </TrackSendHolder>
            <TrackSendHolder Id="1">
              <Send>
                <Manual Value="1.25"/>
              </Send>
            </TrackSendHolder>
          </Sends>
        </Mixer>
        "#;
        let doc = roxmltree::Document::parse(xml).expect("valid xml");
        let mixer = doc
            .descendants()
            .find(|n| n.is_element() && n.has_tag_name("Mixer"))
            .expect("mixer");

        let sends = parse_track_send_manual_values(mixer);
        assert_eq!(sends.len(), 2);
        assert!((sends[0].1 - 0.25).abs() < 1e-9);
        assert!((sends[1].1 - 1.25).abs() < 1e-9);
    }

    #[test]
    fn static_lane_if_missing_does_not_override_existing_lane() {
        let mut track = Track::new("Test");
        track.automation_lanes.push(dream_models::project::AutomationLane {
            param_id: "send.A".to_string(),
            points: vec![dream_models::project::AutomationPoint {
                beat: 0.0,
                value: 0.7,
                curve_type: "linear".to_string(),
                tension: None,
            }],
        });

        upsert_static_import_lane_if_missing(&mut track, "send.A", 0.1);
        assert_eq!(track.automation_lanes.len(), 1);
        assert!((track.automation_lanes[0].points[0].value - 0.7).abs() < 1e-9);
    }

    #[test]
    fn parse_target_track_xml_id_extracts_track_segment() {
        assert_eq!(
            parse_target_track_xml_id("AudioOut/Track.243"),
            Some("243".to_string())
        );
        assert_eq!(
            parse_target_track_xml_id("AudioOut/ReturnTrack.81"),
            Some("81".to_string())
        );
        assert_eq!(parse_target_track_xml_id("AudioOut/Main"), None);
        assert_eq!(parse_target_track_xml_id("AudioOut/GroupTrack"), None);
    }

    #[test]
    fn build_pointee_map_captures_extended_mixer_targets() {
        let xml = r#"
        <Track>
          <DeviceChain>
            <Mixer>
              <CrossFadeState>
                <AutomationTarget Id="1001"/>
              </CrossFadeState>
              <Solo>
                <AutomationTarget Id="1002"/>
              </Solo>
              <Arm>
                <AutomationTarget Id="1003"/>
              </Arm>
              <Sends>
                <TrackSendHolder>
                  <Send><AutomationTarget Id="1004"/></Send>
                </TrackSendHolder>
              </Sends>
            </Mixer>
          </DeviceChain>
        </Track>
        "#;
        let doc = roxmltree::Document::parse(xml).expect("valid xml");
        let track = doc
            .descendants()
            .find(|n| n.is_element() && n.has_tag_name("Track"))
            .expect("track");

        let map = build_pointee_map(track);
        assert_eq!(map.get("1001").map(String::as_str), Some("mixer.crossfade_state"));
        assert_eq!(map.get("1002").map(String::as_str), Some("mixer.solo"));
        assert_eq!(map.get("1003").map(String::as_str), Some("mixer.arm"));
        assert_eq!(map.get("1004").map(String::as_str), Some("send.A"));
    }
}

fn infer_device_display_name(device: roxmltree::Node<'_, '_>, fallback_tag: &str) -> String {
    if let Some(user_name) = node_child_value(device, "UserName")
        && !user_name.trim().is_empty()
    {
        return user_name.trim().to_string();
    }

    // Ableton built-ins often carry a FileRef/RelativePath like:
    // "Devices/Audio Effects/EQ Eight" -> use final segment.
    let rel = device
        .descendants()
        .find(|n| n.is_element() && n.has_tag_name("RelativePath"))
        .and_then(|n| n.attribute("Value"))
        .unwrap_or_default()
        .trim()
        .to_string();
    if !rel.is_empty() {
        let tail = rel
            .replace('\\', "/")
            .split('/')
            .next_back()
            .unwrap_or_default()
            .trim()
            .to_string();
        if !tail.is_empty() {
            return tail;
        }
    }

    let abs = device
        .descendants()
        .find(|n| n.is_element() && n.has_tag_name("Path"))
        .and_then(|n| n.attribute("Value"))
        .unwrap_or_default()
        .trim()
        .to_string();
    if !abs.is_empty() {
        let tail = Path::new(&abs)
            .file_stem()
            .and_then(|s| s.to_str())
            .unwrap_or_default()
            .trim()
            .to_string();
        if !tail.is_empty() {
            return tail;
        }
    }

    fallback_tag.to_string()
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
    if !PathBuf::from(&path)
        .extension()
        .and_then(|s| s.to_str())
        .map(|e| e.eq_ignore_ascii_case("als"))
        .unwrap_or(false)
    {
        return Err("Only .als files can be imported with this command.".to_string());
    }
    open_project(
        path,
        project_state,
        clip_pool_state,
        automation_runtime,
        handle,
        app,
    )
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

        let source_path = extract_audio_clip_source_path(clip_node, als_path);

        let mut clip = AudioClip::new(
            clip_name,
            source_path,
            AbsoluteTime::new(beats_to_frames(start_beats, bpm, sample_rate)),
            AbsoluteTime::new(beats_to_frames(duration_beats, bpm, sample_rate).max(1)),
        );
        if let Some(sample_volume) = node_child_value(clip_node, "SampleVolume")
            .as_deref()
            .and_then(parse_f64_value)
        {
            clip.gain = sample_volume.clamp(0.0, 8.0);
        }
        let (fade_in, fade_out) = parse_fade_frames_from_audio_clip(clip_node, bpm, sample_rate);
        clip.fade_in_frames = fade_in;
        clip.fade_out_frames = fade_out;

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
        let (fade_in, fade_out) = parse_fade_frames_from_audio_clip(clip_node, bpm, sample_rate);
        clip.fade_in_frames = fade_in;
        clip.fade_out_frames = fade_out;

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

fn upsert_static_import_lane(track: &mut Track, param_id: &str, value: f64) {
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

fn upsert_static_import_lane_if_missing(track: &mut Track, param_id: &str, value: f64) {
    if track
        .automation_lanes
        .iter()
        .any(|lane| lane.param_id.eq_ignore_ascii_case(param_id))
    {
        return;
    }
    upsert_static_import_lane(track, param_id, value);
}

fn import_track_devices(
    track_node: roxmltree::Node<'_, '_>,
    track: &mut Track,
    external_plugins: &ExternalPluginIndex,
    als_path: &Path,
) {
    let effect_rack_tags = [
        "AudioEffectGroupDevice",
        "DrumGroupDevice",
        "MidiEffectGroupDevice",
    ];

    for device in collect_track_devices(track_node) {
        let tag = device.tag_name().name();

        // Effect racks: skip the container — inner devices are already
        // flattened by collect_track_devices recursion.
        if effect_rack_tags.contains(&tag) {
            continue;
        }

        // Instrument racks: extract the primary instrument from inside
        // the rack (MultiSampler, InstrumentVector, etc.) so it maps
        // to Dream DAW's single-instrument-per-track model.
        if tag == "InstrumentGroupDevice" {
            if track.track_type == TrackType::Midi && track.instrument.is_none() {
                // Search descendants for the first real instrument device
                let instrument_tags = [
                    "OriginalSimpler", "MultiSampler", "Operator",
                    "InstrumentVector", "Drift",
                ];
                let inner_instrument = device.descendants().find(|n| {
                    n.is_element() && instrument_tags.contains(&n.tag_name().name())
                });
                if let Some(inner) = inner_instrument {
                    let inner_tag = inner.tag_name().name();
                    let inner_name = infer_device_display_name(inner, inner_tag);
                    if let Some((pid, pname, _)) = canonical_internal_plugin_for_import(inner_tag, &inner_name) {
                        track.instrument = Some(DeviceNode::Single(PluginSlot::new(pname, pid)));
                        if track.sampler.is_none() {
                            track.sampler = Some(SamplerConfig::default());
                        }
                        if inner_tag == "OriginalSimpler" {
                            if let Some(sample_path) = extract_simpler_sample_path(inner, als_path) {
                                if let Some(cfg) = &mut track.sampler {
                                    if cfg.sample_path.trim().is_empty() {
                                        cfg.sample_path = sample_path;
                                    }
                                }
                            }
                        }
                        if pid == "internal://instrument/wave-synth" {
                            if let Some(cfg) = &mut track.sampler {
                                if cfg.sample_path.trim().is_empty() {
                                    cfg.sample_path = "internal://waveform/sine".to_string();
                                }
                            }
                        }
                    } else {
                        let rack_name = infer_device_display_name(device, tag);
                        track.instrument = Some(make_missing_plugin_slot("ableton-rack", &rack_name));
                    }
                } else {
                    // Check for a PluginDevice (VST instrument) inside the rack
                    let inner_plugin = device.descendants().find(|n| {
                        n.is_element() && n.tag_name().name() == "PluginDevice"
                    });
                    if inner_plugin.is_some() {
                        // Will be processed by the flattened device list below
                    } else {
                        let rack_name = infer_device_display_name(device, tag);
                        track.instrument = Some(make_missing_plugin_slot("ableton-rack", &rack_name));
                    }
                }
            }
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
            let vst3_path = device
                .descendants()
                .find(|n| n.is_element() && n.has_tag_name("Vst3PluginInfo"))
                .and_then(|vst3| {
                    vst3.children()
                        .find(|n| n.is_element() && n.has_tag_name("Path"))
                        .and_then(|n| n.attribute("Value"))
                })
                .unwrap_or_default()
                .to_string();
            let is_placeholder = device
                .descendants()
                .find(|n| n.is_element() && n.has_tag_name("IsPlaceholderDevice"))
                .and_then(|n| n.attribute("Value"))
                .and_then(parse_bool_value)
                .unwrap_or(false);

            let preferred_name = if !user_name.trim().is_empty() {
                user_name.trim().to_string()
            } else if !vst3_name.trim().is_empty() {
                vst3_name.trim().to_string()
            } else if !vst2_name.trim().is_empty() {
                vst2_name.trim().to_string()
            } else if !vst2_path.trim().is_empty() {
                Path::new(vst2_path.trim())
                    .file_stem()
                    .and_then(|s| s.to_str())
                    .unwrap_or("Unknown Plugin")
                    .to_string()
            } else if !vst3_path.trim().is_empty() {
                Path::new(vst3_path.trim())
                    .file_stem()
                    .and_then(|s| s.to_str())
                    .unwrap_or("Unknown Plugin")
                    .to_string()
            } else {
                infer_device_display_name(device, "Unknown Plugin")
            };

            let resolved_plugin_id = if !vst2_path.trim().is_empty() {
                Some(vst2_path.trim().to_string())
            } else if !vst3_path.trim().is_empty() {
                Some(vst3_path.trim().to_string())
            } else if !vst3_name.trim().is_empty() {
                external_plugins.resolve_by_name(&vst3_name)
            } else if !vst2_name.trim().is_empty() {
                external_plugins.resolve_by_name(&vst2_name)
            } else {
                None
            };

            let is_instrument_slot = track.track_type == TrackType::Midi && track.instrument.is_none();
            let slot = if let Some(plugin_id) = resolved_plugin_id {
                DeviceNode::Single(PluginSlot::new(preferred_name, plugin_id))
            } else if is_placeholder {
                make_missing_plugin_slot("external", &preferred_name)
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

        let display_name = infer_device_display_name(device, tag);

        let canonical = canonical_internal_plugin_for_import(tag, &display_name);
        let is_instrument_slot = track.track_type == TrackType::Midi && track.instrument.is_none();
        if let Some((plugin_id, plugin_name, slot_kind)) = canonical {
            let slot = DeviceNode::Single(PluginSlot::new(plugin_name, plugin_id));
            if slot_kind == "instrument" && is_instrument_slot {
                track.instrument = Some(slot);
                if track.sampler.is_none() {
                    track.sampler = Some(SamplerConfig::default());
                }
                if tag == "OriginalSimpler"
                    && let Some(sample_path) = extract_simpler_sample_path(device, als_path)
                    && let Some(cfg) = &mut track.sampler
                    && cfg.sample_path.trim().is_empty()
                {
                    cfg.sample_path = sample_path;
                }
                if plugin_id == "internal://instrument/wave-synth"
                    && let Some(cfg) = &mut track.sampler
                    && cfg.sample_path.trim().is_empty()
                {
                    cfg.sample_path = "internal://waveform/sine".to_string();
                }
            } else {
                track.effects.push(slot);
                // Import static MIDI FX settings into automation lanes so runtime
                // can reconstruct behavior after .als load.
                if plugin_id == "internal://midi-fx/pitch" {
                    let semitones = maybe_parse_f64_manual(device, "Pitch").unwrap_or(0.0)
                        + maybe_parse_f64_manual(device, "PitchScaleDegrees").unwrap_or(0.0);
                    upsert_static_import_lane(track, "midi.pitch.semitones", semitones.clamp(-48.0, 48.0));
                } else if plugin_id == "internal://midi-fx/velocity" {
                    let gain = maybe_parse_f64_manual(device, "Drive")
                        .or_else(|| maybe_parse_f64_manual(device, "OutHi"))
                        .unwrap_or(1.0);
                    let offset = maybe_parse_f64_manual(device, "OutLow")
                        .or_else(|| maybe_parse_f64_manual(device, "Random"))
                        .unwrap_or(0.0);
                    upsert_static_import_lane(track, "midi.velocity.gain", gain.clamp(0.0, 4.0));
                    upsert_static_import_lane(track, "midi.velocity.offset", offset.clamp(-127.0, 127.0));
                } else if plugin_id == "internal://midi-fx/random" {
                    let chance = maybe_parse_f64_manual(device, "Chance")
                        .or_else(|| maybe_parse_f64_manual(device, "Probability"))
                        .unwrap_or(1.0);
                    let semitones = maybe_parse_f64_manual(device, "Choices")
                        .or_else(|| maybe_parse_f64_manual(device, "Scale"))
                        .unwrap_or(0.0);
                    upsert_static_import_lane(track, "midi.random.chance", chance.clamp(0.0, 1.0));
                    upsert_static_import_lane(track, "midi.random.semitones", semitones.clamp(-24.0, 24.0));
                } else if plugin_id == "internal://midi-fx/scale" {
                    let root = maybe_parse_f64_manual(device, "Base")
                        .or_else(|| maybe_parse_f64_manual(device, "Root"))
                        .or_else(|| maybe_parse_f64_manual(device, "Lowest"))
                        .unwrap_or(0.0);
                    upsert_static_import_lane(track, "midi.scale.root", root.rem_euclid(12.0));
                    // Default to chromatic mask if explicit map isn't parsed yet.
                    upsert_static_import_lane(track, "midi.scale.mask", 4095.0);
                }
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

// ── Ableton Color Mapping ────────────────────────────────────────────────
//
// Ableton Live uses a 70-color palette indexed 0–69. We map each index to
// the nearest TrackColor variant. Unmapped / out-of-range indices fall back
// to `TrackColor::for_index(fallback)`.

fn ableton_color_to_track_color(index: i64, fallback: usize) -> TrackColor {
    match index {
        // Reds / Coral
        0 | 1 | 2 => TrackColor::Coral,
        // Oranges
        3 | 4 | 5 => TrackColor::Orange,
        // Golds
        6 | 7 => TrackColor::Gold,
        // Yellows
        8 | 9 => TrackColor::Yellow,
        // Limes
        10 | 11 | 12 => TrackColor::Lime,
        // Greens
        13 | 14 | 15 => TrackColor::Green,
        // Teals
        16 | 17 => TrackColor::Teal,
        // Cyans
        18 | 19 => TrackColor::Cyan,
        // Sky blues
        20 | 21 => TrackColor::Sky,
        // Blues
        22 | 23 | 24 => TrackColor::Blue,
        // Indigos
        25 | 26 => TrackColor::Indigo,
        // Purples
        27 | 28 | 29 => TrackColor::Purple,
        // Magentas
        30 | 31 => TrackColor::Magenta,
        // Pinks
        32 | 33 | 34 => TrackColor::Pink,
        // Roses
        35 | 36 | 37 => TrackColor::Rose,
        // Grays / Slates
        38..=69 => TrackColor::Slate,
        _ => TrackColor::for_index(fallback),
    }
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
    let mut map = std::collections::HashMap::new();

    // Named mixer parameters → well-known param IDs
    let mixer_params = [
        ("Volume", "volume"),
        ("Pan", "pan"),
        ("SplitStereoPanL", "pan_left"),
        ("SplitStereoPanR", "pan_right"),
        ("CrossFadeState", "mixer.crossfade_state"),
    ];

    // Locate the Mixer node
    let mixer = track_node
        .children()
        .find(|n| n.is_element() && n.has_tag_name("DeviceChain"))
        .and_then(|dc| dc.children().find(|n| n.is_element() && n.has_tag_name("Mixer")));

    if let Some(mixer) = mixer {
        for (tag, param_id) in &mixer_params {
            if let Some(param_node) = mixer.children().find(|n| n.is_element() && n.has_tag_name(*tag)) {
                if let Some(target) = param_node
                    .descendants()
                    .find(|n| n.is_element() && n.has_tag_name("AutomationTarget"))
                {
                    if let Some(id) = target.attribute("Id") {
                        map.insert(id.to_string(), param_id.to_string());
                    }
                }
            }
        }

        // Mixer boolean controls
        for (tag, lane) in [
            ("On", "mixer.on"),
            ("Speaker", "mixer.speaker"),
            ("Solo", "mixer.solo"),
            ("Arm", "mixer.arm"),
        ] {
            if let Some(node) = mixer.children().find(|n| n.is_element() && n.has_tag_name(tag)) {
                if let Some(target) = node.descendants().find(|n| n.is_element() && n.has_tag_name("AutomationTarget")) {
                    if let Some(id) = target.attribute("Id") {
                        map.insert(id.to_string(), lane.to_string());
                    }
                }
            }
        }

        // Send levels (SendA, SendB, etc.)
        for (idx, send) in mixer
            .descendants()
            .filter(|n| n.is_element() && n.has_tag_name("TrackSendHolder"))
            .enumerate()
        {
            if let Some(send_node) = send.children().find(|n| n.is_element() && n.has_tag_name("Send")) {
                if let Some(target) = send_node.descendants().find(|n| n.is_element() && n.has_tag_name("AutomationTarget")) {
                    if let Some(id) = target.attribute("Id") {
                        let send_letter = (b'A' + idx as u8) as char;
                        map.insert(id.to_string(), format!("send.{send_letter}"));
                    }
                }
            }
        }
    }

    // Device parameters: prefer explicit plugin parameter names/ids for PluginDevice.
    for (dev_idx, device) in collect_track_devices(track_node).iter().enumerate() {
        if !device.is_element() || !device.has_tag_name("PluginDevice") {
            continue;
        }

        let plugin_name_raw = infer_device_display_name(*device, "plugin");
        let plugin_key = normalize_plugin_key(&plugin_name_raw);

        for float_param in device
            .descendants()
            .filter(|n| n.is_element() && n.has_tag_name("PluginFloatParameter"))
        {
            let target_id = float_param
                .descendants()
                .find(|n| n.is_element() && n.has_tag_name("AutomationTarget"))
                .and_then(|n| n.attribute("Id"))
                .unwrap_or_default()
                .trim()
                .to_string();
            if target_id.is_empty() || map.contains_key(&target_id) {
                continue;
            }

            let param_name = node_child_value(float_param, "ParameterName")
                .unwrap_or_default()
                .trim()
                .to_string();
            let param_id = node_child_value(float_param, "ParameterId")
                .unwrap_or_default()
                .trim()
                .to_string();

            let mut param_key = normalize_plugin_key(&param_name);
            if param_key.is_empty() {
                let maybe_numeric = param_id.parse::<i64>().ok();
                param_key = match maybe_numeric {
                    Some(v) if v >= 0 => format!("id{v}"),
                    _ => "unnamed".to_string(),
                };
            }

            let lane_key = format!("plugin:{dev_idx}:{plugin_key}:{param_key}");
            map.insert(target_id, lane_key);
        }
    }

    // Generic fallback for any remaining automation target IDs.
    for (dev_idx, device) in collect_track_devices(track_node).iter().enumerate() {
        for target in device
            .descendants()
            .filter(|n| n.is_element() && n.has_tag_name("AutomationTarget"))
        {
            if let Some(id) = target.attribute("Id") {
                if map.contains_key(id) {
                    continue; // Already mapped by mixer
                }
                let param_tag = target
                    .parent()
                    .and_then(|p| if p.is_element() { Some(p.tag_name().name().to_string()) } else { None })
                    .unwrap_or_else(|| "param".to_string());
                map.insert(id.to_string(), format!("device:{dev_idx}:{param_tag}"));
            }
        }
    }

    map
}

fn import_track_automation(
    track_node: roxmltree::Node<'_, '_>,
    track: &mut Track,
) {
    let pointee_map = build_pointee_map(track_node);

    // Walk all AutomationEnvelope elements on this track
    let envelopes_container = track_node
        .children()
        .find(|n| n.is_element() && n.has_tag_name("AutomationEnvelopes"))
        .and_then(|ae| ae.children().find(|n| n.is_element() && n.has_tag_name("Envelopes")));

    let Some(envelopes) = envelopes_container else {
        return;
    };

    for envelope in envelopes
        .children()
        .filter(|n| n.is_element() && n.has_tag_name("AutomationEnvelope"))
    {
        // Resolve param_id from PointeeId
        let pointee_id = envelope
            .descendants()
            .find(|n| n.is_element() && n.has_tag_name("PointeeId"))
            .and_then(|n| n.attribute("Value"))
            .unwrap_or_default()
            .to_string();

        let param_id = pointee_map
            .get(&pointee_id)
            .cloned()
            .unwrap_or_else(|| format!("unknown:{pointee_id}"));

        // Parse FloatEvent entries
        let mut points = Vec::new();
        for event in envelope
            .descendants()
            .filter(|n| n.is_element() && n.has_tag_name("FloatEvent"))
        {
            let time_beats = event
                .attribute("Time")
                .and_then(parse_f64_value)
                .unwrap_or(0.0);

            // Skip the Ableton sentinel value (negative infinity placeholder)
            if time_beats < -1_000_000.0 {
                continue;
            }

            let value = event
                .attribute("Value")
                .and_then(parse_f64_value)
                .unwrap_or(0.0);

            // Detect bezier curve controls
            let has_curve = event.attribute("CurveControl1X").is_some();
            let curve_type = if has_curve {
                "bezier".to_string()
            } else {
                "linear".to_string()
            };

            // Extract tension from bezier control points if present
            let tension = if has_curve {
                let c1y = event
                    .attribute("CurveControl1Y")
                    .and_then(parse_f64_value)
                    .unwrap_or(0.5);
                let c2y = event
                    .attribute("CurveControl2Y")
                    .and_then(parse_f64_value)
                    .unwrap_or(0.5);
                // Approximate tension from control points: 0 = linear, ±1 = extreme curve
                Some((c2y - c1y).clamp(-1.0, 1.0))
            } else {
                None
            };

            points.push(dream_models::project::AutomationPoint {
                beat: time_beats,
                value,
                curve_type,
                tension,
            });
        }

        if points.is_empty() {
            continue;
        }

        // Sort by beat position
        points.sort_by(|a, b| a.beat.partial_cmp(&b.beat).unwrap_or(std::cmp::Ordering::Equal));

        track.automation_lanes.push(dream_models::project::AutomationLane {
            param_id,
            points,
        });
    }
}

fn consolidate_automation_lanes(track: &mut Track) {
    use std::collections::HashMap;

    let mut merged: HashMap<String, Vec<dream_models::project::AutomationPoint>> = HashMap::new();
    for lane in track.automation_lanes.drain(..) {
        let key = lane.param_id.trim().to_string();
        if key.is_empty() {
            continue;
        }
        merged.entry(key).or_default().extend(lane.points);
    }

    let mut out = Vec::new();
    for (param_id, mut points) in merged {
        points.sort_by(|a, b| a.beat.total_cmp(&b.beat));
        points.dedup_by(|a, b| (a.beat - b.beat).abs() < 1e-9);
        if points.is_empty() {
            continue;
        }
        out.push(dream_models::project::AutomationLane { param_id, points });
    }
    out.sort_by(|a, b| a.param_id.cmp(&b.param_id));
    track.automation_lanes = out;
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

    // ── Component 2: Time Signature Import ─────────────────────────────
    if let Some(main_track) = live_set.descendants().find(|n| n.is_element() && n.has_tag_name("MainTrack")) {
        // Ableton stores time signature inside MainTrack > TimeSignature
        if let Some(ts_node) = main_track.descendants().find(|n| n.is_element() && n.has_tag_name("TimeSignature")) {
            let numerator = ts_node
                .descendants()
                .find(|n| n.is_element() && n.has_tag_name("Numerator"))
                .and_then(|n| n.attribute("Value"))
                .and_then(parse_i64_value)
                .map(|v| v.clamp(1, 32) as u8)
                .unwrap_or(4);
            let denominator = ts_node
                .descendants()
                .find(|n| n.is_element() && n.has_tag_name("Denominator"))
                .and_then(|n| n.attribute("Value"))
                .and_then(parse_i64_value)
                .map(|v| v.clamp(1, 32) as u8)
                .unwrap_or(4);
            project.time_signature = TimeSignature::new(numerator, denominator);
        }
    }

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
        if let Some(color_value) = node_child_value(track_node, "Color")
            .as_deref()
            .and_then(parse_i64_value)
        {
            track.color = ableton_color_to_track_color(color_value, index);
        }

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
            static_send_values = parse_track_send_manual_values(mixer);
        }

        import_track_devices(track_node, &mut track, &external_plugins, file_path);
        import_track_clips(track_node, &mut track, file_path, tempo, sample_rate);
        import_track_automation(track_node, &mut track);
        for (send_idx, send_value) in static_send_values {
            if send_idx >= 26 {
                continue;
            }
            let send_letter = (b'A' + send_idx as u8) as char;
            upsert_static_import_lane_if_missing(&mut track, &format!("send.{send_letter}"), send_value);
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

        if let Some(target) = parse_audio_output_target(track_node) {
            if let Some(xml_target_id) = parse_target_track_xml_id(&target) {
                pending_output_refs.push((track.id, xml_target_id));
            } else if target.eq_ignore_ascii_case("AudioOut/GroupTrack") {
                pending_group_output_fallback.push(track.id);
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
        import_track_devices(main_track, &mut project.master_track, &external_plugins, file_path);
        import_track_automation(main_track, &mut project.master_track);
        consolidate_automation_lanes(&mut project.master_track);
    }

    normalize_internal_plugins_for_import(&mut project);

    // ── Component 5: Sample Consolidation ─────────────────────────────
    //
    // Copy referenced audio samples into the Ableton project folder's
    // Samples/Imported/ directory so that clip paths remain valid even
    // if the original sample sources are moved or deleted. Non-fatal —
    // failures are logged but do not block the import.
    if let Some(project_dir) = file_path.parent() {
        let imported_dir = project_dir.join("Samples").join("Imported");
        if let Err(e) = std::fs::create_dir_all(&imported_dir) {
            log::warn!(
                "Could not create Samples/Imported directory for ALS import: {e}"
            );
        } else {
            // Copy each clip's source file into Samples/Imported/
            let mut rewrites = Vec::new();
            for track in &project.tracks {
                for clip in &track.clips {
                    let src = Path::new(&clip.file_path);
                    if !src.exists() || clip.file_path.trim().is_empty() {
                        continue;
                    }
                    if let Some(file_name) = src.file_name() {
                        let dest = imported_dir.join(file_name);
                        if !dest.exists() {
                            if let Err(e) = std::fs::copy(src, &dest) {
                                log::warn!(
                                    "Sample consolidation: failed to copy '{}': {e}",
                                    src.display()
                                );
                                continue;
                            }
                        }
                        rewrites.push((
                            track.id,
                            clip.file_path.clone(),
                            dest.to_string_lossy().to_string(),
                        ));
                    }
                }
            }

            // Rewrite clip paths to the consolidated location
            for (track_id, old_path, new_path) in rewrites {
                if let Some(track) = project.find_track_mut(track_id) {
                    for clip in &mut track.clips {
                        if clip.file_path == old_path {
                            clip.file_path = new_path.clone();
                        }
                    }
                }
            }

            log::info!(
                "ALS import: samples consolidated to '{}'",
                imported_dir.display()
            );
        }
    }

    Ok(project)
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
