pub use super::plugin_mapper_external_meta::{
    ExternalPluginMeta, apply_external_plugin_meta, parse_external_plugin_meta,
};
use super::xml_helpers::*;
use dream_models::midi::SamplerConfig;
use dream_models::project::{DeviceNode, PluginSlot, Project};
use std::path::Path;
pub fn canonical_internal_plugin_for_import(
    plugin_id: &str,
    plugin_name: &str,
) -> Option<(&'static str, &'static str, &'static str)> {
    let pid = plugin_id.trim().to_lowercase();
    let pname = plugin_name.trim().to_lowercase();
    let is_vst = pid == "plugindevice" || pid == "auplugindevice";
    if !is_vst {
        match pid.as_str() {
            "eq8" | "eqeight" | "channeleq" | "eqthree" => {
                return Some(("internal://effect/eq-eight", "EQ", "effect"));
            }
            "compressor2" | "compressor" | "gluecompressor" | "drumbuss" | "multibanddynamics"
            | "transientshaper" => {
                return Some(("internal://effect/compressor", "Compressor", "effect"));
            }
            "delay" | "echo" | "pingpongdelay" | "filterdelay" | "beatrepeat" | "graindelay"
            | "spectraltime" => return Some(("internal://effect/delay", "Delay", "effect")),
            "reverb" | "hybridreverb" | "corpus" | "resonators" | "spectralresonator" => {
                return Some(("internal://effect/reverb", "Reverb", "effect"));
            }
            "chorus" | "chorus2" | "ensemble" | "vibrato" => {
                return Some(("internal://effect/chorus", "Chorus", "effect"));
            }
            "utility" | "tuner" | "looper" | "frequencyshifter" | "shifter" | "autoshift" => {
                return Some(("internal://effect/utility", "Utility", "effect"));
            }
            "autopan" | "autopan2" => {
                return Some(("internal://effect/auto-pan", "Auto Pan", "effect"));
            }
            "saturator" | "dynamictube" => {
                return Some(("internal://effect/saturator", "Saturator", "effect"));
            }
            "spectrumanalyzer" | "spectrum" => {
                return Some(("internal://effect/spectrum", "Spectrum", "effect"));
            }
            "limiter" => return Some(("internal://effect/limiter", "Limiter", "effect")),
            "gate" => return Some(("internal://effect/gate", "Gate", "effect")),
            "redux" | "bitcrusher" => {
                return Some(("internal://effect/bitcrusher", "Bitcrusher", "effect"));
            }
            "autofilter" | "vocoder" => {
                return Some(("internal://effect/auto-filter", "Auto Filter", "effect"));
            }
            "phasernew" | "phaser" | "phaserflanger" => {
                return Some(("internal://effect/phaser", "Phaser", "effect"));
            }
            "flanger" => return Some(("internal://effect/flanger", "Flanger", "effect")),
            "erosion" | "vinyldistortion" | "distortion" | "overdrive" | "amp" | "cabinet"
            | "pedal" | "roar" => {
                return Some(("internal://effect/distortion", "Distortion", "effect"));
            }
            "noisemachine" => {
                return Some(("internal://effect/noise-machine", "Noise Machine", "effect"));
            }
            "midipitcher" => return Some(("internal://midi-fx/pitch", "MIDI Pitch", "effect")),
            "mxdevicescale" | "midichord" => {
                return Some(("internal://midi-fx/scale", "MIDI Scale", "effect"));
            }
            "mxdeviceaudioeffect" => {
                return Some(("internal://effect/utility", "Utility", "effect"));
            }
            "mxdevicevelocity" | "midinotelength" | "midivelocity" => {
                return Some(("internal://midi-fx/velocity", "MIDI Velocity", "effect"));
            }
            "mxdevicerandom" | "midiarpeggiator" | "midirandom" => {
                return Some(("internal://midi-fx/random", "MIDI Random", "effect"));
            }
            "originalsimpler" | "multisampler" | "drumcell" | "instrumentimpulse" => {
                return Some(("internal://instrument/sampler", "Sampler", "instrument"));
            }
            "wavetable" | "operator" | "analog" | "collision" | "tension" | "electricpiano"
            | "instrumentmeld" | "drift" | "instrumentvector" | "loungelizard" | "ultraanalog"
            | "stringstudio" => {
                return Some((
                    "internal://instrument/wave-synth",
                    "Wave Synth",
                    "instrument",
                ));
            }
            _ => {}
        }
    }
    if is_vst {
        match pname.as_str() {
            "span" | "youlean loudness meter" | "loudness meter" | "psyscope" => {
                return Some(("internal://effect/spectrum", "Spectrum", "effect"));
            }
            "synthesizer v studio 2 plugin" => {
                return Some((
                    "internal://instrument/wave-synth",
                    "Wave Synth",
                    "instrument",
                ));
            }
            "utility" | "bass mono" | "mono bass" | "gain utility" => {
                return Some(("internal://effect/utility", "Utility", "effect"));
            }
            "auto filter" | "autofilter" => {
                return Some(("internal://effect/auto-filter", "Auto Filter", "effect"));
            }
            "eq eight" | "eq8" | "channel eq" => {
                return Some(("internal://effect/eq-eight", "EQ", "effect"));
            }
            "drum buss" | "drumbuss" | "compressor" | "glue compressor" => {
                return Some(("internal://effect/compressor", "Compressor", "effect"));
            }
            "echo" | "delay" | "ping pong delay" => {
                return Some(("internal://effect/delay", "Delay", "effect"));
            }
            "hybrid reverb" | "reverb" => {
                return Some(("internal://effect/reverb", "Reverb", "effect"));
            }
            "saturator" | "dynamic tube" => {
                return Some(("internal://effect/saturator", "Saturator", "effect"));
            }
            "amp" | "pedal" | "overdrive" | "distortion" | "roar" => {
                return Some(("internal://effect/distortion", "Distortion", "effect"));
            }
            _ => return None,
        }
    }
    None
}
pub fn canonical_internal_from_plugin_device_node(
    device: roxmltree::Node<'_, '_>,
    preferred_name: &str,
) -> Option<(&'static str, &'static str, &'static str)> {
    fn strip_known_preset_ext(raw: &str) -> String {
        let lower = raw.trim().to_lowercase();
        for ext in [".adv", ".adg", ".aupreset", ".vstpreset", ".fxp", ".fxb"] {
            if lower.ends_with(ext) {
                return raw.trim().trim_end_matches(ext).trim().to_string();
            }
        }
        raw.trim().to_string()
    }
    fn push_candidate(out: &mut Vec<String>, value: Option<String>) {
        if let Some(v) = value {
            let t = v.trim();
            if !t.is_empty() {
                out.push(t.to_string());
            }
        }
    }
    if let Some(mapped) = canonical_internal_plugin_for_import("PluginDevice", preferred_name) {
        return Some(mapped);
    }
    let mut candidates = Vec::<String>::new();
    let preferred = preferred_name.trim();
    if !preferred.is_empty() {
        candidates.push(preferred.to_string());
        candidates.push(strip_known_preset_ext(preferred));
    }
    push_candidate(&mut candidates, node_child_value(device, "UserName"));
    push_candidate(
        &mut candidates,
        device
            .descendants()
            .find(|n| n.is_element() && n.has_tag_name("Vst3PluginInfo"))
            .and_then(|v| {
                v.children()
                    .find(|n| n.is_element() && n.has_tag_name("Name"))
                    .and_then(|n| n.attribute("Value"))
            })
            .map(str::to_string),
    );
    push_candidate(
        &mut candidates,
        device
            .descendants()
            .find(|n| n.is_element() && n.has_tag_name("VstPluginInfo"))
            .and_then(|v| {
                v.children()
                    .find(|n| n.is_element() && n.has_tag_name("PlugName"))
                    .and_then(|n| n.attribute("Value"))
            })
            .map(str::to_string),
    );
    push_candidate(
        &mut candidates,
        device
            .descendants()
            .find(|n| n.is_element() && n.has_tag_name("AuPluginInfo"))
            .and_then(|v| {
                v.children()
                    .find(|n| n.is_element() && n.has_tag_name("Name"))
                    .and_then(|n| n.attribute("Value"))
            })
            .map(str::to_string),
    );
    for field in [
        "DeviceClass",
        "DeviceClassName",
        "ClassName",
        "PluginDesc",
        "OriginalName",
        "DeviceType",
        "MxDeviceAudioEffect",
        "MxDeviceMidiEffect",
        "MxDeviceInstrument",
    ] {
        push_candidate(&mut candidates, node_child_value(device, field));
    }
    for node in device.descendants().filter(|n| n.is_element()) {
        let tag = node.tag_name().name();
        let tag_lc = tag.to_ascii_lowercase();
        if !(tag_lc.contains("class")
            || tag_lc.contains("devicetype")
            || tag_lc.contains("mxdevice")
            || tag_lc.contains("plugindesc"))
        {
            continue;
        }
        if let Some(v) = node.attribute("Value") {
            let trimmed = v.trim();
            if !trimmed.is_empty() {
                candidates.push(trimmed.to_string());
            }
        }
    }
    let rel = device
        .descendants()
        .find(|n| n.is_element() && n.has_tag_name("RelativePath"))
        .and_then(|n| n.attribute("Value"))
        .unwrap_or_default()
        .trim()
        .to_string();
    if !rel.is_empty() {
        candidates.push(rel.clone());
        for part in rel.replace('\\', "/").split('/') {
            let token = part.trim();
            if token.is_empty() {
                continue;
            }
            candidates.push(token.to_string());
            candidates.push(strip_known_preset_ext(token));
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
        candidates.push(abs.clone());
        for part in abs.replace('\\', "/").split('/') {
            let token = part.trim();
            if token.is_empty() {
                continue;
            }
            candidates.push(token.to_string());
            candidates.push(strip_known_preset_ext(token));
        }
        if let Some(stem) = Path::new(&abs).file_stem().and_then(|s| s.to_str()) {
            candidates.push(stem.trim().to_string());
        }
    }
    let mut seen = std::collections::HashSet::<String>::new();
    for candidate in candidates {
        let trimmed = candidate.trim();
        if trimmed.is_empty() {
            continue;
        }
        let key = trimmed.to_lowercase();
        if !seen.insert(key.clone()) {
            continue;
        }
        if let Some(mapped) = canonical_internal_plugin_for_import("PluginDevice", trimmed) {
            return Some(mapped);
        }
        if let Some(mapped) = canonical_internal_plugin_for_import(trimmed, trimmed) {
            return Some(mapped);
        }
        let normalized = normalize_plugin_key(trimmed);
        if !normalized.is_empty()
            && let Some(mapped) = canonical_internal_plugin_for_import(&normalized, trimmed)
        {
            return Some(mapped);
        }
    }
    None
}
pub fn normalize_internal_plugins_for_import(project: &mut Project) {
    fn canonical_from_missing_slot_name(
        display_name: &str,
    ) -> Option<(&'static str, &'static str, &'static str)> {
        let raw = display_name.trim();
        let stripped = raw.strip_prefix("Plugin Not Found:").unwrap_or(raw).trim();
        let primary = stripped
            .split_once('[')
            .map(|(left, _)| left.trim())
            .unwrap_or(stripped)
            .trim();
        if primary.is_empty() {
            return None;
        }
        if let Some(mapped) = canonical_internal_plugin_for_import(primary, primary) {
            return Some(mapped);
        }
        let normalized = normalize_plugin_key(primary);
        if normalized.is_empty() {
            return None;
        }
        canonical_internal_plugin_for_import(&normalized, primary)
    }
    for track in &mut project.tracks {
        if let Some(inst) = &mut track.instrument {
            let pid = inst.plugin_id();
            if pid.is_empty() || pid.starts_with("internal://") || pid.starts_with("missing://") {
                let pname = inst.name().to_string();
                let mapped = canonical_internal_plugin_for_import(&pid, &pname)
                    .or_else(|| canonical_from_missing_slot_name(&pname));
                if let Some((canonical_id, canonical_name, slot)) = mapped
                    && slot == "instrument"
                {
                    inst.set_plugin_id(canonical_id);
                    if pname.trim().is_empty()
                        || pname.to_lowercase() != canonical_name.to_lowercase()
                    {
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
        }
        for fx in &mut track.effects {
            normalize_effect_node(fx, 0);
        }
    }
}
fn normalize_effect_node(node: &mut DeviceNode, depth: usize) {
    fn canonical_from_missing_slot_name(
        display_name: &str,
    ) -> Option<(&'static str, &'static str, &'static str)> {
        let raw = display_name.trim();
        let stripped = raw.strip_prefix("Plugin Not Found:").unwrap_or(raw).trim();
        let primary = stripped
            .split_once('[')
            .map(|(left, _)| left.trim())
            .unwrap_or(stripped)
            .trim();
        if primary.is_empty() {
            return None;
        }
        if let Some(mapped) = canonical_internal_plugin_for_import(primary, primary) {
            return Some(mapped);
        }
        let normalized = normalize_plugin_key(primary);
        if normalized.is_empty() {
            return None;
        }
        canonical_internal_plugin_for_import(&normalized, primary)
    }
    if depth > 16 {
        log::warn!("[normalize_effect_node] Recursion depth limit reached, skipping nested rack");
        return;
    }
    match node {
        DeviceNode::Single(slot) => {
            if !slot.plugin_id.is_empty()
                && !slot.plugin_id.starts_with("internal://")
                && !slot.plugin_id.starts_with("missing://")
            {
                return;
            }
            let pid = slot.plugin_id.clone();
            let pname = slot.name.clone();
            let mapped = canonical_internal_plugin_for_import(&pid, &pname)
                .or_else(|| canonical_from_missing_slot_name(&pname));
            if let Some((canonical_id, canonical_name, _slot_kind)) = mapped {
                slot.plugin_id = canonical_id.to_string();
                if pname.trim().is_empty() || pname.to_lowercase() != canonical_name.to_lowercase()
                {
                    slot.name = canonical_name.to_string();
                }
            }
        }
        DeviceNode::Rack(rack) => {
            for chain in &mut rack.chains {
                for device in &mut chain.devices {
                    normalize_effect_node(device, depth + 1);
                }
            }
        }
    }
}
pub fn make_missing_plugin_slot(kind: &str, ableton_name: &str) -> DeviceNode {
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
pub fn encode_missing_meta(raw: &str) -> String {
    raw.chars()
        .map(|ch| {
            if ch.is_ascii_alphanumeric() || matches!(ch, '-' | '_' | '.' | '~') {
                ch.to_string()
            } else {
                format!("%{:02X}", ch as u32)
            }
        })
        .collect::<String>()
}
pub struct MissingExternalPluginSlotSpec<'a> {
    pub kind: &'a str,
    pub preferred_name: &'a str,
    pub user_name: &'a str,
    pub vst2_name: &'a str,
    pub vst2_path: &'a str,
    pub vst3_name: &'a str,
    pub vst3_path: &'a str,
    pub is_placeholder: bool,
    pub meta: Option<&'a ExternalPluginMeta>,
}
pub fn make_missing_external_plugin_slot_with_metadata(
    spec: MissingExternalPluginSlotSpec<'_>,
) -> DeviceNode {
    let mut details = Vec::new();
    if !spec.user_name.trim().is_empty() {
        details.push(format!("user={}", spec.user_name.trim()));
    }
    if !spec.vst3_name.trim().is_empty() {
        details.push(format!("vst3={}", spec.vst3_name.trim()));
    }
    if !spec.vst3_path.trim().is_empty() {
        details.push(format!("vst3_path={}", spec.vst3_path.trim()));
    }
    if !spec.vst2_name.trim().is_empty() {
        details.push(format!("vst2={}", spec.vst2_name.trim()));
    }
    if !spec.vst2_path.trim().is_empty() {
        details.push(format!("vst2_path={}", spec.vst2_path.trim()));
    }
    details.push(format!(
        "placeholder={}",
        if spec.is_placeholder { "1" } else { "0" }
    ));
    let detail_text = details.join("; ");
    let display_name = if detail_text.is_empty() {
        format!("Plugin Not Found: {}", spec.preferred_name.trim())
    } else {
        format!(
            "Plugin Not Found: {} [{}]",
            spec.preferred_name.trim(),
            detail_text
        )
    };
    let normalized = spec
        .preferred_name
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
    let mut query = Vec::new();
    query.push(format!(
        "name={}",
        encode_missing_meta(spec.preferred_name.trim())
    ));
    if !spec.user_name.trim().is_empty() {
        query.push(format!(
            "user={}",
            encode_missing_meta(spec.user_name.trim())
        ));
    }
    if !spec.vst3_name.trim().is_empty() {
        query.push(format!(
            "vst3={}",
            encode_missing_meta(spec.vst3_name.trim())
        ));
    }
    if !spec.vst3_path.trim().is_empty() {
        query.push(format!(
            "vst3path={}",
            encode_missing_meta(spec.vst3_path.trim())
        ));
    }
    if !spec.vst2_name.trim().is_empty() {
        query.push(format!(
            "vst2={}",
            encode_missing_meta(spec.vst2_name.trim())
        ));
    }
    if !spec.vst2_path.trim().is_empty() {
        query.push(format!(
            "vst2path={}",
            encode_missing_meta(spec.vst2_path.trim())
        ));
    }
    query.push(format!(
        "placeholder={}",
        if spec.is_placeholder { "1" } else { "0" }
    ));
    let plugin_id = format!("missing://{}/{slug}?{}", spec.kind, query.join("&"));
    let mut slot = PluginSlot::new(display_name, plugin_id);
    if let Some(meta) = spec.meta {
        apply_external_plugin_meta(&mut slot, meta);
    }
    DeviceNode::Single(slot)
}
pub fn normalize_plugin_key(raw: &str) -> String {
    raw.chars()
        .filter(|c| c.is_ascii_alphanumeric())
        .map(|c| c.to_ascii_lowercase())
        .collect()
}
pub struct ExternalPluginIndex {
    pub by_name: std::collections::HashMap<String, String>,
    pub by_stem: std::collections::HashMap<String, String>,
    pub by_file_name: std::collections::HashMap<String, String>,
    pub by_normalized: std::collections::HashMap<String, String>,
    pub by_uid: std::collections::HashMap<String, String>,
}
impl ExternalPluginIndex {
    pub fn from_maps(
        by_name: std::collections::HashMap<String, String>,
        by_stem: std::collections::HashMap<String, String>,
        by_file_name: std::collections::HashMap<String, String>,
        by_normalized: std::collections::HashMap<String, String>,
        by_uid: std::collections::HashMap<String, String>,
    ) -> Self {
        Self {
            by_name,
            by_stem,
            by_file_name,
            by_normalized,
            by_uid,
        }
    }
    pub fn build() -> Self {
        let mut by_name = std::collections::HashMap::new();
        let mut by_stem = std::collections::HashMap::new();
        let mut by_file_name = std::collections::HashMap::new();
        let mut by_normalized = std::collections::HashMap::new();
        let mut by_uid = std::collections::HashMap::new();
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
                    desc.path
                        .file_stem()
                        .and_then(|s| s.to_str())
                        .unwrap_or_default(),
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
            if let Some(uid) = desc.unique_id.as_ref() {
                let uid_trimmed = uid.trim();
                if !uid_trimmed.is_empty() {
                    let uid_key = uid_trimmed.to_lowercase();
                    by_uid
                        .entry(uid_key)
                        .or_insert_with(|| desc.path.to_string_lossy().to_string());
                    let normalized_uid = normalize_plugin_key(uid_trimmed);
                    if !normalized_uid.is_empty() {
                        by_uid
                            .entry(normalized_uid)
                            .or_insert_with(|| desc.path.to_string_lossy().to_string());
                    }
                }
            }
        }
        log::info!(
            "[ALS Import] ExternalPluginIndex built: {} by_name, {} by_stem, {} by_file_name, {} by_normalized, {} by_uid",
            by_name.len(),
            by_stem.len(),
            by_file_name.len(),
            by_normalized.len(),
            by_uid.len()
        );
        Self {
            by_name,
            by_stem,
            by_file_name,
            by_normalized,
            by_uid,
        }
    }
    pub fn resolve_by_name(&self, name: &str) -> Option<String> {
        let key = name.trim().to_lowercase();
        if key.is_empty() {
            return None;
        }
        let mut candidates: Vec<String> = Vec::new();
        let mut push_unique = |s: String| {
            if !s.is_empty() && !candidates.iter().any(|c| c == &s) {
                candidates.push(s);
            }
        };
        push_unique(key.clone());
        push_unique(key.replace('-', " "));
        push_unique(key.replace('_', " "));
        let mut simplified = key.clone();
        for suffix in [
            " plugin",
            " standalone",
            " vst3",
            " vst2",
            " au",
            " aax",
            " 64-bit",
            " 64 bit",
        ] {
            simplified = simplified.replace(suffix, "");
        }
        push_unique(simplified.trim().to_string());

        // ── Strip trailing version numbers (e.g. "Serum 2" → "serum") ──
        let without_version = key
            .trim_end_matches(|c: char| c.is_ascii_digit() || c == '.' || c == ' ')
            .trim()
            .to_string();
        if !without_version.is_empty() && without_version != key {
            push_unique(without_version.clone());
            push_unique(without_version.replace(' ', ""));
        }

        // ── Strip common platform/format decorators ──
        for suffix in [
            " x64", " x86", " stereo", " mono", " fx", " instrument",
            " synth", " effect", " demo",
        ] {
            let stripped = key.replace(suffix, "");
            let trimmed = stripped.trim().to_string();
            if !trimmed.is_empty() && trimmed != key {
                push_unique(trimmed);
            }
        }

        if key.contains("reastream") {
            push_unique("reastream".to_string());
        }
        if key.contains("nectar 3") || key.contains("nectar3") {
            push_unique("nectar 3".to_string());
            push_unique("nectar3".to_string());
            push_unique("nectar".to_string());
        }
        if key.contains("synthesizer v studio 2") || key.contains("synthesizer v") {
            push_unique("synthesizer v studio 2".to_string());
            push_unique("synthesizer v studio".to_string());
            push_unique("synthesizervstudio2".to_string());
            push_unique("synthesizervstudio".to_string());
        }
        if key.contains("serum") {
            push_unique("serum".to_string());
            push_unique("serum 2".to_string());
            push_unique("serum fx".to_string());
            push_unique("serumfx".to_string());
        }
        if key.contains("shaperbox") {
            push_unique("shaperbox".to_string());
            push_unique("shaperbox 3".to_string());
            push_unique("shaperbox3".to_string());
        }
        if key.contains("fabfilter") {
            push_unique(key.replace("fabfilter ", ""));
            push_unique(key.replace("fabfilter", ""));
        }
        if key.contains("izotope") {
            push_unique(key.replace("izotope ", ""));
        }
        for candidate in &candidates {
            if let Some(path) = self.by_name.get(candidate) {
                return Some(path.clone());
            }
            if let Some(path) = self.by_stem.get(candidate) {
                return Some(path.clone());
            }
            if let Some(path) = self.by_file_name.get(candidate) {
                return Some(path.clone());
            }
        }
        for candidate in &candidates {
            let normalized = normalize_plugin_key(candidate);
            if normalized.is_empty() {
                continue;
            }
            if let Some(path) = self.by_normalized.get(&normalized) {
                return Some(path.clone());
            }
            if let Some(path) = self
                .by_normalized
                .iter()
                .find(|(k, _)| k.contains(&normalized) || normalized.contains(*k))
                .map(|(_, v)| v.clone())
            {
                return Some(path);
            }
        }
        None
    }
    pub fn resolve_by_uid(&self, uid: &str) -> Option<String> {
        let raw = uid.trim();
        if raw.is_empty() {
            return None;
        }
        let key = raw.to_lowercase();
        if let Some(path) = self.by_uid.get(&key) {
            return Some(path.clone());
        }
        let normalized = normalize_plugin_key(raw);
        if normalized.is_empty() {
            return None;
        }
        if let Some(path) = self.by_uid.get(&normalized) {
            return Some(path.clone());
        }
        self.by_uid
            .iter()
            .find(|(k, _)| k.contains(&normalized) || normalized.contains(*k))
            .map(|(_, v)| v.clone())
    }
}
impl Default for ExternalPluginIndex {
    fn default() -> Self {
        Self::from_maps(
            std::collections::HashMap::new(),
            std::collections::HashMap::new(),
            std::collections::HashMap::new(),
            std::collections::HashMap::new(),
            std::collections::HashMap::new(),
        )
    }
}
pub fn infer_device_display_name(device: roxmltree::Node<'_, '_>, fallback_tag: &str) -> String {
    if let Some(user_name) = node_child_value(device, "UserName")
        && !user_name.trim().is_empty()
    {
        return user_name.trim().to_string();
    }
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
