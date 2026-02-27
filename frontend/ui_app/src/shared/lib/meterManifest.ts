// ═══════════════════════════════════════════════════════════════════════════
// Dream DAW — Metering Manifest (SSOT)
// ═══════════════════════════════════════════════════════════════════════════
//
// Single Source of Truth for ALL metering behaviour across the application.
//
// Every component that displays signal level — DeviceRack MeterBar,
// TrackInspector fader strip, DawShell session track meters, DawShell
// master meter — MUST import its constants and helper functions from
// this file.  Inline `(peak + 60) / 60` patterns, hard-coded gradient
// colors, and ad-hoc threshold checks are PROHIBITED.
//
// ═══════════ SPECIFICATION ═════════════════════════════════════════════════
//
// The metering system models professional-DAW–grade peak meters
// inspired by Ableton Live, Logic Pro, and FL Studio.
//
//  ┌──────────────────────────────────────────────────────────────────┐
//  │  +6 dB ─── ceiling (clips to top)                  ██ RED     │
//  │  +4 dB                                             ██         │
//  │  +2 dB                                             ██         │
//  │   0 dB ─── unity gain (divider line)     ──────────██──────── │
//  │  −2 dB ─── warning transition start      ██ YELLOW → GREEN    │
//  │  −6 dB                                   ██ GREEN             │
//  │ −12 dB                                   ██                   │
//  │ −24 dB                                   ██                   │
//  │ −48 dB                                   ██                   │
//  │ −60 dB ─── floor (silence)               ▁▁                  │
//  └──────────────────────────────────────────────────────────────────┘
//
// Gradient Color Zones (bottom → top):
//
//  Zone 1 — SAFE     (−60 dB → −2 dB)  : solid green   var(--token-color-hex-36c95a)
//  Zone 2 — WARNING  (−2 dB  →  0 dB)  : green→yellow  var(--token-color-hex-36c95a) → var(--token-color-hex-f2d33e)
//  Zone 3 — HOT      ( 0 dB  → +3 dB)  : yellow→orange var(--token-color-hex-f2d33e) → var(--token-color-hex-ff8c1a)
//  Zone 4 — CLIP     (+3 dB  → +6 dB)  : orange→red    var(--token-color-hex-ff8c1a) → var(--token-color-hex-ff3333)
//
// The gradient is STATIC: the entire bar background is a fixed
// green-to-red gradient.  The "fill" div simply grows from height 0%
// to height 100%, revealing more of the gradient as level rises.
// The bar NEVER changes color — only its HEIGHT changes.
//
// ═══════════════════════════════════════════════════════════════════════════

import { clamp01 } from '@/shared/lib/audioMath';

// ─── Range Constants ─────────────────────────────────────────────────────

/** Minimum displayable level in dBFS.  Anything below this reads as silence. */
export const DB_FLOOR = -60;

/** Maximum displayable level in dBFS.  Levels above this pin to the ceiling. */
export const DB_CEILING = 6;

/** Total display range in dB. */
export const DB_RANGE = DB_CEILING - DB_FLOOR; // 66

/** 0 dB (unity) as a normalised fraction of the display range (≈ 0.9091). */
export const DB_ZERO_NORM = (0 - DB_FLOOR) / DB_RANGE; // 60/66

// ─── Threshold Constants ─────────────────────────────────────────────────

/** dB level where green→yellow transition BEGINS. */
export const DB_WARN_START = -2;

/** dB level where yellow→orange transition BEGINS (unity). */
export const DB_HOT_START = 0;

/** dB level where orange→red transition BEGINS. */
export const DB_CLIP_START = 3;

/** Normalised position of the warning threshold. */
export const DB_WARN_NORM = (DB_WARN_START - DB_FLOOR) / DB_RANGE; // 58/66 ≈ 0.8788

/** Normalised position of the hot threshold. */
export const DB_HOT_NORM = (DB_HOT_START - DB_FLOOR) / DB_RANGE; // 60/66 ≈ 0.9091

/** Normalised position of the clip threshold. */
export const DB_CLIP_NORM = (DB_CLIP_START - DB_FLOOR) / DB_RANGE; // 63/66 ≈ 0.9545

// ─── Color Constants ─────────────────────────────────────────────────────

/** Green — safe zone (−60 dB → −2 dB). */
export const COLOR_METER_GREEN = 'var(--token-color-hex-36c95a)';

/** Yellow — warning zone (−2 dB → 0 dB). */
export const COLOR_METER_YELLOW = 'var(--token-color-hex-f2d33e)';

/** Orange — hot zone (0 dB → +3 dB). */
export const COLOR_METER_ORANGE = 'var(--token-color-hex-ff8c1a)';

/** Red — clip zone (+3 dB → +6 dB). */
export const COLOR_METER_RED = 'var(--token-color-hex-ff3333)';

/** Meter background (dark well). */
export const COLOR_METER_BG = 'var(--color-meter-bg, var(--token-color-hex-1e1e1e))';

/** 0 dB divider line color. */
export const COLOR_ZERO_DB_LINE = 'var(--token-color-rgba-255-255-255-0d25)';

/** Channel divider color (between L and R). */
export const COLOR_CHANNEL_DIVIDER = 'var(--token-color-rgba-255-255-255-0d06)';

// ─── MIDI Meter ──────────────────────────────────────────────────────────

/** MIDI velocity meter color (distinct from audio). */
export const COLOR_METER_MIDI = 'var(--token-color-hex-ffd34d)';

