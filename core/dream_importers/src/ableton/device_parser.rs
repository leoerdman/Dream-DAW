// ═══════════════════════════════════════════════════════════════════════
// Device Parser — External plugin metadata and missing-plugin slot builders
// ═══════════════════════════════════════════════════════════════════════
//
// Provides:
//   • ExternalPluginMeta — VST3/VST2/AU preset and state metadata
//   • parse_external_plugin_meta — Extracts metadata from ALS device XML
//   • apply_external_plugin_meta — Applies metadata to PluginSlot
//   • ExternalPluginIndex — Fuzzy local plugin resolution (by name/stem/path)
//   • make_missing_plugin_slot — Creates a placeholder DeviceNode
//   • make_missing_external_plugin_slot_with_metadata — Same with full metadata
//   • normalize_plugin_key / encode_missing_meta — Key normalization helpers
//
// ═══════════════════════════════════════════════════════════════════════

use std::collections::HashMap;

use crate::ableton::xml_helpers::{parse_bool_value, parse_i64_value};
use dream_models::project::{DeviceNode, PluginSlot};

// ── Key Normalization ───────────────────────────────────────────────────

/// Normalizes a plugin key to lowercase alphanumeric for fuzzy matching.
pub fn normalize_plugin_key(raw: &str) -> String {
    raw.chars()
        .filter(|c| c.is_ascii_alphanumeric())
        .map(|c| c.to_ascii_lowercase())
        .collect()
}

/// Percent-encodes non-alphanumeric characters for use in missing-plugin URIs.
fn encode_missing_meta(raw: &str) -> String {
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

// ── Missing Plugin Slot Builders ────────────────────────────────────────

/// Normalizes a plugin display name into a URL-safe slug.
fn slugify(name: &str) -> String {
    let normalized: String = name
        .chars()
        .map(|ch| {
            if ch.is_ascii_alphanumeric() {
                ch.to_ascii_lowercase()
            } else {
                '-'
            }
        })
        .collect();
    let slug: String = normalized
        .split('-')
        .filter(|part| !part.is_empty())
        .collect::<Vec<_>>()
        .join("-");
    if slug.is_empty() {
        "unknown".to_string()
    } else {
        slug
    }
}

/// Creates a placeholder DeviceNode for a plugin that could not be resolved
/// to a local installation (e.g., third-party plugin not installed).
pub fn make_missing_plugin_slot(kind: &str, ableton_name: &str) -> DeviceNode {
    let slug = slugify(ableton_name);
    DeviceNode::Single(PluginSlot::new(
        format!("Plugin Not Found: {}", ableton_name.trim()),
        format!("missing://{kind}/{slug}"),
    ))
}

/// Creates a placeholder DeviceNode with rich metadata for missing external
/// plugins (user name, VST2/VST3 paths, preset state, etc.).
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
    if !user_name.trim().is_empty() {
        details.push(format!("user={}", user_name.trim()));
    }
    if !vst3_name.trim().is_empty() {
        details.push(format!("vst3={}", vst3_name.trim()));
    }
    if !vst3_path.trim().is_empty() {
        details.push(format!("vst3_path={}", vst3_path.trim()));
    }
    if !vst2_name.trim().is_empty() {
        details.push(format!("vst2={}", vst2_name.trim()));
    }
    if !vst2_path.trim().is_empty() {
        details.push(format!("vst2_path={}", vst2_path.trim()));
    }
    details.push(format!(
        "placeholder={}",
        if is_placeholder { "1" } else { "0" }
    ));

    let detail_text = details.join("; ");
    let display_name = if detail_text.is_empty() {
        format!("Plugin Not Found: {}", preferred_name.trim())
    } else {
        format!(
            "Plugin Not Found: {} [{}]",
            preferred_name.trim(),
            detail_text
        )
    };

    let slug = slugify(preferred_name);

    let mut query = Vec::new();
    query.push(format!(
        "name={}",
        encode_missing_meta(preferred_name.trim())
    ));
    if !user_name.trim().is_empty() {
        query.push(format!("user={}", encode_missing_meta(user_name.trim())));
    }
    if !vst3_name.trim().is_empty() {
        query.push(format!("vst3={}", encode_missing_meta(vst3_name.trim())));
    }
    if !vst3_path.trim().is_empty() {
        query.push(format!(
            "vst3path={}",
            encode_missing_meta(vst3_path.trim())
        ));
    }
    if !vst2_name.trim().is_empty() {
        query.push(format!("vst2={}", encode_missing_meta(vst2_name.trim())));
    }
    if !vst2_path.trim().is_empty() {
        query.push(format!(
            "vst2path={}",
            encode_missing_meta(vst2_path.trim())
        ));
    }
    query.push(format!(
        "placeholder={}",
        if is_placeholder { "1" } else { "0" }
    ));

    let plugin_id = format!("missing://{kind}/{slug}?{}", query.join("&"));
    let mut slot = PluginSlot::new(display_name, plugin_id);
    if let Some(meta) = meta {
        apply_external_plugin_meta(&mut slot, meta);
    }
    DeviceNode::Single(slot)
}

