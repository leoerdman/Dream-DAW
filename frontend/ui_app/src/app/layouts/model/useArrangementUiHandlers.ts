import { useCallback } from 'react';
import * as engineApi from '@/shared/api/engine';
import type { BrowserDragItem } from '@/shared/lib/arrangementTypes';

type Args = {
    setFitTimelineToken: React.Dispatch<React.SetStateAction<number>>;
    setEditCursorBeat: React.Dispatch<React.SetStateAction<number>>;
    setEditCursorTrackIndex: React.Dispatch<React.SetStateAction<number>>;
    setEditCursorTrackIndexEnd: React.Dispatch<React.SetStateAction<number>>;
    queuedStartBeatRef: React.MutableRefObject<number | null>;
    dropBrowserItemOnTimeline: (item: BrowserDragItem, trackIndex: number, beat: number) => Promise<void>;
};

type Result = {
    handleFitTimelineHorizontally: () => void;
    handlePlayheadChange: (beat: number) => void;
    handleEditCursorChange: (beat: number, trackStart: number, trackEnd: number) => void;
    handleBrowserDrop: (item: BrowserDragItem, trackIndex: number, beat: number) => void;
};

export function useArrangementUiHandlers({
    setFitTimelineToken,
    setEditCursorBeat,
    setEditCursorTrackIndex,
    setEditCursorTrackIndexEnd,
    queuedStartBeatRef,
    dropBrowserItemOnTimeline,
}: Args): Result {
    const handleFitTimelineHorizontally = useCallback(() => {
        setFitTimelineToken((value) => value + 1);
    }, [setFitTimelineToken]);

    const handlePlayheadChange = useCallback((beat: number) => {
        void engineApi.seekToBeat(Math.max(0, beat));
    }, []);

    const handleEditCursorChange = useCallback((beat: number, trackStart: number, trackEnd: number) => {
        const clampedBeat = Math.max(0, beat);
        setEditCursorBeat(clampedBeat);
        setEditCursorTrackIndex(Math.max(0, trackStart));
        setEditCursorTrackIndexEnd(Math.max(0, trackEnd));
        queuedStartBeatRef.current = clampedBeat;
    }, [queuedStartBeatRef, setEditCursorBeat, setEditCursorTrackIndex, setEditCursorTrackIndexEnd]);

    const handleBrowserDrop = useCallback((item: BrowserDragItem, trackIndex: number, beat: number) => {
        // Drop browser item onto the timeline at the given track and beat.
        void dropBrowserItemOnTimeline(item, trackIndex, beat)
            .catch((err) => console.error('[Dream] browser drop failed:', err));
    }, [dropBrowserItemOnTimeline]);

    return {
        handleFitTimelineHorizontally,
        handlePlayheadChange,
        handleEditCursorChange,
        handleBrowserDrop,
    };
}