// ─── Gradient Stops ──────────────────────────────────────────────────────
//
// These define the STATIC vertical gradient painted on the fill bar.
// Percentages are relative to the TOTAL bar height (bottom = 0%).
//
// The gradient is bottom-to-top, so 0% = bottom, 100% = top.
// The fill div starts at the bottom and grows upward.

export interface MeterGradientStop {
    /** CSS color. */
    color: string;
    /** Position as fraction 0..1 from bottom. */
    position: number;
}

/**
 * Ordered gradient stops (bottom → top) for the meter fill.
 *
 * These map to the dB thresholds:
 *   0.000 → −60 dB (green)
 *   0.879 → −2 dB  (green, begin transition)
 *   0.909 →  0 dB  (yellow)
 *   0.955 → +3 dB  (orange)
 *   1.000 → +6 dB  (red)
 */
export const METER_GRADIENT_STOPS: readonly MeterGradientStop[] = [
    { color: COLOR_METER_GREEN, position: 0 },
    { color: COLOR_METER_GREEN, position: DB_WARN_NORM },
    { color: COLOR_METER_YELLOW, position: DB_HOT_NORM },
    { color: COLOR_METER_ORANGE, position: DB_CLIP_NORM },
    { color: COLOR_METER_RED, position: 1 },
] as const;

// ─── Precomputed CSS Gradients ───────────────────────────────────────────

/**
 * Build a CSS `linear-gradient` from the meter stops.
 *
 * @param direction  CSS gradient direction (default: `to top` for vertical)
 * @returns          A complete CSS `linear-gradient(...)` value.
 */
export function buildMeterGradientCSS(direction = 'to top'): string {
    const stops = METER_GRADIENT_STOPS.map(
        (s) => `${s.color} ${(s.position * 100).toFixed(1)}%`,
    ).join(', ');
    return `linear-gradient(${direction}, ${stops})`;
}

/** Pre-built vertical gradient (bottom → top).  Used by `<MeterStrip>`. */
export const METER_GRADIENT_VERTICAL = buildMeterGradientCSS('to top');

/** Pre-built horizontal gradient (left → right).  Available if needed. */
export const METER_GRADIENT_HORIZONTAL = buildMeterGradientCSS('to right');

// ─── dB ↔ Normalized Conversion ─────────────────────────────────────────

/**
 * Convert a peak dB value to a normalised 0..1 fraction for meter display.
 *
 * Range:  −60 dB → 0,  0 dB → 0.909,  +6 dB → 1.0.
 *
 * This replaces the old `vuNorm()` function from `audioMath.ts`.
 * Every meter in the application MUST use this function.
 *
 * @param peakDb  Peak level in dBFS.
 * @returns       Normalised 0..1 value.
 */
export function dbToMeterNorm(peakDb: number): number {
    if (!isFinite(peakDb) || peakDb < DB_FLOOR) return 0;
    if (peakDb > DB_CEILING) return 1;
    return (peakDb - DB_FLOOR) / DB_RANGE;
}

/**
 * Convert a linear amplitude (0..1+) to a normalised 0..1 fraction
 * for meter display.
 *
 * Used by DeviceRack which receives levels as linear 0..1 values
 * rather than dBFS.
 *
 * Conversion: linear → dB → normalised.
 *   - 0.0 → −∞ dB → 0
 *   - 1.0 → 0 dB → 0.909
 *   - ~2.0 → +6 dB → 1.0
 *
 * @param linear  Linear amplitude (0..1 typical, can exceed 1).
 * @returns       Normalised 0..1 value.
 */
export function linearToMeterNorm(linear: number): number {
    if (!isFinite(linear) || linear <= 0) return 0;
    const db = 20 * Math.log10(linear);
    return dbToMeterNorm(db);
}

// ─── Peak Hold Behaviour ─────────────────────────────────────────────────

/** Duration (ms) before peak hold indicator decays. */
export const PEAK_HOLD_DURATION_MS = 650;

/** Duration (ms) before clip latch resets. */
export const CLIP_LATCH_DURATION_MS = 2000;

// ─── Meter Dimensions ────────────────────────────────────────────────────

/** Default stereo meter bar total width in px. */
export const METER_DEFAULT_WIDTH = 8;

/** Width of each channel bar inside the meter in px. */
export const METER_CHANNEL_WIDTH = 3;

/** Width of the center channel divider in px. */
export const METER_DIVIDER_WIDTH = 2;

/** CSS transition for meter bar height changes. */
export const METER_FILL_TRANSITION = 'height 0.06s linear';

// ─── Utility: dB Label Formatting ────────────────────────────────────────

/**
 * Format a dB value for display.
 *
 * @param db   dB value.
 * @param dp   Decimal places (default 1).
 * @returns    Formatted string, e.g. "−12.3 dB" or "−∞".
 */
export function formatDb(db: number, dp = 1): string {
    if (!isFinite(db) || db <= DB_FLOOR) return '−∞';
    return `${db >= 0 ? '+' : ''}${db.toFixed(dp)} dB`;
}

/**
 * Convert a normalised 0..1 meter position back to dB.
 *
 * @param norm  Normalised position.
 * @returns     dB value (clamped to DB_FLOOR..DB_CEILING).
 */
export function meterNormToDb(norm: number): number {
    const clamped = clamp01(norm);
    return clamped * DB_RANGE + DB_FLOOR;
}
