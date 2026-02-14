// ═══════════════════════════════════════════════════════════════════════════
// Dream DAW — ViewportMatrix (Canvas Camera)
// ═══════════════════════════════════════════════════════════════════════════
//
// Pure f64-precision camera for the Canvas timeline engine.
// Mirrors Rust `Viewport` in `core/dream_renderer/src/viewport.rs`.
//
// This class owns ALL zoom/scroll state and is the SINGLE SOURCE OF TRUTH
// for converting between screen pixels ↔ beats and tracks.
// It has ZERO React dependencies — it is consumed by TimelineEngine.
//
// Architecture:
//   1. Stores scroll (px), zoom (pixels-per-beat), and viewport dimensions
//   2. Provides coordinate conversion: screen ↔ beats, screen ↔ track
//   3. Provides visible range (for clip/grid culling)
//   4. Implements Ableton-style mouse-anchor zoom (focal point stays fixed)
//   5. Exposes a DOMMatrix for canvas ctx.setTransform()
//
// ═══════════════════════════════════════════════════════════════════════════

// ── Constants ─────────────────────────────────────────────────────────────

/** Absolute zoom bounds (pixels per beat). */
export const MIN_PPB = 4;
export const MAX_PPB = 400;

/** Default zoom level. */
export const DEFAULT_PPB = 20;

/** Zoom sensitivity for Ctrl+Wheel. */
const ZOOM_SENSITIVITY = 0.004;

/** Scroll sensitivity for Wheel (px per delta unit). */
const SCROLL_SENSITIVITY = 1.0;

// ── Types ─────────────────────────────────────────────────────────────────

export interface ViewportConfig {
    totalBeats: number;
    trackCount: number;
    trackHeight: number;
    rulerHeight: number;
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

// ── Class ─────────────────────────────────────────────────────────────────

export class ViewportMatrix {
    // ── Internal state (f64 precision) ────────────────────────────────
    private _scrollX = 0;         // horizontal scroll in pixels
    private _scrollY = 0;         // vertical scroll in pixels
    private _ppb: number;         // pixels per beat (zoom level)
    private _viewportW = 0;       // canvas width in CSS pixels
    private _viewportH = 0;       // canvas height in CSS pixels

    // ── Config ────────────────────────────────────────────────────────
    private _totalBeats: number;
    private _trackCount: number;
    private _trackHeight: number;
    private _rulerHeight: number;

    // ── Dirty flag — signals TimelineEngine to re-draw ────────────────
    private _dirty = true;

    // ── Optional callback for React cold-path sync ────────────────────
    private _onFlush: ((snapshot: ViewportSnapshot) => void) | null = null;
    private _flushTimer: ReturnType<typeof setTimeout> | null = null;
    private static readonly FLUSH_DEBOUNCE_MS = 150;

    constructor(config: ViewportConfig) {
        this._totalBeats = config.totalBeats;
        this._trackCount = config.trackCount;
        this._trackHeight = config.trackHeight;
        this._rulerHeight = config.rulerHeight;
        this._ppb = config.initialPpb ?? DEFAULT_PPB;
    }

    // ── Getters ───────────────────────────────────────────────────────

    get scrollX(): number { return this._scrollX; }
    get scrollY(): number { return this._scrollY; }
    get pixelsPerBeat(): number { return this._ppb; }
    get viewportWidth(): number { return this._viewportW; }
    get viewportHeight(): number { return this._viewportH; }
    get trackHeight(): number { return this._trackHeight; }
    get rulerHeight(): number { return this._rulerHeight; }
    get trackCount(): number { return this._trackCount; }
    get totalBeats(): number { return this._totalBeats; }
    get isDirty(): boolean { return this._dirty; }

    get snapshot(): ViewportSnapshot {
        return {
            scrollX: this._scrollX,
            scrollY: this._scrollY,
            ppb: this._ppb,
            viewportWidth: this._viewportW,
            viewportHeight: this._viewportH,
        };
    }

    // ── Canvas width of the entire arrangement ────────────────────────

    get canvasContentWidth(): number {
        return this._totalBeats * this._ppb;
    }

    get canvasContentHeight(): number {
        return this._trackCount * this._trackHeight;
    }

    // ── Viewport dimensions ───────────────────────────────────────────

    setViewportSize(width: number, height: number): void {
        if (width === this._viewportW && height === this._viewportH) return;
        this._viewportW = width;
        this._viewportH = height;
        this._clampScroll();
        this._markDirty();
    }

    // ── Config updates ────────────────────────────────────────────────

    updateConfig(config: Partial<ViewportConfig>): void {
        let changed = false;
        if (config.totalBeats !== undefined && config.totalBeats !== this._totalBeats) {
            this._totalBeats = config.totalBeats;
            changed = true;
        }
        if (config.trackCount !== undefined && config.trackCount !== this._trackCount) {
            this._trackCount = config.trackCount;
            changed = true;
        }
        if (config.trackHeight !== undefined && config.trackHeight !== this._trackHeight) {
            this._trackHeight = config.trackHeight;
            changed = true;
        }
        if (config.rulerHeight !== undefined && config.rulerHeight !== this._rulerHeight) {
            this._rulerHeight = config.rulerHeight;
            changed = true;
        }
        if (changed) {
            this._clampScroll();
            this._markDirty();
        }
    }

    // ── Coordinate conversion ─────────────────────────────────────────

    /** Convert screen clientX → beat position (f64 precision). */
    screenToBeats(clientX: number, canvasRect: DOMRect): number {
        const localX = clientX - canvasRect.left;
        return (localX + this._scrollX) / this._ppb;
    }

