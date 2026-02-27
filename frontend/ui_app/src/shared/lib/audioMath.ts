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
    const safeBpm = Math.max(1, bpm || DEFAULT_BPM);
    const safeSr = Math.max(1, sampleRate || DEFAULT_SAMPLE_RATE);
    // BUG-Q003 FIX: Use Math.floor to ensure strictly non-overlapping sample intervals
    return Math.floor((beat * 60 * safeSr) / safeBpm);
}

/**
 * Convert a sample frame index to a beat position.
 *
 * Inverse of `beatToFrame`. Returns a floating-point beat value.
 */
export function frameToBeat(frame: number, bpm: number, sampleRate: number): number {
    const safeBpm = Math.max(1, bpm || DEFAULT_BPM);
    const safeSr = Math.max(1, sampleRate || DEFAULT_SAMPLE_RATE);
    return (frame * safeBpm) / (60 * safeSr);
}

/**
 * Convert seconds to beats.
 */
export function secondsToBeat(seconds: number, bpm: number): number {
    const safeBpm = Math.max(1, bpm || DEFAULT_BPM);
    return seconds * (safeBpm / 60);
}

/**
 * Convert beats to seconds.
 */
export function beatToSeconds(beat: number, bpm: number): number {
    const safeBpm = Math.max(1, bpm || DEFAULT_BPM);
    return (beat * 60) / safeBpm;
}

/**
 * Convert a duration in beats to a duration in sample frames.
 *
 * Alias for `beatToFrame` — semantically identical but reads better
 * when the value represents a duration rather than a position.
 */
/** BUG-095 SSOT: standardized samples per beat calculation */
export function getSamplesPerBeat(bpm: number, sampleRate: number): number {
    const safeBpm = Math.max(0.1, bpm);
    return Math.max(1, (sampleRate * 60) / safeBpm);
}

export function beatDurationToFrames(durationBeats: number, bpm: number, sampleRate: number): number {
    return durationBeats * getSamplesPerBeat(bpm, sampleRate);
}

// Ensure 0 is avoided for playback rates
export function speedRatioToSemitone(speedRatio: number): number {
    if (speedRatio <= 0) return -100; // arbitrary very low bound
    return 12 * Math.log2(speedRatio);
}
/**
 * Clamp a frame position to a non-negative value.
 */
export function clampFramePosition(frame: number): number {
    return Math.max(0, frame);
}

export const DEFAULT_SAMPLE_RATE = 44_100;

// ── SSOT Constants ─────────────────────────────────────────────────────
// These constants are the single source of truth for validation limits.
// Every place that clamps time signature or BPM MUST use these values.

/** Default BPM when no project or transport BPM is available. */
export const DEFAULT_BPM = 120;

/** Maximum allowed time-signature numerator (beats per bar). */
export const MAX_TIME_SIG_NUMERATOR = 99;

/** Maximum allowed time-signature denominator (beat unit). */
export const MAX_TIME_SIG_DENOMINATOR = 64;

/** Minimum BPM (inclusive). */
export const MIN_BPM = 20;

/** Maximum BPM (inclusive). */
export const MAX_BPM = 999;

/**
 * Resolve the effective BPM from project → transport → fallback.
 *
 * This is the SSOT for BPM resolution — replaces the
 * `store.transport.bpm || store.transport.bpm || 120` pattern
 * that was duplicated 40+ times across the codebase.
 */
export function resolveBpm(projectBpm?: number | null, transportBpm?: number | null): number {
    if (typeof projectBpm === 'number' && Number.isFinite(projectBpm) && projectBpm > 0) {
        return Math.max(1, projectBpm);
    }
    if (typeof transportBpm === 'number' && Number.isFinite(transportBpm) && transportBpm > 0) {
        return Math.max(1, transportBpm);
    }
    return DEFAULT_BPM;
}

/**
 * Clamp a time-signature numerator to the valid range [1, MAX_TIME_SIG_NUMERATOR].
 */
export function clampTimeSigNumerator(n: number): number {
    return Math.max(1, Math.min(MAX_TIME_SIG_NUMERATOR, Math.round(n)));
}

/**
 * Clamp a time-signature denominator to the nearest valid power-of-2
 * within [1, MAX_TIME_SIG_DENOMINATOR].
 */
