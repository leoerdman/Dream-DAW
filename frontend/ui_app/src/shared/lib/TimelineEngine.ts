// ═══════════════════════════════════════════════════════════════════════════
// Dream DAW — TimelineEngine
// ═══════════════════════════════════════════════════════════════════════════
//
// THE CORE ENGINE. Pure TypeScript — ZERO React dependencies.
//
// This class owns the canvas element, viewport, and render loop.
// It replaces ALL DOM-based timeline rendering with a single <canvas>.
//
// Architecture (Figma pattern):
//   1. React creates a <canvas> and passes the ref to this engine
//   2. Engine attaches wheel/mouse/keyboard listeners directly to canvas
//   3. requestAnimationFrame render loop draws everything
//   4. React feeds data (clips, playhead, etc.) via setter methods
//   5. Engine fires callbacks (onClipClick, onClipMove, etc.) to React
//
// Hot-path operations (scroll, zoom, drag, playhead) NEVER touch React.
// Cold-path operations (clip selection, data updates) happen via callbacks.
//
// ═══════════════════════════════════════════════════════════════════════════

import { ViewportMatrix, type ViewportConfig, type ViewportSnapshot } from './ViewportMatrix';
import { CanvasClipRenderer, type TimelineClipData, type LoopRegion, type GhostClipData } from './CanvasClipRenderer';
import { WaveformCache } from './WaveformCache';

// ── Types ─────────────────────────────────────────────────────────────────

export interface TimelineEngineConfig {
    /** Beats per bar (time signature numerator). */
    beatsPerBar: number;
    /** BPM for samples↔beats conversion. */
    bpm: number;
    /** Sample rate (Hz). */
    sampleRate: number;
    /** Viewport config (total beats, track count, track height, ruler height). */
    viewport: ViewportConfig;
    /** Grid snap resolution in beats (e.g. 1 = snap to beats, 0.25 = snap to 16ths). */
    snapBeats?: number;
    /** Whether magnetic snap is enabled. */
    snapEnabled?: boolean;
}

export interface HitTestResult {
    type: 'clip' | 'ruler' | 'track' | 'empty';
    clipId?: string;
    beat: number;
    trackIndex: number;
    /** Clip hit region: header (select/drag) or body (cursor placement). */
    region?: 'header' | 'body';
    /** If the cursor is near a clip edge, indicates which edge. */
    edge?: 'left' | 'right';
    /** If the cursor is near a loop marker handle on the ruler. */
    loopHandle?: 'start' | 'end';
}

interface MarqueeSelection {
    startBeat: number;
    endBeat: number;
    startTrack: number;
    endTrack: number;
}

/** Edge detection threshold in screen pixels. */
const EDGE_GRIP_PX = 6;
/** Must match clip header visual height from CanvasClipRenderer. */
const CLIP_HEADER_HEIGHT_PX = 22;
/** Minimum loop region length in beats (1 bar in 4/4 time). */
const MIN_LOOP_BEATS = 4;

/** Drag state machine. */
type DragMode = 0 | 1 | 2 | 3 | 4 | 5 | 6 | 7;
const DragMode = {
    None: 0 as const,
    ClipMove: 1 as const,
    RulerScrub: 2 as const,
    MarqueeSelect: 3 as const,
    ClipResizeLeft: 4 as const,
    ClipResizeRight: 5 as const,
    LoopStartMove: 6 as const,
    LoopEndMove: 7 as const,
};

interface DragState {
    mode: DragMode;
    /** ID of the clip being dragged. */
    clipId: string | null;
    /** Beat position at drag start. */
    startBeat: number;
    /** Track index at drag start. */
    startTrack: number;
    /** Current beat under cursor. */
    currentBeat: number;
    /** Current track under cursor. */
    currentTrack: number;
    /** Original clip startBeat (for computing delta). */
    clipOriginalBeat: number;
    /** Original clip trackIndex (for computing delta). */
    clipOriginalTrack: number;
    /** Original clip durationBeats (for resize operations). */
    clipOriginalDuration: number;
}

// ── Engine Class ──────────────────────────────────────────────────────────

export class TimelineEngine {
    // ── Sub-systems ───────────────────────────────────────────────────
    private readonly _viewport: ViewportMatrix;
    private readonly _renderer: CanvasClipRenderer;
    private readonly _waveformCache: WaveformCache;

