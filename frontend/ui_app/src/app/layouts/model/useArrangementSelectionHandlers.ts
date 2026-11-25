import { useCallback } from 'react';
import type { TimelineClip } from '@/shared/lib/arrangementTypes';

type Args = {
    timelineClipsForView: TimelineClip[];
    trackIds: string[];
    setSelectedClipIds: React.Dispatch<React.SetStateAction<string[]>>;
    setSelectedTrackId: React.Dispatch<React.SetStateAction<string>>;
    setSelectedTrackIds: React.Dispatch<React.SetStateAction<string[]>>;
    setEditCursorTrackIndex: React.Dispatch<React.SetStateAction<number>>;
    setMarqueeSelection: React.Dispatch<React.SetStateAction<{
        startBeat: number;
        endBeat: number;
        startTrack: number;
        endTrack: number;
    } | null>>;
    queuedStartBeatRef: React.MutableRefObject<number | null>;
};

type Result = {
    handleSelectTrack: (id: string, options?: { preserveCursor?: boolean }) => void;
    handleSelectTracks: (ids: string[], primaryId: string, options?: { preserveCursor?: boolean }) => void;
    handleMarqueeSelectionStart: () => void;
    handleClipSelect: (clipId: string, isShift?: boolean, isCtrl?: boolean) => void;
    handleTimelineClipSelectionChange: (ids: string[]) => void;
    handleTimelineTrackSelect: (trackId: string, trackIndex: number) => void;
};

export function useArrangementSelectionHandlers({
    timelineClipsForView,
    trackIds,
    setSelectedClipIds,
    setSelectedTrackId,
    setSelectedTrackIds,
    setEditCursorTrackIndex,
    setMarqueeSelection,
    queuedStartBeatRef,
}: Args): Result {
    const handleSelectTrack = useCallback((id: string, options?: { preserveCursor?: boolean }) => {
        setSelectedTrackId(id);
        setSelectedTrackIds(id && id !== 'master' ? [id] : []);
        if (!options?.preserveCursor) {
            const index = trackIds.indexOf(id);
            if (index >= 0) {
                setEditCursorTrackIndex(index);
            }
        }
        setSelectedClipIds([]);
    }, [setEditCursorTrackIndex, setSelectedClipIds, setSelectedTrackId, setSelectedTrackIds, trackIds]);

    const handleSelectTracks = useCallback((ids: string[], primaryId: string, options?: { preserveCursor?: boolean }) => {
        const cleaned = Array.from(new Set(ids)).filter((trackId) => trackId && trackId !== 'master');
        setSelectedTrackIds(cleaned);
        setSelectedTrackId(primaryId);
        if (!options?.preserveCursor) {
            const index = trackIds.indexOf(primaryId);
            if (index >= 0) {
                setEditCursorTrackIndex(index);
            }
        }
        setSelectedClipIds([]);
    }, [setEditCursorTrackIndex, setSelectedClipIds, setSelectedTrackId, setSelectedTrackIds, trackIds]);

    const handleMarqueeSelectionStart = useCallback(() => {
        setSelectedClipIds([]);
        setMarqueeSelection(null);
    }, [setMarqueeSelection, setSelectedClipIds]);

    const handleClipSelect = useCallback((clipId: string) => {
        // SSOT FIX: Shift/ctrl logic is handled exclusively in
        // useTimelineCommandBusBindings (clip-select handler). This function
        // is only called via onClipSelect (plain single-click path).
        setSelectedClipIds([clipId]);

        const clip = timelineClipsForView.find((item) => item.id === clipId);
        if (clip) {
            queuedStartBeatRef.current = clip.startBeat;
            const trackId = trackIds[clip.trackIndex];
            if (trackId && trackId !== 'master') {
                setSelectedTrackId(trackId);
                setSelectedTrackIds([trackId]);
            }
        }
    }, [queuedStartBeatRef, setSelectedClipIds, setSelectedTrackId, setSelectedTrackIds, timelineClipsForView, trackIds]);

    const handleTimelineClipSelectionChange = useCallback((ids: string[]) => {
        setSelectedClipIds(ids);

        if (ids.length > 0) {
            const idSet = new Set(ids);
            const trackIdSet = new Set<string>();
            for (const clip of timelineClipsForView) {
                if (idSet.has(clip.id)) {
                    const trackId = trackIds[clip.trackIndex];
                    if (trackId && trackId !== 'master') trackIdSet.add(trackId);
                }
            }
            if (trackIdSet.size > 0) {
                const selectedTracks = Array.from(trackIdSet);
                setSelectedTrackIds(selectedTracks);
                setSelectedTrackId(selectedTracks[selectedTracks.length - 1]);
            }

            let minBeat = Infinity;
            for (const clip of timelineClipsForView) {
                if (idSet.has(clip.id) && clip.startBeat < minBeat) minBeat = clip.startBeat;
            }
            if (Number.isFinite(minBeat)) queuedStartBeatRef.current = minBeat;
        }
    }, [queuedStartBeatRef, setSelectedClipIds, setSelectedTrackId, setSelectedTrackIds, timelineClipsForView, trackIds]);

    const handleTimelineTrackSelect = useCallback((trackId: string, trackIndex: number) => {
        const resolvedTrackId = trackIds[trackIndex] ?? trackId;
        if (!resolvedTrackId || !trackIds.includes(resolvedTrackId)) return;
        handleSelectTrack(resolvedTrackId);
    }, [handleSelectTrack, trackIds]);

    return {
        handleSelectTrack,
        handleSelectTracks,
        handleMarqueeSelectionStart,
        handleClipSelect,
        handleTimelineClipSelectionChange,
        handleTimelineTrackSelect,
    };
}
