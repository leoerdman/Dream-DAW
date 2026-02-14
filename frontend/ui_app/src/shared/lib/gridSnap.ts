// ═══════════════════════════════════════════════════════════════════════════
// Dream DAW — Grid Snap Mathematics (Pure Functions)
// ═══════════════════════════════════════════════════════════════════════════
//
// Zero-dependency snap/quantize math used by the GridStore and tests.
//
// All functions are pure — no side effects, no store access. This allows
// easy unit testing and deterministic behavior across all snap consumers
// (Timeline drag, drop, split, double-click, etc.).
//
// ═══════════════════════════════════════════════════════════════════════════

/** Supported grid division values — mirrors professional DAW quantize menus. */
export type GridDivision =
    | '1/1'   // Whole note (bar)
    | '1/2'   // Half note
    | '1/4'   // Quarter note (default)
    | '1/8'   // Eighth note
    | '1/16'  // Sixteenth note
    | '1/32'  // Thirty-second note
    | 'OFF';  // No snapping (free positioning)

// ── Division → Numeric Divisor ──────────────────────────────────────────

/** Maps a GridDivision to its numeric divisor relative to a whole bar. */
const DIVISION_DIVISORS: Record<Exclude<GridDivision, 'OFF'>, number> = {
    '1/1': 1,
    '1/2': 2,
    '1/4': 4,
    '1/8': 8,
    '1/16': 16,
    '1/32': 32,
};

// ── Core Math ───────────────────────────────────────────────────────────

/**
 * Calculates the beat interval (in beats) for a given grid division.
 *
 * @param division - Current grid division (e.g., '1/8')
 * @param beatsPerBar - Beats per bar from time signature (e.g., 4 for 4/4)
 * @param triplet - Whether triplet mode is active (multiplies by 2/3)
 * @returns Beat interval, or 0 if division is 'OFF'
 *
 * @example
 * divisionToInterval('1/4', 4, false)  // → 1.0    (quarter note in 4/4)
 * divisionToInterval('1/8', 4, false)  // → 0.5    (eighth note in 4/4)
 * divisionToInterval('1/8', 4, true)   // → 0.333  (eighth triplet in 4/4)
 * divisionToInterval('1/1', 4, false)  // → 4.0    (whole bar in 4/4)
 */
export function divisionToInterval(
    division: GridDivision,
    beatsPerBar: number,
    triplet: boolean,
): number {
    if (division === 'OFF') return 0;
    const divisor = DIVISION_DIVISORS[division];
    const interval = beatsPerBar / divisor;
    return triplet ? interval * (2 / 3) : interval;
}

/**
 * Snaps a raw beat value to the nearest grid line.
 *
 * @param rawBeat - Unsnapped beat position
 * @param interval - Grid interval in beats (from `divisionToInterval`)
 * @returns Snapped beat position, clamped to >= 0.
 *          Returns rawBeat unchanged if interval is 0 (OFF mode).
 */
export function snapToGrid(rawBeat: number, interval: number): number {
    if (interval <= 0) return Math.max(0, rawBeat);
    return Math.max(0, Math.round(rawBeat / interval) * interval);
}

/**
 * Converts a pixel X position to a snapped beat value.
 *
 * Convenience function combining pixel→beat conversion with snap.
 *
 * @param px - X position in pixels (relative to timeline origin)
 * @param pixelsPerBeat - Current zoom level in pixels per beat
 * @param interval - Grid interval in beats (0 = no snap)
 * @param freeMode - When true, bypass snap (Alt-key held)
 * @returns Snapped beat position >= 0
 */
export function pixelToSnappedBeat(
    px: number,
    pixelsPerBeat: number,
    interval: number,
    freeMode: boolean = false,
): number {
    const rawBeat = px / pixelsPerBeat;
    if (freeMode || interval <= 0) return Math.max(0, rawBeat);
    return snapToGrid(rawBeat, interval);
}

/**
 * Determines the finest sub-division to render as grid lines based on zoom.
 *
 * Only renders sub-lines when there's enough pixel density to see them
 * (minimum 6px between lines). Returns an array of beat positions to draw.
 *
 * @param totalBeats - Total beats in the visible range
 * @param beatsPerBar - Beats per bar
 * @param pixelsPerBeat - Current zoom level
 * @returns Array of { beat, isBar, isMainBeat, isSub } line descriptors
 */
export interface GridLine {
    beat: number;
    /** This is a bar line (strongest) */
    isBar: boolean;
    /** This is a main beat line (1/4 note level) */
    isMainBeat: boolean;
    /** Subdivision depth: 0=bar, 1=beat, 2=1/8, 3=1/16, 4=1/32 */
    depth: number;
}

const SUB_DIVISIONS = [1, 2, 4, 8, 16] as const; // beat subdivisions
const MIN_LINE_SPACING_PX = 6;

export function computeGridLines(
    totalBeats: number,
    beatsPerBar: number,
    pixelsPerBeat: number,
): GridLine[] {
    const lines: GridLine[] = [];

    // Find the finest subdivision where lines are >6px apart
    let finestSubPerBeat = 1;
    for (const sub of SUB_DIVISIONS) {
        const spacing = pixelsPerBeat / sub;
        if (spacing >= MIN_LINE_SPACING_PX) {
            finestSubPerBeat = sub;
        }
    }

    // Generate all lines at the finest resolution
    const totalSubdivisions = Math.ceil(totalBeats * finestSubPerBeat);
    for (let i = 0; i <= totalSubdivisions; i++) {
        const beat = i / finestSubPerBeat;
        if (beat > totalBeats) break;

        const isBar = beat % beatsPerBar === 0;
        const isMainBeat = beat % 1 === 0;

        // Calculate depth
        let depth = 4; // default: finest
        if (isBar) depth = 0;
        else if (isMainBeat) depth = 1;
        else if ((beat * 2) % 1 === 0) depth = 2;
        else if ((beat * 4) % 1 === 0) depth = 3;

        lines.push({ beat, isBar, isMainBeat, depth });
    }

    return lines;
}
