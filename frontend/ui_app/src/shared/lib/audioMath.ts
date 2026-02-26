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
    const safeBpm = Math.max(1, bpm || 120);
    const safeSr = Math.max(1, sampleRate || DEFAULT_SAMPLE_RATE);
    return Math.round((beat * 60 * safeSr) / safeBpm);
}

/**
 * Convert a sample frame index to a beat position.
 *
 * Inverse of `beatToFrame`. Returns a floating-point beat value.
 */
export function frameToBeat(frame: number, bpm: number, sampleRate: number): number {
    const safeBpm = Math.max(1, bpm || 120);
    const safeSr = Math.max(1, sampleRate || DEFAULT_SAMPLE_RATE);
    return (frame * safeBpm) / (60 * safeSr);
}

/**
 * Convert seconds to beats.
 */
export function secondsToBeat(seconds: number, bpm: number): number {
    const safeBpm = Math.max(1, bpm || 120);
    return seconds * (safeBpm / 60);
}

/**
 * Convert beats to seconds.
 */
export function beatToSeconds(beat: number, bpm: number): number {
    const safeBpm = Math.max(1, bpm || 120);
    return (beat * 60) / safeBpm;
}

/**
 * Convert a duration in beats to a duration in sample frames.
 *
 * Alias for `beatToFrame` — semantically identical but reads better
 * when the value represents a duration rather than a position.
 */
export function beatDurationToFrames(durationBeats: number, bpm: number, sampleRate: number): number {
    const safeBpm = Math.max(1, bpm || 120);
    const safeSr = Math.max(1, sampleRate || DEFAULT_SAMPLE_RATE);
    return Math.round((durationBeats * 60 * safeSr) / safeBpm);
}

/**
 * Clamp a frame position to a non-negative value.
 */
export function clampFramePosition(frame: number): number {
    return Math.max(0, frame);
}

export const DEFAULT_SAMPLE_RATE = 44_100;

/**
 * Resolve effective sample-rate from primary/secondary candidates.
 *
 * Accepts undefined/null/NaN/infinite values and always returns a valid Hz value.
 */
export function resolveSampleRate(
    primary?: number | null,
    secondary?: number | null,
    fallback = DEFAULT_SAMPLE_RATE,
): number {
    if (typeof primary === 'number' && Number.isFinite(primary) && primary > 0) {
        return primary;
    }
    if (typeof secondary === 'number' && Number.isFinite(secondary) && secondary > 0) {
        return secondary;
    }
    return fallback;
}

/**
 * Normalize a peak dB value to 0..1 for VU meter display.
 *
 * @deprecated Use `dbToMeterNorm` from `@/shared/lib/meterManifest` instead.
 * This function is kept for backward compatibility only.
 *
 * Range: −60 dB → 0, 0 dB → 0.909, +6 dB → 1.0.
 * Handles non-finite values (NaN, ±Infinity) gracefully.
 */
export function vuNorm(peakDb: number): number {
    if (!isFinite(peakDb) || peakDb < -60) return 0;
    const clamped = Math.min(peakDb, 6);
    return (clamped + 60) / 66;
}

/**
 * Format a duration in beats as Bars.Beats.Sixteenths (BBS).
 *
 * Standard DAW duration display:
 *   4 beats (4/4) → "1.0.0"  (1 bar, 0 extra beats, 0 sixteenths)
 *   5 beats (4/4) → "1.1.0"  (1 bar, 1 extra beat, 0 sixteenths)
 *   4.25 beats    → "1.0.1"  (1 bar, 0 beats, 1 sixteenth)
 *   0.5 beats     → "0.0.2"  (0 bars, 0 beats, 2 sixteenths)
 *
 * Sixteenths = 4 per beat (each beat is divided into 4).
 */
export function formatBeatsAsBBS(totalBeats: number, beatsPerBar = 4): string {
    const safeBeatsPerBar = Math.max(1, beatsPerBar);
    const bars = Math.floor(totalBeats / safeBeatsPerBar);
    const remainingBeats = totalBeats - bars * safeBeatsPerBar;
    const wholeBeats = Math.floor(remainingBeats);
    const fractionalBeat = remainingBeats - wholeBeats;
    const sixteenths = Math.round(fractionalBeat * 4);
    return `${bars}.${wholeBeats}.${sixteenths}`;
}
