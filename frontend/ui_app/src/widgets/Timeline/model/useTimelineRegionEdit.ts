import { useMemo } from 'react';
import * as engine from '@/shared/api/engine';
import { beatToFrame, resolveBpm, resolveSampleRate } from '@/shared/lib/audioMath';
import { useEngineStore } from '@/shared/stores/useEngineStore';
import { useGridStore } from '@/shared/stores/useGridStore';
import { useRegionEditStore } from '@/shared/stores/useRegionEditStore';
import { useStatusStore } from '@/shared/stores/useStatusStore';


type Region = { startBeat: number; endBeat: number; startTrack: number; endTrack: number };

interface UseTimelineRegionEditArgs {
    marqueeSelection: Region | null;
    effectivePixelsPerBeat: number;
    viewportScrollX: number;
    trackHeight: number;
    beatsPerBar: number;
    masterLaneRef: React.RefObject<HTMLDivElement | null>;
}

export function useTimelineRegionEdit({
    marqueeSelection,
    effectivePixelsPerBeat,
    viewportScrollX,
    trackHeight,
    beatsPerBar,
    masterLaneRef,
}: UseTimelineRegionEditArgs) {
    const regionA = useRegionEditStore((s) => s.regionA);
    const regionB = useRegionEditStore((s) => s.regionB);
    const setRegionA = useRegionEditStore((s) => s.setRegionA);
    const setRegionB = useRegionEditStore((s) => s.setRegionB);
    const clearRegions = useRegionEditStore((s) => s.clear);
    const setStatusInfo = useStatusStore((s) => s.setInfo);
    const setStatusError = useStatusStore((s) => s.setError);

    const normalizeRegion = (m: Region | null) => {
        if (!m) return null;
        const startBeat = Math.min(m.startBeat, m.endBeat);
        const endBeat = Math.max(m.startBeat, m.endBeat);
        const startTrack = Math.min(m.startTrack, m.endTrack);
        const endTrack = Math.max(m.startTrack, m.endTrack);
        if (!Number.isFinite(startBeat) || !Number.isFinite(endBeat) || endBeat - startBeat <= 1e-6) return null;
        return { startBeat, endBeat, startTrack, endTrack };
    };

    const collectRegionClips = (range: Region) => {
        const EPS = 1e-6;
        const clipsNow = useEngineStore.getState().timelineClips;
        return clipsNow.filter((clip) => {
            if (clip.trackIndex < range.startTrack || clip.trackIndex > range.endTrack) return false;
            const clipStart = clip.startBeat;
            const clipEnd = clip.startBeat + clip.durationBeats;
            return clipStart >= range.startBeat - EPS && clipEnd <= range.endBeat + EPS;
        });
    };

    const splitRegionBoundaries = async (range: Region) => {
        const store = useEngineStore.getState();
        const currentBpm = resolveBpm(store.transport.bpm);
        const sampleRate = resolveSampleRate(store.projectSampleRate, store.transport.sample_rate);
        const splitBeats = [range.startBeat, range.endBeat];
        const EPS = 1e-6;
        for (const splitBeat of splitBeats) {
            const splitFrame = Math.max(0, beatToFrame(splitBeat, currentBpm, sampleRate));
            const clipsNow = useEngineStore.getState().timelineClips.filter((clip) => {
                if (clip.trackIndex < range.startTrack || clip.trackIndex > range.endTrack) return false;
                const clipStart = clip.startBeat;
                const clipEnd = clip.startBeat + clip.durationBeats;
                return splitBeat > clipStart + EPS && splitBeat < clipEnd - EPS;
            });
            if (clipsNow.length === 0) continue;
            const responses = await Promise.all(clipsNow.map((clip) => engine.splitClipWithDeltas(clip.id, splitFrame)));
            await useEngineStore.getState().applyProjectDeltas(
                responses.flatMap((response) => response.deltas),
                'timeline:region-boundary-split',
            );
        }
    };

    const runDuplicateRegion = async () => {
        const range = normalizeRegion(marqueeSelection);
        if (!range) return setStatusError('Region Duplicate: marquee selection required');
        await splitRegionBoundaries(range);
        const sourceClips = collectRegionClips(range);
        if (sourceClips.length === 0) return setStatusInfo('Region Duplicate: nothing to duplicate');
        const lenBeats = Math.max(0.0001, range.endBeat - range.startBeat);
        const store = useEngineStore.getState();
        const currentBpm = resolveBpm(store.transport.bpm);
        const sampleRate = resolveSampleRate(store.projectSampleRate, store.transport.sample_rate);
        const responses = await Promise.all(
            sourceClips.map((clip) =>
                engine.duplicateClipWithDeltas(
                    clip.id,
                    Math.max(0, beatToFrame(clip.startBeat + lenBeats, currentBpm, sampleRate)),
                ),
            ),
        );
        await useEngineStore.getState().applyProjectDeltas(
            responses.flatMap((response) => response.deltas),
            'timeline:region-duplicate',
        );
        setStatusInfo(`Region Duplicate: ${responses.length} clip(s)`);
    };

    const runMoveRegion = async (direction: -1 | 1) => {
        const range = normalizeRegion(marqueeSelection);
        if (!range) return setStatusError('Region Move: marquee selection required');
        await splitRegionBoundaries(range);
        const sourceClips = collectRegionClips(range);
        if (sourceClips.length === 0) return setStatusInfo('Region Move: nothing to move');
        const lenBeats = Math.max(0.0001, range.endBeat - range.startBeat);
        let deltaBeats = direction * lenBeats;
        if (deltaBeats < 0) deltaBeats = Math.max(deltaBeats, -range.startBeat);
        const store = useEngineStore.getState();
        const currentBpm = resolveBpm(store.transport.bpm);
        const sampleRate = resolveSampleRate(store.projectSampleRate, store.transport.sample_rate);
        const responses = await Promise.all(
            sourceClips.map((clip) =>
                engine.moveClipWithDeltas(
                    clip.id,
                    clip.trackIndex,
                    Math.max(0, beatToFrame(Math.max(0, clip.startBeat + deltaBeats), currentBpm, sampleRate)),
                ),
            ),
        );
        await useEngineStore.getState().applyProjectDeltas(
            responses.flatMap((response) => response.deltas),
            'timeline:region-move',
        );
        setStatusInfo(`Region Move ${direction < 0 ? 'Left' : 'Right'}: ${responses.length} clip(s)`);
    };

    const runSwapRegions = async () => {
        if (!regionA || !regionB) return setStatusError('Region Swap: set A and B first');
        const lenA = regionA.endBeat - regionA.startBeat;
        const lenB = regionB.endBeat - regionB.startBeat;
        const spanA = regionA.endTrack - regionA.startTrack;
        const spanB = regionB.endTrack - regionB.startTrack;
        if (Math.abs(lenA - lenB) > 1e-6 || spanA !== spanB) return setStatusError('Region Swap: A/B must have same length and track span');
        if (!(regionA.endBeat <= regionB.startBeat || regionB.endBeat <= regionA.startBeat)) return setStatusError('Region Swap: A/B must not overlap');
        await splitRegionBoundaries(regionA);
        await splitRegionBoundaries(regionB);
        const clipsA = collectRegionClips(regionA);
        const clipsB = collectRegionClips(regionB);
        const store = useEngineStore.getState();
        const currentBpm = resolveBpm(store.transport.bpm);
        const sampleRate = resolveSampleRate(store.projectSampleRate, store.transport.sample_rate);
        const deltaBeat = regionB.startBeat - regionA.startBeat;
        const deltaTrack = regionB.startTrack - regionA.startTrack;
        const responses = await Promise.all([
            ...clipsA.map((clip) => engine.moveClipWithDeltas(clip.id, clip.trackIndex + deltaTrack, Math.max(0, beatToFrame(clip.startBeat + deltaBeat, currentBpm, sampleRate)))),
            ...clipsB.map((clip) => engine.moveClipWithDeltas(clip.id, clip.trackIndex - deltaTrack, Math.max(0, beatToFrame(clip.startBeat - deltaBeat, currentBpm, sampleRate)))),
        ]);
        await useEngineStore.getState().applyProjectDeltas(
            responses.flatMap((response) => response.deltas),
            'timeline:region-swap',
        );
        setStatusInfo(`Region Swap: ${clipsA.length + clipsB.length} clip(s)`);
    };

    const setRegionFromMarquee = (which: 'A' | 'B') => {
        const range = normalizeRegion(marqueeSelection);
        if (!range) return setStatusError(`Region ${which}: marquee selection required`);
        if (which === 'A') setRegionA(range);
        else setRegionB(range);
        setStatusInfo(`Region ${which} captured`);
    };

    const regionALineX = regionA ? Math.round(regionA.startBeat * effectivePixelsPerBeat - viewportScrollX) : null;
    const regionBLineX = regionB ? Math.round(regionB.startBeat * effectivePixelsPerBeat - viewportScrollX) : null;
    const regionAEndLineX = regionA ? Math.round(regionA.endBeat * effectivePixelsPerBeat - viewportScrollX) : null;
    const regionBEndLineX = regionB ? Math.round(regionB.endBeat * effectivePixelsPerBeat - viewportScrollX) : null;
    const regionALengthBeats = regionA ? Math.max(0, regionA.endBeat - regionA.startBeat) : 0;
    const regionBLengthBeats = regionB ? Math.max(0, regionB.endBeat - regionB.startBeat) : 0;
    const regionsSwapCompatible = useMemo(
        () => Boolean(regionA && regionB && Math.abs(regionALengthBeats - regionBLengthBeats) <= 1e-6 && (regionA.endTrack - regionA.startTrack) === (regionB.endTrack - regionB.startTrack)),
        [regionA, regionALengthBeats, regionB, regionBLengthBeats],
    );

    const snapRegionBeat = (rawBeat: number, freeMode: boolean) => {
        if (freeMode) return Math.max(0, rawBeat);
        return useGridStore.getState().snapBeat(rawBeat, beatsPerBar, effectivePixelsPerBeat);
    };

    const beginRegionDrag = (which: 'A' | 'B', mode: 'move' | 'resize-start' | 'resize-end', e: React.MouseEvent) => {
        e.preventDefault();
        e.stopPropagation();
        const laneEl = masterLaneRef.current;
        const region = which === 'A' ? regionA : regionB;
        if (!laneEl || !region) return;
        const rect = laneEl.getBoundingClientRect();
        const minLen = 0.25;
        const regionLen = Math.max(minLen, region.endBeat - region.startBeat);
        const originStart = region.startBeat;
        const originEnd = region.endBeat;
        const toBeat = (clientX: number) => Math.max(0, (clientX - rect.left + viewportScrollX) / Math.max(0.0001, effectivePixelsPerBeat));
        const onMove = (ev: MouseEvent) => {
            const beat = snapRegionBeat(toBeat(ev.clientX), ev.altKey);
            let nextStart = originStart;
            let nextEnd = originEnd;
            if (mode === 'move') {
                nextStart = beat;
                nextEnd = beat + regionLen;
            } else if (mode === 'resize-start') {
                nextStart = Math.min(beat, originEnd - minLen);
                nextEnd = originEnd;
            } else {
                nextStart = originStart;
                nextEnd = Math.max(originStart + minLen, beat);
            }
            const next = { startBeat: Math.max(0, nextStart), endBeat: Math.max(Math.max(0, nextStart) + minLen, nextEnd), startTrack: region.startTrack, endTrack: region.endTrack };
            if (which === 'A') setRegionA(next);
            else setRegionB(next);
        };
        const onUp = () => {
            window.removeEventListener('mousemove', onMove);
            window.removeEventListener('mouseup', onUp);
        };
        window.addEventListener('mousemove', onMove);
        window.addEventListener('mouseup', onUp);
    };

    return {
        regionA,
        regionB,
        clearRegions,
        regionALineX,
        regionBLineX,
        regionAEndLineX,
        regionBEndLineX,
        regionALengthBeats,
        regionBLengthBeats,
        regionsSwapCompatible,
        beginRegionDrag,
        setRegionFromMarquee,
        runDuplicateRegion,
        runMoveRegion,
        runSwapRegions,
        trackHeight,
    };
}
