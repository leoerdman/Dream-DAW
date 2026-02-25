import { useEffect, useRef } from 'react';
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

interface UseTimelineViewportSyncResult {
    /** True while a viewport restore is pending (not yet applied). */
    hasPendingRestore: React.RefObject<boolean>;
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
}: UseTimelineViewportSyncArgs): UseTimelineViewportSyncResult {
    const hasPendingRestore = useRef(false);

    // Keep the pending flag in sync with store state.
    useEffect(() => {
        hasPendingRestore.current = restorePixelsPerBeat != null && restoreScrollLeft != null;
    }, [restorePixelsPerBeat, restoreScrollLeft]);

    useEffect(() => {
        setTimelineLayout({
            pixelsPerBeat: viewportState.ppb,
            scrollLeft: viewportState.scrollX,
            scrollTop: viewportState.scrollY,
        });
    }, [viewportState, setTimelineLayout]);

    // Viewport restore: apply saved zoom/scroll to the engine.
    // Uses a retry interval for cases where the engine isn't ready on the
    // first attempt (e.g. project load triggers component remount).
    useEffect(() => {
        if (restorePixelsPerBeat == null || restoreScrollLeft == null) return;

        const applyRestore = (): boolean => {
            const engine = engineRef.current;
            if (!engine) return false;
            engine.viewport.setZoom(restorePixelsPerBeat);
            engine.viewport.scrollTo(restoreScrollLeft, restoreScrollTop ?? engine.viewport.scrollY);
            hasPendingRestore.current = false;
            clearViewportRestore();
            return true;
        };

        // Try immediately.
        if (applyRestore()) return;

        // Engine not ready yet — poll briefly until it appears (max ~500ms).
        let attempts = 0;
        const timer = setInterval(() => {
            attempts += 1;
            if (applyRestore() || attempts >= 25) {
                clearInterval(timer);
                hasPendingRestore.current = false;
            }
        }, 20);

        return () => {
            clearInterval(timer);
        };
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

    return { hasPendingRestore };
}
