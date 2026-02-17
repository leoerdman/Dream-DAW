// ═══════════════════════════════════════════════════════════════════════════
// Dream DAW — Audio Math Utilities
// ═══════════════════════════════════════════════════════════════════════════
//
// Single source of truth for beat ↔ frame ↔ seconds conversions.
//
// Every DAW operation that converts between musical time (beats) and
// absolute time (sample frames / seconds) MUST use these functions.
// Inline `Math.round(posSeconds * sr)` patterns introduce rounding
// drift and are impossible to audit across 20+ call sites.
//
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Convert a beat position to a sample frame index.
 *
 * Uses the canonical formula: `round(beat * 60 * sampleRate / bpm)`
 * to minimize floating-point error (single multiply before rounding).
 */
export function beatToFrame(beat: number, bpm: number, sampleRate: number): number {
    return Math.round((beat * 60 * sampleRate) / bpm);
}

/**
 * Convert a sample frame index to a beat position.
 *
 * Inverse of `beatToFrame`. Returns a floating-point beat value.
 */
export function frameToBeat(frame: number, bpm: number, sampleRate: number): number {
    return (frame * bpm) / (60 * sampleRate);
}

/**
 * Convert seconds to beats.
 */
export function secondsToBeat(seconds: number, bpm: number): number {
    return seconds * (bpm / 60);
}

/**
 * Convert beats to seconds.
 */
export function beatToSeconds(beat: number, bpm: number): number {
    return (beat * 60) / bpm;
}

/**
 * Convert a duration in beats to a duration in sample frames.
 *
 * Alias for `beatToFrame` — semantically identical but reads better
 * when the value represents a duration rather than a position.
 */
export function beatDurationToFrames(durationBeats: number, bpm: number, sampleRate: number): number {
    return Math.round((durationBeats * 60 * sampleRate) / bpm);
}

/**
 * Clamp a frame position to a non-negative value.
 */
export function clampFramePosition(frame: number): number {
    return Math.max(0, frame);
}

/**
 * Normalize a peak dB value to 0..1 for VU meter display.
 *
 * Range: −60 dB → 0, 0 dB → 0.909, +6 dB → 1.0.
 * Handles non-finite values (NaN, ±Infinity) gracefully.
 */
export function vuNorm(peakDb: number): number {
    if (!isFinite(peakDb) || peakDb < -60) return 0;
    const clamped = Math.min(peakDb, 6);
    return (clamped + 60) / 66;
}