    // ── Canvas ────────────────────────────────────────────────────────
    private _canvas: HTMLCanvasElement | null = null;
    private _ctx: CanvasRenderingContext2D | null = null;
    private _rafId: number = 0;
    private _resizeObserver: ResizeObserver | null = null;

    // ── Data (fed by React) ───────────────────────────────────────────
    private _clips: TimelineClipData[] = [];
    private _playheadBeat = 0;
    private _editCursorBeat = 0;
    private _editCursorTrack = 0;
    private _loop: LoopRegion | null = null;
    private _ghost: GhostClipData | null = null;
    private _dropTarget: { track: number; beat: number } | null = null;
    private _marquee: MarqueeSelection | null = null;

    // ── Config ────────────────────────────────────────────────────────
    private _beatsPerBar: number;
    private _bpm: number;
    private _sampleRate: number;
    private _snapBeats: number;
    private _snapEnabled: boolean;

    // ── Drag state ────────────────────────────────────────────────────
    private _drag: DragState = {
        mode: DragMode.None,
        clipId: null,
        startBeat: 0,
        startTrack: 0,
        currentBeat: 0,
        currentTrack: 0,
        clipOriginalBeat: 0,
        clipOriginalTrack: 0,
        clipOriginalDuration: 0,
    };

    /** Whether metaKey (⌘) is currently held — bypasses snap. */
    private _metaKeyHeld = false;

    // ── Bound event handlers (for cleanup) ────────────────────────────
    private _boundWheel: (e: WheelEvent) => void;
    private _boundMouseDown: (e: MouseEvent) => void;
    private _boundMouseMove: (e: MouseEvent) => void;
    private _boundMouseUp: (e: MouseEvent) => void;
    private _boundDblClick: (e: MouseEvent) => void;
    private _boundContextMenu: (e: MouseEvent) => void;

    // ── Callbacks (to React shell) ────────────────────────────────────
    onClipClick?: (clipId: string, addToSelection: boolean) => void;
    onClipMove?: (clipId: string, newBeat: number, newTrack: number) => void;
    onClipResize?: (clipId: string, newStartBeat: number, newDuration: number) => void;
    onPlayheadSeek?: (beat: number) => void;
    onEditCursorChange?: (beat: number, trackIndex: number) => void;
    onDoubleClickTrack?: (trackIndex: number, beat: number) => void;
    onDoubleClickClip?: (clipId: string, trackIndex: number) => void;
    onTrackSelect?: (trackIndex: number) => void;
    onViewportFlush?: (snapshot: ViewportSnapshot) => void;
    onScrollTop?: (scrollTop: number) => void;
    onLoopChange?: (loop: LoopRegion) => void;
    onClipBoxSelection?: (clipIds: string[]) => void;

    // ═══════════════════════════════════════════════════════════════════
    // CONSTRUCTOR
    // ═══════════════════════════════════════════════════════════════════

    constructor(config: TimelineEngineConfig) {
        this._beatsPerBar = config.beatsPerBar;
        this._bpm = config.bpm;
        this._sampleRate = config.sampleRate;
        this._snapBeats = config.snapBeats ?? 1;
        this._snapEnabled = config.snapEnabled ?? true;

        this._waveformCache = new WaveformCache();
        this._renderer = new CanvasClipRenderer(this._waveformCache);
        this._viewport = new ViewportMatrix(config.viewport);

        // Wire viewport flush to React callback
        this._viewport.setFlushCallback((snap) => {
            this.onViewportFlush?.(snap);
        });

        // Pre-bind event handlers
        this._boundWheel = this._onWheel.bind(this);
        this._boundMouseDown = this._onMouseDown.bind(this);
        this._boundMouseMove = this._onMouseMove.bind(this);
        this._boundMouseUp = this._onMouseUp.bind(this);
        this._boundDblClick = this._onDoubleClick.bind(this);
        this._boundContextMenu = (e: MouseEvent) => e.preventDefault();
    }

    // ═══════════════════════════════════════════════════════════════════
    // LIFECYCLE
    // ═══════════════════════════════════════════════════════════════════