// ── External Plugin Metadata ────────────────────────────────────────────

/// Metadata extracted from an ALS device's VST3/VST2/AU plugin info blocks.
/// Captures format, UID, preset state, and binary blobs for state restoration.
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

/// Parses external plugin metadata from an ALS device XML node.
/// Searches for Vst3PluginInfo, VstPluginInfo, and AuPluginInfo blocks,
/// extracts UIDs, preset data, and binary state blobs.
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
        // VST3 UID is often split into Fields.0..3 under <Uid>.
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
        if parts.is_empty() {
            None
        } else {
            Some(parts.join(":"))
        }
    }
    fn maybe_blob_text(node: roxmltree::Node<'_, '_>) -> Option<String> {
        if let Some(value) = node.attribute("Value") {
            let trimmed = value.trim();
            if trimmed.len() >= 32 {
                return Some(trimmed.to_string());
            }
        }
        node.text()
            .map(str::trim)
            .filter(|s| s.len() >= 32)
            .map(ToString::to_string)
    }
    fn extract_blob(
        node: roxmltree::Node<'_, '_>,
        tag_hints: &[&str],
    ) -> Option<(String, String)> {
        let mut best: Option<(String, String)> = None;
        for desc in node.descendants().filter(|n| n.is_element()) {
            let tag = desc.tag_name().name();
            let tag_lc = tag.to_ascii_lowercase();
            if !tag_hints
                .iter()
                .any(|hint| tag_lc.contains(&hint.to_ascii_lowercase()))
            {
                continue;
            }
            if let Some(candidate) = maybe_blob_text(desc) {
                let replace = best
                    .as_ref()
                    .map(|(_, current)| candidate.len() > current.len())
                    .unwrap_or(true);
                if replace {
                    best = Some((tag.to_string(), candidate));
                }
            }
        }
        best
    }

    let mut meta = ExternalPluginMeta::default();
    let vst3_info = device
        .descendants()
        .find(|n| n.is_element() && n.has_tag_name("Vst3PluginInfo"));
    let vst2_info = device
        .descendants()
        .find(|n| n.is_element() && n.has_tag_name("VstPluginInfo"));
    let au_info = device
        .descendants()
        .find(|n| n.is_element() && n.has_tag_name("AuPluginInfo"));

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
        .or_else(|| {
            device
                .descendants()
                .find(|n| n.is_element() && n.has_tag_name("VstPreset"))
        });
    if let Some(preset) = preset_node {
        meta.preset_name = node_value(preset, "Name");
        meta.program_number = node_value(preset, "ProgramNumber")
            .as_deref()
            .and_then(parse_i64_value)
            .map(|v| v as i32);
        meta.parameter_count = node_value(preset, "ParameterCount")
            .as_deref()
            .and_then(parse_i64_value)
            .map(|v| v as i32);
        meta.stored_all_parameters = node_value(preset, "StoredAllParameters")
            .as_deref()
            .and_then(parse_bool_value);
        meta.plugin_version =
            node_value(preset, "PluginVersion").or_else(|| meta.plugin_version.clone());
        if let Some((kind, blob)) = extract_blob(
            preset,
            &[
                "chunk",
                "presetdata",
                "programdata",
                "buffer",
                "data",
                "state",
            ],
        ) {
            meta.preset_blob_kind = Some(kind);
            meta.preset_blob = Some(blob);
        }
    } else {
        meta.parameter_count = node_value(device, "NumberOfParameters")
            .as_deref()
            .and_then(parse_i64_value)
            .map(|v| v as i32);
    }

    if let Some((kind, blob)) = extract_blob(
        device,
        &[
            "pluginstate",
            "processorstate",
            "controllerstate",
            "vststate",
            "chunk",
            "statebuffer",
        ],
    ) {
        meta.state_blob_kind = Some(kind);
        meta.state_blob = Some(blob);
    }

    meta
}

