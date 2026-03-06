// ═══════════════════════════════════════════════════════════════════════════
// Dream DAW — Viewport Store (Sample-Accurate Zoom & Scroll)
// ═══════════════════════════════════════════════════════════════════════════
//
// Zustand store managing the timeline's view state.
//
// The canonical zoom unit is `samplesPerPixel` (SPP) — not beats, not
// pixelsPerBeat. This matches professional DAWs (Ableton, Logic, Pro Tools)
// and eliminates sample rate / BPM dependencies in the zoom calculation.
//
// SPP determines which waveform mip level the renderer selects:
//   SPP ≤ 256   → Mip level 0 (finest, 256 spp)
//   SPP ≤ 1024  → Mip level 1
//   SPP ≤ 4096  → Mip level 2
//   SPP ≤ 16384 → Mip level 3 (coarsest)
//
// ═══════════════════════════════════════════════════════════════════════════

import { create } from 'zustand';
import { getSamplesPerBeat, MIN_BPM } from '@/shared/lib/audioMath';

// ── Constants ────────────────────────────────────────────────────────────
// BUG-036 FIX: Export so ViewportMachine and other modules share the same bounds.

/** Minimum SPP — maximum zoom in. At 44.1kHz, ~5.8ms per pixel. */
export const MIN_SPP = 4;

/** Maximum SPP — maximum zoom out. At 44.1kHz, ~93 seconds per pixel. */
export const MAX_SPP = 65536;

/** Minimum pixels per beat for grid drawing. */
export const MIN_PIXELS_PER_BEAT = 5;

/** Maximum pixels per beat for grid drawing. */
export const MAX_PIXELS_PER_BEAT = 2000;

/** Default zoom level. At 44.1kHz: ~5.8ms per pixel — comfortable overview. */
export const DEFAULT_SPP = 256;

/** Mip level boundaries (must match Rust `MIP_FACTORS`). */
const MIP_FACTORS = [256, 1024, 4096, 16384] as const;

// ── Store Interface ──────────────────────────────────────────────────────

export interface ViewportState {
    /** Current zoom level in samples per pixel. Lower = more zoomed in. */
    samplesPerPixel: number;

    /** Horizontal scroll position in pixels. */
    scrollX: number;

    /** Total timeline width in pixels (derived from project duration + SPP). */
    timelineWidth: number;

    /** Visible viewport width in pixels (container width). */
    viewportWidth: number;
}

export interface ViewportActions {
    /**
     * Zoom in by halving SPP (doubles visual resolution).
     * Optionally anchors zoom around a specific pixel position (cursor).
     */
    zoomIn: (anchorX?: number) => void;

    /**
     * Zoom out by doubling SPP (halves visual resolution).
     * Optionally anchors zoom around a specific pixel position (cursor).
     */
    zoomOut: (anchorX?: number) => void;

    /**
     * Set zoom to an exact SPP value (clamped to bounds).
     * Used for pinch-zoom or zoom slider.
     */
    setZoom: (spp: number, anchorX?: number) => void;

    /** Set horizontal scroll position (clamped to valid range). */
    setScrollX: (x: number) => void;

    /** Update viewport dimensions (called on container resize). */
    setViewportWidth: (width: number) => void;

    /** Update total timeline width (called when project duration changes). */
    setTimelineWidth: (width: number) => void;

    /**
     * Convert a screen X position (relative to viewport) to sample frames.
     * Accounts for scroll offset and zoom level.
     */
    screenToSamples: (screenX: number) => number;

    /**
     * Convert sample frames to a screen X position (relative to viewport).
     * Accounts for scroll offset and zoom level.
     */
    samplesToScreen: (sampleFrame: number) => number;

    /**
     * Get the best mip level index for the current zoom level.
     * Matches `PeakCache::best_mip_level` in Rust.
     */
    bestMipLevel: () => number;

    /**
     * Convert SPP to pixels-per-beat for grid drawing.
     * Requires BPM and sample rate from the engine store.
     */
    pixelsPerBeat: (bpm: number, sampleRate: number) => number;
}

export type ViewportStore = ViewportState & ViewportActions;

// ── Store Implementation ─────────────────────────────────────────────────

