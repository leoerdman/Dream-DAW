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
    /** Optional per-track heights (length == trackCount). */
    trackHeights?: number[];
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
    private _trackHeights: number[] | null = null;
    /** Track boundary offsets in track-space (0..contentHeight). Length = trackCount + 1. */
    private _trackOffsets: number[] = [];
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
        this.setTrackHeights(config.trackHeights ?? null);
    }

    /** Set per-track heights. Pass null to revert to uniform trackHeight. */
    setTrackHeights(heights: number[] | null): void {
        if (heights && heights.length !== this._trackCount) {
            // Soft-fail: ignore invalid arrays to avoid corrupting camera math.
            return;
        }
        this._trackHeights = heights ? heights.map((h) => Math.max(1, Math.round(h))) : null;
        this._rebuildTrackOffsets();
        this._clampScroll();
        this._markDirty();
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
        // Sum of per-track heights if available, else uniform.
        if (this._trackOffsets.length === this._trackCount + 1) {
            return this._trackOffsets[this._trackCount] ?? (this._trackCount * this._trackHeight);
        }
        return this._trackCount * this._trackHeight;
    }

    /** Track top offset in track-space (0..contentHeight). */
    trackOffsetY(trackIndex: number): number {
        if (this._trackOffsets.length === this._trackCount + 1) {
            return this._trackOffsets[Math.max(0, Math.min(this._trackCount, trackIndex))] ?? 0;
        }
        return Math.max(0, Math.min(this._trackCount, trackIndex)) * this._trackHeight;
    }

    /** Track boundary offset (0..trackCount). */
    trackBoundaryOffsetY(boundaryIndex: number): number {
        return this.trackOffsetY(boundaryIndex);
    }

    /** Height for a specific track. */
    trackHeightAt(trackIndex: number): number {
        const idx = Math.max(0, Math.min(this._trackCount - 1, trackIndex));
        return this._trackHeights ? (this._trackHeights[idx] ?? this._trackHeight) : this._trackHeight;
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
        if (config.trackHeights !== undefined) {
            // Defer to setter so offsets rebuild consistently.
            this.setTrackHeights(config.trackHeights ?? null);
            changed = false; // setTrackHeights already clamped + marked dirty
        }
        if (config.rulerHeight !== undefined && config.rulerHeight !== this._rulerHeight) {
            this._rulerHeight = config.rulerHeight;
            changed = true;
        }
        if (changed) {
            this._rebuildTrackOffsets();
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
        return this._trackIndexAtOffsetY(trackY);
    }

    /** Convert screen clientY → pixel Y in canvas content space. */
    screenToContentY(clientY: number, canvasRect: DOMRect): number {
        return clientY - canvasRect.top + this._scrollY;
    }

    /** Convert beat + track → canvas-space pixel coordinates. */
    beatTrackToPixel(beat: number, track: number): { x: number; y: number } {
        return {
            x: beat * this._ppb - this._scrollX,
            y: this._rulerHeight + this.trackOffsetY(track) - this._scrollY,
        };
    }

    // ── Visible range (for culling) ───────────────────────────────────

    getVisibleRange(): VisibleRange {
        const startBeat = Math.max(0, this._scrollX / this._ppb);
        const endBeat = (this._scrollX + this._viewportW) / this._ppb;
        const trackViewportH = Math.max(0, this._viewportH - this._rulerHeight);
        const startTrack = this._trackIndexAtOffsetY(this._scrollY);
        const endTrack = this._trackIndexAtOffsetY(this._scrollY + trackViewportH);
        return { startBeat, endBeat, startTrack, endTrack };
    }

    private _rebuildTrackOffsets(): void {
        const offsets: number[] = new Array(this._trackCount + 1);
        offsets[0] = 0;
        for (let i = 0; i < this._trackCount; i++) {
            const h = this._trackHeights ? (this._trackHeights[i] ?? this._trackHeight) : this._trackHeight;
            offsets[i + 1] = offsets[i] + Math.max(1, Math.round(h));
        }
        this._trackOffsets = offsets;
    }

    private _trackIndexAtOffsetY(offsetY: number): number {
        if (this._trackCount <= 0) return 0;
        const y = Math.max(0, Math.min(this.canvasContentHeight - 0.0001, offsetY));

        // Binary search over boundary offsets.
        const offsets = this._trackOffsets;
        if (offsets.length !== this._trackCount + 1) {
            return Math.max(0, Math.min(this._trackCount - 1, Math.floor(y / this._trackHeight)));
        }

        let lo = 0;
        let hi = this._trackCount;
        while (lo < hi) {
            const mid = (lo + hi) >> 1;
            if ((offsets[mid + 1] ?? 0) <= y) lo = mid + 1;
            else hi = mid;
        }
        return Math.max(0, Math.min(this._trackCount - 1, lo));
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
