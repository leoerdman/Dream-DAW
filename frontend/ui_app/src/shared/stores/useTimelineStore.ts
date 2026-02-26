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
    setLayout: (values) => set((state) => {
        const ppb = values.pixelsPerBeat !== undefined && values.pixelsPerBeat !== state.pixelsPerBeat ? values.pixelsPerBeat : undefined;
        const th = values.trackHeight !== undefined && values.trackHeight !== state.trackHeight ? values.trackHeight : undefined;
        const cr = values.canvasRect !== undefined && values.canvasRect !== state.canvasRect ? values.canvasRect : undefined;
        const sl = values.scrollLeft !== undefined && values.scrollLeft !== state.scrollLeft ? values.scrollLeft : undefined;
        const st = values.scrollTop !== undefined && values.scrollTop !== state.scrollTop ? values.scrollTop : undefined;
        const rh = values.rulerHeight !== undefined && values.rulerHeight !== state.rulerHeight ? values.rulerHeight : undefined;
        if (ppb === undefined && th === undefined && cr === undefined && sl === undefined && st === undefined && rh === undefined) return state;
        return {
            ...(ppb !== undefined && { pixelsPerBeat: ppb }),
            ...(th !== undefined && { trackHeight: th }),
            ...(cr !== undefined && { canvasRect: cr }),
            ...(sl !== undefined && { scrollLeft: sl }),
            ...(st !== undefined && { scrollTop: st }),
            ...(rh !== undefined && { rulerHeight: rh }),
        };
    }),
    requestViewportRestore: (pixelsPerBeat, scrollLeft, scrollTop) =>
        set((state) => ({
            restoreSeq: state.restoreSeq + 1,
            restorePixelsPerBeat: Number.isFinite(pixelsPerBeat) ? pixelsPerBeat : 20,
            restoreScrollLeft: Number.isFinite(scrollLeft) ? Math.max(0, scrollLeft) : 0,
            restoreScrollTop: Number.isFinite(scrollTop) ? Math.max(0, scrollTop as number) : null,
        })),
    // BUG-013: Reset restoreSeq to 0 to prevent stale sequence re-triggers after clear.
    clearViewportRestore: () =>
        set({
            restoreSeq: 0,
            restorePixelsPerBeat: null,
            restoreScrollLeft: null,
            restoreScrollTop: null,
        }),
}));
