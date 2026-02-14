// ═══════════════════════════════════════════════════════════════════════════
// Dream DAW — ViewportMachine (Zero-Render Viewport Engine)
// ═══════════════════════════════════════════════════════════════════════════
//
// A **vanilla TypeScript** class that owns the timeline's scroll & zoom state.
// It writes CSS custom properties directly to the DOM, bypassing React's
// render cycle entirely. React only receives updates via a debounced
// `flushToReact()` call — used for waveform mip-level selection and clip
// culling, which are "cold-path" operations that can tolerate ~150ms delay.
//
// Architecture:
//   wheel event → ViewportMachine.onWheel() → CSS vars → GPU compositing
//   (no React re-render, no layout reflow, sub-millisecond)
//
//   150ms idle → flushToReact() → Zustand set() → waveform re-render
//   (cold path, only when user stops scrolling/zooming)
//
// CSS Variables written to the container element:
//   --vp-scroll-x     Horizontal scroll offset in pixels
//   --vp-scroll-y     Vertical scroll offset in pixels (for track scrolling)
//   --vp-ppb          Pixels per beat (zoom level)
//
// ═══════════════════════════════════════════════════════════════════════════

// ── Constants ────────────────────────────────────────────────────────────

/** Minimum pixels per beat — maximum zoom in. */
const MIN_PPB = 4;

/** Maximum pixels per beat — maximum zoom out to overview. */
const MAX_PPB = 200;

/** Exponential zoom factor per wheel tick. Professional DAWs use 1.06-1.10. */
const ZOOM_FACTOR = 1.08;

/** Debounce delay before flushing state to React (ms). */
const FLUSH_DEBOUNCE_MS = 150;

/** Horizontal scroll speed multiplier for trackpad/mouse wheel. */
const SCROLL_SPEED_X = 1.0;

/** Vertical scroll speed multiplier. */
const SCROLL_SPEED_Y = 1.0;

// ── Types ────────────────────────────────────────────────────────────────

export interface ViewportSnapshot {
    /** Current horizontal scroll offset in pixels within the virtual canvas. */
    scrollX: number;
    /** Current vertical scroll offset in pixels. */
    scrollY: number;
    /** Current pixels per beat (zoom level). */
    pixelsPerBeat: number;
    /** Width of the visible viewport in pixels. */
    viewportWidth: number;
    /** Height of the visible viewport in pixels. */
    viewportHeight: number;
}

export interface ViewportMachineConfig {
    /** Initial pixels per beat. */
    initialPpb?: number;
    /** Initial horizontal scroll. */
    initialScrollX?: number;
    /** Initial vertical scroll. */
    initialScrollY?: number;
    /** Total beats in the project (for max scroll clamp). */
    totalBeats: number;
    /** Total number of tracks. */
    trackCount: number;
    /** Height of each track in pixels. */
    trackHeight: number;
    /** Callback fired on debounced flush — use to sync Zustand. */
    onFlush?: (snapshot: ViewportSnapshot) => void;
    /** Callback fired on every frame-level update (for components that need
     *  instant access to values without reading CSS vars). */
    onFrameUpdate?: (snapshot: ViewportSnapshot) => void;
}

// ── ViewportMachine Class ────────────────────────────────────────────────

export class ViewportMachine {
    // ── State (mutable, NOT reactive) ────────────────────────────
    private _scrollX = 0;
    private _scrollY = 0;
    private _ppb = 20;
    private _viewportWidth = 0;
    private _viewportHeight = 0;
    private _totalBeats: number;
    private _trackCount: number;
    private _trackHeight: number;

    // ── DOM reference ────────────────────────────────────────────
    private _container: HTMLElement | null = null;

    // ── Debounce timer ───────────────────────────────────────────
    private _flushTimer: ReturnType<typeof setTimeout> | null = null;
    private _onFlush: ViewportMachineConfig['onFlush'];
    private _onFrameUpdate: ViewportMachineConfig['onFrameUpdate'];

    // ── Bound handler (so we can remove it) ──────────────────────
    private _boundWheel: (e: WheelEvent) => void;

    constructor(config: ViewportMachineConfig) {
        this._ppb = config.initialPpb ?? 20;
        this._scrollX = config.initialScrollX ?? 0;
        this._scrollY = config.initialScrollY ?? 0;
        this._totalBeats = config.totalBeats;
        this._trackCount = config.trackCount;
        this._trackHeight = config.trackHeight;
        this._onFlush = config.onFlush;
        this._onFrameUpdate = config.onFrameUpdate;
        this._boundWheel = this._handleWheel.bind(this);
    }