/// Applies parsed external plugin metadata to a PluginSlot.
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

// ── External Plugin Index ───────────────────────────────────────────────

/// An index of locally installed plugins for fuzzy name-based resolution
/// during ALS import. Supports multiple search strategies: exact name match,
/// file stem match, file name match, and normalized key match.
pub struct ExternalPluginIndex {
    by_name: HashMap<String, String>,
    by_stem: HashMap<String, String>,
    by_file_name: HashMap<String, String>,
    by_normalized: HashMap<String, String>,
}

impl ExternalPluginIndex {
    /// Scans all locally installed plugins and builds the resolution index.
    pub fn build() -> Self {
        let mut by_name = HashMap::new();
        let mut by_stem = HashMap::new();
        let mut by_file_name = HashMap::new();
        let mut by_normalized = HashMap::new();

        for desc in dream_plugins::PluginScanner::new().scan_all() {
            let path_str = desc.path.to_string_lossy().to_string();
            let name_key = desc.name.to_lowercase();
            by_name
                .entry(name_key)
                .or_insert_with(|| path_str.clone());
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
                by_stem
                    .entry(stem_key)
                    .or_insert_with(|| path_str.clone());
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
        }

        log::info!(
            "[ALS Import] ExternalPluginIndex built: {} by_name, {} by_stem, {} by_file_name, {} by_normalized",
            by_name.len(),
            by_stem.len(),
            by_file_name.len(),
            by_normalized.len()
        );

        Self {
            by_name,
            by_stem,
            by_file_name,
            by_normalized,
        }
    }

    /// Resolves a plugin name to a local installation path using multiple
    /// fuzzy matching strategies (exact, stem, file name, normalized key).
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

        // Well-known aliases for common third-party plugins.
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
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn normalize_plugin_key_strips_symbols() {
        assert_eq!(normalize_plugin_key("FabFilter Pro-Q 3"), "fabfilterproq3");
        assert_eq!(normalize_plugin_key("Serum_x64"), "serumx64");
    }

    #[test]
    fn slugify_handles_empty_and_special_chars() {
        assert_eq!(slugify(""), "unknown");
        assert_eq!(slugify("Pro-Q 3"), "pro-q-3");
        assert_eq!(slugify("Serum"), "serum");
    }

    #[test]
    fn encode_missing_meta_preserves_safe_chars() {
        assert_eq!(encode_missing_meta("hello-world"), "hello-world");
        assert_eq!(encode_missing_meta("Pro Q 3"), "Pro%20Q%203");
    }

    #[test]
    fn make_missing_plugin_slot_creates_valid_id() {
        let node = make_missing_plugin_slot("instrument", "FabFilter Pro-Q 3");
        match node {
            DeviceNode::Single(slot) => {
                assert!(slot.plugin_id.starts_with("missing://instrument/"));
                assert!(slot.name.contains("Plugin Not Found"));
            }
            _ => panic!("Expected Single variant"),
        }
    }
}
