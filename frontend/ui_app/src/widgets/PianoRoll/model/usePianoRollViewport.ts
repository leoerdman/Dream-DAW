import { useEffect, useRef } from 'react';
import {
    DEFAULT_FOCUS_PITCH,
    MAX_NOTE_HEIGHT,
    MAX_PPB,
    MIN_NOTE_HEIGHT,
    MIN_PPB,
    type MidiNote,
} from './pianoRollConfig';

const scrollByClipKey = new Map<string, { top: number; left: number }>();
const MAX_SCROLL_CACHE = 120;

function cacheScrollPosition(key: string, value: { top: number; left: number }): void {
    if (scrollByClipKey.has(key)) scrollByClipKey.delete(key);
    scrollByClipKey.set(key, value);
    if (scrollByClipKey.size <= MAX_SCROLL_CACHE) return;
    const oldest = scrollByClipKey.keys().next().value as string | undefined;
    if (oldest) scrollByClipKey.delete(oldest);
}

function toClipViewportKey(trackIndex: number | undefined, clipStartBeat: number, clipLengthBeats: number | undefined): string {
    void clipLengthBeats;
    return `${trackIndex ?? -1}:${clipStartBeat}`;
}


interface UsePianoRollViewportArgs {
    trackIndex?: number;
    clipStartBeat: number;
    notes: MidiNote[];
    clipLengthBeats?: number;
    noteHeight: number;
    setNoteHeight: React.Dispatch<React.SetStateAction<number>>;
    setZoomOverrideH: React.Dispatch<React.SetStateAction<number | null>>;
    pixelsPerBeatRef: React.RefObject<number>;
    scrollRef: React.RefObject<HTMLDivElement | null>;
    keyboardScrollRef: React.RefObject<HTMLDivElement | null>;
    gridViewportRef: React.RefObject<HTMLDivElement | null>;
    setContainerWidth: React.Dispatch<React.SetStateAction<number>>;
    visiblePitches: number[];
    pitchToY: (pitch: number) => number;
}

