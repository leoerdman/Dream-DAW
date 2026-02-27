export type TimelineClipLike = {
    id: string;
    startBeat: number;
    durationBeats: number;
    trackIndex: number;
};

export const MIN_CLIP_DURATION_BEATS = 0.0001;

export function normalizeTimelineClips<T extends TimelineClipLike>(clips: readonly T[]): readonly T[] {
    const byId = new Map<string, T>();
    for (const clip of clips) {
        if (!clip || typeof clip.id !== 'string') continue;
        const id = clip.id.trim();
        if (!id) continue;
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
        byId.set(id, normalized);
    }
    return Array.from(byId.values());
}
