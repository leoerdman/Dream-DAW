import { useEffect } from 'react';
import type { TimelineEngine } from '@/shared/lib/TimelineEngine';

interface UseTimelineViewportSyncArgs {
    engineRef: React.RefObject<TimelineEngine | null>;
    viewportState: {
        ppb: number;
        scrollX: number;
        scrollY: number;
    };
    setTimelineLayout: (layout: { pixelsPerBeat: number; scrollLeft: number; scrollTop: number }) => void;
    restoreSeq: number;
    restorePixelsPerBeat: number | null;
    restoreScrollLeft: number | null;
    restoreScrollTop: number | null;
    clearViewportRestore: () => void;
    selectedTrackIndex: number;
    selectedTrackIndices?: number[];
    loopStart: number;
    loopEnd: number;
    loopEnabled: boolean;
}

export function useTimelineViewportSync({
    engineRef,
    viewportState,
    setTimelineLayout,
    restoreSeq,
    restorePixelsPerBeat,
    restoreScrollLeft,
    restoreScrollTop,
    clearViewportRestore,
    selectedTrackIndex,
    selectedTrackIndices,
    loopStart,
    loopEnd,
    loopEnabled,
}: UseTimelineViewportSyncArgs) {
    useEffect(() => {
        setTimelineLayout({
            pixelsPerBeat: viewportState.ppb,
            scrollLeft: viewportState.scrollX,
            scrollTop: viewportState.scrollY,
        });
    }, [viewportState, setTimelineLayout]);

    useEffect(() => {
        if (restorePixelsPerBeat == null || restoreScrollLeft == null) return;
        const engine = engineRef.current;
        if (!engine) return;
        engine.viewport.setZoom(restorePixelsPerBeat);
        engine.viewport.scrollTo(restoreScrollLeft, restoreScrollTop ?? engine.viewport.scrollY);
        clearViewportRestore();
    }, [restoreSeq, restorePixelsPerBeat, restoreScrollLeft, restoreScrollTop, engineRef, clearViewportRestore]);

    useEffect(() => {
        const engine = engineRef.current;
        if (!engine) return;
        const list = (selectedTrackIndices && selectedTrackIndices.length > 0)
            ? selectedTrackIndices
            : (selectedTrackIndex >= 0 ? [selectedTrackIndex] : []);
        engine.setSelectedTracks(selectedTrackIndex, list);
    }, [selectedTrackIndex, selectedTrackIndices, engineRef]);

    useEffect(() => {
        const engine = engineRef.current;
        if (!engine) return;
        engine.setLoop({
            start: loopStart,
            end: loopEnd,
            enabled: loopEnabled,
        });
    }, [loopStart, loopEnd, loopEnabled, engineRef]);
}
