import { useEffect, useRef } from 'react';
import * as engineApi from '@/shared/api/engine';
import type { TimelineClip } from '@/shared/lib/arrangementTypes';

type Args = {
    transportIsPlaying: boolean;
    selectedClipIds: string[];
    timelineClipsForView: TimelineClip[];
    queuedStartBeatRef: React.MutableRefObject<number | null>;
    editCursorBeat: number;
};

/**
 * Standard DAW "return-to-cursor" behavior:
 * 1. On PLAY: seek to edit cursor / selected clip start / queued anchor.
 * 2. On STOP: seek BACK to that same anchor so the next play resumes there.
 */
export function usePlaybackStartAnchor({
    transportIsPlaying,
    selectedClipIds,
    timelineClipsForView,
    queuedStartBeatRef,
    editCursorBeat,
}: Args): void {
    const prevIsPlayingRef = useRef(false);
    /** Persists the beat we started playing from, so we can return on stop. */
    const playStartAnchorRef = useRef<number | null>(null);

    useEffect(() => {
        const justStarted = transportIsPlaying && !prevIsPlayingRef.current;
        const justStopped = !transportIsPlaying && prevIsPlayingRef.current;
        prevIsPlayingRef.current = transportIsPlaying;

        // ── On PLAY START: resolve anchor & seek ──
        if (justStarted) {
            let startBeat: number | null = null;

            // Priority 1: selected clips → start from earliest selected clip
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

            // Priority 2: queued beat (from timeline click / edit cursor set)
            if (startBeat === null && queuedStartBeatRef.current !== null) {
                startBeat = queuedStartBeatRef.current;
            }

            // Priority 3: current edit cursor position
            if (startBeat === null && editCursorBeat >= 0) {
                startBeat = editCursorBeat;
            }

            queuedStartBeatRef.current = null;

            if (startBeat !== null) {
                playStartAnchorRef.current = startBeat;
                void engineApi.seekToBeat(Math.max(0, startBeat)).catch((err) => {
                    console.error('[DawShell] seek to playback anchor failed:', err);
                });
            }
            return;
        }

        // ── On STOP: return playhead to saved anchor ──
        if (justStopped && playStartAnchorRef.current !== null) {
            const anchor = playStartAnchorRef.current;
            void engineApi.seekToBeat(Math.max(0, anchor)).catch((err) => {
                console.error('[DawShell] seek back to anchor on stop failed:', err);
            });
            // Don't clear the anchor — so pressing play again starts from here.
        }
    }, [transportIsPlaying, selectedClipIds, timelineClipsForView, queuedStartBeatRef, editCursorBeat]);
}
