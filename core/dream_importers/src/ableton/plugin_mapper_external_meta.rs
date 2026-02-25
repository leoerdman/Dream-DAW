use dream_models::project::PluginSlot;

use super::xml_helpers::{parse_bool_value, parse_i64_value};

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
    fn extract_blob(node: roxmltree::Node<'_, '_>, tag_hints: &[&str]) -> Option<(String, String)> {
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
        meta.plugin_version =
            node_value(info, "Version").or_else(|| node_value(info, "PlugVersion"));
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
