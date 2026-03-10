export const MIN_PPB = 4;
export const MAX_PPB = 5000;
export const DEFAULT_PPB = 20;
export const ZOOM_SENSITIVITY = 0.004;
export const SCROLL_SENSITIVITY = 1.0;

export interface ViewportConfig {
    totalBeats: number;
    trackCount: number;
    trackHeight: number;
    trackHeights?: number[];
    rulerHeight: number;
    /** Extra vertical scroll room after the last track (px). */
    bottomPaddingPx?: number;
    initialPpb?: number;
}

export interface ViewportSnapshot {
    scrollX: number;
    scrollY: number;
    ppb: number;
    viewportWidth: number;
    viewportHeight: number;
}

export interface VisibleRange {
    startBeat: number;
    endBeat: number;
    startTrack: number;
    endTrack: number;
}
