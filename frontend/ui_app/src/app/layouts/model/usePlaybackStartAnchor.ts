import { useEffect, useRef, useCallback } from 'react';
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
 * ENTERPRISE FIX: Standard DAW "return-to-cursor" behavior — refactored for
 * atomic seek-and-play to eliminate the playback stutter.
 *
 * **Previous architecture (caused stutter)**:
 *   togglePlay() → SetPlay(true) pushed to ring buffer → audio callback processes it
 *   → 1–2 buffers render from OLD position → React useEffect fires → seekToBeat()
 *   → Seek pushed to ring buffer → audio callback catches up → correct position.
 *   Result: brief sound burst from old position ("stutter").
 *
 * **New architecture (atomic)**:
 *   resolveAnchorBeat() computes the beat SYNCHRONOUSLY inline → playFromBeat(beat)
 *   pushes Seek+SetPlay atomically → audio callback processes both in one drain cycle.
 *   No stutter, no race condition.
 *
 * Responsibilities:
 * 1. `resolveAnchorBeat()` — synchronously computes where playback should start.
 * 2. On STOP: seek back to the saved anchor (classic return-to-cursor behavior).
 */
export function usePlaybackStartAnchor({
    transportIsPlaying,
    selectedClipIds,
    timelineClipsForView,
    queuedStartBeatRef,
    editCursorBeat,
}: Args): { resolveAnchorBeat: () => number | null } {
    const prevIsPlayingRef = useRef(false);
    /** Persists the beat we started playing from, so we can return on stop. */
    const playStartAnchorRef = useRef<number | null>(null);

    /**
     * Synchronously resolves where playback should start.
     * Called by the toggle-play wrapper BEFORE calling playFromBeat().
     *
     * Returns `null` if no anchor is needed (i.e., resume from current position).
     */
    const resolveAnchorBeat = useCallback((): number | null => {
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
        }

        return startBeat;
    }, [selectedClipIds, timelineClipsForView, queuedStartBeatRef, editCursorBeat]);

    // ── On STOP: seek back to saved anchor (return-to-cursor) ──
    useEffect(() => {
        const justStopped = !transportIsPlaying && prevIsPlayingRef.current;
        prevIsPlayingRef.current = transportIsPlaying;

        if (justStopped && playStartAnchorRef.current !== null) {
            const anchor = playStartAnchorRef.current;
            void engineApi.seekToBeat(Math.max(0, anchor)).catch((err) => {
                console.error('[Dream] seek back to anchor on stop failed:', err);
            });
            // Don't clear the anchor — so pressing play again starts from here.
        }
    }, [transportIsPlaying]);

    return { resolveAnchorBeat };
}
