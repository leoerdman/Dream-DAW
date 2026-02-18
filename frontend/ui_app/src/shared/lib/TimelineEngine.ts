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
import { beatDurationToFrames } from './audioMath';

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
    /** If the cursor is on a clip fade handle hotspot. */
    fadeHandle?: 'in' | 'out';
    /** If the cursor is on a fade curve control point. */
    fadeCurveHandle?: 'in' | 'out';
    /** If cursor is inside fade region body. */
    fadeZone?: 'in' | 'out';
    /** If the cursor is near a loop marker handle on the ruler. */
    loopHandle?: 'start' | 'end';
}

interface MarqueeSelection {
    startBeat: number;
    endBeat: number;
    startTrack: number;
    endTrack: number;
}

interface TrimPreviewState {
    clipId: string;
    startBeat: number;
    durationBeats: number;
}

/** Edge detection threshold in screen pixels. */
const EDGE_GRIP_PX = 8;
/** Must match clip header visual height from CanvasClipRenderer. */
const CLIP_HEADER_HEIGHT_PX = 22;
/** Minimum loop region length in beats (1 bar in 4/4 time). */
const MIN_LOOP_BEATS = 4;
/** Fade handle hotspot width inside clip (in screen pixels). */
const FADE_HANDLE_HOTSPOT_PX = 12;
const FADE_CURVE_HANDLE_RADIUS_PX = 6;
const FADE_CURVE_PRESETS = [0.2, 0.35, 0.5, 0.65, 0.8] as const;

/** Drag state machine. */
type DragMode = 0 | 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9 | 10 | 11 | 12 | 13;
const DragMode = {
    None: 0 as const,
    ClipMove: 1 as const,
    ClipMoveArmed: 12 as const,
    RulerScrub: 2 as const,
    MarqueeSelect: 3 as const,
    ClipResizeLeft: 4 as const,
    ClipResizeRight: 5 as const,
    LoopStartMove: 6 as const,
    LoopEndMove: 7 as const,
    ClipFadeIn: 8 as const,
    ClipFadeOut: 9 as const,
    ClipFadeInCurve: 10 as const,
    ClipFadeOutCurve: 11 as const,
    MultiCursorSelect: 13 as const,
};