    /**
     * Attach the engine to a canvas element.
     * This starts the render loop and event listeners.
     */
    attach(canvas: HTMLCanvasElement): void {
        if (this._canvas) this.detach();

        this._canvas = canvas;
        this._ctx = canvas.getContext('2d', { alpha: false })!;

        // Set initial size
        this._syncCanvasSize();

        // Observe resize
        this._resizeObserver = new ResizeObserver(() => {
            this._syncCanvasSize();
        });
        this._resizeObserver.observe(canvas);

        // Attach event listeners
        canvas.addEventListener('wheel', this._boundWheel, { passive: false });
        canvas.addEventListener('mousedown', this._boundMouseDown);
        canvas.addEventListener('dblclick', this._boundDblClick);
        canvas.addEventListener('contextmenu', this._boundContextMenu);

        // Global listeners for drag (must work even when cursor leaves canvas)
        window.addEventListener('mousemove', this._boundMouseMove);
        window.addEventListener('mouseup', this._boundMouseUp);

        // Start render loop
        this._tick();
    }

    /** Detach from canvas, stop render loop, remove listeners. */
    detach(): void {
        if (this._rafId) {
            cancelAnimationFrame(this._rafId);
            this._rafId = 0;
        }

        this._resizeObserver?.disconnect();
        this._resizeObserver = null;

        const canvas = this._canvas;
        if (canvas) {
            canvas.removeEventListener('wheel', this._boundWheel);
            canvas.removeEventListener('mousedown', this._boundMouseDown);
            canvas.removeEventListener('dblclick', this._boundDblClick);
            canvas.removeEventListener('contextmenu', this._boundContextMenu);
        }

        window.removeEventListener('mousemove', this._boundMouseMove);
        window.removeEventListener('mouseup', this._boundMouseUp);

        this._canvas = null;
        this._ctx = null;
    }

    /** Full cleanup — detach + destroy sub-systems. */
    destroy(): void {
        this.detach();
        this._viewport.destroy();
        this._waveformCache.clear();
    }

    // ═══════════════════════════════════════════════════════════════════
    // DATA SETTERS (called by React shell)
    // ═══════════════════════════════════════════════════════════════════

    setClips(clips: TimelineClipData[]): void {
        this._clips = clips;
        this._viewport.clearDirty(); // Force redraw
        this._prefetchVisibleWaveforms();
        this._requestRedraw();
    }

    setPlayheadBeat(beat: number): void {
        if (beat === this._playheadBeat) return;
        this._playheadBeat = beat;
        this._requestRedraw();
    }

    setEditCursor(beat: number, track: number): void {
        this._editCursorBeat = beat;
        this._editCursorTrack = track;
        this._requestRedraw();
    }

    setLoop(loop: LoopRegion | null): void {
        // While dragging, ignore external updates to prevent "fighting" with React round-trips.
        // This is the core fix for the "markers jumping/flying away" bug.
        if (this._drag.mode === DragMode.LoopStartMove || this._drag.mode === DragMode.LoopEndMove) {
            return;
        }

        if (!loop) {
            if (this._loop !== null) {
                this._loop = null;
                this._requestRedraw();
            }
        } else {
            // Only update if actually different (sub-sample precision check)
            const changed = !this._loop ||
                Math.abs(this._loop.start - loop.start) > 0.000001 ||
                Math.abs(this._loop.end - loop.end) > 0.000001 ||
                this._loop.enabled !== loop.enabled;

            if (changed) {
                this._loop = { ...loop };
                this._requestRedraw();
            }
        }
    }

    setGhostClip(ghost: GhostClipData | null): void {
        this._ghost = ghost;
        this._requestRedraw();
    }

    setDropTarget(target: { track: number; beat: number } | null): void {
        this._dropTarget = target;
        this._requestRedraw();
    }

    setConfig(config: Partial<TimelineEngineConfig>): void {
        if (config.beatsPerBar !== undefined) this._beatsPerBar = config.beatsPerBar;
        if (config.bpm !== undefined) this._bpm = config.bpm;
        if (config.sampleRate !== undefined) this._sampleRate = config.sampleRate;
        if (config.snapBeats !== undefined) this._snapBeats = config.snapBeats;
        if (config.snapEnabled !== undefined) this._snapEnabled = config.snapEnabled;
        if (config.viewport) {
            this._viewport.updateConfig(config.viewport);
        }
        this._requestRedraw();
    }

    /** Ensure a beat is visible (playhead follow). */
    ensureBeatVisible(beat: number): void {
        this._viewport.ensureBeatVisible(beat);
    }