    // ── Public API ───────────────────────────────────────────────

    /** Attach to a DOM container. Starts listening for wheel events. */
    attach(container: HTMLElement): void {
        this._container = container;
        this._viewportWidth = container.clientWidth;
        this._viewportHeight = container.clientHeight;
        container.addEventListener('wheel', this._boundWheel, { passive: false });
        this._applyCSS();
    }

    /** Detach from the current container. Cleans up listeners. */
    detach(): void {
        if (this._container) {
            this._container.removeEventListener('wheel', this._boundWheel);
            this._container = null;
        }
        if (this._flushTimer) {
            clearTimeout(this._flushTimer);
            this._flushTimer = null;
        }
    }

    /** Update layout config when project changes (e.g. totalBeats, trackCount). */
    updateConfig(partial: Partial<Pick<ViewportMachineConfig, 'totalBeats' | 'trackCount' | 'trackHeight'>>) {
        if (partial.totalBeats !== undefined) this._totalBeats = partial.totalBeats;
        if (partial.trackCount !== undefined) this._trackCount = partial.trackCount;
        if (partial.trackHeight !== undefined) this._trackHeight = partial.trackHeight;
    }

    /** Update viewport dimensions (call on resize). */
    updateViewportSize(width: number, height: number): void {
        this._viewportWidth = width;
        this._viewportHeight = height;
        // Re-clamp scroll in case viewport grew
        this._clampScroll();
        this._applyCSS();
    }

    /** Get current snapshot (no React, no reactivity — just raw values). */
    get snapshot(): ViewportSnapshot {
        return {
            scrollX: this._scrollX,
            scrollY: this._scrollY,
            pixelsPerBeat: this._ppb,
            viewportWidth: this._viewportWidth,
            viewportHeight: this._viewportHeight,
        };
    }

    // ── Getters for hot-path access ──────────────────────────────

    get scrollX(): number { return this._scrollX; }
    get scrollY(): number { return this._scrollY; }
    get pixelsPerBeat(): number { return this._ppb; }
    get viewportWidth(): number { return this._viewportWidth; }
    get viewportHeight(): number { return this._viewportHeight; }

    // ── Coordinate Conversion (f64 precision — no early rounding) ─

    /**
     * Convert a screen X position (clientX) to beats.
     * Subtracts the container's left edge (accounting for sidebar/inspector).
     * Returns f64 precision — caller rounds only at final pixel output.
     */
    screenToBeats(clientX: number, containerRect?: DOMRect): number {
        const rect = containerRect ?? this._container?.getBoundingClientRect();
        if (!rect) return 0;
        const localX = clientX - rect.left;
        return (this._scrollX + localX) / this._ppb;
    }

    /**
     * Convert beats to screen X position (relative to container left edge).
     * Returns f64 precision.
     */
    beatsToScreen(beat: number): number {
        return beat * this._ppb - this._scrollX;
    }

    /**
     * Convert a screen Y position (clientY) to track index.
     */
    screenToTrack(clientY: number, containerRect?: DOMRect): number {
        const rect = containerRect ?? this._container?.getBoundingClientRect();
        if (!rect) return 0;
        const localY = clientY - rect.top + this._scrollY;
        return Math.max(0, Math.min(this._trackCount - 1, Math.floor(localY / this._trackHeight)));
    }

    /**
     * Programmatic scroll (e.g., follow playhead).
     * Does NOT debounce — caller is responsible for rate-limiting.
     */
    setScrollX(x: number): void {
        this._scrollX = x;
        this._clampScroll();
        this._applyCSS();
        this._onFrameUpdate?.(this.snapshot);
    }

    /**
     * Programmatic scroll Y.
     */
    setScrollY(y: number): void {
        this._scrollY = y;
        this._clampScroll();
        this._applyCSS();
        this._onFrameUpdate?.(this.snapshot);
    }

