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

    /** One-shot viewport restore payload sequence. */
    restoreSeq: number;
    restorePixelsPerBeat: number | null;
    restoreScrollLeft: number | null;
    restoreScrollTop: number | null;

    /** Update layout values. */
    setLayout: (values: Partial<Pick<TimelineState, 'pixelsPerBeat' | 'trackHeight' | 'canvasRect' | 'scrollLeft' | 'scrollTop' | 'rulerHeight'>>) => void;
    requestViewportRestore: (pixelsPerBeat: number, scrollLeft: number, scrollTop?: number) => void;
    clearViewportRestore: () => void;
}

export const useTimelineStore = create<TimelineState>((set) => ({
    pixelsPerBeat: 20,
    trackHeight: 48,
    canvasRect: null,
    scrollLeft: 0,
    scrollTop: 0,
    rulerHeight: 24,
    restoreSeq: 0,
    restorePixelsPerBeat: null,
    restoreScrollLeft: null,
    restoreScrollTop: null,

    // BUG-021: Optimized to avoid creating intermediate `next` object on every
    // scroll tick (~60Hz). Directly checks and returns only changed fields.
    // BUG-019 FIX: Build partial explicitly instead of relying on `...false` JS quirk.
    setLayout: (values) => set((state) => {
        const partial: Partial<TimelineState> = {};
        let changed = false;
        if (values.pixelsPerBeat !== undefined && values.pixelsPerBeat !== state.pixelsPerBeat) {
            partial.pixelsPerBeat = values.pixelsPerBeat; changed = true;
        }
        if (values.trackHeight !== undefined && values.trackHeight !== state.trackHeight) {
            partial.trackHeight = values.trackHeight; changed = true;
        }
        // BUG-014 FIX: Compare DOMRect values, not references — getBoundingClientRect()
        // always returns a new object, causing 60 unnecessary state writes/sec.
        if (values.canvasRect !== undefined) {
            const a = values.canvasRect;
            const b = state.canvasRect;
            const same = a && b && a.x === b.x && a.y === b.y && a.width === b.width && a.height === b.height;
            if (!same) {
                partial.canvasRect = a; changed = true;
            }
        }
        if (values.scrollLeft !== undefined && values.scrollLeft !== state.scrollLeft) {
            partial.scrollLeft = values.scrollLeft; changed = true;
        }
        if (values.scrollTop !== undefined && values.scrollTop !== state.scrollTop) {
            partial.scrollTop = values.scrollTop; changed = true;
        }
        if (values.rulerHeight !== undefined && values.rulerHeight !== state.rulerHeight) {
            partial.rulerHeight = values.rulerHeight; changed = true;
        }
        if (!changed) return state;
        return partial;
    }),
    requestViewportRestore: (pixelsPerBeat, scrollLeft, scrollTop) =>
        set((state) => ({
            // BUG-A065 FIX: Simple increment — MAX_SAFE_INTEGER modulo is unnecessary
            // and introduces bias. Monotonic increment is safe for any practical session.
            restoreSeq: state.restoreSeq + 1,
            restorePixelsPerBeat: Number.isFinite(pixelsPerBeat) ? pixelsPerBeat : 20,
            restoreScrollLeft: Number.isFinite(scrollLeft) ? Math.max(0, scrollLeft) : 0,
            restoreScrollTop: Number.isFinite(scrollTop) ? Math.max(0, scrollTop as number) : null,
        })),
    // BUG-054 FIX: Don't reset restoreSeq to 0 — it could re-trigger if consumer's
    // lastProcessedSeq was also 0 (initial value). Just null the payload.
    clearViewportRestore: () =>
        set({
            restorePixelsPerBeat: null,
            restoreScrollLeft: null,
            restoreScrollTop: null,
        }),
}));