    /** Convert beat → screen-space X relative to canvas origin. */
    beatsToScreenX(beat: number): number {
        return beat * this._ppb - this._scrollX;
    }

    /** Convert screen clientY → track index (clamped). */
    screenToTrack(clientY: number, canvasRect: DOMRect): number {
        const localY = clientY - canvasRect.top;
        const trackY = localY + this._scrollY - this._rulerHeight;
        return Math.max(0, Math.min(this._trackCount - 1, Math.floor(trackY / this._trackHeight)));
    }

    /** Convert screen clientY → pixel Y in canvas content space. */
    screenToContentY(clientY: number, canvasRect: DOMRect): number {
        return clientY - canvasRect.top + this._scrollY;
    }

    /** Convert beat + track → canvas-space pixel coordinates. */
    beatTrackToPixel(beat: number, track: number): { x: number; y: number } {
        return {
            x: beat * this._ppb - this._scrollX,
            y: this._rulerHeight + track * this._trackHeight - this._scrollY,
        };
    }

    // ── Visible range (for culling) ───────────────────────────────────

    getVisibleRange(): VisibleRange {
        const startBeat = Math.max(0, this._scrollX / this._ppb);
        const endBeat = (this._scrollX + this._viewportW) / this._ppb;
        const startTrack = Math.max(0, Math.floor(this._scrollY / this._trackHeight));
        const endTrack = Math.min(
            this._trackCount - 1,
            Math.floor((this._scrollY + this._viewportH) / this._trackHeight),
        );
        return { startBeat, endBeat, startTrack, endTrack };
    }

    // ── Scroll ────────────────────────────────────────────────────────

    scrollBy(deltaX: number, deltaY: number): void {
        this._scrollX += deltaX * SCROLL_SENSITIVITY;
        this._scrollY += deltaY * SCROLL_SENSITIVITY;
        this._clampScroll();
        this._markDirty();
    }

    scrollTo(x: number, y: number): void {
        this._scrollX = x;
        this._scrollY = y;
        this._clampScroll();
        this._markDirty();
    }

    /** Ensure playhead beat is visible (auto-follow). */
    ensureBeatVisible(beat: number): void {
        const px = beat * this._ppb;
        const margin = this._viewportW * 0.15;
        if (px < this._scrollX + margin) {
            this._scrollX = Math.max(0, px - margin);
            this._markDirty();
        } else if (px > this._scrollX + this._viewportW - margin) {
            this._scrollX = px - this._viewportW + margin;
            this._markDirty();
        }
    }

    // ── Zoom (Ableton-style mouse-anchor) ─────────────────────────────

    /**
     * Zoom in/out anchored at a screen X position.
     * The beat under the focal point stays fixed after zoom.
     */
    zoomAtScreenX(deltaY: number, focalScreenX: number, canvasRect: DOMRect): void {
        const focalLocalX = focalScreenX - canvasRect.left;
        const beatAtFocal = (focalLocalX + this._scrollX) / this._ppb;

        // Compute new ppb
        const factor = Math.exp(-deltaY * ZOOM_SENSITIVITY);
        const newPpb = Math.max(MIN_PPB, Math.min(MAX_PPB, this._ppb * factor));

        if (newPpb === this._ppb) return;
        this._ppb = newPpb;

        // Adjust scroll so the focal beat stays at the same screen position
        this._scrollX = beatAtFocal * this._ppb - focalLocalX;
        this._clampScroll();
        this._markDirty();
    }

    /** Direct zoom setter (for programmatic use). */
    setZoom(ppb: number): void {
        const clamped = Math.max(MIN_PPB, Math.min(MAX_PPB, ppb));
        if (clamped === this._ppb) return;
        this._ppb = clamped;
        this._clampScroll();
        this._markDirty();
    }

    // ── Wheel handler (to be called by TimelineEngine) ────────────────

    handleWheel(e: WheelEvent, canvasRect: DOMRect): void {
        e.preventDefault();

        if (e.ctrlKey || e.metaKey) {
            // Zoom
            this.zoomAtScreenX(e.deltaY, e.clientX, canvasRect);
        } else if (e.shiftKey) {
            // Force horizontal scroll
            this.scrollBy(e.deltaY, 0);
        } else {
            // Standard scroll
            this.scrollBy(e.deltaX, e.deltaY);
        }
    }

    // ── Dirty flag ────────────────────────────────────────────────────

    clearDirty(): void {
        this._dirty = false;
    }

    // ── React cold-path sync ──────────────────────────────────────────

    setFlushCallback(cb: (snapshot: ViewportSnapshot) => void): void {
        this._onFlush = cb;
    }

    // ── Cleanup ───────────────────────────────────────────────────────

    destroy(): void {
        if (this._flushTimer) {
            clearTimeout(this._flushTimer);
            this._flushTimer = null;
        }
        this._onFlush = null;
    }

    // ── Private ───────────────────────────────────────────────────────

    private _clampScroll(): void {
        const maxScrollX = Math.max(0, this.canvasContentWidth - this._viewportW);
        const maxScrollY = Math.max(0, this.canvasContentHeight - (this._viewportH - this._rulerHeight));
        this._scrollX = Math.max(0, Math.min(maxScrollX, this._scrollX));
        this._scrollY = Math.max(0, Math.min(maxScrollY, this._scrollY));
    }

    private _markDirty(): void {
        this._dirty = true;
        this._scheduleFlush();
    }

    private _scheduleFlush(): void {
        if (this._flushTimer) clearTimeout(this._flushTimer);
        this._flushTimer = setTimeout(() => {
            this._flushTimer = null;
            this._onFlush?.(this.snapshot);
        }, ViewportMatrix.FLUSH_DEBOUNCE_MS);
    }
}
