import {
    DEFAULT_PPB,
    MAX_PPB,
    MIN_PPB,
    SCROLL_SENSITIVITY,
    ZOOM_SENSITIVITY,
    type ViewportConfig,
    type ViewportSnapshot,
    type VisibleRange,
} from './viewportTypes';
import { buildTrackOffsets, trackIndexAtOffsetY } from './viewportTrackMath';
export { DEFAULT_PPB, MAX_PPB, MIN_PPB, type ViewportConfig, type ViewportSnapshot, type VisibleRange } from './viewportTypes';

export class ViewportMatrix {
    private _scrollX = 0;
    private _scrollY = 0;
    private _ppb: number;
    private _viewportW = 0;
    private _viewportH = 0;

    private _totalBeats: number;
    private _trackCount: number;
    private _trackHeight: number;
    private _trackHeights: number[] | null = null;
    private _trackOffsets: number[] = [];
    private _rulerHeight: number;
    private _bottomPaddingPx: number;

    private _dirty = true;
    private _onFlush: ((snapshot: ViewportSnapshot) => void) | null = null;
    private _onScrollYChange: ((scrollY: number) => void) | null = null;
    /** Persists across calls — tracks the last scrollY we notified about. */
    private _lastNotifiedScrollY = 0;
    private _flushTimer: ReturnType<typeof setTimeout> | null = null;
    private static readonly FLUSH_DEBOUNCE_MS = 150;

    constructor(config: ViewportConfig) {
        this._totalBeats = config.totalBeats;
        this._trackCount = config.trackCount;
        this._trackHeight = config.trackHeight;
        this._rulerHeight = config.rulerHeight;
        this._bottomPaddingPx = Math.max(0, Math.round(config.bottomPaddingPx ?? 0));
        this._ppb = config.initialPpb ?? DEFAULT_PPB;
        this.setTrackHeights(config.trackHeights ?? null);
    }

    setTrackHeights(heights: number[] | null): void {
        if (heights && heights.length !== this._trackCount) {
            return;
        }
        this._trackHeights = heights ? heights.map((h) => Math.max(0, Math.round(h))) : null;
        this._rebuildTrackOffsets();
        this._clampScroll();
        this._markDirty();
    }

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

    get canvasContentWidth(): number {
        return this._totalBeats * this._ppb;
    }

    get canvasContentHeight(): number {
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

    setViewportSize(width: number, height: number): void {
        if (width === this._viewportW && height === this._viewportH) return;
        this._viewportW = width;
        this._viewportH = height;
        this._clampScroll();
        this._markDirty();
    }

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
            this.setTrackHeights(config.trackHeights ?? null);
            changed = false; // setTrackHeights already clamped + marked dirty
        }
        if (config.rulerHeight !== undefined && config.rulerHeight !== this._rulerHeight) {
            this._rulerHeight = config.rulerHeight;
            changed = true;
        }
        if (
            config.bottomPaddingPx !== undefined
            && Math.max(0, Math.round(config.bottomPaddingPx)) !== this._bottomPaddingPx
        ) {
            this._bottomPaddingPx = Math.max(0, Math.round(config.bottomPaddingPx));
            changed = true;
        }
        if (changed) {
            this._rebuildTrackOffsets();
            this._clampScroll();
            this._markDirty();
        }
    }

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

    getVisibleRange(): VisibleRange {
        const startBeat = Math.max(0, this._scrollX / this._ppb);
        const endBeat = (this._scrollX + this._viewportW) / this._ppb;
        const trackViewportH = Math.max(0, this._viewportH - this._rulerHeight);
        const startTrack = this._trackIndexAtOffsetY(this._scrollY);
        const endTrack = this._trackIndexAtOffsetY(this._scrollY + trackViewportH);
        return { startBeat, endBeat, startTrack, endTrack };
    }

    private _rebuildTrackOffsets(): void {
        this._trackOffsets = buildTrackOffsets(this._trackCount, this._trackHeight, this._trackHeights);
    }

    private _trackIndexAtOffsetY(offsetY: number): number {
        return trackIndexAtOffsetY(offsetY, this._trackCount, this.canvasContentHeight, this._trackOffsets, this._trackHeight);
    }

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

    /**
     * Zoom in/out anchored at a screen X position.
     * The beat under the focal point stays fixed after zoom.
     */
    zoomAtScreenX(deltaY: number, focalScreenX: number, canvasRect: DOMRect): void {
        const focalLocalX = focalScreenX - canvasRect.left;
        const beatAtFocal = (focalLocalX + this._scrollX) / this._ppb;

        const factor = Math.exp(-deltaY * ZOOM_SENSITIVITY);
        const newPpb = Math.max(MIN_PPB, Math.min(MAX_PPB, this._ppb * factor));

        if (newPpb === this._ppb) return;
        this._ppb = newPpb;

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

    handleWheel(e: WheelEvent, canvasRect: DOMRect): void {
        e.preventDefault();

        if (e.ctrlKey || e.metaKey) {
            this.zoomAtScreenX(e.deltaY, e.clientX, canvasRect);
        } else if (e.shiftKey) {
            this.scrollBy(e.deltaY, 0);
        } else {
            this.scrollBy(e.deltaX, e.deltaY);
        }
    }

    clearDirty(): void {
        this._dirty = false;
    }

    setFlushCallback(cb: (snapshot: ViewportSnapshot) => void): void {
        this._onFlush = cb;
    }

    /**
     * Enterprise scroll sync: fires synchronously whenever scrollY changes.
     * This is the SSOT notification path — ensures ALL scroll-Y mutations
     * (wheel, zoom clamp, scrollTo, resize, track height change) are
     * propagated to TrackInspector and any other synced panel.
     */
    setScrollYChangeCallback(cb: (scrollY: number) => void): void {
        this._onScrollYChange = cb;
    }

    destroy(): void {
        if (this._flushTimer) {
            clearTimeout(this._flushTimer);
            this._flushTimer = null;
        }
        this._onFlush = null;
    }

    private _clampScroll(): void {
        const maxScrollX = Math.max(0, this.canvasContentWidth - this._viewportW);
        const scrollableContentHeight = this.canvasContentHeight + this._bottomPaddingPx;
        const maxScrollY = Math.max(0, scrollableContentHeight - (this._viewportH - this._rulerHeight));
        this._scrollX = Math.max(0, Math.min(maxScrollX, this._scrollX));
        this._scrollY = Math.max(0, Math.min(maxScrollY, this._scrollY));
        // SSOT: Fire synchronous scroll-Y notification when scrollY changed
        // since the last notification. Uses persistent _lastNotifiedScrollY
        // (NOT a local variable) so that scrollBy()'s delta is detected.
        if (Math.abs(this._scrollY - this._lastNotifiedScrollY) > 0.25) {
            this._lastNotifiedScrollY = this._scrollY;
            this._onScrollYChange?.(this._scrollY);
        }
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
