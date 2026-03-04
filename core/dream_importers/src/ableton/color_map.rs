// ═══════════════════════════════════════════════════════════════════════
// Dream DAW — Ableton Color Mapping
// ═══════════════════════════════════════════════════════════════════════
//
// Maps Ableton Live's 70-color palette (indices 0–69) to Dream DAW's
// TrackColor enum AND provides exact hex values for 1:1 visual fidelity.
//
// The `color_hex` field on Track stores the exact Ableton hex value,
// while `color` stores the nearest TrackColor variant for programmatic use.
//
// ═══════════════════════════════════════════════════════════════════════

use crate::ableton::xml_helpers::{node_child_value, parse_i64_value};
use dream_models::project::TrackColor;

/// Exact Ableton Live 12 palette: 70 colors, 5 rows × 14 columns.
/// These are the stock track/clip colors as they appear in Ableton's color picker.
const ABLETON_PALETTE: [&str; 70] = [
    // Row 1 (pastel / bright)
    "#FE9AAA", "#FEA741", "#D19D3A", "#F7F58C", "#C1FC40", "#2DFE50",
    "#34FEAF", "#65FFEA", "#90C7FC", "#5C86E1", "#97ABFB", "#D975E2",
    "#E55CA2", "#FFFFFF",
    // Row 2 (saturated)
    "#FE3E40", "#F76F23", "#9F7752", "#FFF054", "#8DFF79", "#42C52E",
    "#11C2B2", "#28E9FD", "#1AA6EB", "#5C86E1", "#8E74E2", "#BA81C7",
    "#FE41D1", "#D9D9D9",
    // Row 3 (muted / pastel)
    "#E26F64", "#FEA67E", "#D6B27F", "#EEFFB7", "#D6E6A6", "#BFD383",
    "#A4C99A", "#D9FDE5", "#D2F3F9", "#C2C9E6", "#D3C4E5", "#B5A1E4",
    "#EAE3E7", "#B3B3B3",
    // Row 4 (desaturated)
    "#CB9B96", "#BB8862", "#9F8A75", "#C3BE78", "#A9C12F", "#84B45D",
    "#93C7C0", "#A5BBC9", "#8FACC5", "#8D9CCD", "#AE9FBB", "#C6A9C4",
    "#BF7A9C", "#838383",
    // Row 5 (dark)
    "#B53637", "#AE5437", "#775345", "#DEC633", "#899B31", "#57A53F",
    "#139F91", "#256686", "#1A3096", "#3155A4", "#6751AE", "#A752AF",
    "#CE3571", "#3F3F3F",
];