export function usePianoRollViewport({
    trackIndex,
    clipStartBeat,
    notes,
    clipLengthBeats,
    noteHeight,
    setNoteHeight,
    setZoomOverrideH,
    pixelsPerBeatRef,
    scrollRef,
    keyboardScrollRef,
    gridViewportRef,
    setContainerWidth,
    visiblePitches,
    pitchToY,
}: UsePianoRollViewportArgs) {
    const clipViewportKey = toClipViewportKey(trackIndex, clipStartBeat, clipLengthBeats);

    useEffect(() => {
        const element = gridViewportRef.current;
        if (!element) return;
        const observer = new ResizeObserver((entries) => {
            for (const entry of entries) setContainerWidth(entry.contentRect.width);
        });
        observer.observe(element);
        setContainerWidth(element.clientWidth);
        return () => observer.disconnect();
    }, [gridViewportRef, setContainerWidth]);

    // Bug #2 fix: Only reset zoom when switching to a genuinely different clip,
    // not when the current clip is trimmed/extended.
    const clipKeyRef = useRef(clipViewportKey);
    useEffect(() => {
        const key = clipViewportKey;
        const prev = clipKeyRef.current;
        clipKeyRef.current = key;
        if (prev !== key) {
            // Different track/clip → reset zoom to auto-fit
            setZoomOverrideH(null);
        }
    }, [clipViewportKey, setZoomOverrideH]);

    useEffect(() => {
        const grid = scrollRef.current;
        const keyboard = keyboardScrollRef.current;
        if (!grid || !keyboard) return;
        const onScroll = () => {
            keyboard.scrollTop = grid.scrollTop;
            cacheScrollPosition(clipViewportKey, { top: grid.scrollTop, left: grid.scrollLeft });
        };
        grid.addEventListener('scroll', onScroll);
        return () => {
            grid.removeEventListener('scroll', onScroll);
            cacheScrollPosition(clipViewportKey, { top: grid.scrollTop, left: grid.scrollLeft });
        };
    }, [clipViewportKey, keyboardScrollRef, scrollRef]);

    // Bug #20 fix: Accumulate Alt+scroll deltas instead of dropping during RAF.
    const pendingNoteHeightDeltaRef = useRef(0);
    const noteHeightRafRef = useRef<number | null>(null);
    useEffect(() => {
        const element = scrollRef.current;
        if (!element) return;
        const onWheel = (event: WheelEvent) => {
            if (event.altKey) {
                event.preventDefault();
                pendingNoteHeightDeltaRef.current += event.deltaY > 0 ? -1 : 1;
                if (noteHeightRafRef.current == null) {
                    noteHeightRafRef.current = requestAnimationFrame(() => {
                        const accumulated = pendingNoteHeightDeltaRef.current;
                        pendingNoteHeightDeltaRef.current = 0;
                        noteHeightRafRef.current = null;
                        if (accumulated !== 0) {
                            setNoteHeight((prev) => Math.max(MIN_NOTE_HEIGHT, Math.min(MAX_NOTE_HEIGHT, prev + accumulated)));
                        }
                    });
                }
            } else if (event.ctrlKey || event.metaKey) {
                event.preventDefault();
                const factor = event.deltaY > 0 ? 0.9 : 1.1;
                setZoomOverrideH((prev) => {
                    const current = prev ?? pixelsPerBeatRef.current;
                    return Math.max(MIN_PPB, Math.min(MAX_PPB, Math.round(current * factor)));
                });
            }
        };
        element.addEventListener('wheel', onWheel, { passive: false });
        return () => {
            element.removeEventListener('wheel', onWheel);
            if (noteHeightRafRef.current !== null) {
                cancelAnimationFrame(noteHeightRafRef.current);
                noteHeightRafRef.current = null;
            }
        };
    }, [pixelsPerBeatRef, scrollRef, setNoteHeight, setZoomOverrideH]);

    const noteHeightRef = useRef(noteHeight);
    useEffect(() => { noteHeightRef.current = noteHeight; }, [noteHeight]);

    // Bug #1 fix: Use a ref for notes to avoid resetting scroll on every note edit.
    // Only recalculate scroll position on clip switch (clipLengthBeats + trackIndex change).
    const notesSnapshotRef = useRef(notes);
    useEffect(() => { notesSnapshotRef.current = notes; }, [notes]);

    useEffect(() => {
        const grid = scrollRef.current;
        const keyboard = keyboardScrollRef.current;
        if (!grid) return;
        const nh = noteHeightRef.current;
        const currentNotes = notesSnapshotRef.current;

        const centerToNotes = () => {
            let focusPitch: number;
            if (currentNotes.length > 0) {
                const sorted = currentNotes.map((n) => n.pitch).sort((a, b) => a - b);
                const mid = Math.floor(sorted.length / 2);
                focusPitch = sorted.length % 2 === 0 ? Math.round((sorted[mid - 1] + sorted[mid]) / 2) : sorted[mid];
            } else {
                focusPitch = DEFAULT_FOCUS_PITCH;
            }
            if (!visiblePitches.includes(focusPitch)) {
                focusPitch = visiblePitches[Math.floor(visiblePitches.length / 2)] ?? DEFAULT_FOCUS_PITCH;
            }
            const targetY = pitchToY(focusPitch);
            if (targetY >= 0) {
                const centered = Math.max(0, targetY - grid.clientHeight * 0.5 + nh * 0.5);
                grid.scrollTop = centered;
                if (keyboard) keyboard.scrollTop = centered;
            }

            if (currentNotes.length > 0) {
                let minBeat = Infinity;
                let maxBeat = -Infinity;
                for (const note of currentNotes) {
                    minBeat = Math.min(minBeat, note.startBeat);
                    maxBeat = Math.max(maxBeat, note.startBeat + note.durationBeats);
                }
                if (Number.isFinite(minBeat) && Number.isFinite(maxBeat)) {
                    const noteSpan = Math.max(0.25, maxBeat - minBeat);
                    const padBeats = Math.max(0.125, noteSpan * 0.2);
                    const centerBeat = (minBeat + maxBeat) * 0.5;
                    const targetLeft = Math.max(0, (centerBeat - padBeats) * pixelsPerBeatRef.current - grid.clientWidth * 0.5);
                    grid.scrollLeft = targetLeft;
                }
            }
        };

        const rafId = requestAnimationFrame(() => {
            const saved = scrollByClipKey.get(clipViewportKey);
            if (saved) {
                grid.scrollTop = saved.top;
                grid.scrollLeft = saved.left;
                if (keyboard) keyboard.scrollTop = saved.top;

                if (currentNotes.length > 0) {
                    let minY = Infinity;
                    let maxY = -Infinity;
                    let minX = Infinity;
                    let maxX = -Infinity;
                    for (const note of currentNotes) {
                        const y = pitchToY(note.pitch);
                        if (y < 0) continue;
                        minY = Math.min(minY, y);
                        maxY = Math.max(maxY, y + nh);
                        minX = Math.min(minX, note.startBeat * pixelsPerBeatRef.current);
                        maxX = Math.max(maxX, (note.startBeat + note.durationBeats) * pixelsPerBeatRef.current);
                    }

                    if (Number.isFinite(minY) && Number.isFinite(maxY) && Number.isFinite(minX) && Number.isFinite(maxX)) {
                        const viewTop = grid.scrollTop;
                        const viewBottom = grid.scrollTop + grid.clientHeight;
                        const viewLeft = grid.scrollLeft;
                        const viewRight = grid.scrollLeft + grid.clientWidth;
                        const verticallyVisible = maxY >= viewTop + 4 && minY <= viewBottom - 4;
                        const horizontallyVisible = maxX >= viewLeft + 4 && minX <= viewRight - 4;
                        if (!verticallyVisible || !horizontallyVisible) {
                            centerToNotes();
                        }
                    } else {
                        centerToNotes();
                    }
                }
            } else {
                centerToNotes();
            }
        });
        return () => cancelAnimationFrame(rafId);
    }, [clipLengthBeats, clipStartBeat, clipViewportKey, keyboardScrollRef, pitchToY, scrollRef, trackIndex, visiblePitches, pixelsPerBeatRef]);
}
