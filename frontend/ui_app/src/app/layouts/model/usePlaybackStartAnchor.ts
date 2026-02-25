import { useEffect, useRef } from 'react';
import * as engineApi from '@/shared/api/engine';
import type { TimelineClip } from '@/shared/lib/arrangementTypes';

type Args = {
    transportIsPlaying: boolean;
    selectedClipIds: string[];
    timelineClipsForView: TimelineClip[];
    queuedStartBeatRef: React.MutableRefObject<number | null>;
};

export function usePlaybackStartAnchor({
    transportIsPlaying,
    selectedClipIds,
    timelineClipsForView,
    queuedStartBeatRef,
}: Args): void {
    const prevIsPlayingRef = useRef(false);

    useEffect(() => {
        const justStarted = transportIsPlaying && !prevIsPlayingRef.current;
        prevIsPlayingRef.current = transportIsPlaying;
        if (!justStarted) return;

        let startBeat: number | null = null;

        if (selectedClipIds.length > 0) {
            const selectedSet = new Set(selectedClipIds);
            let minBeat = Infinity;
            for (const clip of timelineClipsForView) {
                if (selectedSet.has(clip.id) && clip.startBeat < minBeat) {
                    minBeat = clip.startBeat;
                }
            }
            if (Number.isFinite(minBeat)) startBeat = minBeat;
        }

        if (startBeat === null && queuedStartBeatRef.current !== null) {
            startBeat = queuedStartBeatRef.current;
        }

        queuedStartBeatRef.current = null;
        if (startBeat === null) return;

        void engineApi.seekToBeat(Math.max(0, startBeat)).catch((err) => {
            console.error('[DawShell] seek to playback anchor failed:', err);
        });
    }, [transportIsPlaying, selectedClipIds, timelineClipsForView, queuedStartBeatRef]);
}
