import { useCallback, useEffect, useMemo, useRef } from 'react';
import { useGridStore } from '@/shared/stores/useGridStore';
import { useRegionEditStore } from '@/shared/stores/useRegionEditStore';
import { useStatusStore } from '@/shared/stores/useStatusStore';
import {
    normalizeRegion,
    duplicateRegion,
    moveRegion,
    swapRegions,
    type RegionBox,
} from '@/shared/hooks/keyboardShortcuts/transportAndEditingRegions';

type Region = RegionBox;

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

    // ── SSOT: All region logic delegates to transportAndEditingRegions.ts ──

    const runDuplicateRegion = async () => {
        const range = normalizeRegion(marqueeSelection);
        if (!range) return setStatusError('Region Duplicate: marquee selection required');
        const newIds = await duplicateRegion(range);
        if (newIds.length === 0) return setStatusInfo('Region Duplicate: nothing to duplicate');
        setStatusInfo(`Region Duplicate: ${newIds.length} clip(s)`);
    };

    const runMoveRegion = async (direction: -1 | 1) => {
        const range = normalizeRegion(marqueeSelection);
        if (!range) return setStatusError('Region Move: marquee selection required');
        const moved = await moveRegion(range, direction);
        if (moved === 0) return setStatusInfo('Region Move: nothing to move');
        setStatusInfo(`Region Move ${direction < 0 ? 'Left' : 'Right'}: ${moved} clip(s)`);
    };

    const runSwapRegions = async () => {
        if (!regionA || !regionB) return setStatusError('Region Swap: set A and B first');
        const lenA = regionA.endBeat - regionA.startBeat;
        const lenB = regionB.endBeat - regionB.startBeat;
        const spanA = regionA.endTrack - regionA.startTrack;
        const spanB = regionB.endTrack - regionB.startTrack;
        if (Math.abs(lenA - lenB) > 1e-6 || spanA !== spanB) return setStatusError('Region Swap: A/B must have same length and track span');
        if (!(regionA.endBeat <= regionB.startBeat || regionB.endBeat <= regionA.startBeat)) return setStatusError('Region Swap: A/B must not overlap');
        const moved = await swapRegions(regionA, regionB);
        setStatusInfo(`Region Swap: ${moved} clip(s)`);
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

    // ENTERPRISE FIX (BUG-W5-003): Cleanup ref for active region drag listeners.
    const regionDragCleanupRef = useRef<(() => void) | null>(null);

    useEffect(() => () => {
        regionDragCleanupRef.current?.();
        regionDragCleanupRef.current = null;
    }, []);

    const beginRegionDrag = useCallback((which: 'A' | 'B', mode: 'move' | 'resize-start' | 'resize-end', e: React.PointerEvent) => {
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
        const onMove = (ev: PointerEvent) => {
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
        // ENTERPRISE FIX (Phase 33): pointerup + pointercancel for full interrupt safety.
        // Legacy mouseup was missing pointercancel — OS interrupts (alerts, sleep,
        // 3-finger swipe) left drag listeners orphaned.
        const cleanup = () => {
            window.removeEventListener('pointermove', onMove);
            window.removeEventListener('pointerup', onUp);
            window.removeEventListener('pointercancel', onUp);
            regionDragCleanupRef.current = null;
        };
        const onUp = () => { cleanup(); };
        regionDragCleanupRef.current?.();
        regionDragCleanupRef.current = cleanup;
        window.addEventListener('pointermove', onMove);
        window.addEventListener('pointerup', onUp);
        window.addEventListener('pointercancel', onUp);
    }, [regionA, regionB, masterLaneRef, viewportScrollX, effectivePixelsPerBeat, setRegionA, setRegionB, snapRegionBeat]);

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