    // ═══════════════════════════════════════════════════════════════════
    // VIEWPORT ACCESS (for React cold-path)
    // ═══════════════════════════════════════════════════════════════════

    get viewport(): ViewportMatrix {
        return this._viewport;
    }

    // ═══════════════════════════════════════════════════════════════════
    // RENDER LOOP (requestAnimationFrame)
    // ═══════════════════════════════════════════════════════════════════

    private _needsRedraw = true;

    private _requestRedraw(): void {
        this._needsRedraw = true;
    }

    private _tick = (): void => {
        this._rafId = requestAnimationFrame(this._tick);

        // Only draw when something changed
        if (!this._needsRedraw && !this._viewport.isDirty) return;
        this._needsRedraw = false;
        this._viewport.clearDirty();

        const ctx = this._ctx;
        if (!ctx) return;

        this._renderer.drawFrame(
            ctx,
            this._viewport,
            this._clips,
            this._playheadBeat,
            this._editCursorBeat,
            this._editCursorTrack,
            this._loop,
            this._beatsPerBar,
            this._snapBeats,
            this._marquee,
            this._ghost,
            this._dropTarget,
            this._sampleRate,
            this._bpm,
        );
    };

    // ═══════════════════════════════════════════════════════════════════
    // CANVAS SIZE MANAGEMENT
    // ═══════════════════════════════════════════════════════════════════

    private _syncCanvasSize(): void {
        const canvas = this._canvas;
        if (!canvas) return;

        const rect = canvas.getBoundingClientRect();
        const dpr = window.devicePixelRatio || 1;

        // Set backing store size (sharp rendering on HiDPI)
        const backingW = Math.round(rect.width * dpr);
        const backingH = Math.round(rect.height * dpr);

        if (canvas.width !== backingW || canvas.height !== backingH) {
            canvas.width = backingW;
            canvas.height = backingH;
        }

        this._viewport.setViewportSize(rect.width, rect.height);
        this._requestRedraw();
    }

    // ═══════════════════════════════════════════════════════════════════
    // WHEEL HANDLER (Zoom + Scroll — zero React)
    // ═══════════════════════════════════════════════════════════════════

    private _onWheel(e: WheelEvent): void {
        e.preventDefault();
        const canvas = this._canvas;
        if (!canvas) return;

        const rect = canvas.getBoundingClientRect();

        if (e.ctrlKey || e.metaKey) {
            // Zoom — anchored at mouse position
            this._viewport.zoomAtScreenX(e.deltaY, e.clientX, rect);
        } else if (e.shiftKey) {
            // Force horizontal scroll
            this._viewport.scrollBy(e.deltaY, 0);
        } else {
            // Standard scroll
            this._viewport.scrollBy(e.deltaX, e.deltaY);
            this.onScrollTop?.(this._viewport.scrollY);
        }

        this._prefetchVisibleWaveforms();
    }

    // ═══════════════════════════════════════════════════════════════════
    // HIT TESTING (Mathematical raycasting — zero DOM)
    // ═══════════════════════════════════════════════════════════════════

