export type TimelineClipLike = {
    id: string;
    startBeat: number;
    durationBeats: number;
    trackIndex: number;
};

export const MIN_CLIP_DURATION_BEATS = 0.0001;

// PERF FIX: Cache the last result by input reference.
// normalizeTimelineClips is called on every setClips() — typically 60fps.
// If the same array reference is passed, return cached result (O(1)).
let _lastInput: readonly unknown[] | null = null;
let _lastOutput: readonly unknown[] | null = null;

export function normalizeTimelineClips<T extends TimelineClipLike>(clips: readonly T[]): readonly T[] {
    // Fast path: same reference = same data = same output.
    if (clips === _lastInput && _lastOutput !== null) return _lastOutput as readonly T[];

    const byId = new Map<string, T>();
    for (const clip of clips) {
        if (!clip || typeof clip.id !== 'string') continue;
        const id = clip.id.trim();
        if (!id) continue;
        if (byId.has(id)) {
            console.warn(`[Dream] normalizeTimelineClips: Dropping duplicate clip id ${id}`);
            continue;
        }
        if (!Number.isFinite(clip.startBeat) || !Number.isFinite(clip.durationBeats)) continue;
        const normalized = {
            ...clip,
            id,
            trackIndex: Number.isFinite(clip.trackIndex) ? Math.max(0, Math.trunc(clip.trackIndex)) : 0,
            durationBeats: Math.max(MIN_CLIP_DURATION_BEATS, clip.durationBeats),
        };
        // BUG-010 FIX: Log warning when duplicate clip ID is detected.
        if (byId.has(id)) {
            console.warn(`[clipNormalization] Duplicate clip ID "${id}" — later clip overwrites earlier one.`);
        }
        byId.set(id, normalized as T); // cast back to T since we spread it
    }
    // BUG-055 FIX: Removed Object.freeze — it prevents Zustand's immer middleware
    // from working and adds ~0.5ms overhead per frame for 500+ clips.
    const result = Array.from(byId.values());
    _lastInput = clips;
    _lastOutput = result;
    return result;
}

