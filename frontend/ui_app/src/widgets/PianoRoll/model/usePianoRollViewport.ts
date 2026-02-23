import { useEffect, useRef } from 'react';
import {
    DEFAULT_FOCUS_PITCH,
    MAX_NOTE_HEIGHT,
    MAX_PPB,
    MIN_NOTE_HEIGHT,
    MIN_PPB,
    type MidiNote,
} from './pianoRollConfig';

const scrollTopByTrack = new Map<number, number>();

interface UsePianoRollViewportArgs {
    trackIndex?: number;
    notes: MidiNote[];
    clipLengthBeats?: number;
    totalBars: number;
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
    notes,
    clipLengthBeats,
    totalBars,
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
    useEffect(() => {
        if (trackIndex != null) scrollTopByTrack.delete(trackIndex);
    }, [clipLengthBeats, trackIndex]);

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

    useEffect(() => {
        Promise.resolve().then(() => setZoomOverrideH(null));
    }, [clipLengthBeats, setZoomOverrideH, totalBars]);

    useEffect(() => {
        const grid = scrollRef.current;
        const keyboard = keyboardScrollRef.current;
        if (!grid || !keyboard) return;
        const onScroll = () => {
            keyboard.scrollTop = grid.scrollTop;
            if (trackIndex != null) scrollTopByTrack.set(trackIndex, grid.scrollTop);
        };
        grid.addEventListener('scroll', onScroll);
        return () => {
            grid.removeEventListener('scroll', onScroll);
            if (trackIndex != null) scrollTopByTrack.set(trackIndex, grid.scrollTop);
        };
    }, [keyboardScrollRef, scrollRef, trackIndex]);

    const noteHeightRafRef = useRef<number | null>(null);
    useEffect(() => {
        const element = scrollRef.current;
        if (!element) return;
        const onWheel = (event: WheelEvent) => {
            if (event.altKey) {
                event.preventDefault();
                const delta = event.deltaY > 0 ? -1 : 1;
                if (noteHeightRafRef.current == null) {
                    noteHeightRafRef.current = requestAnimationFrame(() => {
                        noteHeightRafRef.current = null;
                    });
                    setNoteHeight((prev) => Math.max(MIN_NOTE_HEIGHT, Math.min(MAX_NOTE_HEIGHT, prev + delta)));
                }
            } else if (event.ctrlKey || event.metaKey) {
                event.preventDefault();
                const delta = event.deltaY > 0 ? -2 : 2;
                setZoomOverrideH((prev) => {
                    const current = prev ?? pixelsPerBeatRef.current;
                    return Math.max(MIN_PPB, Math.min(MAX_PPB, current + delta));
                });
            }
        };
        element.addEventListener('wheel', onWheel, { passive: false });
        return () => element.removeEventListener('wheel', onWheel);
    }, [noteHeight, pixelsPerBeatRef, scrollRef, setNoteHeight, setZoomOverrideH]);

    const noteHeightRef = useRef(noteHeight);
    useEffect(() => { noteHeightRef.current = noteHeight; }, [noteHeight]);

    useEffect(() => {
        const grid = scrollRef.current;
        const keyboard = keyboardScrollRef.current;
        if (!grid) return;
        const nh = noteHeightRef.current;
        requestAnimationFrame(() => {
            const saved = trackIndex != null ? scrollTopByTrack.get(trackIndex) : undefined;
            if (saved != null) {
                grid.scrollTop = saved;
                if (keyboard) keyboard.scrollTop = saved;
            } else {
                let focusPitch: number;
                if (notes.length > 0) {
                    const sorted = notes.map((n) => n.pitch).sort((a, b) => a - b);
                    const mid = Math.floor(sorted.length / 2);
                    focusPitch = sorted.length % 2 === 0 ? Math.round((sorted[mid - 1] + sorted[mid]) / 2) : sorted[mid];
                } else {
                    focusPitch = DEFAULT_FOCUS_PITCH;
                }
                if (!visiblePitches.includes(focusPitch)) {
                    focusPitch = visiblePitches[Math.floor(visiblePitches.length / 2)] ?? DEFAULT_FOCUS_PITCH;
                }
                const targetY = pitchToY(focusPitch);
                if (targetY < 0) return;
                const centered = Math.max(0, targetY - grid.clientHeight * 0.5 + nh * 0.5);
                grid.scrollTop = centered;
                if (keyboard) keyboard.scrollTop = centered;
            }
        });
    }, [clipLengthBeats, keyboardScrollRef, notes, pitchToY, scrollRef, trackIndex, visiblePitches]);
}