    /**
     * Programmatic zoom (e.g., from zoom slider or keyboard shortcut).
     * Optionally anchors at a specific screen X.
     */
    setZoom(ppb: number, anchorClientX?: number): void {
        const newPpb = Math.max(MIN_PPB, Math.min(MAX_PPB, ppb));
        if (anchorClientX !== undefined && this._container) {
            this._applyAnchoredZoom(newPpb, anchorClientX);
        } else {
            // Zoom centered on viewport
            const centerBeat = (this._scrollX + this._viewportWidth / 2) / this._ppb;
            this._ppb = newPpb;
            this._scrollX = centerBeat * newPpb - this._viewportWidth / 2;
        }
        this._clampScroll();
        this._applyCSS();
        this._scheduleFlush();
        this._onFrameUpdate?.(this.snapshot);
    }

    // ── Private: Wheel Handler ───────────────────────────────────

    private _handleWheel(e: WheelEvent): void {
        // Always prevent default to kill native scroll
        e.preventDefault();

        if (e.ctrlKey || e.metaKey) {
            // ── ZOOM (Ctrl/Cmd + Wheel) ─────────────────────────
            this._handleZoom(e);
        } else {
            // ── SCROLL ──────────────────────────────────────────
            this._handleScroll(e);
        }
    }

    private _handleZoom(e: WheelEvent): void {
        const direction = e.deltaY > 0 ? -1 : 1; // scroll down = zoom out
        const newPpb = Math.max(
            MIN_PPB,
            Math.min(MAX_PPB, this._ppb * Math.pow(ZOOM_FACTOR, direction)),
        );
        if (Math.abs(newPpb - this._ppb) < 0.001) return;

        // ── Mouse-Anchor Zoom (Ableton-style) ───────────────
        this._applyAnchoredZoom(newPpb, e.clientX);

        this._clampScroll();
        this._applyCSS();
        this._scheduleFlush();
        this._onFrameUpdate?.(this.snapshot);
    }

    /**
     * Core mouse-anchor zoom: the beat under the cursor stays under the cursor.
     * This is how Ableton, Logic, Bitwig, and Figma handle zoom.
     */
    private _applyAnchoredZoom(newPpb: number, clientX: number): void {
        const rect = this._container?.getBoundingClientRect();
        if (!rect) {
            this._ppb = newPpb;
            return;
        }

        // Mouse position relative to container
        const mouseX = clientX - rect.left;

        // Beat under mouse at OLD zoom
        const mouseBeat = (this._scrollX + mouseX) / this._ppb;

        // Apply new zoom
        this._ppb = newPpb;

        // Compute new scrollX so the same beat stays under the mouse
        this._scrollX = mouseBeat * newPpb - mouseX;
    }

    private _handleScroll(e: WheelEvent): void {
        // Trackpads give both deltaX and deltaY. Mice give only deltaY.
        // For horizontal scroll: use deltaX (trackpad swipe) OR Shift+deltaY (mouse).
        const dx = e.shiftKey ? e.deltaY * SCROLL_SPEED_X : e.deltaX * SCROLL_SPEED_X;
        const dy = e.shiftKey ? 0 : e.deltaY * SCROLL_SPEED_Y;

        this._scrollX += dx;
        this._scrollY += dy;

        this._clampScroll();
        this._applyCSS();
        this._scheduleFlush();
        this._onFrameUpdate?.(this.snapshot);
    }

    // ── Private: CSS Variable Application ────────────────────────

    /** Write current state to CSS custom properties — triggers GPU compositing. */
    private _applyCSS(): void {
        const el = this._container;
        if (!el) return;

        el.style.setProperty('--vp-scroll-x', String(this._scrollX));
        el.style.setProperty('--vp-scroll-y', String(this._scrollY));
        el.style.setProperty('--vp-ppb', String(this._ppb));
    }

    // ── Private: Scroll Clamping ─────────────────────────────────

    private _clampScroll(): void {
        const maxScrollX = Math.max(0, this._totalBeats * this._ppb - this._viewportWidth);
        const maxScrollY = Math.max(0, this._trackCount * this._trackHeight - this._viewportHeight);
        this._scrollX = Math.max(0, Math.min(maxScrollX, this._scrollX));
        this._scrollY = Math.max(0, Math.min(maxScrollY, this._scrollY));
    }

    // ── Private: Debounced React Flush ───────────────────────────

    private _scheduleFlush(): void {
        if (this._flushTimer) clearTimeout(this._flushTimer);
        this._flushTimer = setTimeout(() => {
            this._flushTimer = null;
            this._onFlush?.(this.snapshot);
        }, FLUSH_DEBOUNCE_MS);
    }
}
