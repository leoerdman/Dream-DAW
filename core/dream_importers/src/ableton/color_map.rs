// ═══════════════════════════════════════════════════════════════════════
// Dream DAW — Ableton Color Mapping
// ═══════════════════════════════════════════════════════════════════════
//
// Maps Ableton Live's 70-color palette (indices 0–69) to Dream DAW's
// TrackColor enum. Also provides the exact hex values for each index.
//
// ═══════════════════════════════════════════════════════════════════════

use dream_models::project::TrackColor;

/// Maps an Ableton color index (0–69) to the nearest TrackColor variant.
/// Falls back to `TrackColor::for_index(fallback)` for out-of-range indices.
pub fn ableton_color_to_track_color(index: i64, fallback: usize) -> TrackColor {
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

/// Returns the exact Ableton Live hex color for a given color index (0–69).
///
/// Ableton uses a 70-color palette arranged in a 14×5 grid.
pub fn ableton_color_index_to_hex(index: i64) -> Option<&'static str> {
    const ABLETON_COLORS: [&str; 70] = [
        "#FF94A6", "#FFA529", "#CC9927", "#F7F47C", "#BEFA40", "#20FF32", "#25FEA9",
        "#5CFFE8", "#8DC7FA", "#5480E4", "#92A8FB", "#D170DA", "#E156A1", "#FFFFFF",
        "#FF3636", "#F66C03", "#997551", "#FFF034", "#87FF67", "#3DC300", "#00BFA8",
        "#19E9FD", "#10A4EE", "#007DC0", "#886CE4", "#B677C6", "#FF39D4", "#D0D0D0",
        "#E2675A", "#FFA374", "#D3AD71", "#EDFFAE", "#D2E498", "#BAD074", "#9FC48D",
        "#D4FDE1", "#CDF1F8", "#B9C1E3", "#CDBADB", "#AF97E4", "#E5DDE1", "#A9A9A9",
        "#C6928B", "#B58057", "#9A8468", "#BEBA6F", "#A3B82C", "#85B054", "#90C3BB",
        "#9EBAC1", "#8BA7BF", "#8998C8", "#A99AB5", "#BEA4BC", "#BD7396", "#7B7B7B",
        "#AF3333", "#A85131", "#724F41", "#DFC133", "#85982C", "#529F36", "#0A9C8E",
        "#236384", "#1A2F96", "#2F52A2", "#624BAD", "#A34BAD", "#CC2E6E", "#3E3E3E",
    ];
    if (0..=69).contains(&index) {
        Some(ABLETON_COLORS[index as usize])
    } else {
        None
    }
}
