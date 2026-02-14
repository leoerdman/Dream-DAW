/**
 * useTimelineStore — Shared timeline layout state.
 *
 * Exposes dynamic layout values from the Timeline component so that
 * other widgets (e.g. DawShell drag handler) can read them without
 * prop-drilling or stale closures.
 */

import { create } from 'zustand';

interface TimelineState {
    /** Current zoom level (pixels per beat). */
    pixelsPerBeat: number;

    /** Track lane height in pixels. */
    trackHeight: number;

    /** Bounding rect of the scrollable canvas area (updated on layout). */
    canvasRect: DOMRect | null;

    /** Horizontal scroll offset. */
    scrollLeft: number;

    /** Vertical scroll offset. */
    scrollTop: number;

    /** Ruler height in pixels. */
    rulerHeight: number;

    /** Update layout values. */
    setLayout: (values: Partial<Pick<TimelineState, 'pixelsPerBeat' | 'trackHeight' | 'canvasRect' | 'scrollLeft' | 'scrollTop' | 'rulerHeight'>>) => void;
}

export const useTimelineStore = create<TimelineState>((set) => ({
    pixelsPerBeat: 20,
    trackHeight: 48,
    canvasRect: null,
    scrollLeft: 0,
    scrollTop: 0,
    rulerHeight: 24,

    setLayout: (values) => set(values),
}));
