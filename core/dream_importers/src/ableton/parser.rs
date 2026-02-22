// ═══════════════════════════════════════════════════════════════════════
// ALS Parser — foundational helpers for top-level Ableton import
// ═══════════════════════════════════════════════════════════════════════
//
// This module holds non-UI, non-Tauri orchestration helpers used by the
// desktop host ALS importer:
// - read/decompress ALS payload
// - parse XML document and resolve <LiveSet>
// - parse top-level tempo/sample-rate/project-name defaults
//
// Full end-to-end project import orchestration is still migrated in phases.
// ═══════════════════════════════════════════════════════════════════════

use std::io::Read;
use std::path::Path;

use crate::ableton::xml_helpers::parse_f64_value;

pub fn read_als_xml_text(file_path: &Path) -> Result<String, String> {
    let bytes = std::fs::read(file_path)
        .map_err(|e| format!("Failed to read ALS file '{}': {e}", file_path.display()))?;
    let xml_bytes = {
        let mut decoder = flate2::read::GzDecoder::new(&bytes[..]);
        let mut inflated = Vec::new();
        match decoder.read_to_end(&mut inflated) {
            Ok(_) if !inflated.is_empty() => inflated,
            _ => bytes,
        }
    };
    String::from_utf8(xml_bytes).map_err(|e| format!("ALS is not valid UTF-8 XML: {e}"))
}

pub fn parse_als_document<'a>(xml_text: &'a str) -> Result<roxmltree::Document<'a>, String> {
    roxmltree::Document::parse(xml_text).map_err(|e| format!("Failed to parse ALS XML: {e}"))
}

pub fn find_live_set<'a>(
    doc: &'a roxmltree::Document<'a>,
) -> Result<roxmltree::Node<'a, 'a>, String> {
    doc.descendants()
        .find(|n| n.is_element() && n.has_tag_name("LiveSet"))
        .ok_or_else(|| "ALS parse error: <LiveSet> node not found".to_string())
}

pub fn parse_project_name(file_path: &Path) -> String {
    file_path
        .file_stem()
        .and_then(|s| s.to_str())
        .map(|s| s.trim())
        .filter(|s| !s.is_empty())
        .unwrap_or("Imported Ableton Project")
        .to_string()
}

pub fn parse_main_tempo(live_set: roxmltree::Node<'_, '_>) -> f64 {
    live_set
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
        .unwrap_or(120.0)
}

pub fn parse_imported_sample_rate(live_set: roxmltree::Node<'_, '_>) -> f64 {
    live_set
        .descendants()
        .find(|n| n.is_element() && n.has_tag_name("OverrideSampleRate"))
        .and_then(|n| n.children().find(|c| c.is_element() && c.has_tag_name("Manual")))
        .and_then(|n| n.attribute("Value"))
        .and_then(parse_f64_value)
        .filter(|v| *v > 0.0)
        .or_else(|| {
            live_set
                .descendants()
                .find(|n| n.is_element() && n.has_tag_name("SampleRate"))
                .and_then(|n| n.children().find(|c| c.is_element() && c.has_tag_name("Manual")))
                .and_then(|n| n.attribute("Value"))
                .and_then(parse_f64_value)
                .filter(|v| *v > 0.0)
        })
        .unwrap_or(44100.0)
}

pub fn resolve_timeline_sample_rate(imported_sample_rate: f64, target_sample_rate: Option<f64>) -> f64 {
    target_sample_rate
        .filter(|v| v.is_finite() && *v > 0.0)
        .unwrap_or(imported_sample_rate)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::Path;

    #[test]
    fn parse_project_name_uses_file_stem() {
        let p = Path::new("/tmp/My Cool Project.als");
        assert_eq!(parse_project_name(p), "My Cool Project");
    }

    #[test]
    fn parse_main_tempo_reads_manual_value() {
        let xml = r#"
        <Ableton>
          <LiveSet>
            <MainTrack>
              <Tempo>
                <Manual Value="174.0" />
              </Tempo>
            </MainTrack>
          </LiveSet>
        </Ableton>
        "#;
        let doc = parse_als_document(xml).expect("doc");
        let live_set = find_live_set(&doc).expect("live set");
        assert!((parse_main_tempo(live_set) - 174.0).abs() < 1e-9);
    }

    #[test]
    fn parse_imported_sample_rate_prefers_override() {
        let xml = r#"
        <Ableton>
          <LiveSet>
            <SampleRate><Manual Value="44100"/></SampleRate>
            <OverrideSampleRate><Manual Value="48000"/></OverrideSampleRate>
          </LiveSet>
        </Ableton>
        "#;
        let doc = parse_als_document(xml).expect("doc");
        let live_set = find_live_set(&doc).expect("live set");
        assert!((parse_imported_sample_rate(live_set) - 48000.0).abs() < 1e-9);
    }

    #[test]
    fn resolve_timeline_sample_rate_prefers_valid_target() {
        assert_eq!(resolve_timeline_sample_rate(44100.0, Some(48000.0)), 48000.0);
        assert_eq!(resolve_timeline_sample_rate(44100.0, Some(0.0)), 44100.0);
        assert_eq!(resolve_timeline_sample_rate(44100.0, None), 44100.0);
    }
}
