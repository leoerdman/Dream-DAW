export type TimelineClipLike = {
    id: string;
    startBeat: number;
    durationBeats: number;
    trackIndex: number;
};

export function normalizeTimelineClips<T extends TimelineClipLike>(clips: readonly T[]): T[] {
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
            durationBeats: Math.max(0.0001, clip.durationBeats),
        };
        byId.set(id, normalized);
    }
    return Array.from(byId.values());
}
