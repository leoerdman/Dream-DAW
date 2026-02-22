// ═══════════════════════════════════════════════════════════════════════
// Dream DAW — Ableton ALS Plugin Mapper
// ═══════════════════════════════════════════════════════════════════════
//
// Maps Ableton Live device XML tags (EQ8, Compressor2, PluginDevice, etc.)
// to Dream DAW's canonical internal plugin IDs.
//
// Also handles:
//   • ExternalPluginMeta — VST2/VST3/AU metadata from ALS XML
//   • ExternalPluginIndex — Runtime plugin scanner index for name resolution
//   • Missing plugin slot construction for unresolved devices
//
// ═══════════════════════════════════════════════════════════════════════

use std::path::Path;
use dream_models::project::{DeviceNode, PluginSlot, Project};
use dream_models::midi::SamplerConfig;

use super::xml_helpers::*;

// ── Canonical Plugin ID Resolution ─────────────────────────────────────

/// Maps an Ableton device XML tag and plugin name to a canonical
/// Dream DAW plugin ID, display name, and slot kind ("instrument" or "effect").
pub fn canonical_internal_plugin_for_import(
    plugin_id: &str,
    plugin_name: &str,
) -> Option<(&'static str, &'static str, &'static str)> {
    let pid = plugin_id.trim().to_lowercase();
    let pname = plugin_name.trim().to_lowercase();

    let is_vst = pid == "plugindevice" || pid == "auplugindevice";
    if !is_vst {
        match pid.as_str() {
            "eq8" | "eqeight" | "channeleq" | "eqthree" => return Some(("internal://effect/eq-eight", "EQ", "effect")),
            "compressor2" | "compressor" | "gluecompressor" | "drumbuss" | "multibanddynamics" | "transientshaper" => return Some(("internal://effect/compressor", "Compressor", "effect")),
            "delay" | "echo" | "pingpongdelay" | "filterdelay" | "beatrepeat" | "graindelay" | "spectraltime" => return Some(("internal://effect/delay", "Delay", "effect")),
            "reverb" | "hybridreverb" | "corpus" | "resonators" | "spectralresonator" => return Some(("internal://effect/reverb", "Reverb", "effect")),
            "chorus" | "chorus2" | "ensemble" | "vibrato" => return Some(("internal://effect/chorus", "Chorus", "effect")),
            "utility" | "tuner" | "looper" | "frequencyshifter" | "shifter" | "autoshift" => return Some(("internal://effect/utility", "Utility", "effect")),
            "autopan" | "autopan2" => return Some(("internal://effect/auto-pan", "Auto Pan", "effect")),
            "saturator" | "dynamictube" => return Some(("internal://effect/saturator", "Saturator", "effect")),
            "spectrumanalyzer" | "spectrum" => return Some(("internal://effect/spectrum", "Spectrum", "effect")),
            "limiter" => return Some(("internal://effect/limiter", "Limiter", "effect")),
            "gate" => return Some(("internal://effect/gate", "Gate", "effect")),
            "redux" | "bitcrusher" => return Some(("internal://effect/bitcrusher", "Bitcrusher", "effect")),
            "autofilter" | "vocoder" => return Some(("internal://effect/auto-filter", "Auto Filter", "effect")),
            "phasernew" | "phaser" | "phaserflanger" => return Some(("internal://effect/phaser", "Phaser", "effect")),
            "flanger" => return Some(("internal://effect/flanger", "Flanger", "effect")),
            "erosion" | "vinyldistortion" | "distortion" | "overdrive" | "amp" | "cabinet" | "pedal" | "roar" => return Some(("internal://effect/distortion", "Distortion", "effect")),
            "noisemachine" => return Some(("internal://effect/noise-machine", "Noise Machine", "effect")),

            "midipitcher" => return Some(("internal://midi-fx/pitch", "MIDI Pitch", "effect")),
            "mxdevicescale" | "midichord" => return Some(("internal://midi-fx/scale", "MIDI Scale", "effect")),
            "mxdevicevelocity" | "midinotelength" | "midivelocity" => return Some(("internal://midi-fx/velocity", "MIDI Velocity", "effect")),
            "mxdevicerandom" | "midiarpeggiator" | "midirandom" => return Some(("internal://midi-fx/random", "MIDI Random", "effect")),

            "originalsimpler" | "multisampler" | "drumcell" | "instrumentimpulse" => return Some(("internal://instrument/sampler", "Sampler", "instrument")),
            "wavetable" | "operator" | "analog" | "collision" | "tension" | "electricpiano" | "instrumentmeld" | "drift" | "instrumentvector" | "loungelizard" | "ultraanalog" | "stringstudio" => return Some(("internal://instrument/wave-synth", "Wave Synth", "instrument")),

            _ => {}
        }
    }

    if is_vst {
        match pname.as_str() {
            "span" | "youlean loudness meter" | "loudness meter" | "psyscope" => return Some(("internal://effect/spectrum", "Spectrum", "effect")),
            "synthesizer v studio 2 plugin" => return Some(("internal://instrument/wave-synth", "Wave Synth", "instrument")),
            _ => return None,
        }
    }

    None
}