const CLIP_DRAG_START_THRESHOLD_PX = 4;

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
    /** Initial pointer position for drag threshold gating. */
    startClientX?: number;
    startClientY?: number;
    /** Original clip fade-in amount (fraction 0..1). */
    clipOriginalFadeIn?: number;
    /** Original clip fade-out amount (fraction 0..1). */
    clipOriginalFadeOut?: number;
    /** Original clip fade-in curve (0.05..0.95). */
    clipOriginalFadeInCurve?: number;
    /** Original clip fade-out curve (0.05..0.95). */
    clipOriginalFadeOutCurve?: number;
    /**
     * Original positions of OTHER selected clips that should move together.
     * Maps clipId → { beat, track }. Populated when a group-move starts.
     */
    coMoverOrigins?: Map<string, { beat: number; track: number }>;
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
    private _resizeRafId = 0;

    // ── Data (fed by React) ───────────────────────────────────────────
    private _clips: TimelineClipData[] = [];
    private _playheadBeat = 0;
    private _editCursorBeat = 0;
    private _editCursorTrack = 0;
    private _editCursorTrackEnd = 0;
    private _selectedTrack = -1;
    private _selectedTracks: number[] = [];
    private _loop: LoopRegion | null = null;
    private _ghost: GhostClipData | null = null;
    private _dropTarget: { track: number; beat: number } | null = null;
    private _marquee: MarqueeSelection | null = null;
    private _trimPreview: TrimPreviewState | null = null;
    private _fadeCurvePoints: Record<string, { in: boolean; out: boolean }> = {};
    private _hoverClipId: string | null = null;

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

    /** Whether the snap-override key is held (⌘ on Mac, Ctrl on Win/Linux). */
    private _metaKeyHeld = false;

    // ── Bound event handlers (for cleanup) ────────────────────────────
    private _boundWheel: (e: WheelEvent) => void;
    private _boundMouseDown: (e: MouseEvent) => void;
    private _boundMouseMove: (e: MouseEvent) => void;
    private _boundMouseUp: (e: MouseEvent) => void;
    private _boundDblClick: (e: MouseEvent) => void;
    private _boundContextMenu: (e: MouseEvent) => void;
    private _boundKeyDown: (e: KeyboardEvent) => void;

    // ── Waveform prefetch cancel handles ──────────────────────────────
    /** requestIdleCallback handle for deferred waveform redraw. */
    private _prefetchIdleId: number = 0;
    /** setTimeout handle for browsers without requestIdleCallback. */
    private _prefetchTimeoutId: ReturnType<typeof setTimeout> | null = null;

    // ── Callbacks (to React shell) ────────────────────────────────────
    onClipClick?: (clipId: string, addToSelection: boolean) => void;
    onClipMove?: (clipId: string, newBeat: number, newTrack: number) => void;
    onClipResize?: (clipId: string, newStartBeat: number, newDuration: number) => void;
    onClipFades?: (clipId: string, fadeInFrames: number, fadeOutFrames: number) => void;
    onClipFadeCurves?: (clipId: string, fadeInCurve: number, fadeOutCurve: number) => void;
    onPlayheadSeek?: (beat: number) => void;
    onEditCursorChange?: (beat: number, trackStart: number, trackEnd: number) => void;
    onDoubleClickTrack?: (trackIndex: number, beat: number) => void;
    onDoubleClickClip?: (clipId: string, trackIndex: number) => void;
    onTrackSelect?: (trackIndex: number) => void;
    onViewportFlush?: (snapshot: ViewportSnapshot) => void;
    onScrollTop?: (scrollTop: number) => void;
    onLoopChange?: (loop: LoopRegion) => void;
    onClipBoxSelection?: (clipIds: string[]) => void;
    onMarqueeSelectionStart?: () => void;
    onMarqueeSelectionChange?: (marquee: MarqueeSelection | null) => void;

    private _setMarquee(next: MarqueeSelection | null, emit = true): void {
        this._marquee = next;
        if (emit) this.onMarqueeSelectionChange?.(next ? { ...next } : null);
        this._requestRedraw();
    }

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
        this._boundContextMenu = this._onContextMenu.bind(this);
        this._boundKeyDown = this._onKeyDown.bind(this);
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
            this._scheduleCanvasResizeSync();
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
        // Escape key cancels active drag operations.
        window.addEventListener('keydown', this._boundKeyDown, { capture: true });

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
        if (this._resizeRafId) {
            cancelAnimationFrame(this._resizeRafId);
            this._resizeRafId = 0;
        }

        const canvas = this._canvas;
        if (canvas) {
            canvas.removeEventListener('wheel', this._boundWheel);
            canvas.removeEventListener('mousedown', this._boundMouseDown);
            canvas.removeEventListener('dblclick', this._boundDblClick);
            canvas.removeEventListener('contextmenu', this._boundContextMenu);
        }

        window.removeEventListener('mousemove', this._boundMouseMove);
        window.removeEventListener('mouseup', this._boundMouseUp);
        window.removeEventListener('keydown', this._boundKeyDown, { capture: true });

        // Cancel any in-flight waveform prefetch redraw timers.
        if (this._prefetchIdleId) {
            if (typeof cancelIdleCallback === 'function') {
                cancelIdleCallback(this._prefetchIdleId);
            }
            this._prefetchIdleId = 0;
        }
        if (this._prefetchTimeoutId !== null) {
            clearTimeout(this._prefetchTimeoutId);
            this._prefetchTimeoutId = null;
        }

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
        const prevClips = this._clips;
        this._clips = clips.map((clip) => {
            const flags = this._fadeCurvePoints[clip.id];
            return {
                ...clip,
                hovered: this._hoverClipId === clip.id,
                showFadeInCurvePoint: Boolean(flags?.in),
                showFadeOutCurvePoint: Boolean(flags?.out),
            };
        });

        // Bug #80: prune _fadeCurvePoints for clips that no longer exist to avoid
        // unbounded memory growth on long sessions with many clip create/delete cycles.
        const currentIds = new Set(clips.map((c) => c.id));
        for (const id of Object.keys(this._fadeCurvePoints)) {
            if (!currentIds.has(id)) delete this._fadeCurvePoints[id];
        }

        const structureChanged = this._didClipStructureChange(prevClips, this._clips);
        if (structureChanged) {
            this._viewport.clearDirty(); // Force redraw for geometry/content changes
            this._prefetchVisibleWaveforms();
        }
        this._requestRedraw();
    }

    setClipSelection(selectedClipIds: string[]): void {
        const selected = new Set(selectedClipIds);
        let changed = false;

        this._clips = this._clips.map((clip) => {
            const nextSelected = selected.has(clip.id);
            if (clip.selected === nextSelected) return clip;
            changed = true;
            return { ...clip, selected: nextSelected };
        });

        if (!changed) return;
        this._requestRedraw();
    }

    setPlayheadBeat(beat: number): void {
        if (beat === this._playheadBeat) return;
        this._playheadBeat = beat;
        this._requestRedraw();
    }

    setEditCursor(beat: number, trackStart: number, trackEnd: number): void {
        this._editCursorBeat = beat;
        this._editCursorTrack = trackStart;
        this._editCursorTrackEnd = trackEnd;
        this._requestRedraw();
    }

    setSelectedTrack(track: number): void {
        this.setSelectedTracks(track, track >= 0 ? [track] : []);
    }

    setSelectedTracks(primary: number, tracks: number[]): void {
        const normalizedPrimary = Number.isFinite(primary)
            ? Math.max(-1, Math.min(this._viewport.trackCount - 1, Math.trunc(primary)))
            : -1;

        const cleaned = Array.from(new Set(tracks))
            .map((t) => Math.max(0, Math.min(this._viewport.trackCount - 1, Math.trunc(t))))
            .filter((t) => Number.isFinite(t));

        // Ensure primary is included when valid.
        if (normalizedPrimary >= 0 && !cleaned.includes(normalizedPrimary)) cleaned.unshift(normalizedPrimary);

        const samePrimary = normalizedPrimary === this._selectedTrack;
        const sameList = cleaned.length === this._selectedTracks.length && cleaned.every((v, i) => v === this._selectedTracks[i]);
        if (samePrimary && sameList) return;

        this._selectedTrack = normalizedPrimary;
        this._selectedTracks = cleaned;
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

    private _drawFrameNow(force = false): void {
        const animateEditCursor = this._editCursorBeat >= 0;
        if (!force && !this._needsRedraw && !this._viewport.isDirty && !animateEditCursor) return;
        this._needsRedraw = false;
        this._viewport.clearDirty();

        const ctx = this._ctx;
        if (!ctx) return;

        const clipsForDraw = this._composeDrawClips();
        this._renderer.drawFrame(
            ctx,
            this._viewport,
            clipsForDraw,
            this._playheadBeat,
            this._editCursorBeat,
            this._editCursorTrack,
            this._editCursorTrackEnd,
            this._selectedTrack,
            this._selectedTracks,
            this._loop,
            this._beatsPerBar,
            this._snapBeats,
            this._marquee,
            this._ghost,
            this._dropTarget,
            this._sampleRate,
            this._bpm,
        );
    }

    private _tick = (): void => {
        this._rafId = requestAnimationFrame(this._tick);

        this._drawFrameNow();
    };

    private _composeDrawClips(): TimelineClipData[] {
        const preview = this._trimPreview;
        if (!preview) return this._clips;
        return this._clips.map((clip) =>
            clip.id === preview.clipId
                ? {
                    ...clip,
                    startBeat: preview.startBeat,
                    durationBeats: preview.durationBeats,
                }
                : clip,
        );
    }

    private _didClipStructureChange(prev: TimelineClipData[], next: TimelineClipData[]): boolean {
        if (prev.length !== next.length) return true;
        for (let i = 0; i < next.length; i += 1) {
            const a = prev[i];
            const b = next[i];
            if (!a) return true;
            if (a.id !== b.id) return true;
            if (a.trackIndex !== b.trackIndex) return true;
            if (a.startBeat !== b.startBeat || a.durationBeats !== b.durationBeats) return true;
            if (a.type !== b.type) return true;
            if ((a.filePath ?? '') !== (b.filePath ?? '')) return true;
            if ((a.durationSamples ?? 0) !== (b.durationSamples ?? 0)) return true;
            if ((a.sourceOffset ?? 0) !== (b.sourceOffset ?? 0)) return true;
            if ((a.fadeIn ?? 0) !== (b.fadeIn ?? 0)) return true;
            if ((a.fadeOut ?? 0) !== (b.fadeOut ?? 0)) return true;
            if ((a.fadeInCurve ?? 0.5) !== (b.fadeInCurve ?? 0.5)) return true;
            if ((a.fadeOutCurve ?? 0.5) !== (b.fadeOutCurve ?? 0.5)) return true;
            if ((a.muted ?? false) !== (b.muted ?? false)) return true;
            if ((a.isOffline ?? false) !== (b.isOffline ?? false)) return true;
        }
        return false;
    }

    private _clientToWorld(clientX: number, clientY: number): { beat: number; trackIndex: number } {
        const canvas = this._canvas;
        if (!canvas) return { beat: 0, trackIndex: 0 };
        const rect = canvas.getBoundingClientRect();
        // Uses viewport inverse mapping from screen-space back to world-space.
        return {
            beat: this._viewport.screenToBeats(clientX, rect),
            trackIndex: this._viewport.screenToTrack(clientY, rect),
        };
    }

    // ═══════════════════════════════════════════════════════════════════
    // CANVAS SIZE MANAGEMENT
    // ═══════════════════════════════════════════════════════════════════

    private _syncCanvasSize(): void {
        const canvas = this._canvas;
        if (!canvas) return;

        const rect = canvas.getBoundingClientRect();
        if (rect.width <= 0 || rect.height <= 0) return;
        const dpr = window.devicePixelRatio || 1;

        // Set backing store size (sharp rendering on HiDPI)
        const backingW = Math.round(rect.width * dpr);
        const backingH = Math.round(rect.height * dpr);

        let backingChanged = false;
        if (canvas.width !== backingW || canvas.height !== backingH) {
            canvas.width = backingW;
            canvas.height = backingH;
            backingChanged = true;
        }

        const viewportChanged =
            Math.abs(this._viewport.viewportWidth - rect.width) > 0.5
            || Math.abs(this._viewport.viewportHeight - rect.height) > 0.5;

        if (viewportChanged || backingChanged) {
            this._viewport.setViewportSize(rect.width, rect.height);
            this._requestRedraw();
            // Draw immediately after backing-store resize to avoid visible blank-frame flicker
            // while panes are being resized/zoomed.
            this._drawFrameNow(true);
        }
    }

    private _scheduleCanvasResizeSync(): void {
        if (this._resizeRafId) return;
        this._resizeRafId = requestAnimationFrame(() => {
            this._resizeRafId = 0;
            this._syncCanvasSize();
        });
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

        const world = this._clientToWorld(clientX, clientY);
        const beat = world.beat;
        const trackIndex = world.trackIndex;

        // Check clips (reverse order — topmost first, since selected are sorted last)
        for (let i = this._clips.length - 1; i >= 0; i--) {
            const clip = this._clips[i];
            if (clip.trackIndex !== trackIndex) continue;

            const clipLeftPx = this._viewport.beatsToScreenX(clip.startBeat);
            const clipRightPx = this._viewport.beatsToScreenX(clip.startBeat + clip.durationBeats);
            const localX = clientX - rect.left;

            // Check if cursor is within clip bounds OR within EDGE_GRIP_PX of edges
            const isInsideOrNear = localX >= clipLeftPx - EDGE_GRIP_PX && localX <= clipRightPx + EDGE_GRIP_PX;

            if (isInsideOrNear) {
                const clipTopPx =
                    this._viewport.rulerHeight + this._viewport.trackOffsetY(clip.trackIndex) - this._viewport.scrollY;
                const localYInClip = Math.max(0, clientY - rect.top - clipTopPx);
                const localYPx = clientY - rect.top;
                const trackH = this._viewport.trackHeightAt(clip.trackIndex);
                const region: 'header' | 'body' =
                    localYInClip <= Math.min(CLIP_HEADER_HEIGHT_PX, trackH - 2)
                        ? 'header'
                        : 'body';

                const showFadeUi = this._shouldShowFadeUiForClip(clip.id);
                const fadeBody = this._getFadeBodyBounds(clipTopPx, trackH);
                const inFadeBody = showFadeUi && localYPx >= fadeBody.top && localYPx <= fadeBody.bottom;

                let fadeZone: 'in' | 'out' | undefined;
                const clipWidthPx = Math.max(1, clipRightPx - clipLeftPx);
                const fadeInWidthPx = clipWidthPx * this._clampFadeFraction(clip.fadeIn ?? 0);
                const fadeOutWidthPx = clipWidthPx * this._clampFadeFraction(clip.fadeOut ?? 0);
                if (inFadeBody) {
                    if (fadeInWidthPx > 0 && localX >= clipLeftPx && localX <= clipLeftPx + fadeInWidthPx) {
                        fadeZone = 'in';
                    } else if (fadeOutWidthPx > 0 && localX <= clipRightPx && localX >= clipRightPx - fadeOutWidthPx) {
                        fadeZone = 'out';
                    }
                }

                let fadeHandle: 'in' | 'out' | undefined;
                if (inFadeBody) {
                    const handleY = fadeBody.top + 6;
                    const inHandleX = clipLeftPx + Math.max(4, Math.min(clipWidthPx - 4, fadeInWidthPx));
                    const outHandleX = clipRightPx - Math.max(4, Math.min(clipWidthPx - 4, fadeOutWidthPx));
                    if (Math.hypot(localX - inHandleX, localYPx - handleY) <= FADE_HANDLE_HOTSPOT_PX) {
                        fadeHandle = 'in';
                    } else if (Math.hypot(localX - outHandleX, localYPx - handleY) <= FADE_HANDLE_HOTSPOT_PX) {
                        fadeHandle = 'out';
                    }
                }

                let fadeCurveHandle: 'in' | 'out' | undefined;
                const showCurveFlags = showFadeUi ? this._fadeCurvePoints[clip.id] : undefined;
                if (showCurveFlags?.in) {
                    const p = this._getFadeCurveHandlePosition(clipLeftPx, clipRightPx, clipTopPx, clip, 'in');
                    if (p && Math.hypot(localX - p.x, localYPx - p.y) <= FADE_CURVE_HANDLE_RADIUS_PX) {
                        fadeCurveHandle = 'in';
                    }
                }
                if (!fadeCurveHandle && showCurveFlags?.out) {
                    const p = this._getFadeCurveHandlePosition(clipLeftPx, clipRightPx, clipTopPx, clip, 'out');
                    if (p && Math.hypot(localX - p.x, localYPx - p.y) <= FADE_CURVE_HANDLE_RADIUS_PX) {
                        fadeCurveHandle = 'out';
                    }
                }

                let edge: 'left' | 'right' | undefined;
                if (Math.abs(localX - clipLeftPx) <= EDGE_GRIP_PX) {
                    edge = 'left';
                } else if (Math.abs(localX - clipRightPx) <= EDGE_GRIP_PX) {
                    edge = 'right';
                }

                if (fadeHandle || fadeCurveHandle) {
                    edge = undefined;
                }

                // If we are NOT near an edge, but outside the actual clip bounds, ignore this clip
                if (!edge && (localX < clipLeftPx || localX > clipRightPx)) {
                    continue;
                }

                return { type: 'clip', clipId: clip.id, beat, trackIndex, region, edge, fadeHandle, fadeCurveHandle, fadeZone };
            }
        }

        return { type: 'track', beat, trackIndex };
    }

    private _selectClipsWithinMarquee(
        startBeat: number,
        endBeat: number,
        startTrack: number,
        endTrack: number,
    ): void {
        const minBeat = Math.min(startBeat, endBeat);
        const maxBeat = Math.max(startBeat, endBeat);
        const minTrack = Math.min(startTrack, endTrack);
        const maxTrack = Math.max(startTrack, endTrack);
        // Bug #70: use overlap test, not full-containment — a clip partially
        // inside the marquee should be selected.
        // Bug #71: removed visible-range filter so offscreen clips can be selected
        // when the user drags the marquee beyond the current viewport.
        const selectedIds = this._clips
            .filter((clip) => {
                const clipStart = clip.startBeat;
                const clipEnd = clip.startBeat + clip.durationBeats;
                if (clip.trackIndex < minTrack || clip.trackIndex > maxTrack) return false;
                // Overlap: clip intersects [minBeat, maxBeat]
                return clipEnd > minBeat && clipStart < maxBeat;
            })
            .map((clip) => clip.id);

        this.onClipBoxSelection?.(selectedIds);
        this._setMarquee({
            startBeat: minBeat,
            endBeat: maxBeat,
            startTrack: minTrack,
            endTrack: maxTrack,
        });
    }

    private _clampFadeCurve(value: number): number {
        return Math.max(0.05, Math.min(0.95, value));
    }

    private _nextFadeCurvePreset(current: number): number {
        const normalized = this._clampFadeCurve(current);
        const idx = FADE_CURVE_PRESETS.findIndex((v) => Math.abs(v - normalized) < 0.04);
        if (idx < 0) return FADE_CURVE_PRESETS[2];
        return FADE_CURVE_PRESETS[(idx + 1) % FADE_CURVE_PRESETS.length];
    }

    private _getFadeBodyBounds(clipTopPx: number, trackH: number): { top: number; bottom: number } {
        const headerH = Math.min(CLIP_HEADER_HEIGHT_PX, trackH - 2);
        const bodyTop = clipTopPx + headerH + 2;
        const bodyBottom = clipTopPx + trackH - 2;
        return { top: bodyTop, bottom: Math.max(bodyTop + 6, bodyBottom) };
    }

    private _getFadeCurveHandlePosition(
        clipLeftPx: number,
        clipRightPx: number,
        clipTopPx: number,
        clip: TimelineClipData,
        side: 'in' | 'out',
    ): { x: number; y: number } | null {
        const clipWidth = Math.max(1, clipRightPx - clipLeftPx);
        const fadeAmount = side === 'in' ? (clip.fadeIn ?? 0) : (clip.fadeOut ?? 0);
        if (fadeAmount <= 0) return null;
        const fadeWidth = Math.max(8, clipWidth * this._clampFadeFraction(fadeAmount));
        const curve = side === 'in'
            ? this._clampFadeCurve(clip.fadeInCurve ?? 0.5)
            : this._clampFadeCurve(clip.fadeOutCurve ?? 0.5);
        const body = this._getFadeBodyBounds(clipTopPx, this._viewport.trackHeightAt(clip.trackIndex));
        const bodyH = body.bottom - body.top;
        const handleY = side === 'in'
            ? body.bottom - bodyH * curve
            : body.top + bodyH * curve;
        const handleX = side === 'in'
            ? clipLeftPx + fadeWidth * curve
            : clipRightPx - fadeWidth * curve;
        return { x: handleX, y: handleY };
    }

    private _isFadeDragMode(mode: DragMode): boolean {
        return mode === DragMode.ClipFadeIn
            || mode === DragMode.ClipFadeOut
            || mode === DragMode.ClipFadeInCurve
            || mode === DragMode.ClipFadeOutCurve;
    }

    private _shouldShowFadeUiForClip(clipId: string): boolean {
        const activeFadeClipId = this._isFadeDragMode(this._drag.mode) ? this._drag.clipId : null;
        return this._hoverClipId === clipId || activeFadeClipId === clipId;
    }

    private _syncHoveredClip(clipId: string | null): void {
        // Bug #81: avoid in-place mutation of clip objects; derive hovered state from
        // _hoverClipId when the renderer reads it via _shouldShowFadeUiForClip.
        if (this._hoverClipId === clipId) return;
        this._hoverClipId = clipId;
        const activeFadeClipId = this._isFadeDragMode(this._drag.mode) ? this._drag.clipId : null;

        // Update the lightweight hovered flag on each clip without full object replacement.
        for (const clip of this._clips) {
            const next = clip.id === this._hoverClipId || (Boolean(activeFadeClipId) && clip.id === activeFadeClipId);
            clip.hovered = next; // This flag is only used for rendering — not for React state.
        }
        this._requestRedraw();
    }

    // ═══════════════════════════════════════════════════════════════════
    // MOUSE HANDLERS
    // ═══════════════════════════════════════════════════════════════════

    private _onMouseDown(e: MouseEvent): void {
        if (e.button !== 0) return; // Left click only
        if (!this._canvas) return;

        // Bug #72: snap override should work on both Mac (metaKey) and Win/Linux (ctrlKey).
        this._metaKeyHeld = e.metaKey || e.ctrlKey;
        const hit = this.hitTest(e.clientX, e.clientY);

        switch (hit.type) {
            case 'ruler': {
                if (this._marquee) this._setMarquee(null);
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
                    this.onEditCursorChange?.(snapped, this._editCursorTrack, this._editCursorTrackEnd);
                }
                break;
            }

            case 'clip': {
                if (this._marquee) this._setMarquee(null);
                if (!hit.clipId) break;

                const clip = this._clips.find(c => c.id === hit.clipId);
                if (!clip) break;

                // Body click: select clip and arm drag-to-move (same as header click).
                // Standard DAW behavior — clicking anywhere on a clip selects it.
                // Body click: place cursor ONLY (Liquid Industry model).
                // Does NOT select clip, does NOT move global playhead line.
                if (hit.region === 'body' && !hit.edge && !hit.fadeHandle && !hit.fadeCurveHandle) {
                    const snapped = this._snapBeat(hit.beat);
                    this.onEditCursorChange?.(snapped, hit.trackIndex, hit.trackIndex);
                    // this.onPlayheadSeek?.(snapped); // DEPRECATED: Only Ruler or Transport moves playhead.

                    this._drag = {
                        mode: DragMode.MultiCursorSelect,
                        clipId: null,
                        startBeat: snapped,
                        startTrack: hit.trackIndex,
                        currentBeat: snapped,
                        currentTrack: hit.trackIndex,
                        clipOriginalBeat: 0,
                        clipOriginalTrack: 0,
                        clipOriginalDuration: 0,
                        startClientX: e.clientX,
                        startClientY: e.clientY,
                    };
                    break;
                }

                if (hit.fadeCurveHandle === 'in' || hit.fadeCurveHandle === 'out') {
                    this.onClipClick?.(hit.clipId, false);
                    this._drag = {
                        mode: hit.fadeCurveHandle === 'in' ? DragMode.ClipFadeInCurve : DragMode.ClipFadeOutCurve,
                        clipId: hit.clipId,
                        startBeat: hit.beat,
                        startTrack: hit.trackIndex,
                        currentBeat: hit.beat,
                        currentTrack: hit.trackIndex,
                        clipOriginalBeat: clip.startBeat,
                        clipOriginalTrack: clip.trackIndex,
                        clipOriginalDuration: clip.durationBeats,
                        clipOriginalFadeIn: this._clampFadeFraction(clip.fadeIn ?? 0),
                        clipOriginalFadeOut: this._clampFadeFraction(clip.fadeOut ?? 0),
                        clipOriginalFadeInCurve: this._clampFadeCurve(clip.fadeInCurve ?? 0.5),
                        clipOriginalFadeOutCurve: this._clampFadeCurve(clip.fadeOutCurve ?? 0.5),
                    };
                    break;
                }

                if (hit.fadeHandle === 'in' || hit.fadeHandle === 'out') {
                    this.onClipClick?.(hit.clipId, false);
                    this._drag = {
                        mode: hit.fadeHandle === 'in' ? DragMode.ClipFadeIn : DragMode.ClipFadeOut,
                        clipId: hit.clipId,
                        startBeat: hit.beat,
                        startTrack: hit.trackIndex,
                        currentBeat: hit.beat,
                        currentTrack: hit.trackIndex,
                        clipOriginalBeat: clip.startBeat,
                        clipOriginalTrack: clip.trackIndex,
                        clipOriginalDuration: clip.durationBeats,
                        clipOriginalFadeIn: this._clampFadeFraction(clip.fadeIn ?? 0),
                        clipOriginalFadeOut: this._clampFadeFraction(clip.fadeOut ?? 0),
                    };
                } else if (hit.edge === 'left') {
                    // Determine drag mode based on edge detection
                    // Start left-edge resize
                    this.onClipClick?.(hit.clipId, false);
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
                    this._trimPreview = {
                        clipId: hit.clipId,
                        startBeat: clip.startBeat,
                        durationBeats: clip.durationBeats,
                    };
                } else if (hit.edge === 'right') {
                    // Start right-edge resize
                    this.onClipClick?.(hit.clipId, false);
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
                    this._trimPreview = {
                        clipId: hit.clipId,
                        startBeat: clip.startBeat,
                        durationBeats: clip.durationBeats,
                    };
                } else {
                    // Header click/drag path: arm drag, start moving only after threshold.
                    this.onClipClick?.(hit.clipId, e.shiftKey || e.metaKey);

                    // Bug #100: Initialize co-movers if multiple clips are selected.
                    const selectedClipIds = this._clips.filter(c => c.selected).map(c => c.id);
                    const coMovers = new Map<string, { beat: number; track: number }>();
                    if (selectedClipIds.length > 1 && selectedClipIds.includes(hit.clipId)) {
                        for (const sc of this._clips) {
                            if (sc.selected && sc.id !== hit.clipId) {
                                coMovers.set(sc.id, { beat: sc.startBeat, track: sc.trackIndex });
                            }
                        }
                    }

                    this._drag = {
                        mode: DragMode.ClipMoveArmed,
                        clipId: hit.clipId,
                        startBeat: hit.beat,
                        startTrack: hit.trackIndex,
                        currentBeat: hit.beat,
                        currentTrack: hit.trackIndex,
                        clipOriginalBeat: clip.startBeat,
                        clipOriginalTrack: clip.trackIndex,
                        clipOriginalDuration: clip.durationBeats,
                        startClientX: e.clientX,
                        startClientY: e.clientY,
                        coMoverOrigins: coMovers.size > 0 ? coMovers : undefined,
                    };
                }
                break;
            }

            case 'track': {
                // Empty area -> potential marquee box selection (grid-snapped).
                const snappedBeat = this._snapBeat(hit.beat);
                if (e.shiftKey && this._editCursorBeat >= 0) {
                    const anchorBeat = this._snapBeat(Math.max(0, this._editCursorBeat));
                    const anchorTrack = Math.max(0, Math.min(this._viewport.trackCount - 1, this._editCursorTrack));
                    this.onMarqueeSelectionStart?.();
                    this._selectClipsWithinMarquee(anchorBeat, snappedBeat, anchorTrack, hit.trackIndex);
                    break;
                }
                this.onMarqueeSelectionStart?.();
                this._drag = {
                    mode: DragMode.MultiCursorSelect,
                    clipId: null,
                    startBeat: snappedBeat,
                    startTrack: hit.trackIndex,
                    currentBeat: snappedBeat,
                    currentTrack: hit.trackIndex,
                    clipOriginalBeat: 0,
                    clipOriginalTrack: 0,
                    clipOriginalDuration: 0,
                    startClientX: e.clientX,
                    startClientY: e.clientY,
                };
                // Multi-track cursor visual (thin line across tracks).
                this._setMarquee({
                    startBeat: snappedBeat,
                    endBeat: snappedBeat,
                    startTrack: hit.trackIndex,
                    endTrack: hit.trackIndex,
                }, false);
                break;
            }
        }
    }

    private _onMouseMove(e: MouseEvent): void {
        // Bug #72: track both metaKey (Mac) and ctrlKey (Win/Linux).
        this._metaKeyHeld = e.metaKey || e.ctrlKey;
        const canvas = this._canvas;
        if (!canvas) return;

        // ── Cursor management (when NOT dragging) ──
        if (this._drag.mode === DragMode.None) {
            const hit = this.hitTest(e.clientX, e.clientY);
            this._syncHoveredClip(hit.type === 'clip' && hit.clipId ? hit.clipId : null);
            if (hit.type === 'clip' && hit.fadeCurveHandle) {
                canvas.style.cursor = 'pointer';
            } else if (hit.type === 'clip' && hit.fadeHandle) {
                canvas.style.cursor = 'ew-resize';
            } else if (hit.type === 'clip' && hit.edge) {
                canvas.style.cursor = 'ew-resize';
            } else if (hit.type === 'clip' && hit.region === 'header') {
                canvas.style.cursor = 'grab';
            } else if (hit.type === 'clip' && hit.region === 'body') {
                canvas.style.cursor = 'default';
            } else if (hit.type === 'ruler' && hit.loopHandle) {
                canvas.style.cursor = 'ew-resize';
            } else {
                canvas.style.cursor = 'default';
            }
            return;
        }

        const world = this._clientToWorld(e.clientX, e.clientY);
        const beat = world.beat;
        const track = world.trackIndex;

        this._drag.currentBeat = beat;
        this._drag.currentTrack = track;

        switch (this._drag.mode) {
            case DragMode.ClipMoveArmed: {
                const startX = this._drag.startClientX ?? e.clientX;
                const startY = this._drag.startClientY ?? e.clientY;
                const dx = e.clientX - startX;
                const dy = e.clientY - startY;
                if (Math.hypot(dx, dy) < CLIP_DRAG_START_THRESHOLD_PX) {
                    canvas.style.cursor = 'grab';
                    break;
                }
                this._drag.mode = DragMode.ClipMove;
                canvas.style.cursor = 'grabbing';
                // Snapshot original positions of all other selected clips so we can
                // move them together with the dragged clip (multi-select group move).
                const coMoverOrigins = new Map<string, { beat: number; track: number }>();
                for (const c of this._clips) {
                    if (c.selected && c.id !== this._drag.clipId) {
                        coMoverOrigins.set(c.id, { beat: c.startBeat, track: c.trackIndex });
                    }
                }
                this._drag.coMoverOrigins = coMoverOrigins;
                // Apply first drag frame immediately.
                const deltaBeat = beat - this._drag.startBeat;
                const deltaTrack = track - this._drag.startTrack;
                const newBeat = this._snapBeat(
                    Math.max(0, this._drag.clipOriginalBeat + deltaBeat),
                );
                const newTrack = Math.max(
                    0,
                    Math.min(this._viewport.trackCount - 1, this._drag.clipOriginalTrack + deltaTrack),
                );
                const clip = this._clips.find(c => c.id === this._drag.clipId);
                if (clip) {
                    clip.startBeat = newBeat;
                    clip.trackIndex = newTrack;
                }
                // Move all co-movers by the raw (unsnapped) delta too.
                for (const [id, origin] of coMoverOrigins) {
                    const co = this._clips.find(c => c.id === id);
                    if (co) {
                        co.startBeat = this._snapBeat(Math.max(0, origin.beat + deltaBeat));
                        co.trackIndex = Math.max(0, Math.min(this._viewport.trackCount - 1, origin.track + deltaTrack));
                    }
                }
                this._requestRedraw();
                break;
            }

            case DragMode.RulerScrub: {
                // Ruler drag = continuous edit-cursor repositioning (no live scrub).
                const snapped = this._snapBeat(Math.max(0, beat));
                this.onEditCursorChange?.(snapped, this._editCursorTrack, this._editCursorTrackEnd);
                break;
            }

            case DragMode.ClipMove: {
                canvas.style.cursor = 'grabbing';
                const deltaBeat = beat - this._drag.startBeat;
                const deltaTrack = track - this._drag.startTrack;

                const primaryClip = this._clips.find(c => c.id === this._drag.clipId);
                if (primaryClip) {
                    primaryClip.startBeat = this._snapBeat(Math.max(0, this._drag.clipOriginalBeat + deltaBeat));
                    primaryClip.trackIndex = Math.max(0, Math.min(this._viewport.trackCount - 1, this._drag.clipOriginalTrack + deltaTrack));

                    if (this._drag.coMoverOrigins) {
                        for (const [id, origin] of this._drag.coMoverOrigins) {
                            const co = this._clips.find(c => c.id === id);
                            if (co) {
                                co.startBeat = this._snapBeat(Math.max(0, origin.beat + deltaBeat));
                                co.trackIndex = Math.max(0, Math.min(this._viewport.trackCount - 1, origin.track + deltaTrack));
                            }
                        }
                    }
                    this._requestRedraw();
                }
                break;
            }

            case DragMode.ClipResizeLeft: {
                canvas.style.cursor = 'ew-resize';
                if (!this._drag.clipId) break;
                const deltaBeat = beat - this._drag.startBeat;
                const rawNewStart = this._drag.clipOriginalBeat + deltaBeat;
                const clipEnd = this._drag.clipOriginalBeat + this._drag.clipOriginalDuration;
                const maxNewStart = clipEnd - 0.25;
                const newStart = this._snapBeat(Math.max(0, Math.min(maxNewStart, rawNewStart)));
                const newDuration = Math.max(0.25, clipEnd - newStart);
                this._trimPreview = { clipId: this._drag.clipId, startBeat: newStart, durationBeats: newDuration };
                this._requestRedraw();
                break;
            }

            case DragMode.ClipResizeRight: {
                canvas.style.cursor = 'ew-resize';
                if (!this._drag.clipId) break;
                const rawNewEnd = beat;
                const snappedEnd = this._snapBeat(Math.max(this._drag.clipOriginalBeat + 0.25, rawNewEnd));
                const newDuration = Math.max(0.25, snappedEnd - this._drag.clipOriginalBeat);
                this._trimPreview = { clipId: this._drag.clipId, startBeat: this._drag.clipOriginalBeat, durationBeats: newDuration };
                this._requestRedraw();
                break;
            }

            case DragMode.ClipFadeIn: {
                canvas.style.cursor = 'ew-resize';
                if (!this._drag.clipId) break;
                const clip = this._clips.find(c => c.id === this._drag.clipId);
                if (!clip || clip.durationBeats <= 0) break;
                const deltaFraction = (beat - this._drag.startBeat) / clip.durationBeats;
                const fineFactor = e.altKey ? (e.shiftKey ? 0.08 : 0.14) : (e.shiftKey ? 0.28 : 1);
                clip.fadeIn = this._clampFadeFraction((this._drag.clipOriginalFadeIn ?? 0) + deltaFraction * fineFactor);
                this._requestRedraw();
                break;
            }

            case DragMode.ClipFadeOut: {
                canvas.style.cursor = 'ew-resize';
                if (!this._drag.clipId) break;
                const clip = this._clips.find(c => c.id === this._drag.clipId);
                if (!clip || clip.durationBeats <= 0) break;
                const deltaFraction = (beat - this._drag.startBeat) / clip.durationBeats;
                const fineFactor = e.altKey ? (e.shiftKey ? 0.08 : 0.14) : (e.shiftKey ? 0.28 : 1);
                clip.fadeOut = this._clampFadeFraction((this._drag.clipOriginalFadeOut ?? 0) - deltaFraction * fineFactor);
                this._requestRedraw();
                break;
            }

            case DragMode.ClipFadeInCurve:
            case DragMode.ClipFadeOutCurve: {
                canvas.style.cursor = 'pointer';
                if (!this._drag.clipId || !canvas) break;
                const clip = this._clips.find((c) => c.id === this._drag.clipId);
                if (!clip) break;
                const rect = canvas.getBoundingClientRect();
                const localX = e.clientX - rect.left;
                const localY = e.clientY - rect.top;
                const clipLeftPx = this._viewport.beatsToScreenX(clip.startBeat);
                const clipRightPx = this._viewport.beatsToScreenX(clip.startBeat + clip.durationBeats);
                const clipTopPx = this._viewport.rulerHeight + this._viewport.trackOffsetY(clip.trackIndex) - this._viewport.scrollY;
                const body = this._getFadeBodyBounds(clipTopPx, this._viewport.trackHeightAt(clip.trackIndex));
                const bodyHeight = Math.max(6, body.bottom - body.top);
                const yCurveIn = this._clampFadeCurve((body.bottom - localY) / bodyHeight);
                const yCurveOut = this._clampFadeCurve((localY - body.top) / bodyHeight);

                if (this._drag.mode === DragMode.ClipFadeInCurve) {
                    const fadeWidth = Math.max(8, (clipRightPx - clipLeftPx) * this._clampFadeFraction(clip.fadeIn ?? 0));
                    const xCurve = this._clampFadeCurve((localX - clipLeftPx) / Math.max(1, fadeWidth));
                    const target = this._clampFadeCurve((xCurve * 0.7) + (yCurveIn * 0.3));
                    const origin = this._drag.clipOriginalFadeInCurve ?? 0.5;
                    const fineFactor = e.altKey ? (e.shiftKey ? 0.08 : 0.12) : (e.shiftKey ? 0.22 : 1);
                    clip.fadeInCurve = this._clampFadeCurve(origin + (target - origin) * fineFactor);
                } else {
                    const fadeWidth = Math.max(8, (clipRightPx - clipLeftPx) * this._clampFadeFraction(clip.fadeOut ?? 0));
                    const xCurve = this._clampFadeCurve((clipRightPx - localX) / Math.max(1, fadeWidth));
                    const target = this._clampFadeCurve((xCurve * 0.7) + (yCurveOut * 0.3));
                    const origin = this._drag.clipOriginalFadeOutCurve ?? 0.5;
                    const fineFactor = e.altKey ? (e.shiftKey ? 0.08 : 0.12) : (e.shiftKey ? 0.22 : 1);
                    clip.fadeOutCurve = this._clampFadeCurve(origin + (target - origin) * fineFactor);
                }
                this._requestRedraw();
                break;
            }

            case DragMode.LoopStartMove: {
                canvas.style.cursor = 'ew-resize';
                const snapped = this._snapBeat(Math.max(0, beat));
                if (this._loop) {
                    const minLoop = this._beatsPerBar > 0 ? this._beatsPerBar : MIN_LOOP_BEATS;
                    const newStart = Math.max(0, Math.min(snapped, this._loop.end - minLoop));
                    if (newStart !== this._loop.start) {
                        this._loop = { ...this._loop, start: newStart };
                        this.onLoopChange?.(this._loop);
                        this._requestRedraw();
                    }
                }
                break;
            }

            case DragMode.LoopEndMove: {
                canvas.style.cursor = 'ew-resize';
                const snapped = this._snapBeat(Math.max(0, beat));
                if (this._loop) {
                    const minLoop = this._beatsPerBar > 0 ? this._beatsPerBar : MIN_LOOP_BEATS;
                    const newEnd = Math.max(this._loop.start + minLoop, snapped);
                    if (newEnd !== this._loop.end) {
                        this._loop = { ...this._loop, end: newEnd };
                        this.onLoopChange?.(this._loop);
                        this._requestRedraw();
                    }
                }
                break;
            }

            case DragMode.MarqueeSelect: {
                const dx = Math.abs(e.clientX - (this._drag.startClientX ?? e.clientX));
                const verticalLineMode = dx <= 6;
                canvas.style.cursor = verticalLineMode ? 'ns-resize' : 'default';
                const snappedBeat = verticalLineMode ? this._drag.startBeat : this._snapBeat(Math.max(0, beat));
                const clampedTrack = Math.max(0, Math.min(this._viewport.trackCount - 1, track));
                this._drag.currentBeat = snappedBeat;
                this._drag.currentTrack = clampedTrack;
                this._setMarquee({ startBeat: this._drag.startBeat, endBeat: snappedBeat, startTrack: this._drag.startTrack, endTrack: clampedTrack }, false);
                break;
            }

            case DragMode.MultiCursorSelect: {
                const dx = Math.abs(e.clientX - (this._drag.startClientX ?? e.clientX));
                if (dx > 6) {
                    this._drag.mode = DragMode.MarqueeSelect;
                    const snappedBeat = this._snapBeat(Math.max(0, beat));
                    const clampedTrack = Math.max(0, Math.min(this._viewport.trackCount - 1, track));
                    this._drag.currentBeat = snappedBeat;
                    this._drag.currentTrack = clampedTrack;
                    this._setMarquee({ startBeat: this._drag.startBeat, endBeat: snappedBeat, startTrack: this._drag.startTrack, endTrack: clampedTrack }, false);
                } else {
                    canvas.style.cursor = 'ns-resize';
                    const clampedTrack = Math.max(0, Math.min(this._viewport.trackCount - 1, track));
                    this._drag.currentTrack = clampedTrack;
                    this._drag.currentBeat = this._drag.startBeat;
                    this._setMarquee({ startBeat: this._drag.startBeat, endBeat: this._drag.startBeat, startTrack: this._drag.startTrack, endTrack: clampedTrack }, false);
                }
                break;
            }
        }
    }

    private _onMouseUp(e: MouseEvent): void {
        if (this._drag.mode === DragMode.None) return;

        const canvas = this._canvas;
        if (canvas) canvas.style.cursor = 'default';

        switch (this._drag.mode) {
            case DragMode.ClipMoveArmed: {
                // Header click without passing drag threshold: selection already handled on mousedown.
                break;
            }
            case DragMode.ClipMove: {
                if (this._drag.clipId) {
                    if (!canvas) break;

                    const rect = canvas.getBoundingClientRect();
                    const beat = this._viewport.screenToBeats(e.clientX, rect);
                    const track = this._viewport.screenToTrack(e.clientY, rect);

                    const deltaBeat = beat - this._drag.startBeat;
                    const deltaTrack = track - this._drag.startTrack;
                    const beatCommitThreshold = this._snapEnabled
                        ? Math.max(0.05, this._snapBeats * 0.5)
                        : 0.05;
                    const isTinyMove =
                        Math.abs(deltaBeat) < beatCommitThreshold && Math.abs(deltaTrack) < 0.5;
                    if (isTinyMove) {
                        // Bug #76: restore the dragged clip's visual position.
                        const clipToRestore = this._clips.find(c => c.id === this._drag.clipId);
                        if (clipToRestore) {
                            clipToRestore.startBeat = this._drag.clipOriginalBeat;
                            clipToRestore.trackIndex = this._drag.clipOriginalTrack;
                        }
                        // Also restore co-movers to their original positions.
                        if (this._drag.coMoverOrigins) {
                            for (const [id, origin] of this._drag.coMoverOrigins) {
                                const co = this._clips.find(c => c.id === id);
                                if (co) {
                                    co.startBeat = origin.beat;
                                    co.trackIndex = origin.track;
                                }
                            }
                        }
                        this._requestRedraw();
                        break;
                    }
                    const finalBeat = this._snapBeat(
                        Math.max(0, this._drag.clipOriginalBeat + deltaBeat),
                    );
                    const finalTrack = Math.max(
                        0,
                        Math.min(this._viewport.trackCount - 1, this._drag.clipOriginalTrack + deltaTrack),
                    );

                    // Fire callback for the primary dragged clip if position changed.
                    if (
                        finalBeat !== this._drag.clipOriginalBeat ||
                        finalTrack !== this._drag.clipOriginalTrack
                    ) {
                        this.onClipMove?.(this._drag.clipId, finalBeat, finalTrack);
                    }
                    // Fire callbacks for co-movers.
                    if (this._drag.coMoverOrigins) {
                        for (const [id, origin] of this._drag.coMoverOrigins) {
                            const coFinalBeat = this._snapBeat(Math.max(0, origin.beat + deltaBeat));
                            const coFinalTrack = Math.max(0, Math.min(this._viewport.trackCount - 1, origin.track + deltaTrack));
                            if (coFinalBeat !== origin.beat || coFinalTrack !== origin.track) {
                                this.onClipMove?.(id, coFinalBeat, coFinalTrack);
                            }
                        }
                    }
                }
                break;
            }

            case DragMode.ClipResizeLeft:
            case DragMode.ClipResizeRight: {
                if (this._drag.clipId) {
                    const preview = this._trimPreview;
                    if (preview && preview.clipId === this._drag.clipId) {
                        // Commit trim to Rust only on pointerup.
                        if (
                            preview.startBeat !== this._drag.clipOriginalBeat ||
                            preview.durationBeats !== this._drag.clipOriginalDuration
                        ) {
                            this.onClipResize?.(this._drag.clipId, preview.startBeat, preview.durationBeats);
                        }
                    }
                }
                this._trimPreview = null;
                this._requestRedraw();
                break;
            }

            case DragMode.ClipFadeIn:
            case DragMode.ClipFadeOut: {
                if (this._drag.clipId) {
                    const clip = this._clips.find((c) => c.id === this._drag.clipId);
                    if (!clip) break;
                    const durationFrames = Math.max(1, this._clipDurationFrames(clip));
                    const maxFadeFrames = Math.round(durationFrames * 0.5);
                    const fadeInFrames = Math.max(0, Math.min(maxFadeFrames, Math.round((clip.fadeIn ?? 0) * durationFrames)));
                    const fadeOutFrames = Math.max(0, Math.min(maxFadeFrames, Math.round((clip.fadeOut ?? 0) * durationFrames)));
                    const prevFadeInFrames = Math.max(0, Math.min(maxFadeFrames, Math.round((this._drag.clipOriginalFadeIn ?? 0) * durationFrames)));
                    const prevFadeOutFrames = Math.max(0, Math.min(maxFadeFrames, Math.round((this._drag.clipOriginalFadeOut ?? 0) * durationFrames)));
                    if (fadeInFrames !== prevFadeInFrames || fadeOutFrames !== prevFadeOutFrames) {
                        this.onClipFades?.(this._drag.clipId, fadeInFrames, fadeOutFrames);
                    }
                }
                this._requestRedraw();
                break;
            }

            case DragMode.ClipFadeInCurve:
            case DragMode.ClipFadeOutCurve: {
                if (this._drag.clipId) {
                    const clip = this._clips.find((c) => c.id === this._drag.clipId);
                    if (clip) {
                        const nextIn = this._clampFadeCurve(clip.fadeInCurve ?? 0.5);
                        const nextOut = this._clampFadeCurve(clip.fadeOutCurve ?? 0.5);
                        const prevIn = this._clampFadeCurve(this._drag.clipOriginalFadeInCurve ?? 0.5);
                        const prevOut = this._clampFadeCurve(this._drag.clipOriginalFadeOutCurve ?? 0.5);
                        if (Math.abs(nextIn - prevIn) > 0.0001 || Math.abs(nextOut - prevOut) > 0.0001) {
                            this.onClipFadeCurves?.(clip.id, nextIn, nextOut);
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
                const isVerticalLine = Math.abs(maxBeat - minBeat) <= 1e-6 && minTrack !== maxTrack;
                const moved =
                    Math.abs(maxBeat - minBeat) >= 1e-6 || minTrack !== maxTrack;

                if (!moved) {
                    // Plain click on empty area: set cursor/track only.
                    const snappedBeat = this._snapBeat(this._drag.startBeat);
                    this.onEditCursorChange?.(snappedBeat, this._drag.startTrack, this._drag.startTrack);
                    this.onTrackSelect?.(this._drag.startTrack);
                    // Empty-space click clears current clip selection.
                    this.onClipBoxSelection?.([]);
                    this._setMarquee(null);
                } else if (isVerticalLine) {
                    // Vertical-only marquee becomes multi-cursor stripe.
                    const snappedBeat = this._snapBeat(Math.max(0, this._drag.startBeat));
                    this.onEditCursorChange?.(snappedBeat, this._drag.startTrack, this._drag.currentTrack);
                    this.onTrackSelect?.(this._drag.currentTrack);
                    this._setMarquee({
                        startBeat: snappedBeat,
                        endBeat: snappedBeat,
                        startTrack: minTrack,
                        endTrack: maxTrack,
                    });
                } else {
                    this._selectClipsWithinMarquee(minBeat, maxBeat, minTrack, maxTrack);
                }
                break;
            }

            case DragMode.MultiCursorSelect: {
                const minTrack = Math.min(this._drag.startTrack, this._drag.currentTrack);
                const maxTrack = Math.max(this._drag.startTrack, this._drag.currentTrack);
                const moved = minTrack !== maxTrack;
                const snappedBeat = this._snapBeat(Math.max(0, this._drag.startBeat));

                this.onEditCursorChange?.(snappedBeat, this._drag.startTrack, this._drag.currentTrack);
                this.onTrackSelect?.(this._drag.currentTrack);

                if (!moved) {
                    // Plain click on clip body: place cursor and clear box selection overlay.
                    this.onClipBoxSelection?.([]);
                    this._setMarquee(null);
                } else {
                    // Keep thin multi-cursor stripe active for subsequent Cmd+E split.
                    this._setMarquee({
                        startBeat: snappedBeat,
                        endBeat: snappedBeat,
                        startTrack: minTrack,
                        endTrack: maxTrack,
                    });
                }
                break;
            }
        }

        this._trimPreview = null;
        const hoveredAfterUp = this.hitTest(e.clientX, e.clientY);
        this._syncHoveredClip(hoveredAfterUp.type === 'clip' && hoveredAfterUp.clipId ? hoveredAfterUp.clipId : null);
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
                    if (hit.fadeHandle === 'in' || hit.fadeHandle === 'out') {
                        const clip = this._clips.find((c) => c.id === hit.clipId);
                        if (clip) {
                            if (hit.fadeHandle === 'in') clip.fadeIn = 0;
                            else clip.fadeOut = 0;
                            const durationFrames = Math.max(1, this._clipDurationFrames(clip));
                            const maxFadeFrames = Math.round(durationFrames * 0.5);
                            const fadeInFrames = Math.max(0, Math.min(maxFadeFrames, Math.round((clip.fadeIn ?? 0) * durationFrames)));
                            const fadeOutFrames = Math.max(0, Math.min(maxFadeFrames, Math.round((clip.fadeOut ?? 0) * durationFrames)));
                            this.onClipFades?.(clip.id, fadeInFrames, fadeOutFrames);
                            this._requestRedraw();
                            break;
                        }
                    }
                    if (hit.fadeCurveHandle === 'in' || hit.fadeCurveHandle === 'out') {
                        const clip = this._clips.find((c) => c.id === hit.clipId);
                        if (clip) {
                            const flags = this._fadeCurvePoints[clip.id] ?? { in: false, out: false };
                            if (hit.fadeCurveHandle === 'in') {
                                flags.in = true;
                                clip.showFadeInCurvePoint = true;
                                clip.fadeInCurve = 0.5;
                            } else {
                                flags.out = true;
                                clip.showFadeOutCurvePoint = true;
                                clip.fadeOutCurve = 0.5;
                            }
                            this._fadeCurvePoints[clip.id] = flags;
                            this.onClipFadeCurves?.(
                                clip.id,
                                this._clampFadeCurve(clip.fadeInCurve ?? 0.5),
                                this._clampFadeCurve(clip.fadeOutCurve ?? 0.5),
                            );
                            this._requestRedraw();
                            break;
                        }
                    }
                    if (hit.fadeZone === 'in' || hit.fadeZone === 'out') {
                        const clip = this._clips.find((c) => c.id === hit.clipId);
                        if (clip) {
                            const flags = this._fadeCurvePoints[clip.id] ?? { in: false, out: false };
                            if (hit.fadeZone === 'in') flags.in = true;
                            if (hit.fadeZone === 'out') flags.out = true;
                            this._fadeCurvePoints[clip.id] = flags;
                            clip.showFadeInCurvePoint = flags.in;
                            clip.showFadeOutCurvePoint = flags.out;
                            this._requestRedraw();
                            break;
                        }
                    }
                    // Body double-click: place edit cursor (same as single-click) — do NOT open
                    // the MIDI editor. Only a header double-click opens the MIDI editor.
                    if (hit.region === 'body') {
                        const snapped = this._snapBeat(hit.beat);
                        this.onEditCursorChange?.(snapped, hit.trackIndex, hit.trackIndex);
                        break;
                    }
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

    private _onContextMenu(e: MouseEvent): void {
        const hit = this.hitTest(e.clientX, e.clientY);
        // Bug #79: only intercept right-click on fade zone/curve handles.
        if (hit.type !== 'clip' || !hit.clipId) {
            return; // let native menu show
        }

        const side = hit.fadeCurveHandle ?? hit.fadeZone;
        if (side !== 'in' && side !== 'out') {
            return; // let native menu show
        }

        e.preventDefault();
        const clip = this._clips.find((c) => c.id === hit.clipId);
        if (!clip) return;

        const flags = this._fadeCurvePoints[clip.id] ?? { in: false, out: false };
        if (side === 'in') {
            flags.in = true;
            clip.showFadeInCurvePoint = true;
            clip.fadeInCurve = this._nextFadeCurvePreset(clip.fadeInCurve ?? 0.5);
        } else {
            flags.out = true;
            clip.showFadeOutCurvePoint = true;
            clip.fadeOutCurve = this._nextFadeCurvePreset(clip.fadeOutCurve ?? 0.5);
        }
        this._fadeCurvePoints[clip.id] = flags;

        this.onClipFadeCurves?.(
            clip.id,
            this._clampFadeCurve(clip.fadeInCurve ?? 0.5),
            this._clampFadeCurve(clip.fadeOutCurve ?? 0.5),
        );
        this._requestRedraw();
    }

    private _clampFadeFraction(value: number): number {
        return Math.max(0, Math.min(0.5, value));
    }

    private _clipDurationFrames(clip: TimelineClipData): number {
        if (clip.durationSamples && clip.durationSamples > 0) {
            return clip.durationSamples;
        }
        if (this._bpm <= 0 || this._sampleRate <= 0) return 1;
        return Math.max(1, beatDurationToFrames(clip.durationBeats, this._bpm, this._sampleRate));
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
            if (typeof requestIdleCallback === 'function') {
                if (this._prefetchIdleId) cancelIdleCallback(this._prefetchIdleId);
                this._prefetchIdleId = requestIdleCallback(() => {
                    this._prefetchIdleId = 0;
                    this._requestRedraw();
                }, { timeout: 300 });
            } else {
                if (this._prefetchTimeoutId !== null) clearTimeout(this._prefetchTimeoutId);
                this._prefetchTimeoutId = setTimeout(() => {
                    this._prefetchTimeoutId = null;
                    this._requestRedraw();
                }, 200);
            }
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

    private _onKeyDown(e: KeyboardEvent): void {
        this._metaKeyHeld = e.metaKey || e.ctrlKey;

        if (e.key === 'Escape') {
            if (this._drag.mode !== DragMode.None) {
                // Cancel drag: restore positions and end drag.
                if (this._drag.clipId) {
                    const c = this._clips.find(cl => cl.id === this._drag.clipId);
                    if (c) {
                        c.startBeat = this._drag.clipOriginalBeat;
                        c.trackIndex = this._drag.clipOriginalTrack;
                    }
                    if (this._drag.coMoverOrigins) {
                        for (const [id, origin] of this._drag.coMoverOrigins) {
                            const co = this._clips.find(cl => cl.id === id);
                            if (co) {
                                co.startBeat = origin.beat;
                                co.trackIndex = origin.track;
                            }
                        }
                    }
                }
                this._drag = { mode: DragMode.None, clipId: null, startBeat: 0, startTrack: 0, currentBeat: 0, currentTrack: 0, clipOriginalBeat: 0, clipOriginalTrack: 0, clipOriginalDuration: 0 };
                this._requestRedraw();
            } else if (this._marquee) {
                this._setMarquee(null);
            }
        }
    }
}