export function clampTimeSigDenominator(d: number): number {
    const raw = Math.max(1, Math.min(MAX_TIME_SIG_DENOMINATOR, Math.round(d)));
    return Math.pow(2, Math.round(Math.log2(raw)));
}

// ── SSOT Round 2 Constants ──────────────────────────────────────────────

/** Default time-signature numerator (beats per bar). */
export const DEFAULT_TIME_SIG_NUMERATOR = 4;
/** Default time-signature denominator (beat unit). */
export const DEFAULT_TIME_SIG_DENOMINATOR = 4;

/** Minimum pitch-shift in semitones. */
export const MIN_PITCH_SHIFT = -48;
/** Maximum pitch-shift in semitones. */
export const MAX_PITCH_SHIFT = 48;
/** Clamp pitch shift to the valid range [MIN_PITCH_SHIFT, MAX_PITCH_SHIFT]. */
export function clampPitchShift(semitones: number): number {
    return Math.max(MIN_PITCH_SHIFT, Math.min(MAX_PITCH_SHIFT, semitones));
}

/** Minimum MIDI pitch (note number). */
export const MIN_MIDI_PITCH = 0;
/** Maximum MIDI pitch (note number). */
export const MAX_MIDI_PITCH = 127;
/** Clamp a MIDI pitch to the valid range [0, 127]. */
export function clampMidiPitch(pitch: number): number {
    return Math.max(MIN_MIDI_PITCH, Math.min(MAX_MIDI_PITCH, Math.round(pitch)));
}

/** Minimum MIDI velocity. */
export const MIN_MIDI_VELOCITY = 1;
/** Maximum MIDI velocity. */
export const MAX_MIDI_VELOCITY = 127;
/** Clamp a MIDI velocity to the valid range [1, 127]. */
export function clampMidiVelocity(velocity: number): number {
    return Math.max(MIN_MIDI_VELOCITY, Math.min(MAX_MIDI_VELOCITY, Math.round(velocity)));
}

/** Clamp a normalized value to [0, 1]. Used for automation, fader positions, etc. */
export function clamp01(value: number): number {
    return value <= 0 ? 0 : value >= 1 ? 1 : value;
}

/** Minimum EQ band gain in dB. */
export const MIN_EQ_GAIN_DB = -24;
/** Maximum EQ band gain in dB. */
export const MAX_EQ_GAIN_DB = 24;
/** Clamp EQ band gain to the valid range [MIN_EQ_GAIN_DB, MAX_EQ_GAIN_DB]. */
export function clampEqGainDb(gainDb: number): number {
    return Math.max(MIN_EQ_GAIN_DB, Math.min(MAX_EQ_GAIN_DB, gainDb));
}

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
    // BUG-E006 FIX: Use <= for clearer boundary semantics at exactly -60 dB.
    if (!isFinite(peakDb) || peakDb <= -60) return 0;
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
export function formatBeatsAsBBS(totalBeats: number, beatsPerBar = DEFAULT_TIME_SIG_NUMERATOR): string {
    const safeBeatsPerBar = Math.max(1, beatsPerBar);
    let bars = Math.floor(totalBeats / safeBeatsPerBar);
    const remainingBeats = totalBeats - bars * safeBeatsPerBar;
    let wholeBeats = Math.floor(remainingBeats);
    const fractionalBeat = remainingBeats - wholeBeats;
    let sixteenths = Math.round(fractionalBeat * 4);
    // BUG-E005 FIX: When rounding pushes sixteenths to 4, carry into next beat.
    if (sixteenths >= 4) {
        sixteenths = 0;
        wholeBeats += 1;
    }
    // BUG-F009 FIX: When carrying pushes wholeBeats to beatsPerBar, carry into next bar.
    if (wholeBeats >= safeBeatsPerBar) {
        wholeBeats -= safeBeatsPerBar;
        bars += 1;
    }
    // Carry overflow into bars if wholeBeats exceeds beatsPerBar.
    let adjustedBars = bars;
    if (wholeBeats >= safeBeatsPerBar) {
        wholeBeats -= safeBeatsPerBar;
        adjustedBars += 1;
    }
    return `${adjustedBars}.${wholeBeats}.${sixteenths}`;
}