    hitTest(clientX: number, clientY: number): HitTestResult {
        const canvas = this._canvas;
        if (!canvas) return { type: 'empty', beat: 0, trackIndex: 0 };

        const rect = canvas.getBoundingClientRect();
        const localY = clientY - rect.top;

        // Check if in ruler area
        if (localY < this._viewport.rulerHeight) {
            const beat = this._viewport.screenToBeats(clientX, rect);

            // Loop handle hit testing
            if (this._loop) {
                const startPx = this._viewport.beatsToScreenX(this._loop.start);
                const endPx = this._viewport.beatsToScreenX(this._loop.end);
                const localX = clientX - rect.left;

                // Start handle
                if (Math.abs(localX - startPx) <= EDGE_GRIP_PX + 4) {
                    return { type: 'ruler', beat, trackIndex: -1, loopHandle: 'start' };
                }
                // End handle
                if (Math.abs(localX - endPx) <= EDGE_GRIP_PX + 4) {
                    return { type: 'ruler', beat, trackIndex: -1, loopHandle: 'end' };
                }
            }

            return { type: 'ruler', beat, trackIndex: -1 };
        }

        const beat = this._viewport.screenToBeats(clientX, rect);
        const trackIndex = this._viewport.screenToTrack(clientY, rect);

        // Check clips (reverse order — topmost first, since selected are sorted last)
        for (let i = this._clips.length - 1; i >= 0; i--) {
            const clip = this._clips[i];
            if (clip.trackIndex !== trackIndex) continue;
            if (beat >= clip.startBeat && beat <= clip.startBeat + clip.durationBeats) {
                // Edge detection: check if cursor is within EDGE_GRIP_PX of left/right edge
                const clipLeftPx = this._viewport.beatsToScreenX(clip.startBeat);
                const clipRightPx = this._viewport.beatsToScreenX(clip.startBeat + clip.durationBeats);
                const localX = clientX - rect.left;
                const clipTopPx =
                    this._viewport.rulerHeight + clip.trackIndex * this._viewport.trackHeight - this._viewport.scrollY;
                const localYInClip = Math.max(0, clientY - rect.top - clipTopPx);
                const region: 'header' | 'body' =
                    localYInClip <= Math.min(CLIP_HEADER_HEIGHT_PX, this._viewport.trackHeight - 2)
                        ? 'header'
                        : 'body';

                let edge: 'left' | 'right' | undefined;
                if (Math.abs(localX - clipLeftPx) <= EDGE_GRIP_PX) {
                    edge = 'left';
                } else if (Math.abs(localX - clipRightPx) <= EDGE_GRIP_PX) {
                    edge = 'right';
                }
                return { type: 'clip', clipId: clip.id, beat, trackIndex, region, edge };
            }
        }

        return { type: 'track', beat, trackIndex };
    }

    // ═══════════════════════════════════════════════════════════════════
    // MOUSE HANDLERS
    // ═══════════════════════════════════════════════════════════════════

    private _onMouseDown(e: MouseEvent): void {
        if (e.button !== 0) return; // Left click only
        if (!this._canvas) return;

        this._metaKeyHeld = e.metaKey;
        const hit = this.hitTest(e.clientX, e.clientY);

        switch (hit.type) {
            case 'ruler': {
                if (hit.loopHandle === 'start') {
                    this._drag = {
                        mode: DragMode.LoopStartMove,
                        clipId: null,
                        startBeat: hit.beat,
                        startTrack: 0,
                        currentBeat: hit.beat,
                        currentTrack: 0,
                        clipOriginalBeat: this._loop?.start || 0,
                        clipOriginalTrack: 0,
                        clipOriginalDuration: 0,
                    };
                } else if (hit.loopHandle === 'end') {
                    this._drag = {
                        mode: DragMode.LoopEndMove,
                        clipId: null,
                        startBeat: hit.beat,
                        startTrack: 0,
                        currentBeat: hit.beat,
                        currentTrack: 0,
                        clipOriginalBeat: this._loop?.end || 0,
                        clipOriginalTrack: 0,
                        clipOriginalDuration: 0,
                    };
                } else {
                    // Ruler click = set edit cursor (deferred seek on play).
                    const snapped = this._snapBeat(hit.beat);
                    this._drag = {
                        mode: DragMode.RulerScrub,
                        clipId: null,
                        startBeat: snapped,
                        startTrack: 0,
                        currentBeat: snapped,
                        currentTrack: 0,
                        clipOriginalBeat: 0,
                        clipOriginalTrack: 0,
                        clipOriginalDuration: 0,
                    };
                    this.onEditCursorChange?.(snapped, this._editCursorTrack);
                }
                break;
            }

            case 'clip': {
                if (!hit.clipId) break;

                const clip = this._clips.find(c => c.id === hit.clipId);
                if (!clip) break;

                // Body click behavior: place edit cursor only, do not alter clip selection.
                if (hit.region === 'body' && !hit.edge) {
                    const snappedBeat = this._snapBeat(hit.beat);
                    this.onEditCursorChange?.(snappedBeat, hit.trackIndex);
                    this.onTrackSelect?.(hit.trackIndex);
                    break;
                }

                // Determine drag mode based on edge detection
                if (hit.edge === 'left') {
                    // Start left-edge resize
                    this.onTrackSelect?.(hit.trackIndex);
                    this._drag = {
                        mode: DragMode.ClipResizeLeft,
                        clipId: hit.clipId,
                        startBeat: hit.beat,
                        startTrack: hit.trackIndex,
                        currentBeat: hit.beat,
                        currentTrack: hit.trackIndex,
                        clipOriginalBeat: clip.startBeat,
                        clipOriginalTrack: clip.trackIndex,
                        clipOriginalDuration: clip.durationBeats,
                    };
                } else if (hit.edge === 'right') {
                    // Start right-edge resize
                    this.onTrackSelect?.(hit.trackIndex);
                    this._drag = {
                        mode: DragMode.ClipResizeRight,
                        clipId: hit.clipId,
                        startBeat: hit.beat,
                        startTrack: hit.trackIndex,
                        currentBeat: hit.beat,
                        currentTrack: hit.trackIndex,
                        clipOriginalBeat: clip.startBeat,
                        clipOriginalTrack: clip.trackIndex,
                        clipOriginalDuration: clip.durationBeats,
                    };
                } else {
                    // Standard clip move
                    this.onClipClick?.(hit.clipId, e.shiftKey || e.metaKey);
                    this.onTrackSelect?.(hit.trackIndex);

                    this._drag = {
                        mode: DragMode.ClipMove,
                        clipId: hit.clipId,
                        startBeat: hit.beat,
                        startTrack: hit.trackIndex,
                        currentBeat: hit.beat,
                        currentTrack: hit.trackIndex,
                        clipOriginalBeat: clip.startBeat,
                        clipOriginalTrack: clip.trackIndex,
                        clipOriginalDuration: clip.durationBeats,
                    };
                }
                break;
            }

            case 'track': {
                // Empty area -> potential marquee box selection (grid-snapped).
                const snappedBeat = this._snapBeat(hit.beat);
                this._drag = {
                    mode: DragMode.MarqueeSelect,
                    clipId: null,
                    startBeat: snappedBeat,
                    startTrack: hit.trackIndex,
                    currentBeat: snappedBeat,
                    currentTrack: hit.trackIndex,
                    clipOriginalBeat: 0,
                    clipOriginalTrack: 0,
                    clipOriginalDuration: 0,
                };
                this._marquee = {
                    startBeat: snappedBeat,
                    endBeat: snappedBeat,
                    startTrack: hit.trackIndex,
                    endTrack: hit.trackIndex,
                };
                this._requestRedraw();
                break;
            }
        }
    }

