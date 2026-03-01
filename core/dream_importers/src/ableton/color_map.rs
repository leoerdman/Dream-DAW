// ═══════════════════════════════════════════════════════════════════════
// Dream DAW — Ableton Color Mapping
// ═══════════════════════════════════════════════════════════════════════
//
// Maps Ableton Live's 70-color palette (indices 0–69) to Dream DAW's
// TrackColor enum. Also provides the exact hex values for each index.
//
// ═══════════════════════════════════════════════════════════════════════

use crate::ableton::xml_helpers::{node_child_value, parse_i64_value};
use dream_models::project::TrackColor;

/// Maps an Ableton color index (0–69) to the nearest TrackColor variant.
/// Falls back to `TrackColor::for_index(fallback)` for out-of-range indices.
pub fn ableton_color_to_track_color(index: i64, fallback: usize) -> TrackColor {
    // Ableton uses a 70-slot palette with multiple shade banks.
    // We preserve hue semantics across the whole range instead of
    // collapsing high indices into a single gray bucket.
    let semantic_index = match index {
        0..=37 => index,
        38..=69 => index - 38,
        _ => return TrackColor::for_index(fallback),
    };

    match semantic_index {
        // Reds / Coral
        0..=2 => TrackColor::Coral,
        // Oranges
        3..=5 => TrackColor::Orange,
        // Golds
        6 | 7 => TrackColor::Gold,
        // Yellows
        8 | 9 => TrackColor::Yellow,
        // Limes
        10..=12 => TrackColor::Lime,
        // Greens
        13..=15 => TrackColor::Green,
        // Teals
        16 | 17 => TrackColor::Teal,
        // Cyans
        18 | 19 => TrackColor::Cyan,
        // Sky blues
        20 | 21 => TrackColor::Sky,
        // Blues
        22..=24 => TrackColor::Blue,
        // Indigos
        25 | 26 => TrackColor::Indigo,
        // Purples
        27..=29 => TrackColor::Purple,
        // Magentas
        30 | 31 => TrackColor::Magenta,
        // Pinks
        32..=34 => TrackColor::Pink,
        // Roses
        35..=37 => TrackColor::Rose,
        // Defensive fallback (should be unreachable for valid ALS color indices)
        _ => TrackColor::Slate,
    }
}

/// Returns a stable UI hex color for a given Ableton color index.
///
/// We intentionally derive this from the same 70→16 semantic mapping as
/// `ableton_color_to_track_color` so track/clip colors stay consistent
/// throughout the app even when ALS variants use different palette internals.
pub fn ableton_color_index_to_hex(index: i64) -> Option<String> {
    (0..=69)
        .contains(&index)
        .then(|| ableton_color_to_track_color(index, 0).hex())
}

/// Extracts an Ableton color index from the known ALS representations.
///
/// Supports both element and attribute forms:
/// - `<Color Value="17"/>`
/// - `<ColorIndex Value="17"/>`
/// - `Color="17"`
/// - `ColorIndex="17"`
pub fn extract_ableton_color_index(node: roxmltree::Node<'_, '_>) -> Option<i64> {
    node_child_value(node, "Color")
        .or_else(|| node_child_value(node, "ColorIndex"))
        .or_else(|| node.attribute("Color").map(|s| s.to_string()))
        .or_else(|| node.attribute("ColorIndex").map(|s| s.to_string()))
        .as_deref()
        .and_then(parse_i64_value)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn color_hex_is_derived_from_track_color_mapping() {
        assert_eq!(ableton_color_index_to_hex(17), Some(TrackColor::Teal.hex()));
        assert_eq!(ableton_color_index_to_hex(24), Some(TrackColor::Blue.hex()));
        assert_eq!(ableton_color_index_to_hex(56), Some(TrackColor::Cyan.hex()));
        assert_eq!(ableton_color_index_to_hex(-1), None);
        assert_eq!(ableton_color_index_to_hex(70), None);
    }

    #[test]
    fn extract_color_index_supports_node_and_attribute_forms() {
        let xml = r#"
        <Root>
          <A><Color Value="12"/></A>
          <B><ColorIndex Value="24"/></B>
          <C Color="33" />
          <D ColorIndex="48" />
        </Root>
        "#;
        let doc = roxmltree::Document::parse(xml).expect("valid xml");
        let root = doc.root_element();
        let nodes: Vec<_> = root.children().filter(|n| n.is_element()).collect();

        assert_eq!(extract_ableton_color_index(nodes[0]), Some(12));
        assert_eq!(extract_ableton_color_index(nodes[1]), Some(24));
        assert_eq!(extract_ableton_color_index(nodes[2]), Some(33));
        assert_eq!(extract_ableton_color_index(nodes[3]), Some(48));
    }
}
