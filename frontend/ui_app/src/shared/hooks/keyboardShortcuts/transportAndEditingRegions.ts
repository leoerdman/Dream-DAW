import * as engine from '@/shared/api/engine';
import { beatToFrame, resolveBpm, resolveSampleRate } from '@/shared/lib/audioMath';
import { useEngineStore } from '@/shared/stores/useEngineStore';
import type { KeyboardShortcutHandlerEnv } from './types';

export type RegionBox = { startBeat: number; endBeat: number; startTrack: number; endTrack: number };

export function normalizeRegion(marquee: KeyboardShortcutHandlerEnv['ctx']['marqueeSelection']): RegionBox | null {
    if (!marquee) return null;
    const startBeat = Math.min(marquee.startBeat, marquee.endBeat);
    const endBeat = Math.max(marquee.startBeat, marquee.endBeat);
    const startTrack = Math.min(marquee.startTrack, marquee.endTrack);
    const endTrack = Math.max(marquee.startTrack, marquee.endTrack);
    if (!Number.isFinite(startBeat) || !Number.isFinite(endBeat) || endBeat - startBeat <= 1e-6) return null;
    return { startBeat, endBeat, startTrack, endTrack };
}

function collectRegionClips(range: RegionBox): Array<KeyboardShortcutHandlerEnv['ctx']['timelineClips'][number]> {
    const EPS = 1e-6;
    const clips = useEngineStore.getState().timelineClips;
    return clips.filter((clip) => {
        if (clip.trackIndex < range.startTrack || clip.trackIndex > range.endTrack) return false;
        const clipStart = clip.startBeat;
        const clipEnd = clip.startBeat + clip.durationBeats;
        return clipStart >= range.startBeat - EPS && clipEnd <= range.endBeat + EPS;
    });
}

async function splitRegionBoundaries(range: RegionBox): Promise<void> {
    const store = useEngineStore.getState();
    const bpm = resolveBpm(store.transport.bpm);
    const sampleRate = resolveSampleRate(store.projectSampleRate, store.transport.sample_rate);
    const splitBeats = [range.startBeat, range.endBeat];
    const EPS = 1e-6;

    for (const splitBeat of splitBeats) {
        const splitFrame = Math.max(0, beatToFrame(splitBeat, bpm, sampleRate));
        const clips = useEngineStore.getState().timelineClips.filter((clip) => {
            if (clip.trackIndex < range.startTrack || clip.trackIndex > range.endTrack) return false;
            const clipStart = clip.startBeat;
            const clipEnd = clip.startBeat + clip.durationBeats;
            return splitBeat > clipStart + EPS && splitBeat < clipEnd - EPS;
        });
        if (clips.length === 0) continue;
        const responses = await Promise.all(clips.map((clip) => engine.splitClipWithDeltas(clip.id, splitFrame)));
        await useEngineStore.getState().applyProjectDeltas(
            responses.flatMap((response) => response.deltas),
            'keyboard:region-boundary-split',
        );
    }
}

export async function duplicateRegion(range: RegionBox): Promise<string[]> {
    await splitRegionBoundaries(range);
    const sourceClips = collectRegionClips(range);
    if (sourceClips.length === 0) return [];
    const lenBeats = Math.max(0.0001, range.endBeat - range.startBeat);
    const store = useEngineStore.getState();
    const bpm = resolveBpm(store.transport.bpm);
    const sampleRate = resolveSampleRate(store.projectSampleRate, store.transport.sample_rate);
    const responses = await Promise.all(
        sourceClips.map((clip) =>
            engine.duplicateClipWithDeltas(
                clip.id,
                Math.max(0, beatToFrame(clip.startBeat + lenBeats, bpm, sampleRate)),
            ),
        ),
    );
    await useEngineStore.getState().applyProjectDeltas(
        responses.flatMap((response) => response.deltas),
        'keyboard:region-duplicate',
    );
    return responses.map((response) => response.new_id);
}

export async function moveRegion(range: RegionBox, direction: -1 | 1): Promise<number> {
    await splitRegionBoundaries(range);
    const clips = collectRegionClips(range);
    if (clips.length === 0) return 0;
    const lenBeats = Math.max(0.0001, range.endBeat - range.startBeat);
    let deltaBeats = direction * lenBeats;
    if (deltaBeats < 0) deltaBeats = Math.max(deltaBeats, -range.startBeat);
    if (Math.abs(deltaBeats) <= 1e-9) return 0;

    const store = useEngineStore.getState();
    const bpm = resolveBpm(store.transport.bpm);
    const sampleRate = resolveSampleRate(store.projectSampleRate, store.transport.sample_rate);
    const responses = await Promise.all(
        clips.map((clip) => {
            const nextBeat = Math.max(0, clip.startBeat + deltaBeats);
            return engine.moveClipWithDeltas(
                clip.id,
                clip.trackIndex,
                Math.max(0, beatToFrame(nextBeat, bpm, sampleRate)),
            );
        }),
    );
    await useEngineStore.getState().applyProjectDeltas(
        responses.flatMap((response) => response.deltas),
        'keyboard:region-move',
    );
    return clips.length;
}

export async function swapRegions(regionA: RegionBox, regionB: RegionBox): Promise<number> {
    const lenA = regionA.endBeat - regionA.startBeat;
    const lenB = regionB.endBeat - regionB.startBeat;
    const trackSpanA = regionA.endTrack - regionA.startTrack;
    const trackSpanB = regionB.endTrack - regionB.startTrack;
    if (Math.abs(lenA - lenB) > 1e-6 || trackSpanA !== trackSpanB) {
        throw new Error('Region A/B must have same length and track span');
    }
    if (!(regionA.endBeat <= regionB.startBeat || regionB.endBeat <= regionA.startBeat)) {
        throw new Error('Region A and B must not overlap');
    }

    await splitRegionBoundaries(regionA);
    await splitRegionBoundaries(regionB);

    const clipsA = collectRegionClips(regionA);
    const clipsB = collectRegionClips(regionB);
    if (clipsA.length === 0 && clipsB.length === 0) return 0;

    const store = useEngineStore.getState();
    const bpm = resolveBpm(store.transport.bpm);
    const sampleRate = resolveSampleRate(store.projectSampleRate, store.transport.sample_rate);
    const deltaBeat = regionB.startBeat - regionA.startBeat;
    const deltaTrack = regionB.startTrack - regionA.startTrack;

    const responses = await Promise.all([
        ...clipsA.map((clip) =>
            engine.moveClipWithDeltas(
                clip.id,
                clip.trackIndex + deltaTrack,
                Math.max(0, beatToFrame(clip.startBeat + deltaBeat, bpm, sampleRate)),
            ),
        ),
        ...clipsB.map((clip) =>
            engine.moveClipWithDeltas(
                clip.id,
                clip.trackIndex - deltaTrack,
                Math.max(0, beatToFrame(clip.startBeat - deltaBeat, bpm, sampleRate)),
            ),
        ),
    ]);
    await useEngineStore.getState().applyProjectDeltas(
        responses.flatMap((response) => response.deltas),
        'keyboard:region-swap',
    );
    return clipsA.length + clipsB.length;
}