// ── Plugin Normalization ───────────────────────────────────────────────

/// Recursively normalizes plugin IDs across all tracks in a project.
pub fn normalize_internal_plugins_for_import(project: &mut Project) {
    for track in &mut project.tracks {
        if let Some(inst) = &mut track.instrument {
            let pid = inst.plugin_id();
            if pid.is_empty() || pid.starts_with("internal://") {
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
        }
        for fx in &mut track.effects {
            normalize_effect_node(fx, 0);
        }
    }
}

/// Recursively normalize a single `DeviceNode` and all children inside racks.
fn normalize_effect_node(node: &mut DeviceNode, depth: usize) {
    if depth > 16 {
        log::warn!("[normalize_effect_node] Recursion depth limit reached, skipping nested rack");
        return;
    }
    match node {
        DeviceNode::Single(slot) => {
            if !slot.plugin_id.is_empty()
                && !slot.plugin_id.starts_with("internal://")
            {
                return;
            }
            let pid = slot.plugin_id.clone();
            let pname = slot.name.clone();
            if let Some((canonical_id, canonical_name, _slot_kind)) =
                canonical_internal_plugin_for_import(&pid, &pname)
            {
                slot.plugin_id = canonical_id.to_string();
                if pname.trim().is_empty()
                    || pname.to_lowercase() != canonical_name.to_lowercase()
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

// ── Missing Plugin Slots ───────────────────────────────────────────────

/// Creates a missing-plugin placeholder slot for an unresolved Ableton device.
pub fn make_missing_plugin_slot(kind: &str, ableton_name: &str) -> DeviceNode {
    let normalized = ableton_name
        .chars()
        .map(|ch| {
            if ch.is_ascii_alphanumeric() { ch.to_ascii_lowercase() } else { '-' }
        })
        .collect::<String>()
        .split('-')
        .filter(|part| !part.is_empty())
        .collect::<Vec<_>>()
        .join("-");
    let slug = if normalized.is_empty() { "unknown".to_string() } else { normalized };
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

pub fn make_missing_external_plugin_slot_with_metadata(
    kind: &str,
    preferred_name: &str,
    user_name: &str,
    vst2_name: &str,
    vst2_path: &str,
    vst3_name: &str,
    vst3_path: &str,
    is_placeholder: bool,
    meta: Option<&ExternalPluginMeta>,
) -> DeviceNode {
    let mut details = Vec::new();
    if !user_name.trim().is_empty() { details.push(format!("user={}", user_name.trim())); }
    if !vst3_name.trim().is_empty() { details.push(format!("vst3={}", vst3_name.trim())); }
    if !vst3_path.trim().is_empty() { details.push(format!("vst3_path={}", vst3_path.trim())); }
    if !vst2_name.trim().is_empty() { details.push(format!("vst2={}", vst2_name.trim())); }
    if !vst2_path.trim().is_empty() { details.push(format!("vst2_path={}", vst2_path.trim())); }
    details.push(format!("placeholder={}", if is_placeholder { "1" } else { "0" }));

    let detail_text = details.join("; ");
    let display_name = if detail_text.is_empty() {
        format!("Plugin Not Found: {}", preferred_name.trim())
    } else {
        format!("Plugin Not Found: {} [{}]", preferred_name.trim(), detail_text)
    };

    let normalized = preferred_name
        .chars()
        .map(|ch| { if ch.is_ascii_alphanumeric() { ch.to_ascii_lowercase() } else { '-' } })
        .collect::<String>()
        .split('-')
        .filter(|part| !part.is_empty())
        .collect::<Vec<_>>()
        .join("-");
    let slug = if normalized.is_empty() { "unknown".to_string() } else { normalized };

    let mut query = Vec::new();
    query.push(format!("name={}", encode_missing_meta(preferred_name.trim())));
    if !user_name.trim().is_empty() { query.push(format!("user={}", encode_missing_meta(user_name.trim()))); }
    if !vst3_name.trim().is_empty() { query.push(format!("vst3={}", encode_missing_meta(vst3_name.trim()))); }
    if !vst3_path.trim().is_empty() { query.push(format!("vst3path={}", encode_missing_meta(vst3_path.trim()))); }
    if !vst2_name.trim().is_empty() { query.push(format!("vst2={}", encode_missing_meta(vst2_name.trim()))); }
    if !vst2_path.trim().is_empty() { query.push(format!("vst2path={}", encode_missing_meta(vst2_path.trim()))); }
    query.push(format!("placeholder={}", if is_placeholder { "1" } else { "0" }));

    let plugin_id = format!("missing://{kind}/{slug}?{}", query.join("&"));
    let mut slot = PluginSlot::new(display_name, plugin_id);
    if let Some(meta) = meta {
        apply_external_plugin_meta(&mut slot, meta);
    }
    DeviceNode::Single(slot)
}

// ── External Plugin Metadata ───────────────────────────────────────────

#[derive(Default)]
pub struct ExternalPluginMeta {
    pub format: Option<String>,
    pub uid: Option<String>,
    pub preset_name: Option<String>,
    pub program_number: Option<i32>,
    pub parameter_count: Option<i32>,
    pub stored_all_parameters: Option<bool>,
    pub plugin_version: Option<String>,
    pub state_blob: Option<String>,
    pub state_blob_kind: Option<String>,
    pub preset_blob: Option<String>,
    pub preset_blob_kind: Option<String>,
}

pub fn parse_external_plugin_meta(device: roxmltree::Node<'_, '_>) -> ExternalPluginMeta {
    fn node_value(node: roxmltree::Node<'_, '_>, tag: &str) -> Option<String> {
        node.descendants()
            .find(|n| n.is_element() && n.has_tag_name(tag))
            .and_then(|n| n.attribute("Value"))
            .map(|s| s.trim().to_string())
            .filter(|s| !s.is_empty())
    }
    fn parse_uid(info: roxmltree::Node<'_, '_>) -> Option<String> {
        if let Some(uid) = info
            .descendants()
            .find(|n| n.is_element() && n.has_tag_name("UniqueId"))
            .and_then(|n| n.attribute("Value"))
            .map(|s| s.trim().to_string())
            .filter(|s| !s.is_empty())
        {
            return Some(uid);
        }
        let mut parts = Vec::new();
        for field in info.descendants().filter(|n| {
            n.is_element()
                && n.tag_name().name().starts_with("Fields.")
                && n.attribute("Value").is_some()
        }) {
            if let Some(v) = field.attribute("Value") {
                parts.push(v.trim().to_string());
            }
        }
        if parts.is_empty() { None } else { Some(parts.join(":")) }
    }
    fn maybe_blob_text(node: roxmltree::Node<'_, '_>) -> Option<String> {
        if let Some(value) = node.attribute("Value") {
            let trimmed = value.trim();
            if trimmed.len() >= 32 { return Some(trimmed.to_string()); }
        }
        node.text()
            .map(str::trim)
            .filter(|s| s.len() >= 32)
            .map(ToString::to_string)
    }
    fn extract_blob(node: roxmltree::Node<'_, '_>, tag_hints: &[&str]) -> Option<(String, String)> {
        let mut best: Option<(String, String)> = None;
        for desc in node.descendants().filter(|n| n.is_element()) {
            let tag = desc.tag_name().name();
            let tag_lc = tag.to_ascii_lowercase();
            if !tag_hints.iter().any(|hint| tag_lc.contains(&hint.to_ascii_lowercase())) {
                continue;
            }
            if let Some(candidate) = maybe_blob_text(desc) {
                let replace = best.as_ref().map(|(_, current)| candidate.len() > current.len()).unwrap_or(true);
                if replace { best = Some((tag.to_string(), candidate)); }
            }
        }
        best
    }

    let mut meta = ExternalPluginMeta::default();
    let vst3_info = device.descendants().find(|n| n.is_element() && n.has_tag_name("Vst3PluginInfo"));
    let vst2_info = device.descendants().find(|n| n.is_element() && n.has_tag_name("VstPluginInfo"));
    let au_info = device.descendants().find(|n| n.is_element() && n.has_tag_name("AuPluginInfo"));

    if let Some(info) = vst3_info {
        meta.format = Some("vst3".to_string());
        meta.uid = parse_uid(info);
        meta.plugin_version = node_value(info, "Version")
            .or_else(|| node_value(info, "PlugVersion"))
            .or_else(|| node_value(info, "SdkVersion"));
    } else if let Some(info) = vst2_info {
        meta.format = Some("vst2".to_string());
        meta.uid = parse_uid(info);
        meta.plugin_version = node_value(info, "Version")
            .or_else(|| node_value(info, "PlugVersion"));
    } else if let Some(info) = au_info {
        meta.format = Some("au".to_string());
        meta.uid = parse_uid(info).or_else(|| node_value(info, "ComponentId"));
        meta.plugin_version = node_value(info, "Version");
    }

    let preset_node = device
        .descendants()
        .find(|n| n.is_element() && n.has_tag_name("Vst3Preset"))
        .or_else(|| device.descendants().find(|n| n.is_element() && n.has_tag_name("VstPreset")));
    if let Some(preset) = preset_node {
        meta.preset_name = node_value(preset, "Name");
        meta.program_number = node_value(preset, "ProgramNumber").as_deref().and_then(parse_i64_value).map(|v| v as i32);
        meta.parameter_count = node_value(preset, "ParameterCount").as_deref().and_then(parse_i64_value).map(|v| v as i32);
        meta.stored_all_parameters = node_value(preset, "StoredAllParameters").as_deref().and_then(parse_bool_value);
        meta.plugin_version = node_value(preset, "PluginVersion").or_else(|| meta.plugin_version.clone());
        if let Some((kind, blob)) = extract_blob(preset, &["chunk", "presetdata", "programdata", "buffer", "data", "state"]) {
            meta.preset_blob_kind = Some(kind);
            meta.preset_blob = Some(blob);
        }
    } else {
        meta.parameter_count = node_value(device, "NumberOfParameters").as_deref().and_then(parse_i64_value).map(|v| v as i32);
    }

    if let Some((kind, blob)) = extract_blob(device, &["pluginstate", "processorstate", "controllerstate", "vststate", "chunk", "statebuffer"]) {
        meta.state_blob_kind = Some(kind);
        meta.state_blob = Some(blob);
    }

    meta
}

pub fn apply_external_plugin_meta(slot: &mut PluginSlot, meta: &ExternalPluginMeta) {
    slot.external_format = meta.format.clone();
    slot.external_uid = meta.uid.clone();
    slot.external_preset_name = meta.preset_name.clone();
    slot.external_program_number = meta.program_number;
    slot.external_parameter_count = meta.parameter_count;
    slot.external_stored_all_parameters = meta.stored_all_parameters;
    slot.external_plugin_version = meta.plugin_version.clone();
    slot.external_state_blob = meta.state_blob.clone();
    slot.external_state_blob_kind = meta.state_blob_kind.clone();
    slot.external_preset_blob = meta.preset_blob.clone();
    slot.external_preset_blob_kind = meta.preset_blob_kind.clone();
}

// ── Plugin Key Normalization ───────────────────────────────────────────

pub fn normalize_plugin_key(raw: &str) -> String {
    raw.chars()
        .filter(|c| c.is_ascii_alphanumeric())
        .map(|c| c.to_ascii_lowercase())
        .collect()
}

// ── External Plugin Index (Scanner) ────────────────────────────────────

pub struct ExternalPluginIndex {
    pub by_name: std::collections::HashMap<String, String>,
    pub by_stem: std::collections::HashMap<String, String>,
    pub by_file_name: std::collections::HashMap<String, String>,
    pub by_normalized: std::collections::HashMap<String, String>,
}

impl ExternalPluginIndex {
    pub fn from_maps(
        by_name: std::collections::HashMap<String, String>,
        by_stem: std::collections::HashMap<String, String>,
        by_file_name: std::collections::HashMap<String, String>,
        by_normalized: std::collections::HashMap<String, String>,
    ) -> Self {
        Self {
            by_name,
            by_stem,
            by_file_name,
            by_normalized,
        }
    }

    pub fn build() -> Self {
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
                by_normalized.entry(normalized_name).or_insert_with(|| path_str.clone());
            }

            let stem_key = desc.path.file_stem().and_then(|s| s.to_str()).unwrap_or_default().to_lowercase();
            if !stem_key.is_empty() {
                by_stem.entry(stem_key).or_insert_with(|| path_str.clone());
                let normalized_stem = normalize_plugin_key(
                    desc.path.file_stem().and_then(|s| s.to_str()).unwrap_or_default(),
                );
                if !normalized_stem.is_empty() {
                    by_normalized.entry(normalized_stem).or_insert_with(|| path_str.clone());
                }
            }

            let file_key = desc.path.file_name().and_then(|s| s.to_str()).unwrap_or_default().to_lowercase();
            if !file_key.is_empty() {
                by_file_name.entry(file_key).or_insert(path_str);
            }
        }

        log::info!(
            "[ALS Import] ExternalPluginIndex built: {} by_name, {} by_stem, {} by_file_name, {} by_normalized",
            by_name.len(), by_stem.len(), by_file_name.len(), by_normalized.len()
        );

        Self { by_name, by_stem, by_file_name, by_normalized }
    }

    pub fn resolve_by_name(&self, name: &str) -> Option<String> {
        let key = name.trim().to_lowercase();
        if key.is_empty() { return None; }
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
        for suffix in [" plugin", " standalone", " vst3", " vst2", " au", " aax", " 64-bit", " 64 bit"] {
            simplified = simplified.replace(suffix, "");
        }
        push_unique(simplified.trim().to_string());

        if key.contains("reastream") { push_unique("reastream".to_string()); }
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

        for candidate in &candidates {
            if let Some(path) = self.by_name.get(candidate) { return Some(path.clone()); }
            if let Some(path) = self.by_stem.get(candidate) { return Some(path.clone()); }
            if let Some(path) = self.by_file_name.get(candidate) { return Some(path.clone()); }
        }

        for candidate in &candidates {
            let normalized = normalize_plugin_key(candidate);
            if normalized.is_empty() { continue; }
            if let Some(path) = self.by_normalized.get(&normalized) { return Some(path.clone()); }
            if let Some(path) = self.by_normalized.iter()
                .find(|(k, _)| k.contains(&normalized) || normalized.contains(*k))
                .map(|(_, v)| v.clone())
            {
                return Some(path);
            }
        }
        None
    }
}

impl Default for ExternalPluginIndex {
    fn default() -> Self {
        Self::from_maps(
            std::collections::HashMap::new(),
            std::collections::HashMap::new(),
            std::collections::HashMap::new(),
            std::collections::HashMap::new(),
        )
    }
}

// ── Device Display Name Inference ──────────────────────────────────────

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
        let tail = rel.replace('\\', "/").split('/').next_back().unwrap_or_default().trim().to_string();
        if !tail.is_empty() { return tail; }
    }

    let abs = device
        .descendants()
        .find(|n| n.is_element() && n.has_tag_name("Path"))
        .and_then(|n| n.attribute("Value"))
        .unwrap_or_default()
        .trim()
        .to_string();
    if !abs.is_empty() {
        let tail = Path::new(&abs).file_stem().and_then(|s| s.to_str()).unwrap_or_default().trim().to_string();
        if !tail.is_empty() { return tail; }
    }

    fallback_tag.to_string()
}