export const useViewportStore = create<ViewportStore>((set, get) => ({
    // ── State ──────────────────────────────────────────────────────
    samplesPerPixel: DEFAULT_SPP,
    scrollX: 0,
    timelineWidth: 10000,
    viewportWidth: 1200,

    // ── Zoom Actions ───────────────────────────────────────────────

    zoomIn: (anchorX?: number) => {
        const state = get();
        const newSpp = Math.max(MIN_SPP, state.samplesPerPixel / 2);
        applyZoom(state, newSpp, anchorX, set);
    },

    zoomOut: (anchorX?: number) => {
        const state = get();
        const newSpp = Math.min(MAX_SPP, state.samplesPerPixel * 2);
        applyZoom(state, newSpp, anchorX, set);
    },

    setZoom: (spp: number, anchorX?: number) => {
        // BUG-035 FIX: Guard against NaN/infinite from edge-case pinch-zoom or external API.
        if (!Number.isFinite(spp)) return;
        const state = get();
        const newSpp = Math.min(MAX_SPP, Math.max(MIN_SPP, spp));
        applyZoom(state, newSpp, anchorX, set);
    },

    // ── Scroll ─────────────────────────────────────────────────────

    setScrollX: (x: number) => {
        const state = get();
        const maxScroll = Math.max(0, state.timelineWidth - state.viewportWidth);
        set({ scrollX: Math.min(maxScroll, Math.max(0, x)) });
    },

    // ── Layout ─────────────────────────────────────────────────────

    setViewportWidth: (width: number) => set({ viewportWidth: width }),
    setTimelineWidth: (width: number) => set({ timelineWidth: width }),

    // ── Coordinate Conversion ──────────────────────────────────────

    screenToSamples: (screenX: number) => {
        const { scrollX, samplesPerPixel } = get();
        return Math.round((scrollX + screenX) * samplesPerPixel);
    },

    samplesToScreen: (sampleFrame: number) => {
        const { scrollX, samplesPerPixel } = get();
        return sampleFrame / samplesPerPixel - scrollX;
    },

    // ── Mip Level ──────────────────────────────────────────────────

    bestMipLevel: () => {
        const { samplesPerPixel } = get();
        for (let i = MIP_FACTORS.length - 1; i >= 0; i--) {
            if (samplesPerPixel >= MIP_FACTORS[i]) {
                return i;
            }
        }
        return 0;
    },

    // ── Grid Conversion ────────────────────────────────────────────

    pixelsPerBeat: (bpm: number, sampleRate: number) => {
        const { samplesPerPixel } = get();
        // BUG-029 FIX: SSOT — use MIN_BPM from audioMath instead of inline fallback.
        const safeBpm = Number.isFinite(bpm) ? Math.max(MIN_BPM, bpm) : MIN_BPM;
        const samplesPerBeat = getSamplesPerBeat(safeBpm, sampleRate);
        return samplesPerBeat / samplesPerPixel;
    },
}));

// ── Zoom Helper ──────────────────────────────────────────────────────────

/**
 * Applies a zoom change while optionally anchoring the view at a given
 * pixel position (e.g., the cursor). Without an anchor, zoom centers on
 * the current viewport center.
 *
 * This ensures the sample under the cursor stays under the cursor after
 * zooming — the standard UX for scroll-wheel zoom in professional DAWs.
 */
function applyZoom(
    state: ViewportState,
    newSpp: number,
    anchorX: number | undefined,
    set: (partial: Partial<ViewportState>) => void,
) {
    const oldSpp = state.samplesPerPixel;
    if (newSpp === oldSpp) return;

    // BUG-010 FIX: Guard against NaN/Infinity anchorX from broken
    // getBoundingClientRect() or edge-case touch events.
    const anchor = (anchorX != null && Number.isFinite(anchorX)) ? anchorX : state.viewportWidth / 2;

    // Sample frame at the anchor point
    const sampleAtAnchor = (state.scrollX + anchor) * oldSpp;

    // New scroll position that keeps the same sample under the anchor
    const newScrollX = Math.max(0, sampleAtAnchor / newSpp - anchor);

    set({
        samplesPerPixel: newSpp,
        scrollX: newScrollX,
    });
}