    private _onMouseMove(e: MouseEvent): void {
        this._metaKeyHeld = e.metaKey;
        const canvas = this._canvas;
        if (!canvas) return;

        // ── Cursor management (when NOT dragging) ──
        if (this._drag.mode === DragMode.None) {
            const hit = this.hitTest(e.clientX, e.clientY);
            if (hit.type === 'clip' && hit.edge) {
                canvas.style.cursor = 'col-resize';
            } else if (hit.type === 'clip' && hit.region === 'header') {
                canvas.style.cursor = 'grab';
            } else if (hit.type === 'clip' && hit.region === 'body') {
                canvas.style.cursor = 'crosshair';
            } else if (hit.type === 'ruler' && hit.loopHandle) {
                canvas.style.cursor = 'col-resize';
            } else {
                canvas.style.cursor = 'crosshair';
            }
            return;
        }

        const rect = canvas.getBoundingClientRect();
        const beat = this._viewport.screenToBeats(e.clientX, rect);
        const track = this._viewport.screenToTrack(e.clientY, rect);

        this._drag.currentBeat = beat;
        this._drag.currentTrack = track;

        switch (this._drag.mode) {
            case DragMode.RulerScrub: {
                // Ruler drag = continuous edit-cursor repositioning (no live scrub).
                const snapped = this._snapBeat(Math.max(0, beat));
                this.onEditCursorChange?.(snapped, this._editCursorTrack);
                break;
            }

            case DragMode.ClipMove: {
                canvas.style.cursor = 'grabbing';
                // Compute delta from drag start and apply to original position
                const deltaBeat = beat - this._drag.startBeat;
                const deltaTrack = track - this._drag.startTrack;
                const newBeat = this._snapBeat(
                    Math.max(0, this._drag.clipOriginalBeat + deltaBeat),
                );
                const newTrack = Math.max(
                    0,
                    Math.min(this._viewport.trackCount - 1, this._drag.clipOriginalTrack + deltaTrack),
                );

                // Update clip position in local array for visual feedback
                const clip = this._clips.find(c => c.id === this._drag.clipId);
                if (clip) {
                    clip.startBeat = newBeat;
                    clip.trackIndex = newTrack;
                    this._requestRedraw();
                }
                break;
            }

            case DragMode.ClipResizeLeft: {
                canvas.style.cursor = 'col-resize';
                const clip = this._clips.find(c => c.id === this._drag.clipId);
                if (!clip) break;

                const deltaBeat = beat - this._drag.startBeat;
                const rawNewStart = this._drag.clipOriginalBeat + deltaBeat;
                const newStart = this._snapBeat(Math.max(0, rawNewStart));
                // Duration adjusts inversely — clip end stays fixed
                const clipEnd = this._drag.clipOriginalBeat + this._drag.clipOriginalDuration;
                const newDuration = Math.max(0.25, clipEnd - newStart);

                clip.startBeat = newStart;
                clip.durationBeats = newDuration;
                this._requestRedraw();
                break;
            }

            case DragMode.ClipResizeRight: {
                canvas.style.cursor = 'col-resize';
                const clip = this._clips.find(c => c.id === this._drag.clipId);
                if (!clip) break;

                const rawNewEnd = beat;
                const snappedEnd = this._snapBeat(Math.max(this._drag.clipOriginalBeat + 0.25, rawNewEnd));
                const newDuration = Math.max(0.25, snappedEnd - this._drag.clipOriginalBeat);

                clip.durationBeats = newDuration;
                this._requestRedraw();
                break;
            }

            case DragMode.LoopStartMove: {
                canvas.style.cursor = 'col-resize';
                const clampedBeat = Math.max(0, Math.min(1000000, beat));
                const snapped = this._snapBeat(clampedBeat);
                if (this._loop) {
                    // Right marker minus minimum loop length
                    const newStart = Math.max(0, Math.min(snapped, this._loop.end - MIN_LOOP_BEATS));
                    if (newStart !== this._loop.start) {
                        this._loop = { ...this._loop, start: newStart };
                        this.onLoopChange?.(this._loop);
                    }
                }
                break;
            }

            case DragMode.LoopEndMove: {
                canvas.style.cursor = 'col-resize';
                const clampedBeat = Math.max(0, Math.min(1000000, beat));
                const snapped = this._snapBeat(clampedBeat);
                if (this._loop) {
                    // Left marker plus minimum loop length
                    const newEnd = Math.max(this._loop.start + MIN_LOOP_BEATS, snapped);
                    if (newEnd !== this._loop.end) {
                        this._loop = { ...this._loop, end: newEnd };
                        this.onLoopChange?.(this._loop);
                    }
                }
                break;
            }

            case DragMode.MarqueeSelect: {
                canvas.style.cursor = 'crosshair';
                const snappedBeat = this._snapBeat(Math.max(0, beat));
                const clampedTrack = Math.max(0, Math.min(this._viewport.trackCount - 1, track));
                this._drag.currentBeat = snappedBeat;
                this._drag.currentTrack = clampedTrack;
                this._marquee = {
                    startBeat: this._drag.startBeat,
                    endBeat: snappedBeat,
                    startTrack: this._drag.startTrack,
                    endTrack: clampedTrack,
                };
                this._requestRedraw();
                break;
            }
        }
    }