/// Maps an Ableton color index (0–69) to the nearest TrackColor variant.
/// Falls back to `TrackColor::for_index(fallback)` for out-of-range indices.
///
/// This mapping preserves hue semantics: each Ableton palette slot maps to
/// the closest Dream DAW color category for programmatic use (sort, group, etc.).
/// For exact visual fidelity, use `ableton_color_index_to_hex()`.
pub fn ableton_color_to_track_color(index: i64, fallback: usize) -> TrackColor {
    if !(0..=69).contains(&index) {
        return TrackColor::for_index(fallback);
    }
    match index {
        // Row 1 (0–13): Pastel / bright
        0 => TrackColor::Rose,     // #FE9AAA — pastel rose
        1 => TrackColor::Orange,   // #FEA741 — orange
        2 => TrackColor::Gold,     // #D19D3A — dark gold
        3 => TrackColor::Yellow,   // #F7F58C — pastel yellow
        4 => TrackColor::Lime,     // #C1FC40 — lime
        5 => TrackColor::Green,    // #2DFE50 — bright green
        6 => TrackColor::Teal,     // #34FEAF — teal-green
        7 => TrackColor::Cyan,     // #65FFEA — cyan
        8 => TrackColor::Sky,      // #90C7FC — sky blue
        9 => TrackColor::Blue,     // #5C86E1 — blue
        10 => TrackColor::Indigo,  // #97ABFB — lavender-blue
        11 => TrackColor::Purple,  // #D975E2 — purple
        12 => TrackColor::Magenta, // #E55CA2 — magenta-pink
        13 => TrackColor::Slate,   // #FFFFFF — white
        // Row 2 (14–27): Saturated
        14 => TrackColor::Coral,   // #FE3E40 — red
        15 => TrackColor::Orange,  // #F76F23 — deep orange
        16 => TrackColor::Gold,    // #9F7752 — brown-gold
        17 => TrackColor::Yellow,  // #FFF054 — yellow
        18 => TrackColor::Lime,    // #8DFF79 — lime green
        19 => TrackColor::Green,   // #42C52E — green
        20 => TrackColor::Teal,    // #11C2B2 — teal
        21 => TrackColor::Cyan,    // #28E9FD — cyan
        22 => TrackColor::Sky,     // #1AA6EB — blue
        23 => TrackColor::Blue,    // #5C86E1 — blue
        24 => TrackColor::Indigo,  // #8E74E2 — indigo
        25 => TrackColor::Purple,  // #BA81C7 — purple
        26 => TrackColor::Pink,    // #FE41D1 — hot pink
        27 => TrackColor::Slate,   // #D9D9D9 — light gray
        // Row 3 (28–41): Muted / pastel
        28 => TrackColor::Coral,   // #E26F64 — muted coral
        29 => TrackColor::Orange,  // #FEA67E — peach
        30 => TrackColor::Gold,    // #D6B27F — tan
        31 => TrackColor::Yellow,  // #EEFFB7 — pale yellow
        32 => TrackColor::Lime,    // #D6E6A6 — sage green
        33 => TrackColor::Lime,    // #BFD383 — olive
        34 => TrackColor::Green,   // #A4C99A — muted green
        35 => TrackColor::Teal,    // #D9FDE5 — mint
        36 => TrackColor::Cyan,    // #D2F3F9 — ice blue
        37 => TrackColor::Sky,     // #C2C9E6 — lavender
        38 => TrackColor::Indigo,  // #D3C4E5 — light purple
        39 => TrackColor::Purple,  // #B5A1E4 — purple
        40 => TrackColor::Pink,    // #EAE3E7 — blush
        41 => TrackColor::Slate,   // #B3B3B3 — gray
        // Row 4 (42–55): Desaturated
        42 => TrackColor::Rose,    // #CB9B96 — dusty rose
        43 => TrackColor::Orange,  // #BB8862 — brown
        44 => TrackColor::Gold,    // #9F8A75 — khaki
        45 => TrackColor::Yellow,  // #C3BE78 — mustard
        46 => TrackColor::Lime,    // #A9C12F — olive green
        47 => TrackColor::Green,   // #84B45D — forest green
        48 => TrackColor::Teal,    // #93C7C0 — sage teal
        49 => TrackColor::Cyan,    // #A5BBC9 — steel blue
        50 => TrackColor::Sky,     // #8FACC5 — powder blue
        51 => TrackColor::Blue,    // #8D9CCD — muted blue
        52 => TrackColor::Indigo,  // #AE9FBB — mauve
        53 => TrackColor::Purple,  // #C6A9C4 — lavender
        54 => TrackColor::Magenta, // #BF7A9C — muted magenta
        55 => TrackColor::Slate,   // #838383 — medium gray
        // Row 5 (56–69): Dark
        56 => TrackColor::Coral,   // #B53637 — dark red
        57 => TrackColor::Orange,  // #AE5437 — burnt orange
        58 => TrackColor::Gold,    // #775345 — dark brown
        59 => TrackColor::Yellow,  // #DEC633 — dark yellow
        60 => TrackColor::Lime,    // #899B31 — dark olive
        61 => TrackColor::Green,   // #57A53F — dark green
        62 => TrackColor::Teal,    // #139F91 — dark teal
        63 => TrackColor::Sky,     // #256686 — dark navy
        64 => TrackColor::Blue,    // #1A3096 — dark blue
        65 => TrackColor::Indigo,  // #3155A4 — dark indigo
        66 => TrackColor::Purple,  // #6751AE — dark purple
        67 => TrackColor::Magenta, // #A752AF — dark magenta
        68 => TrackColor::Pink,    // #CE3571 — dark pink
        69 => TrackColor::Slate,   // #3F3F3F — dark gray
        _ => unreachable!(), // guarded by contains check above
    }
}

/// Returns the exact hex color for a given Ableton color index (0–69).
///
/// Uses the official Ableton Live 12 palette for pixel-perfect color fidelity
/// when importing tracks and clips from .als files.
pub fn ableton_color_index_to_hex(index: i64) -> Option<&'static str> {
    if (0..70).contains(&index) {
        Some(ABLETON_PALETTE[index as usize])
    } else {
        None
    }
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
    fn color_hex_returns_exact_ableton_values() {
        // Exact Ableton Live 12 palette hex values
        assert_eq!(ableton_color_index_to_hex(0), Some("#FE9AAA"));
        assert_eq!(ableton_color_index_to_hex(17), Some("#FFF054"));
        assert_eq!(ableton_color_index_to_hex(24), Some("#8E74E2"));
        assert_eq!(ableton_color_index_to_hex(56), Some("#B53637"));
        assert_eq!(ableton_color_index_to_hex(69), Some("#3F3F3F"));
        assert_eq!(ableton_color_index_to_hex(-1), None);
        assert_eq!(ableton_color_index_to_hex(70), None);
    }

    #[test]
    fn color_mapping_covers_all_70_indices() {
        for i in 0..70 {
            let color = ableton_color_to_track_color(i, 0);
            // Should never panic — all 70 indices must map to a valid TrackColor
            let _ = color.hex();
        }
    }

    #[test]
    fn out_of_range_gives_fallback() {
        assert_eq!(ableton_color_to_track_color(-1, 3), TrackColor::for_index(3));
        assert_eq!(ableton_color_to_track_color(70, 5), TrackColor::for_index(5));
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