    private _onMouseUp(e: MouseEvent): void {
        if (this._drag.mode === DragMode.None) return;

        const canvas = this._canvas;
        if (canvas) canvas.style.cursor = 'default';

        switch (this._drag.mode) {
            case DragMode.ClipMove: {
                if (this._drag.clipId) {
                    if (!canvas) break;

                    const rect = canvas.getBoundingClientRect();
                    const beat = this._viewport.screenToBeats(e.clientX, rect);
                    const track = this._viewport.screenToTrack(e.clientY, rect);

                    const deltaBeat = beat - this._drag.startBeat;
                    const deltaTrack = track - this._drag.startTrack;
                    const finalBeat = this._snapBeat(
                        Math.max(0, this._drag.clipOriginalBeat + deltaBeat),
                    );
                    const finalTrack = Math.max(
                        0,
                        Math.min(this._viewport.trackCount - 1, this._drag.clipOriginalTrack + deltaTrack),
                    );

                    // Only fire callback if position actually changed
                    if (
                        finalBeat !== this._drag.clipOriginalBeat ||
                        finalTrack !== this._drag.clipOriginalTrack
                    ) {
                        this.onClipMove?.(this._drag.clipId, finalBeat, finalTrack);
                    }
                }
                break;
            }

            case DragMode.ClipResizeLeft:
            case DragMode.ClipResizeRight: {
                if (this._drag.clipId) {
                    const clip = this._clips.find(c => c.id === this._drag.clipId);
                    if (clip) {
                        // Only fire if something actually changed
                        if (
                            clip.startBeat !== this._drag.clipOriginalBeat ||
                            clip.durationBeats !== this._drag.clipOriginalDuration
                        ) {
                            this.onClipResize?.(this._drag.clipId, clip.startBeat, clip.durationBeats);
                        }
                    }
                }
                break;
            }

            case DragMode.MarqueeSelect: {
                const minBeat = Math.min(this._drag.startBeat, this._drag.currentBeat);
                const maxBeat = Math.max(this._drag.startBeat, this._drag.currentBeat);
                const minTrack = Math.min(this._drag.startTrack, this._drag.currentTrack);
                const maxTrack = Math.max(this._drag.startTrack, this._drag.currentTrack);
                const moved =
                    Math.abs(maxBeat - minBeat) >= 1e-6 || minTrack !== maxTrack;

                if (!moved) {
                    // Plain click on empty area: set cursor/track only.
                    const snappedBeat = this._snapBeat(this._drag.startBeat);
                    this.onEditCursorChange?.(snappedBeat, this._drag.startTrack);
                    this.onTrackSelect?.(this._drag.startTrack);
                    // Empty-space click clears current clip selection.
                    this.onClipBoxSelection?.([]);
                } else {
                    const selectedIds = this._clips
                        .filter((clip) => {
                            if (clip.trackIndex < minTrack || clip.trackIndex > maxTrack) return false;
                            const clipStart = clip.startBeat;
                            const clipEnd = clip.startBeat + clip.durationBeats;
                            return clipEnd >= minBeat && clipStart <= maxBeat;
                        })
                        .map((clip) => clip.id);
                    this.onClipBoxSelection?.(selectedIds);
                }
                this._marquee = null;
                this._requestRedraw();
                break;
            }
        }

        this._marquee = null;
        this._drag = {
            mode: DragMode.None,
            clipId: null,
            startBeat: 0,
            startTrack: 0,
            currentBeat: 0,
            currentTrack: 0,
            clipOriginalBeat: 0,
            clipOriginalTrack: 0,
            clipOriginalDuration: 0,
        };
    }

    private _onDoubleClick(e: MouseEvent): void {
        const hit = this.hitTest(e.clientX, e.clientY);

        switch (hit.type) {
            case 'clip':
                if (hit.clipId) {
                    this.onDoubleClickClip?.(hit.clipId, hit.trackIndex);
                }
                break;
            case 'track': {
                const snapped = this._snapBeat(hit.beat);
                this.onDoubleClickTrack?.(hit.trackIndex, snapped);
                break;
            }
        }
    }

    // ═══════════════════════════════════════════════════════════════════
    // WAVEFORM PREFETCH
    // ═══════════════════════════════════════════════════════════════════

    private _prefetchVisibleWaveforms(): void {
        const range = this._viewport.getVisibleRange();
        const bufferBeats = 10;
        const paths: string[] = [];

        for (const clip of this._clips) {
            if (
                clip.type === 'audio' &&
                clip.filePath &&
                clip.startBeat + clip.durationBeats >= range.startBeat - bufferBeats &&
                clip.startBeat <= range.endBeat + bufferBeats
            ) {
                if (!this._waveformCache.has(clip.filePath)) {
                    paths.push(clip.filePath);
                }
            }
        }

        if (paths.length > 0) {
            this._waveformCache.prefetch(paths);
            // Re-request draw when waveforms load (they'll be available next frame)
            setTimeout(() => this._requestRedraw(), 200);
        }
    }

    // ═══════════════════════════════════════════════════════════════════
    // SNAP UTILITY
    // ═══════════════════════════════════════════════════════════════════

    private _snapBeat(beat: number): number {
        // ⌘ key override — free positioning when held
        if (this._metaKeyHeld) return beat;
        if (!this._snapEnabled || this._snapBeats <= 0) return beat;
        return Math.round(beat / this._snapBeats) * this._snapBeats;
    }
}
