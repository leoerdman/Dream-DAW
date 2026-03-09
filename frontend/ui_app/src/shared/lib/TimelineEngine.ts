
import { ViewportMatrix, type ViewportSnapshot } from './ViewportMatrix';
import { CanvasClipRenderer, type TimelineClipData, type LoopRegion, type GhostClipData } from './CanvasClipRenderer';
import { FADE_HANDLE_SIZE, FADE_HANDLE_EDGE_PAD, CLIP_BODY_INSET, EDGE_RESIZE_PAD_PX, FADE_CURVE_CLAMP_MIN, FADE_CURVE_CLAMP_MAX, MIN_FADE_WIDTH_PX, MIN_FADE_BODY_HEIGHT_PX } from './CanvasClipRenderer.constants';
import { WaveformCache } from './WaveformCache';
import { beatDurationToFrames, framesToBeatDuration } from './audioMath';
import { normalizeTimelineClips } from './clipNormalization';
import { cancelIdle, scheduleIdle, type IdleHandle } from './idleScheduler';
import {
    BEAT_COMMIT_THRESHOLD,
    CLIP_DRAG_START_THRESHOLD_PX,
    CLIP_HEADER_HEIGHT_PX,
    CURVE_X_WEIGHT,
    CURVE_Y_WEIGHT,
    DEFAULT_FADE_CURVE,
    DragMode,
    EDGE_GRIP_PX,
    EDGE_WIDTH_MAX_RATIO,
    EDGE_WIDTH_MIN_PX,
    EDGE_WIDTH_MIN_RATIO,
    FADE_CURVE_HANDLE_RADIUS_PX,
    FADE_CURVE_PRESETS,
    FADE_HANDLE_HOTSPOT_PX,
    FINE_FACTOR_ALT,
    FINE_FACTOR_ALT_SHIFT,
    FINE_FACTOR_CURVE_ALT,
    FINE_FACTOR_CURVE_SHIFT,
    FINE_FACTOR_SHIFT,
    MIN_LOOP_BEATS,
    MIN_RESIZE_DURATION_BEATS,
    RESIZE_BOUNDARY_EPS,
    TRACK_COMMIT_THRESHOLD,
    type DragState,
    type HitTestResult,
    type MarqueeSelection,
    type TimelineEngineConfig,
    type TrimPreviewState,
    isLoopRegionChanged,
} from './TimelineEngine.types';

export class TimelineEngine {
    private readonly _viewport: ViewportMatrix;
    private readonly _renderer: CanvasClipRenderer;
    private readonly _waveformCache: WaveformCache;

    private _canvas: HTMLCanvasElement | null = null;
    private _ctx: CanvasRenderingContext2D | null = null;
    private _rafId: number = 0;
    private _resizeObserver: ResizeObserver | null = null;
    private _resizeRafId = 0;

    private _clips: TimelineClipData[] = [];
    /** PERF-OPT-1: O(1) clip lookup by ID — built in setClips(). */
    private _clipById = new Map<string, TimelineClipData>();
    /** PERF-OPT-2: O(1) per-track clip lookup — avoids scanning all clips in hitTest. */
    private _clipsByTrack = new Map<number, TimelineClipData[]>();
    /** Deferred clips from setClips() calls during active drag. */
    private _pendingClips: TimelineClipData[] | null = null;
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
    /** Ghost clips rendered during Cmd+Drag to preview duplication. */
    private _cmdDragGhosts: TimelineClipData[] = [];

    private _beatsPerBar: number;
    private _bpm: number;
    private _sampleRate: number;
    private _snapBeats: number;
    private _snapEnabled: boolean;
    private _automationVisible: boolean;

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

    private _boundWheel: (e: WheelEvent) => void;
    private _boundPointerDown: (e: PointerEvent) => void;
    private _boundPointerMove: (e: PointerEvent) => void;
    private _boundPointerUp: (e: PointerEvent) => void;
    private _boundDblClick: (e: MouseEvent) => void;
    private _boundContextMenu: (e: MouseEvent) => void;
    private _boundKeyDown: (e: KeyboardEvent) => void;
    private _boundKeyUp: (e: KeyboardEvent) => void;
    private _boundWindowBlur: () => void;

    /** Deferred prefetch redraw handle (idle callback or fallback timeout). */
    private _prefetchDeferredId: IdleHandle | null = null;
    /** Debounce timer for _prefetchVisibleWaveforms during rapid zoom/scroll. */
    private _prefetchDebounceId: ReturnType<typeof setTimeout> | null = null;

    onClipClick?: (clipId: string, isShift: boolean, isCtrl: boolean) => void;
    onClipMove?: (clipId: string, newBeat: number, newTrack: number) => void;
    onClipDuplicate?: (clipId: string, newBeat: number, newTrack: number) => void;
    onClipResize?: (clipId: string, newStartBeat: number, newDuration: number, allowStretch: boolean, optSourceOffset?: number) => void;
    onClipFades?: (clipId: string, fadeInFrames: number, fadeOutFrames: number) => void;
    onClipFadeCurves?: (clipId: string, fadeInCurve: number, fadeOutCurve: number) => void;
    onClipContextMenu?: (clipId: string, beat: number, trackIndex: number, clientX: number, clientY: number) => void;
    onPlayheadSeek?: (beat: number) => void;
    onEditCursorChange?: (beat: number, trackStart: number, trackEnd: number) => void;
    onDoubleClickTrack?: (trackIndex: number, beat: number) => void;
    onDoubleClickClip?: (clipId: string, trackIndex: number) => void;
    onTrackSelect?: (trackIndex: number) => void;
    onViewportFlush?: (snapshot: ViewportSnapshot) => void;
    onFrameDrawn?: (snapshot: {
        playheadBeat: number;
        playheadX: number;
        scrollX: number;
        pixelsPerBeat: number;
        viewportWidth: number;
    }) => void;
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

    constructor(config: TimelineEngineConfig) {
        this._beatsPerBar = config.beatsPerBar;
        this._bpm = config.bpm;
        this._sampleRate = config.sampleRate;
        this._snapBeats = config.snapBeats ?? 1;
        this._snapEnabled = config.snapEnabled ?? true;
        this._automationVisible = config.automationVisible ?? false;

        this._waveformCache = new WaveformCache();
        // ENTERPRISE: When async waveform data arrives, schedule a redraw
        // so clips show waveforms immediately after project open.
        this._waveformCache.onDataReady = () => {
            this._requestRedraw();
        };
        this._renderer = new CanvasClipRenderer(this._waveformCache);
        this._viewport = new ViewportMatrix(config.viewport);

        this._viewport.setFlushCallback((snap) => {
            this.onViewportFlush?.(snap);
        });

        this._viewport.setScrollYChangeCallback((scrollY) => {
            this.onScrollTop?.(scrollY);
        });

        this._boundWheel = this._onWheel.bind(this);
        this._boundPointerDown = this._onPointerDown.bind(this);
        this._boundPointerMove = this._onPointerMove.bind(this);
        this._boundPointerUp = this._onPointerUp.bind(this);
        this._boundDblClick = this._onDoubleClick.bind(this);
        this._boundContextMenu = this._onContextMenu.bind(this);
        this._boundKeyDown = this._onKeyDown.bind(this);
        this._boundKeyUp = this._onKeyUp.bind(this);
        this._boundWindowBlur = this._onWindowBlur.bind(this);
    }

    /**
     * Attach the engine to a canvas element.
     * This starts the render loop and event listeners.
     */
    attach(canvas: HTMLCanvasElement): void {
        if (this._canvas) this.detach();

        this._canvas = canvas;
        this._ctx = canvas.getContext('2d', { alpha: false });
        if (!this._ctx) {
            this._canvas = null;
            return;
        }

        this._syncCanvasSize();

        this._resizeObserver = new ResizeObserver(() => {
            this._scheduleCanvasResizeSync();
        });
        this._resizeObserver.observe(canvas);

        canvas.addEventListener('wheel', this._boundWheel, { passive: false });
        canvas.addEventListener('pointerdown', this._boundPointerDown);
        canvas.addEventListener('dblclick', this._boundDblClick);
        canvas.addEventListener('contextmenu', this._boundContextMenu);

        // ENTERPRISE FIX (Phase 33): Use pointer events for window-level listeners.
        // Legacy mousemove/mouseup missed pointercancel — OS interrupts (alerts,
        // sleep, 3-finger swipe) left the engine in stuck drag state.
        window.addEventListener('pointermove', this._boundPointerMove);
        window.addEventListener('pointerup', this._boundPointerUp);
        window.addEventListener('pointercancel', this._boundPointerUp);
        window.addEventListener('keydown', this._boundKeyDown, { capture: true });
        window.addEventListener('keyup', this._boundKeyUp, { capture: true });
        window.addEventListener('blur', this._boundWindowBlur);

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
            canvas.removeEventListener('pointerdown', this._boundPointerDown);
            canvas.removeEventListener('dblclick', this._boundDblClick);
            canvas.removeEventListener('contextmenu', this._boundContextMenu);
        }

        window.removeEventListener('pointermove', this._boundPointerMove);
        window.removeEventListener('pointerup', this._boundPointerUp);
        window.removeEventListener('pointercancel', this._boundPointerUp);
        window.removeEventListener('keydown', this._boundKeyDown, { capture: true });
        window.removeEventListener('keyup', this._boundKeyUp, { capture: true });
        window.removeEventListener('blur', this._boundWindowBlur);

        cancelIdle(this._prefetchDeferredId);
        this._prefetchDeferredId = null;
        if (this._prefetchDebounceId !== null) {
            clearTimeout(this._prefetchDebounceId);
            this._prefetchDebounceId = null;
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

    setClips(clips: TimelineClipData[]): void {
        // ENTERPRISE FIX: Skip setClips during active drag to prevent stale
        // store data from overwriting drag visuals. The drag operates on internal
        // clip objects; when the store triggers a React re-render, useEffect calls
        // setClips with PRE-DRAG positions, causing clips to snap back visually.
        if (this._drag.mode !== DragMode.None) {
            this._pendingClips = clips;
            return;
        }

        const prevClips = this._clips;
        const normalizedInput = normalizeTimelineClips(clips);

        // PERF FIX: Only spread-copy clips whose hovered/fade flags actually differ.
        // Previously .map() spread-copied EVERY clip on EVERY setClips() call.
        const nextClips: TimelineClipData[] = new Array(normalizedInput.length);
        for (let i = 0; i < normalizedInput.length; i++) {
            const clip = normalizedInput[i];
            const hovered = this._hoverClipId === clip.id;
            const flags = this._fadeCurvePoints[clip.id];
            const showIn = Boolean(flags?.in);
            const showOut = Boolean(flags?.out);

            // SSOT FIX: Carry over selection state from old internal clip objects.
            // React provides fresh clip objects without selectionStartBeat/selectionEndBeat.
            // We must preserve these fields from the engine's internal state so that
            // marquee-computed partial selection ranges survive React re-renders.
            const oldClip = this._clipById.get(clip.id);
            const sel = oldClip?.selected ?? clip.selected;
            const priSel = oldClip?.primarySelected ?? clip.primarySelected;
            const selStart = sel ? (oldClip?.selectionStartBeat) : undefined;
            const selEnd = sel ? (oldClip?.selectionEndBeat) : undefined;

            // ENTERPRISE: Cross-clamp fadeIn+fadeOut to prevent sum > 1.0
            let fadeIn = clip.fadeIn ?? 0;
            let fadeOut = clip.fadeOut ?? 0;
            if (fadeIn + fadeOut > 1.0 && (fadeIn + fadeOut) > 0) {
                const total = fadeIn + fadeOut;
                fadeIn = fadeIn / total;
                fadeOut = fadeOut / total;
            }

            // Fast path: if merged result matches the input clip, reuse without allocation.
            // NOTE: React provides clip.selected=false, but engine may have set it to true.
            // We compare merged values against the clip to decide if a new object is needed.
            if (
                clip.hovered === hovered &&
                clip.showFadeInCurvePoint === showIn &&
                clip.showFadeOutCurvePoint === showOut &&
                clip.selected === sel &&
                clip.primarySelected === priSel &&
                clip.selectionStartBeat === selStart &&
                clip.selectionEndBeat === selEnd &&
                clip.fadeIn === fadeIn &&
                clip.fadeOut === fadeOut
            ) {
                nextClips[i] = clip;
            } else {
                nextClips[i] = {
                    ...clip,
                    hovered,
                    showFadeInCurvePoint: showIn,
                    showFadeOutCurvePoint: showOut,
                    selected: sel,
                    primarySelected: priSel,
                    selectionStartBeat: selStart,
                    selectionEndBeat: selEnd,
                    fadeIn,
                    fadeOut,
                };
            }
        }
        this._clips = nextClips;

        // PERF-OPT-1: Build O(1) lookup map after clip array update.
        this._clipById.clear();
        this._clipsByTrack.clear();
        for (const c of this._clips) {
            this._clipById.set(c.id, c);
            let arr = this._clipsByTrack.get(c.trackIndex);
            if (!arr) { arr = []; this._clipsByTrack.set(c.trackIndex, arr); }
            arr.push(c);
        }

        // PERF FIX: Build ID Set directly via for-loop — avoids .map() intermediate array.
        const currentIds = new Set<string>();
        for (let i = 0; i < normalizedInput.length; i++) currentIds.add(normalizedInput[i].id);

        for (const id of Object.keys(this._fadeCurvePoints)) {
            if (!currentIds.has(id)) delete this._fadeCurvePoints[id];
        }
        if (this._hoverClipId && !currentIds.has(this._hoverClipId)) {
            this._hoverClipId = null;
        }
        if (this._trimPreview && !currentIds.has(this._trimPreview.clipId)) {
            this._trimPreview = null;
        }
        if (this._drag.clipId && !currentIds.has(this._drag.clipId)) {
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
            this._trimPreview = null;
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
        const primarySelectedId = selectedClipIds.length > 0 ? selectedClipIds[selectedClipIds.length - 1] : null;
        let changed = false;

        // SSOT FIX: When a marquee is active, _selectClipsWithinMarquee has already
        // computed partial selectionStartBeat/selectionEndBeat on the internal clips.
        // If React re-renders and calls setClipSelection (via useTimelineClipSync),
        // we must PRESERVE those partial ranges rather than overwriting them with
        // full-clip ranges (0 → durationBeats).
        const hasMarquee = this._marquee !== null;

        // PERF FIX: Mutate in-place instead of .map() to avoid O(N) object allocation.
        // Only create new objects for clips whose selection state actually changed.
        for (let i = 0, len = this._clips.length; i < len; i++) {
            const clip = this._clips[i];
            const nextSelected = selected.has(clip.id);
            const nextPrimarySelected = primarySelectedId === clip.id;

            // SSOT FIX: Even if selected/primarySelected flags haven't changed,
            // we may need to upgrade partial selection ranges to full-clip ranges
            // after a marquee was dismissed (Escape key). Without this check,
            // partial highlights from the marquee persist indefinitely.
            const hasStalePartialRange = nextSelected && !hasMarquee
                && clip.selectionStartBeat !== undefined
                && clip.selectionEndBeat !== undefined
                && (clip.selectionStartBeat !== 0 || clip.selectionEndBeat !== clip.durationBeats);

            if (clip.selected === nextSelected && clip.primarySelected === nextPrimarySelected && !hasStalePartialRange) continue;
            changed = true;

            // Determine selection ranges:
            // - If marquee is active AND this clip already has partial ranges from
            //   _selectClipsWithinMarquee, preserve them.
            // - Otherwise, use full-clip range (0 → durationBeats).
            let selStart: number | undefined;
            let selEnd: number | undefined;
            if (nextSelected) {
                if (hasMarquee && clip.selectionStartBeat !== undefined && clip.selectionEndBeat !== undefined) {
                    // Preserve existing partial selection ranges from marquee
                    selStart = clip.selectionStartBeat;
                    selEnd = clip.selectionEndBeat;
                } else {
                    // Full clip highlight (header click or non-marquee selection)
                    selStart = 0;
                    selEnd = clip.durationBeats;
                }
            }

            const updated: TimelineClipData = {
                ...clip,
                selected: nextSelected,
                primarySelected: nextPrimarySelected,
                selectionStartBeat: selStart,
                selectionEndBeat: selEnd,
            };
            this._updateClipInStores(i, clip, updated);
        }

        if (!changed) return;
        // PERF #4: Update renderer's tracked selection flag (avoids O(N) clips.some() per frame)
        this._renderer.setHasClipSelection(selected.size > 0);
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

        if (normalizedPrimary >= 0 && !cleaned.includes(normalizedPrimary)) cleaned.unshift(normalizedPrimary);

        const samePrimary = normalizedPrimary === this._selectedTrack;
        const sameList = cleaned.length === this._selectedTracks.length && cleaned.every((v, i) => v === this._selectedTracks[i]);
        if (samePrimary && sameList) return;

        this._selectedTrack = normalizedPrimary;
        this._selectedTracks = cleaned;
        this._requestRedraw();
    }

    setLoop(loop: LoopRegion | null): void {
        if (this._drag.mode === DragMode.LoopStartMove || this._drag.mode === DragMode.LoopEndMove) {
            return;
        }

        if (!loop) {
            if (this._loop !== null) {
                this._loop = null;
                this._requestRedraw();
            }
        } else {
            const changed = isLoopRegionChanged(this._loop, loop);

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

    /**
     * Update group track metadata for miniature rendering.
     * @param groupTracks Map of group-track-index → array of child-track-indices
     * @param trackColors Map of track-index → hex color string
     */
    setTrackMeta(
        groupTracks: Map<number, number[]>,
        trackColors: Map<number, string>,
    ): void {
        this._renderer.setGroupTracks(groupTracks, trackColors);
        this._requestRedraw();
    }

    setConfig(config: Partial<TimelineEngineConfig>): void {
        // PERF #11: Track whether any value actually changed before triggering redraw.
        let changed = false;
        if (config.beatsPerBar !== undefined && config.beatsPerBar !== this._beatsPerBar) {
            this._beatsPerBar = config.beatsPerBar; changed = true;
        }
        if (config.bpm !== undefined && config.bpm !== this._bpm) {
            this._bpm = config.bpm; changed = true;
        }
        if (config.sampleRate !== undefined && config.sampleRate !== this._sampleRate) {
            this._sampleRate = config.sampleRate; changed = true;
        }
        if (config.snapBeats !== undefined && config.snapBeats !== this._snapBeats) {
            this._snapBeats = config.snapBeats; changed = true;
        }
        if (config.snapEnabled !== undefined && config.snapEnabled !== this._snapEnabled) {
            this._snapEnabled = config.snapEnabled; changed = true;
        }
        if (config.automationVisible !== undefined && config.automationVisible !== this._automationVisible) {
            this._automationVisible = config.automationVisible; changed = true;
        }
        if (config.viewport) {
            this._viewport.updateConfig(config.viewport);
            // ViewportMatrix.updateConfig sets its own dirty flag if anything changed
            changed = true;
        }
        if (changed) this._requestRedraw();
    }

    /** Ensure a beat is visible (playhead follow). */
    ensureBeatVisible(beat: number): void {
        this._viewport.ensureBeatVisible(beat);
    }

    /** Set vertical scroll position (for external sync, e.g. TrackInspector). */
    setScrollY(y: number): void {
        this._viewport.scrollTo(this._viewport.scrollX, y);
    }

    get viewport(): ViewportMatrix {
        return this._viewport;
    }

    private _needsRedraw = true;
    /** Tracks edit cursor blink state (on/off) for the 500ms blink cycle (PERF-FIX-3). */
    private _lastCursorBlinkOn = true;

    private _requestRedraw(): void {
        this._needsRedraw = true;
    }

    private _drawFrameNow(force = false): void {
        const hasEditCursor = this._editCursorBeat >= 0;
        if (hasEditCursor) {
            const now = performance.now();
            const blinkOn = (Math.floor(now / 500) % 2) === 0;
            if (blinkOn !== this._lastCursorBlinkOn) {
                this._lastCursorBlinkOn = blinkOn;
                this._needsRedraw = true;
            }
        }
        if (!force && !this._needsRedraw && !this._viewport.isDirty) return;
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
            this._automationVisible,
        );
        this.onFrameDrawn?.({
            playheadBeat: this._playheadBeat,
            playheadX: this._viewport.beatsToScreenX(this._playheadBeat),
            scrollX: this._viewport.scrollX,
            pixelsPerBeat: this._viewport.pixelsPerBeat,
            viewportWidth: this._viewport.viewportWidth,
        });
    }

    private _tick = (): void => {
        this._rafId = requestAnimationFrame(this._tick);

        this._drawFrameNow();
    };

    private _composeDrawClips(): TimelineClipData[] {
        const preview = this._trimPreview;
        const hasGhosts = this._cmdDragGhosts.length > 0;

        if (!preview && !hasGhosts) return this._clips;

        let base: TimelineClipData[];
        if (!preview) {
            base = this._clips;
        } else {
            base = this._clips.map((clip) => {
                if (clip.id !== preview.clipId) return clip;

                const nextClip: TimelineClipData = {
                    ...clip,
                    startBeat: preview.startBeat,
                    durationBeats: preview.durationBeats,
                };
                if (clip.type === 'midi') {
                    if (preview.edge === 'left' && !preview.allowStretch) {
                        const trimmedBeats = preview.startBeat - preview.originalStartBeat;
                        if (trimmedBeats !== 0 && clip.midiNotes) {
                            nextClip.midiNotes = clip.midiNotes.map((note) => ({
                                ...note,
                                startBeat: note.startBeat - trimmedBeats,
                            })).filter(note => note.startBeat + note.durationBeats > 0);
                        }
                    }
                    return nextClip;
                }

                if (clip.type !== 'audio' || !clip.durationSamples) {
                    return nextClip;
                }

                if (!preview.allowStretch) {
                    const previewFrames = Math.max(1, beatDurationToFrames(preview.durationBeats, this._bpm, this._sampleRate));
                    const clipSourceOffset = Math.max(0, clip.sourceOffset ?? 0);
                    if (clip.isWarped && (clip.warpSourceDurationFrames ?? 0) > 0 && (clip.durationSamples ?? 0) > 0) {
                        const sourceTotal = Math.max(1, clip.warpSourceDurationFrames ?? 1);
                        const sourceAvailableBefore = Math.max(1, sourceTotal - clipSourceOffset);
                        const sourcePerTimeline = sourceAvailableBefore / Math.max(1, clip.durationSamples ?? 1);

                        let nextSourceOffset = clipSourceOffset;
                        if (preview.edge === 'left') {
                            const trimmedBeats = Math.max(0, preview.startBeat - preview.originalStartBeat);
                            const trimmedFrames = Math.max(0, beatDurationToFrames(trimmedBeats, this._bpm, this._sampleRate));
                            nextSourceOffset = Math.max(0, Math.round(clipSourceOffset + trimmedFrames * sourcePerTimeline));
                        }
                        nextSourceOffset = Math.min(nextSourceOffset, Math.max(0, sourceTotal - 1));

                        const sourceAvailableAfter = Math.max(1, sourceTotal - nextSourceOffset);
                        const maxPreviewFrames = Math.max(1, Math.floor(sourceAvailableAfter / Math.max(1e-9, sourcePerTimeline)));
                        const clampedPreviewFrames = Math.max(1, Math.min(previewFrames, maxPreviewFrames));
                        const consumedSource = Math.max(1, Math.round(clampedPreviewFrames * sourcePerTimeline));

                        nextClip.durationSamples = clampedPreviewFrames;
                        nextClip.sourceOffset = nextSourceOffset;
                        nextClip.warpSourceDurationFrames = nextSourceOffset + consumedSource;
                    } else {
                        let trimmedBeats = preview.edge === 'left' ? preview.startBeat - preview.originalStartBeat : 0;
                        let trimmedFrames = beatDurationToFrames(trimmedBeats, this._bpm, this._sampleRate);

                        // Prevent expanding left beyond the beginning of the audio source
                        if (trimmedFrames < -clipSourceOffset) {
                            trimmedFrames = -clipSourceOffset;
                            trimmedBeats = framesToBeatDuration(trimmedFrames, this._bpm, this._sampleRate);
                        }

                        const nextSourceOffset = Math.max(0, clipSourceOffset + trimmedFrames);
                        const sourceTotal = Math.max(1, clip.warpSourceDurationFrames ?? clip.durationSamples ?? 1);
                        const availableFrames = Math.max(1, sourceTotal - nextSourceOffset);

                        const clampedPreviewFrames = Math.max(1, Math.min(previewFrames, availableFrames));

                        nextClip.durationSamples = clampedPreviewFrames;
                        nextClip.sourceOffset = nextSourceOffset;

                        if (preview.edge === 'left') {
                            nextClip.startBeat = preview.originalStartBeat + trimmedBeats;
                            nextClip.durationBeats = preview.originalDurationBeats - trimmedBeats;
                        } else {
                            nextClip.durationBeats = framesToBeatDuration(clampedPreviewFrames, this._bpm, this._sampleRate);
                        }
                    }
                } else {
                    const ratio = preview.durationBeats / (clip.durationBeats || 1);
                    nextClip.durationSamples = Math.max(1, Math.round(clip.durationSamples * ratio));
                    if (!clip.isWarped) {
                        nextClip.isWarped = true;
                        nextClip.warpSourceDurationFrames = clip.durationSamples;
                    }
                }

                return nextClip;
            });
        }

        // ENTERPRISE: Append Cmd+Drag ghost clips to the draw list
        if (hasGhosts) {
            return [...base, ...this._cmdDragGhosts];
        }
        return base;
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
            if ((a.fadeInCurve ?? DEFAULT_FADE_CURVE) !== (b.fadeInCurve ?? DEFAULT_FADE_CURVE)) return true;
            if ((a.fadeOutCurve ?? DEFAULT_FADE_CURVE) !== (b.fadeOutCurve ?? DEFAULT_FADE_CURVE)) return true;
            if ((a.muted ?? false) !== (b.muted ?? false)) return true;
            if ((a.isOffline ?? false) !== (b.isOffline ?? false)) return true;
            if ((a.color ?? '') !== (b.color ?? '')) return true;
            if ((a.name ?? '') !== (b.name ?? '')) return true;
            if ((a.isWarped ?? false) !== (b.isWarped ?? false)) return true;
            if ((a.warpSourceDurationFrames ?? 0) !== (b.warpSourceDurationFrames ?? 0)) return true;
            if ((a.pitchShiftSemitones ?? 0) !== (b.pitchShiftSemitones ?? 0)) return true;
            if ((a.trackDisabled ?? false) !== (b.trackDisabled ?? false)) return true;
        }
        return false;
    }

    private _clientToWorld(clientX: number, clientY: number): { beat: number; trackIndex: number } {
        const canvas = this._canvas;
        if (!canvas) return { beat: 0, trackIndex: 0 };
        const rect = canvas.getBoundingClientRect();
        return {
            beat: this._viewport.screenToBeats(clientX, rect),
            trackIndex: this._viewport.screenToTrack(clientY, rect),
        };
    }

    private _syncCanvasSize(): void {
        const canvas = this._canvas;
        if (!canvas) return;

        const rect = canvas.getBoundingClientRect();
        if (rect.width <= 0 || rect.height <= 0) return;
        const dpr = window.devicePixelRatio || 1;

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

    private _onWheel(e: WheelEvent): void {
        e.preventDefault();
        const canvas = this._canvas;
        if (!canvas) return;

        const rect = canvas.getBoundingClientRect();

        if (e.ctrlKey || e.metaKey) {
            this._viewport.zoomAtScreenX(e.deltaY, e.clientX, rect);
        } else if (e.shiftKey) {
            this._viewport.scrollBy(e.deltaY, 0);
        } else {
            this._viewport.scrollBy(e.deltaX, e.deltaY);
        }

        // Debounce waveform prefetch so it doesn't run on every scroll tick
        if (this._prefetchDebounceId !== null) clearTimeout(this._prefetchDebounceId);
        this._prefetchDebounceId = setTimeout(() => {
            this._prefetchDebounceId = null;
            this._prefetchVisibleWaveforms();
        }, 100);
    }

    hitTest(clientX: number, clientY: number): HitTestResult {
        const canvas = this._canvas;
        if (!canvas) return { type: 'empty', beat: 0, trackIndex: 0 };

        const rect = canvas.getBoundingClientRect();
        const localY = clientY - rect.top;

        if (localY < this._viewport.rulerHeight) {
            const beat = this._viewport.screenToBeats(clientX, rect);

            if (this._loop) {
                const startPx = this._viewport.beatsToScreenX(this._loop.start);
                const endPx = this._viewport.beatsToScreenX(this._loop.end);
                const localX = clientX - rect.left;

                if (Math.abs(localX - startPx) <= FADE_HANDLE_HOTSPOT_PX) {
                    return { type: 'ruler', beat, trackIndex: -1, loopHandle: 'start' };
                }
                if (Math.abs(localX - endPx) <= FADE_HANDLE_HOTSPOT_PX) {
                    return { type: 'ruler', beat, trackIndex: -1, loopHandle: 'end' };
                }
            }

            return { type: 'ruler', beat, trackIndex: -1 };
        }

        const world = this._clientToWorld(clientX, clientY);
        const beat = world.beat;
        const trackIndex = world.trackIndex;

        // PERF-OPT-2: Only iterate clips on the hovered track via per-track index.
        const trackClips = this._clipsByTrack.get(trackIndex);
        if (!trackClips || trackClips.length === 0) return { type: 'track', beat, trackIndex };
        for (let i = trackClips.length - 1; i >= 0; i--) {
            const clip = trackClips[i];

            const clipLeftPx = this._viewport.beatsToScreenX(clip.startBeat);
            const clipRightPx = this._viewport.beatsToScreenX(clip.startBeat + clip.durationBeats);
            const localX = clientX - rect.left;

            const isInsideOrNear = localX >= clipLeftPx - EDGE_GRIP_PX && localX <= clipRightPx + EDGE_GRIP_PX;

            if (isInsideOrNear) {
                const clipTopPx =
                    this._viewport.rulerHeight + this._viewport.trackOffsetY(clip.trackIndex) - this._viewport.scrollY;
                const localYInClip = Math.max(0, clientY - rect.top - clipTopPx);
                const localYPx = clientY - rect.top;
                const trackH = this._viewport.trackHeightAt(clip.trackIndex);
                const region: 'header' | 'body' =
                    localYInClip <= Math.min(CLIP_HEADER_HEIGHT_PX, trackH - CLIP_BODY_INSET)
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
                    // ENTERPRISE: Square handles pressed to header bottom — rectangular hit test
                    const handleTopY = fadeBody.top; // Top of body = bottom of header
                    const inHandleX = clipLeftPx + Math.max(FADE_HANDLE_EDGE_PAD, Math.min(clipWidthPx - FADE_HANDLE_EDGE_PAD, fadeInWidthPx));
                    const outHandleX = clipRightPx - Math.max(FADE_HANDLE_EDGE_PAD, Math.min(clipWidthPx - FADE_HANDLE_EDGE_PAD, fadeOutWidthPx));
                    const pad = FADE_HANDLE_HOTSPOT_PX;
                    if (
                        localX >= inHandleX - FADE_HANDLE_SIZE / 2 - pad &&
                        localX <= inHandleX + FADE_HANDLE_SIZE / 2 + pad &&
                        localYPx >= handleTopY - pad &&
                        localYPx <= handleTopY + FADE_HANDLE_SIZE + pad
                    ) {
                        fadeHandle = 'in';
                    } else if (
                        localX >= outHandleX - FADE_HANDLE_SIZE / 2 - pad &&
                        localX <= outHandleX + FADE_HANDLE_SIZE / 2 + pad &&
                        localYPx >= handleTopY - pad &&
                        localYPx <= handleTopY + FADE_HANDLE_SIZE + pad
                    ) {
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
                const edgeWidth = Math.min(clipWidthPx * EDGE_WIDTH_MAX_RATIO, Math.max(EDGE_WIDTH_MIN_PX, clipWidthPx * EDGE_WIDTH_MIN_RATIO));
                if (localX >= clipLeftPx - EDGE_RESIZE_PAD_PX && localX <= clipLeftPx + edgeWidth) {
                    edge = 'left';
                } else if (localX <= clipRightPx + EDGE_RESIZE_PAD_PX && localX >= clipRightPx - edgeWidth) {
                    edge = 'right';
                }

                if (fadeHandle || fadeCurveHandle) {
                    edge = undefined;
                }

                if (!edge && (localX < clipLeftPx || localX > clipRightPx)) {
                    continue;
                }

                return { type: 'clip', clipId: clip.id, beat, trackIndex, region, edge, fadeHandle, fadeCurveHandle, fadeZone };
            }
        }

        return { type: 'track', beat, trackIndex };
    }

    /** Rebuilds _clipsByTrack from current _clips array. Call after in-place trackIndex mutations (drag). */
    private _rebuildClipsByTrack(): void {
        this._clipsByTrack.clear();
        for (const c of this._clips) {
            let arr = this._clipsByTrack.get(c.trackIndex);
            if (!arr) { arr = []; this._clipsByTrack.set(c.trackIndex, arr); }
            arr.push(c);
        }
    }

    /**
     * SSOT: Atomically updates clip in all 3 stores (_clips, _clipById, _clipsByTrack).
     * Prevents the duplicated sync pattern that was previously in 5 places.
     */
    private _updateClipInStores(index: number, oldClip: TimelineClipData, newClip: TimelineClipData): void {
        this._clips[index] = newClip;
        this._clipById.set(newClip.id, newClip);
        const trackArr = this._clipsByTrack.get(newClip.trackIndex);
        if (trackArr) {
            const tIdx = trackArr.indexOf(oldClip);
            if (tIdx >= 0) trackArr[tIdx] = newClip;
        }
    }

    /** Clears selection state on a single clip by index (avoids copy-paste). */
    private _deselectClipAt(i: number): void {
        const clip = this._clips[i];
        if (!clip.selected) return;
        const cleared: TimelineClipData = { ...clip, selected: false, primarySelected: false, selectionStartBeat: undefined, selectionEndBeat: undefined };
        this._updateClipInStores(i, clip, cleared);
    }

    /**
     * SSOT HELPER: Selects a single clip by ID, updating all 3 stores atomically.
     * Must be called AFTER _clearAllClipSelections() to avoid stale references.
     * Re-fetches the clip from _clipById because clear may have replaced objects.
     */
    private _selectSingleClip(clipId: string): void {
        const freshClip = this._clipById.get(clipId);
        if (!freshClip) return;
        const selectedClip: TimelineClipData = {
            ...freshClip,
            selected: true,
            primarySelected: true,
            selectionStartBeat: 0,
            selectionEndBeat: freshClip.durationBeats,
        };
        const clipIdx = this._clips.indexOf(freshClip);
        if (clipIdx >= 0) this._updateClipInStores(clipIdx, freshClip, selectedClip);
        this._renderer.setHasClipSelection(true);
    }

    /** Clears selection+ranges on all internal clips. Used when marquee is dismissed. */
    private _clearAllClipSelections(): void {
        for (let i = 0, len = this._clips.length; i < len; i++) {
            this._deselectClipAt(i);
        }
        this._renderer.setHasClipSelection(false);
    }

    /** SSOT: Atomic clear selection + notify React in one call. */
    private _clearSelectionAndNotify(): void {
        this._clearAllClipSelections();
        this.onClipBoxSelection?.([]);
    }

    private _selectClipsWithinMarquee(
        startBeat: number,
        endBeat: number,
        startTrack: number,
        endTrack: number,
        startContentY?: number,
        endContentY?: number,
    ): void {
        const minBeat = Math.min(startBeat, endBeat);
        const maxBeat = Math.max(startBeat, endBeat);
        const minTrack = Math.min(startTrack, endTrack);
        const maxTrack = Math.max(startTrack, endTrack);

        // ── ENTERPRISE: Floating-point tolerant overlap detection ─────────
        const OVERLAP_EPS = 1e-6;

        const usePixelY = startContentY != null && endContentY != null;
        const marqueeYMin = usePixelY ? Math.min(startContentY, endContentY) : 0;
        const marqueeYMax = usePixelY ? Math.max(startContentY, endContentY) : 0;
        const PX_EPS = 0.5;

        const selectedIds: string[] = [];

        // ── Ableton-style per-clip partial selection ranges ───────────────
        // For each clip that overlaps the marquee, compute the intersection
        // of the marquee beat range with the clip's beat range and store it
        // as selectionStartBeat/selectionEndBeat (relative to clip start).
        // This enables the renderer to highlight only the overlapping portion.
        for (let i = 0, len = this._clips.length; i < len; i++) {
            const clip = this._clips[i];
            const clipStart = clip.startBeat;
            const clipEnd = clip.startBeat + clip.durationBeats;

            // Skip clips on hidden (zero-height) tracks
            const clipTrackHeight = this._viewport.trackHeightAt(clip.trackIndex);
            if (clipTrackHeight <= 0) {
                this._deselectClipAt(i);
                continue;
            }

            // Beat axis overlap check
            if (clipEnd <= minBeat + OVERLAP_EPS || clipStart >= maxBeat - OVERLAP_EPS) {
                this._deselectClipAt(i);
                continue;
            }

            // Track axis overlap check
            let trackOverlaps: boolean;
            if (usePixelY) {
                const clipTopPx = this._viewport.trackOffsetY(clip.trackIndex);
                const clipBottomPx = clipTopPx + clipTrackHeight;
                trackOverlaps = clipBottomPx > marqueeYMin + PX_EPS && clipTopPx < marqueeYMax - PX_EPS;
            } else {
                trackOverlaps = clip.trackIndex >= minTrack && clip.trackIndex <= maxTrack;
            }

            if (!trackOverlaps) {
                this._deselectClipAt(i);
                continue;
            }

            // Compute intersection relative to clip start
            const overlapStart = Math.max(0, minBeat - clipStart);
            const overlapEnd = Math.min(clip.durationBeats, maxBeat - clipStart);

            selectedIds.push(clip.id);

            // Update clip with partial selection range
            const updated: TimelineClipData = {
                ...clip,
                selected: true,
                primarySelected: false,
                selectionStartBeat: overlapStart,
                selectionEndBeat: overlapEnd,
            };
            this._updateClipInStores(i, clip, updated);
        }

        this._renderer.setHasClipSelection(selectedIds.length > 0);
        this.onClipBoxSelection?.(selectedIds);
        this._setMarquee({
            startBeat: minBeat,
            endBeat: maxBeat,
            startTrack: minTrack,
            endTrack: maxTrack,
        });
    }

    private _clampFadeCurve(value: number): number {
        return Math.max(FADE_CURVE_CLAMP_MIN, Math.min(FADE_CURVE_CLAMP_MAX, value));
    }

    private _nextFadeCurvePreset(current: number): number {
        const normalized = this._clampFadeCurve(current);
        const idx = FADE_CURVE_PRESETS.findIndex((v) => Math.abs(v - normalized) < 0.04);
        if (idx < 0) return FADE_CURVE_PRESETS[2];
        return FADE_CURVE_PRESETS[(idx + 1) % FADE_CURVE_PRESETS.length];
    }

    private _getFadeBodyBounds(clipTopPx: number, trackH: number): { top: number; bottom: number } {
        const headerH = Math.min(CLIP_HEADER_HEIGHT_PX, trackH - CLIP_BODY_INSET);
        // Match renderer: bodyY = y + headerH, bodyBottom = bodyY + bodyH - 2
        const bodyTop = clipTopPx + headerH;
        const bodyBottom = clipTopPx + trackH - CLIP_BODY_INSET;
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
        const fadeWidth = Math.max(MIN_FADE_WIDTH_PX, clipWidth * this._clampFadeFraction(fadeAmount));
        const curve = side === 'in'
            ? this._clampFadeCurve(clip.fadeInCurve ?? DEFAULT_FADE_CURVE)
            : this._clampFadeCurve(clip.fadeOutCurve ?? DEFAULT_FADE_CURVE);
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
        if (this._hoverClipId === clipId) return;
        const activeFadeClipId = this._isFadeDragMode(this._drag.mode) ? this._drag.clipId : null;

        // PERF-OPT-2: Toggle only old+new hovered clips via Map (O(1)),
        // instead of iterating ALL clips on every mouse move (O(N)).
        if (this._hoverClipId) {
            const old = this._clipById.get(this._hoverClipId);
            if (old && old.id !== activeFadeClipId) old.hovered = false;
        }
        this._hoverClipId = clipId;
        if (clipId) {
            const cur = this._clipById.get(clipId);
            if (cur) cur.hovered = true;
        }
        if (activeFadeClipId) {
            const fade = this._clipById.get(activeFadeClipId);
            if (fade) fade.hovered = true;
        }
        this._requestRedraw();
    }

    private _onPointerDown(e: PointerEvent): void {
        if (e.button !== 0) return; // Left click only
        if (!this._canvas) return;

        this._metaKeyHeld = e.metaKey || e.ctrlKey;
        const hit = this.hitTest(e.clientX, e.clientY);

        switch (hit.type) {
            case 'ruler': {
                if (this._marquee) this._setMarquee(null);
                // Clear any lingering clip selection when clicking the ruler
                this._clearSelectionAndNotify();
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
                    const snapped = this._snapBeat(Math.max(0, hit.beat));
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

                // BUG-AUDIT-CRITICAL: Must use hit.clipId (current click target),
                // NOT this._drag.clipId (stale from previous drag — typically null).
                const clip = this._clipById.get(hit.clipId);
                if (!clip) break;

                if (hit.fadeCurveHandle === 'in' || hit.fadeCurveHandle === 'out') {
                    // SSOT FIX: Clear+select on engine side before notifying React
                    this._clearAllClipSelections();
                    this._selectSingleClip(hit.clipId);
                    this._requestRedraw();
                    this.onClipClick?.(hit.clipId, false, false);
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
                        clipOriginalFadeInCurve: this._clampFadeCurve(clip.fadeInCurve ?? DEFAULT_FADE_CURVE),
                        clipOriginalFadeOutCurve: this._clampFadeCurve(clip.fadeOutCurve ?? DEFAULT_FADE_CURVE),
                    };
                    break;
                }

                if (hit.fadeHandle === 'in' || hit.fadeHandle === 'out') {
                    // SSOT FIX: Clear+select on engine side before notifying React
                    this._clearAllClipSelections();
                    this._selectSingleClip(hit.clipId);
                    this._requestRedraw();
                    this.onClipClick?.(hit.clipId, false, false);
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
                    break;
                }

                if (hit.edge === 'left') {
                    // SSOT FIX: Clear+select on engine side before notifying React
                    this._clearAllClipSelections();
                    this._selectSingleClip(hit.clipId);
                    this._requestRedraw();
                    this.onClipClick?.(hit.clipId, false, false);
                    const allowStretch = e.shiftKey;
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
                        clipResizeAllowStretch: allowStretch,
                    };
                    this._trimPreview = {
                        clipId: hit.clipId,
                        startBeat: clip.startBeat,
                        durationBeats: clip.durationBeats,
                        edge: 'left',
                        allowStretch,
                        originalStartBeat: clip.startBeat,
                        originalDurationBeats: clip.durationBeats,
                    };
                    break;
                }
                if (hit.edge === 'right') {
                    // SSOT FIX: Clear+select on engine side before notifying React
                    this._clearAllClipSelections();
                    this._selectSingleClip(hit.clipId);
                    this._requestRedraw();
                    this.onClipClick?.(hit.clipId, false, false);
                    const allowStretch = e.shiftKey;
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
                        clipResizeAllowStretch: allowStretch,
                    };
                    this._trimPreview = {
                        clipId: hit.clipId,
                        startBeat: clip.startBeat,
                        durationBeats: clip.durationBeats,
                        edge: 'right',
                        allowStretch,
                        originalStartBeat: clip.startBeat,
                        originalDurationBeats: clip.durationBeats,
                    };
                    break;
                }

                const isShift = e.shiftKey;
                const isCtrl = e.metaKey || e.ctrlKey;
                const isAdditive = isShift || isCtrl;

                if (hit.region === 'body' && !isAdditive) {
                    const snapped = this._snapBeat(hit.beat);
                    this.onEditCursorChange?.(snapped, hit.trackIndex, hit.trackIndex);
                    this.onTrackSelect?.(hit.trackIndex);
                    // Clear clip selection when clicking on clip body (not header)
                    this._clearSelectionAndNotify();
                    break;
                }

                const isAlreadySelected = clip.selected === true;
                // BUG-AUDIT-PERF: Replaced O(N) .filter().length with manual count (avoids GC array).
                let selectedCount = 0;
                for (let i = 0, len = this._clips.length; i < len && selectedCount < 2; i++) {
                    if (this._clips[i].selected) selectedCount++;
                }
                const multipleSelected = selectedCount > 1;
                const preserveMultiSelect = isAlreadySelected && multipleSelected && !isAdditive;

                // ENTERPRISE SSOT FIX: For non-additive clicks, clear ALL engine-side
                // selections IMMEDIATELY and mark the clicked clip selected.
                // Uses _selectSingleClip helper for atomic 3-store update.
                if (!isAdditive && !preserveMultiSelect) {
                    this._clearAllClipSelections();
                    this._selectSingleClip(hit.clipId);
                    this._requestRedraw();
                }

                if (!preserveMultiSelect) {
                    this.onClipClick?.(hit.clipId, isShift, isCtrl);
                }

                // SSOT FIX (Bug 35): For Ctrl+click, toggle the clicked clip's
                // engine-side selection IMMEDIATELY so coMovers reflects the
                // correct set. Without this, a Ctrl-deselected clip is still
                // included in coMovers and moves when dragging.
                if (isCtrl && !preserveMultiSelect) {
                    if (isAlreadySelected) {
                        // Ctrl+click on selected clip → deselect it in engine
                        const idx = this._clips.findIndex((c) => c.id === hit.clipId);
                        if (idx >= 0) this._deselectClipAt(idx);
                    } else {
                        // Ctrl+click on unselected clip → select it in engine
                        this._selectSingleClip(hit.clipId);
                    }
                    this._renderer.setHasClipSelection(this._clips.some((c) => c.selected));
                    this._requestRedraw();
                }

                const coMovers = new Map<string, { beat: number; track: number }>();
                for (const sc of this._clips) {
                    if (sc.selected && sc.id !== hit.clipId) {
                        coMovers.set(sc.id, { beat: sc.startBeat, track: sc.trackIndex });
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
                    deferSingleSelectOnMouseUp: preserveMultiSelect,
                };
                break;
            }

            case 'track': {
                const snappedBeat = this._snapBeat(hit.beat);
                // PERF FIX: Break-early loop instead of O(N) .some() — most tracks have few selected clips.
                let hasSelectedClips = false;
                for (let i = 0, len = this._clips.length; i < len; i++) {
                    if (this._clips[i].selected) { hasSelectedClips = true; break; }
                }

                if (e.shiftKey && hasSelectedClips) {
                    // Shift+click on empty timeline should not replace clip selection with marquee.
                    break;
                }

                if (e.shiftKey) {
                    let anchorBeat: number;
                    let anchorTrack: number;
                    let hasAnchor = false;

                    if (this._editCursorBeat >= 0) {
                        anchorBeat = this._editCursorBeat;
                        anchorTrack = this._editCursorTrack >= 0 ? this._editCursorTrack : hit.trackIndex;
                        hasAnchor = true;
                    } else {
                        // PERF FIX: First-found loop instead of O(N) .filter() allocation.
                        for (let i = 0, len = this._clips.length; i < len; i++) {
                            const sc = this._clips[i];
                            if (sc.selected) {
                                anchorBeat = sc.startBeat;
                                anchorTrack = sc.trackIndex;
                                hasAnchor = true;
                                break;
                            }
                        }
                    }

                    if (hasAnchor) {
                        this.onMarqueeSelectionStart?.();
                        this._drag = {
                            mode: DragMode.MarqueeSelect,
                            clipId: null,
                            startBeat: anchorBeat!,
                            startTrack: anchorTrack!,
                            currentBeat: snappedBeat,
                            currentTrack: hit.trackIndex,
                            clipOriginalBeat: 0,
                            clipOriginalTrack: 0,
                            clipOriginalDuration: 0,
                            startClientX: e.clientX,
                            startClientY: e.clientY,
                            startContentY: this._viewport.trackOffsetY(anchorTrack!),
                        };

                        const minBeat = Math.min(anchorBeat!, snappedBeat);
                        const maxBeat = Math.max(anchorBeat!, snappedBeat);
                        const minTrack = Math.min(anchorTrack!, hit.trackIndex);
                        const maxTrack = Math.max(anchorTrack!, hit.trackIndex);
                        this._setMarquee({ startBeat: minBeat, endBeat: maxBeat, startTrack: minTrack, endTrack: maxTrack }, false);
                        this._selectClipsWithinMarquee(minBeat, maxBeat, minTrack, maxTrack);

                        this.onEditCursorChange?.(anchorBeat!, anchorTrack!, hit.trackIndex);
                        break;
                    }
                }

                // ENTERPRISE: Atomically clear prior selection on mousedown — prevents
                // two-step visual where marquee disappears but clip highlights persist.
                this._clearSelectionAndNotify();

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
                    startContentY: this._viewport.trackOffsetY(hit.trackIndex),
                };
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

    private _onPointerMove(e: PointerEvent): void {
        this._metaKeyHeld = e.metaKey || e.ctrlKey;
        const canvas = this._canvas;
        if (!canvas) return;

        if (this._drag.mode === DragMode.None) {
            const hit = this.hitTest(e.clientX, e.clientY);
            this._syncHoveredClip(hit.type === 'clip' && hit.clipId ? hit.clipId : null);

            if (hit.type === 'clip' && hit.fadeCurveHandle) {
                canvas.style.cursor = 'pointer';
            } else if (hit.type === 'clip' && hit.fadeHandle) {
                canvas.style.cursor = 'ew-resize';
            } else if (hit.type === 'clip' && hit.edge === 'left') {
                // BUG-U005 FIX: Show resize cursor so user knows edges are draggable.
                canvas.style.cursor = 'ew-resize';
            } else if (hit.type === 'clip' && hit.edge === 'right') {
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
                canvas.style.cursor = this._metaKeyHeld ? 'copy' : 'grabbing';
                const coMoverOrigins = new Map<string, { beat: number; track: number }>();
                for (const c of this._clips) {
                    if (c.selected && c.id !== this._drag.clipId) {
                        coMoverOrigins.set(c.id, { beat: c.startBeat, track: c.trackIndex });
                    }
                }
                this._drag.coMoverOrigins = coMoverOrigins;
                const deltaBeat = beat - this._drag.startBeat;
                const deltaTrack = track - this._drag.startTrack;
                const newBeat = this._snapBeat(
                    Math.max(0, this._drag.clipOriginalBeat + deltaBeat),
                );
                const newTrack = Math.max(
                    0,
                    Math.min(this._viewport.trackCount - 1, this._drag.clipOriginalTrack + deltaTrack),
                );
                const clip = this._drag.clipId ? this._clipById.get(this._drag.clipId) : undefined;
                if (clip) {
                    clip.startBeat = newBeat;
                    clip.trackIndex = newTrack;
                }
                for (const [id, origin] of coMoverOrigins) {
                    const co = this._clipById.get(id);
                    if (co) {
                        co.startBeat = this._snapBeat(Math.max(0, origin.beat + deltaBeat));
                        co.trackIndex = Math.max(0, Math.min(this._viewport.trackCount - 1, origin.track + deltaTrack));
                    }
                }
                this._rebuildClipsByTrack();
                this._requestRedraw();
                break;
            }

            case DragMode.RulerScrub: {
                canvas.style.cursor = 'col-resize';
                const snapped = this._snapBeat(Math.max(0, beat));
                this.onEditCursorChange?.(snapped, this._editCursorTrack, this._editCursorTrackEnd);
                break;
            }

            case DragMode.ClipMove: {
                this._applyClipMoveVisuals();
                break;
            }

            case DragMode.ClipResizeLeft: {
                canvas.style.cursor = 'ew-resize';
                if (!this._drag.clipId) break;
                const deltaBeat = beat - this._drag.startBeat;
                const rawNewStart = this._drag.clipOriginalBeat + deltaBeat;
                const clipEnd = this._drag.clipOriginalBeat + this._drag.clipOriginalDuration;
                const maxNewStart = clipEnd - MIN_RESIZE_DURATION_BEATS;

                const clipTrack = this._drag.clipOriginalTrack;
                let leftBound = 0;
                for (const c of this._clips) {
                    if (c.id === this._drag.clipId || c.trackIndex !== clipTrack) continue;
                    const cEnd = c.startBeat + c.durationBeats;
                    if (cEnd <= this._drag.clipOriginalBeat + RESIZE_BOUNDARY_EPS && cEnd > leftBound) {
                        leftBound = cEnd;
                    }
                }
                const clampedStart = Math.max(leftBound, Math.min(maxNewStart, rawNewStart));
                const newStart = this._snapBeat(clampedStart);
                const safeStart = Math.max(leftBound, newStart);
                const newDuration = Math.max(MIN_RESIZE_DURATION_BEATS, clipEnd - safeStart);
                this._trimPreview = {
                    clipId: this._drag.clipId,
                    startBeat: safeStart,
                    durationBeats: newDuration,
                    edge: 'left',
                    allowStretch: this._drag.clipResizeAllowStretch === true,
                    originalStartBeat: this._drag.clipOriginalBeat,
                    originalDurationBeats: this._drag.clipOriginalDuration,
                };
                this._requestRedraw();
                break;
            }

            case DragMode.ClipResizeRight: {
                canvas.style.cursor = 'ew-resize';
                if (!this._drag.clipId) break;
                const rawNewEnd = beat;

                const rClipTrack = this._drag.clipOriginalTrack;
                const originalEnd = this._drag.clipOriginalBeat + this._drag.clipOriginalDuration;
                let rightBound = Infinity;
                for (const c of this._clips) {
                    if (c.id === this._drag.clipId || c.trackIndex !== rClipTrack) continue;
                    if (c.startBeat >= originalEnd - RESIZE_BOUNDARY_EPS && c.startBeat < rightBound) {
                        rightBound = c.startBeat;
                    }
                }
                const clampedEnd = Math.min(rightBound, rawNewEnd);
                const snappedEnd = this._snapBeat(Math.max(this._drag.clipOriginalBeat + MIN_RESIZE_DURATION_BEATS, clampedEnd));
                const finalEnd = rightBound < Infinity ? Math.min(rightBound, snappedEnd) : snappedEnd;
                const newDuration = Math.max(MIN_RESIZE_DURATION_BEATS, finalEnd - this._drag.clipOriginalBeat);
                this._trimPreview = {
                    clipId: this._drag.clipId,
                    startBeat: this._drag.clipOriginalBeat,
                    durationBeats: newDuration,
                    edge: 'right',
                    allowStretch: this._drag.clipResizeAllowStretch === true,
                    originalStartBeat: this._drag.clipOriginalBeat,
                    originalDurationBeats: this._drag.clipOriginalDuration,
                };
                this._requestRedraw();
                break;
            }

            case DragMode.ClipFadeIn: {
                canvas.style.cursor = 'ew-resize';
                if (!this._drag.clipId) break;
                const clip = this._drag.clipId ? this._clipById.get(this._drag.clipId) : undefined;
                if (!clip || clip.durationBeats <= 0) break;
                const deltaFraction = (beat - this._drag.startBeat) / clip.durationBeats;
                const fineFactor = e.altKey ? (e.shiftKey ? FINE_FACTOR_ALT_SHIFT : FINE_FACTOR_ALT) : (e.shiftKey ? FINE_FACTOR_SHIFT : 1);
                clip.fadeIn = this._clampFadeFraction((this._drag.clipOriginalFadeIn ?? 0) + deltaFraction * fineFactor);
                // ENTERPRISE: Dynamically push fadeOut to make room for fadeIn instead of hard-stopping
                const maxFadeIn = 1.0 - (clip.fadeOut ?? 0);
                if (clip.fadeIn > maxFadeIn) {
                    clip.fadeOut = Math.max(0, 1.0 - clip.fadeIn);
                }
                this._requestRedraw();
                break;
            }

            case DragMode.ClipFadeOut: {
                canvas.style.cursor = 'ew-resize';
                if (!this._drag.clipId) break;
                const clip = this._clipById.get(this._drag.clipId);
                if (!clip || clip.durationBeats <= 0) break;
                const deltaFraction = (beat - this._drag.startBeat) / clip.durationBeats;
                const fineFactor = e.altKey ? (e.shiftKey ? FINE_FACTOR_ALT_SHIFT : FINE_FACTOR_ALT) : (e.shiftKey ? FINE_FACTOR_SHIFT : 1);
                clip.fadeOut = this._clampFadeFraction((this._drag.clipOriginalFadeOut ?? 0) - deltaFraction * fineFactor);
                // ENTERPRISE: Dynamically push fadeIn to make room for fadeOut instead of hard-stopping
                const maxFadeOut = 1.0 - (clip.fadeIn ?? 0);
                if (clip.fadeOut > maxFadeOut) {
                    clip.fadeIn = Math.max(0, 1.0 - clip.fadeOut);
                }
                this._requestRedraw();
                break;
            }

            case DragMode.ClipFadeInCurve:
            case DragMode.ClipFadeOutCurve: {
                canvas.style.cursor = 'pointer';
                if (!this._drag.clipId || !canvas) break;
                const clip = this._drag.clipId ? this._clipById.get(this._drag.clipId) : undefined;
                if (!clip) break;
                const rect = canvas.getBoundingClientRect();
                const localX = e.clientX - rect.left;
                const localY = e.clientY - rect.top;
                const clipLeftPx = this._viewport.beatsToScreenX(clip.startBeat);
                const clipRightPx = this._viewport.beatsToScreenX(clip.startBeat + clip.durationBeats);
                const clipTopPx = this._viewport.rulerHeight + this._viewport.trackOffsetY(clip.trackIndex) - this._viewport.scrollY;
                const body = this._getFadeBodyBounds(clipTopPx, this._viewport.trackHeightAt(clip.trackIndex));
                const bodyHeight = Math.max(MIN_FADE_BODY_HEIGHT_PX, body.bottom - body.top);
                const yCurveIn = this._clampFadeCurve((body.bottom - localY) / bodyHeight);
                const yCurveOut = this._clampFadeCurve((localY - body.top) / bodyHeight);

                if (this._drag.mode === DragMode.ClipFadeInCurve) {
                    const fadeWidth = Math.max(MIN_FADE_WIDTH_PX, (clipRightPx - clipLeftPx) * this._clampFadeFraction(clip.fadeIn ?? 0));
                    const xCurve = this._clampFadeCurve((localX - clipLeftPx) / Math.max(1, fadeWidth));
                    const target = this._clampFadeCurve((xCurve * CURVE_X_WEIGHT) + (yCurveIn * CURVE_Y_WEIGHT));
                    const origin = this._drag.clipOriginalFadeInCurve ?? DEFAULT_FADE_CURVE;
                    const fineFactor = e.altKey ? (e.shiftKey ? FINE_FACTOR_ALT_SHIFT : FINE_FACTOR_CURVE_ALT) : (e.shiftKey ? FINE_FACTOR_CURVE_SHIFT : 1);
                    clip.fadeInCurve = this._clampFadeCurve(origin + (target - origin) * fineFactor);
                } else {
                    const fadeWidth = Math.max(MIN_FADE_WIDTH_PX, (clipRightPx - clipLeftPx) * this._clampFadeFraction(clip.fadeOut ?? 0));
                    const xCurve = this._clampFadeCurve((clipRightPx - localX) / Math.max(1, fadeWidth));
                    const target = this._clampFadeCurve((xCurve * CURVE_X_WEIGHT) + (yCurveOut * CURVE_Y_WEIGHT));
                    const origin = this._drag.clipOriginalFadeOutCurve ?? DEFAULT_FADE_CURVE;
                    const fineFactor = e.altKey ? (e.shiftKey ? FINE_FACTOR_ALT_SHIFT : FINE_FACTOR_CURVE_ALT) : (e.shiftKey ? FINE_FACTOR_CURVE_SHIFT : 1);
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
                // ENTERPRISE: Real-time clip selection during marquee drag
                this._selectClipsWithinMarquee(
                    this._drag.startBeat, snappedBeat,
                    this._drag.startTrack, clampedTrack,
                    this._drag.startContentY, this._pointerToContentY(e.clientY),
                );
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
                    // ENTERPRISE: Real-time clip selection during marquee drag
                    this._selectClipsWithinMarquee(
                        this._drag.startBeat, snappedBeat,
                        this._drag.startTrack, clampedTrack,
                        this._drag.startContentY, this._pointerToContentY(e.clientY),
                    );
                } else {
                    canvas.style.cursor = 'ns-resize';
                    const clampedTrack = Math.max(0, Math.min(this._viewport.trackCount - 1, track));
                    this._drag.currentTrack = clampedTrack;
                    this._drag.currentBeat = this._drag.startBeat;
                    this._setMarquee({ startBeat: this._drag.startBeat, endBeat: this._drag.startBeat, startTrack: this._drag.startTrack, endTrack: clampedTrack }, false);
                    // ENTERPRISE: Real-time clip selection during vertical marquee drag
                    this._selectClipsWithinMarquee(
                        this._drag.startBeat, this._drag.startBeat,
                        this._drag.startTrack, clampedTrack,
                        this._drag.startContentY, this._pointerToContentY(e.clientY),
                    );
                }
                break;
            }
        }
    }

    private _onPointerUp(e: PointerEvent): void {
        if (this._drag.mode === DragMode.None) return;

        const canvas = this._canvas;
        if (canvas) canvas.style.cursor = 'default';

        switch (this._drag.mode) {
            case DragMode.ClipMoveArmed: {
                if (
                    this._drag.deferSingleSelectOnMouseUp
                    && this._drag.clipId
                    && this._drag.coMoverOrigins
                    && this._drag.coMoverOrigins.size > 0
                ) {
                    // SSOT FIX: Clear+select on engine side before notifying React
                    this._clearAllClipSelections();
                    this._selectSingleClip(this._drag.clipId);
                    this._requestRedraw();
                    this.onClipClick?.(this._drag.clipId, false, false);
                }
                break;
            }
            case DragMode.ClipMove: {
                if (this._drag.clipId) {
                    if (!canvas) {
                        const clipToRestore = this._drag.clipId ? this._clipById.get(this._drag.clipId) : undefined;
                        if (clipToRestore) {
                            clipToRestore.startBeat = this._drag.clipOriginalBeat;
                            clipToRestore.trackIndex = this._drag.clipOriginalTrack;
                        }
                        if (this._drag.coMoverOrigins) {
                            for (const [id, origin] of this._drag.coMoverOrigins) {
                                const co = this._clipById.get(id);
                                if (co) {
                                    co.startBeat = origin.beat;
                                    co.trackIndex = origin.track;
                                }
                            }
                        }
                        // SSOT FIX: Rebuild _clipsByTrack after in-place trackIndex restore
                        this._rebuildClipsByTrack();
                        this._requestRedraw();
                        break;
                    }

                    const rect = canvas.getBoundingClientRect();
                    const beat = this._viewport.screenToBeats(e.clientX, rect);
                    const track = this._viewport.screenToTrack(e.clientY, rect);

                    const deltaBeat = beat - this._drag.startBeat;
                    const deltaTrack = track - this._drag.startTrack;
                    const beatCommitThreshold = this._snapEnabled
                        ? Math.max(BEAT_COMMIT_THRESHOLD, this._snapBeats * TRACK_COMMIT_THRESHOLD)
                        : BEAT_COMMIT_THRESHOLD;
                    const isTinyMove =
                        Math.abs(deltaBeat) < beatCommitThreshold && Math.abs(deltaTrack) < TRACK_COMMIT_THRESHOLD;
                    if (isTinyMove) {
                        const clipToRestore = this._drag.clipId ? this._clipById.get(this._drag.clipId) : undefined;
                        if (clipToRestore) {
                            clipToRestore.startBeat = this._drag.clipOriginalBeat;
                            clipToRestore.trackIndex = this._drag.clipOriginalTrack;
                        }
                        if (this._drag.coMoverOrigins) {
                            for (const [id, origin] of this._drag.coMoverOrigins) {
                                const co = this._clipById.get(id);
                                if (co) {
                                    co.startBeat = origin.beat;
                                    co.trackIndex = origin.track;
                                }
                            }
                        }
                        this._trimPreview = null;
                        this._ghost = null;
                        // SSOT FIX: Rebuild _clipsByTrack after in-place trackIndex restore
                        this._rebuildClipsByTrack();
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

                    if (
                        finalBeat !== this._drag.clipOriginalBeat ||
                        finalTrack !== this._drag.clipOriginalTrack
                    ) {
                        if (e.metaKey || e.ctrlKey) {
                            // ENTERPRISE: Cmd+Drag → duplicate.
                            // _applyClipMoveVisuals() already keeps originals at their
                            // positions when Cmd held, so just emit duplicate callback.
                            this.onClipDuplicate?.(this._drag.clipId, finalBeat, finalTrack);
                        } else {
                            this.onClipMove?.(this._drag.clipId, finalBeat, finalTrack);

                            // ENTERPRISE FIX: Optimistic position update in pending clips.
                            // The onClipMove callback triggers an async IPC round-trip.
                            // Meanwhile, _pendingClips contains PRE-MOVE store data.
                            // Without this fix, flushing _pendingClips would overwrite
                            // drag positions with stale data, making clips vanish until
                            // the async delta arrives. Apply the move delta to pending
                            // clips so they reflect the new positions immediately.
                            if (this._pendingClips) {
                                const moveMap = new Map<string, { beat: number; track: number }>();
                                moveMap.set(this._drag.clipId!, { beat: finalBeat, track: finalTrack });
                                if (this._drag.coMoverOrigins) {
                                    const dBeat = finalBeat - this._drag.clipOriginalBeat;
                                    const dTrack = finalTrack - this._drag.clipOriginalTrack;
                                    for (const [id, origin] of this._drag.coMoverOrigins) {
                                        moveMap.set(id, {
                                            beat: this._snapBeat(Math.max(0, origin.beat + dBeat)),
                                            track: Math.max(0, Math.min(this._viewport.trackCount - 1, origin.track + dTrack)),
                                        });
                                    }
                                }
                                this._pendingClips = this._pendingClips.map((c) => {
                                    const moved = moveMap.get(c.id);
                                    if (moved) {
                                        return { ...c, startBeat: moved.beat, trackIndex: moved.track };
                                    }
                                    return c;
                                });
                            }
                        }
                    }
                    // Always clear Cmd+Drag ghosts on commit
                    this._cmdDragGhosts.length = 0;
                }
                break;
            }

            case DragMode.ClipResizeLeft:
            case DragMode.ClipResizeRight: {
                if (this._drag.clipId) {
                    const preview = this._trimPreview;
                    if (preview && preview.clipId === this._drag.clipId) {
                        if (
                            preview.startBeat !== this._drag.clipOriginalBeat ||
                            preview.durationBeats !== this._drag.clipOriginalDuration
                        ) {
                            const composedPreview = this._composeDrawClips();
                            const previewClip = composedPreview.find((c) => c.id === this._drag.clipId);

                            this.onClipResize?.(
                                this._drag.clipId,
                                preview.startBeat,
                                preview.durationBeats,
                                preview.allowStretch,
                                previewClip?.sourceOffset
                            );

                            // ENTERPRISE: Optimistic in-place update — keep the clip
                            // at the resized position during the async IPC round-trip.
                            // Without this, clearing _trimPreview on line below causes
                            // _composeDrawClips() to render from the stale _clips array,
                            // producing a visible snap-back to the old position for 1-2
                            // frames until the backend delta response updates the store.
                            // This mirrors the ClipMove pattern (lines 1870-1978).
                            const currentClip = this._clipById.get(this._drag.clipId!);
                            if (currentClip) {
                                const clipIdx = this._clips.indexOf(currentClip);
                                if (clipIdx >= 0) {
                                    const optimistic: TimelineClipData = {
                                        ...currentClip,
                                        startBeat: preview.startBeat,
                                        durationBeats: preview.durationBeats,
                                        // Carry over computed source fields from the
                                        // preview composite (sourceOffset, durationSamples,
                                        // warpSourceDurationFrames) so the waveform
                                        // doesn't jump when the store later reconciles.
                                        ...(previewClip ? {
                                            sourceOffset: previewClip.sourceOffset,
                                            durationSamples: previewClip.durationSamples,
                                            warpSourceDurationFrames: previewClip.warpSourceDurationFrames,
                                            isWarped: previewClip.isWarped,
                                        } : {}),
                                    };
                                    this._updateClipInStores(clipIdx, currentClip, optimistic);
                                }
                            }

                            // SSOT FIX: Optimistic update for pending clips (same pattern as ClipMove)
                            if (this._pendingClips) {
                                const resizeId = this._drag.clipId;
                                const resizeBeat = preview.startBeat;
                                const resizeDur = preview.durationBeats;
                                this._pendingClips = this._pendingClips.map((c) =>
                                    c.id === resizeId
                                        ? {
                                            ...c,
                                            startBeat: resizeBeat,
                                            durationBeats: resizeDur,
                                            ...(previewClip ? {
                                                sourceOffset: previewClip.sourceOffset,
                                                durationSamples: previewClip.durationSamples,
                                                warpSourceDurationFrames: previewClip.warpSourceDurationFrames,
                                                isWarped: previewClip.isWarped,
                                            } : {}),
                                        }
                                        : c,
                                );
                            }
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
                    const clip = this._clipById.get(this._drag.clipId);
                    if (!clip) break;
                    const durationFrames = Math.max(1, this._clipDurationFrames(clip));
                    const maxFadeFrames = durationFrames;
                    const fadeInFrames = Math.max(0, Math.min(maxFadeFrames, Math.round((clip.fadeIn ?? 0) * durationFrames)));
                    const fadeOutFrames = Math.max(0, Math.min(maxFadeFrames, Math.round((clip.fadeOut ?? 0) * durationFrames)));
                    const prevFadeInFrames = Math.max(0, Math.min(maxFadeFrames, Math.round((this._drag.clipOriginalFadeIn ?? 0) * durationFrames)));
                    const prevFadeOutFrames = Math.max(0, Math.min(maxFadeFrames, Math.round((this._drag.clipOriginalFadeOut ?? 0) * durationFrames)));
                    if (fadeInFrames !== prevFadeInFrames || fadeOutFrames !== prevFadeOutFrames) {
                        this.onClipFades?.(this._drag.clipId, fadeInFrames, fadeOutFrames);
                        // SSOT FIX: Optimistic update for pending clips (same pattern as ClipMove)
                        if (this._pendingClips) {
                            const fadeClipId = this._drag.clipId;
                            const fadeInFrac = clip.fadeIn ?? 0;
                            const fadeOutFrac = clip.fadeOut ?? 0;
                            this._pendingClips = this._pendingClips.map((c) => {
                                if (c.id !== fadeClipId) return c;
                                const dur = Math.max(1, c.durationSamples ?? 0);
                                return { ...c, fadeIn: Math.round(fadeInFrac * dur), fadeOut: Math.round(fadeOutFrac * dur) };
                            });
                        }
                    }
                }
                this._requestRedraw();
                break;
            }

            case DragMode.ClipFadeInCurve:
            case DragMode.ClipFadeOutCurve: {
                if (this._drag.clipId) {
                    const clip = this._clipById.get(this._drag.clipId);
                    if (clip) {
                        const nextIn = this._clampFadeCurve(clip.fadeInCurve ?? DEFAULT_FADE_CURVE);
                        const nextOut = this._clampFadeCurve(clip.fadeOutCurve ?? DEFAULT_FADE_CURVE);
                        const prevIn = this._clampFadeCurve(this._drag.clipOriginalFadeInCurve ?? DEFAULT_FADE_CURVE);
                        const prevOut = this._clampFadeCurve(this._drag.clipOriginalFadeOutCurve ?? DEFAULT_FADE_CURVE);
                        if (Math.abs(nextIn - prevIn) > 0.0001 || Math.abs(nextOut - prevOut) > 0.0001) {
                            this.onClipFadeCurves?.(clip.id, nextIn, nextOut);
                            // SSOT FIX: Optimistic update for pending clips
                            if (this._pendingClips) {
                                const curveClipId = clip.id;
                                this._pendingClips = this._pendingClips.map((c) =>
                                    c.id === curveClipId
                                        ? { ...c, fadeInCurve: nextIn, fadeOutCurve: nextOut }
                                        : c,
                                );
                            }
                        }
                    }
                }
                break;
            }

            case DragMode.MarqueeSelect: {
                // Recompute from mouseup event to avoid stale coordinates from last mousemove
                const upWorld = this._clientToWorld(e.clientX, e.clientY);
                const upBeat = this._snapBeat(Math.max(0, upWorld.beat));
                const upTrack = Math.max(0, Math.min(this._viewport.trackCount - 1, upWorld.trackIndex));
                const minBeat = Math.min(this._drag.startBeat, upBeat);
                const maxBeat = Math.max(this._drag.startBeat, upBeat);
                const minTrack = Math.min(this._drag.startTrack, upTrack);
                const maxTrack = Math.max(this._drag.startTrack, upTrack);
                const isVerticalLine = Math.abs(maxBeat - minBeat) <= 1e-6 && minTrack !== maxTrack;
                const moved =
                    Math.abs(maxBeat - minBeat) >= 1e-6 || minTrack !== maxTrack;

                // Compute content-Y for pixel-level clip overlap detection
                const rect = this._canvas?.getBoundingClientRect();
                const upContentY = rect
                    ? this._viewport.screenToContentY(e.clientY, rect) - this._viewport.rulerHeight
                    : this._viewport.trackOffsetY(upTrack) + this._viewport.trackHeightAt(upTrack);
                const startContentY = this._drag.startContentY ?? this._viewport.trackOffsetY(this._drag.startTrack);

                if (!moved) {
                    const snappedBeat = this._snapBeat(this._drag.startBeat);
                    this.onEditCursorChange?.(snappedBeat, this._drag.startTrack, this._drag.startTrack);
                    this.onTrackSelect?.(this._drag.startTrack);
                    this._clearSelectionAndNotify();
                    this._setMarquee(null);
                } else if (isVerticalLine) {
                    const snappedBeat = this._snapBeat(Math.max(0, this._drag.startBeat));
                    this.onEditCursorChange?.(snappedBeat, this._drag.startTrack, this._drag.currentTrack);
                    this.onTrackSelect?.(this._drag.currentTrack);
                    // Vertical-line marquee still needs to select clips that overlap the vertical range
                    this._selectClipsWithinMarquee(
                        snappedBeat, snappedBeat,
                        minTrack, maxTrack,
                        startContentY, upContentY,
                    );
                    this._setMarquee({
                        startBeat: snappedBeat,
                        endBeat: snappedBeat,
                        startTrack: minTrack,
                        endTrack: maxTrack,
                    });
                } else {
                    this._selectClipsWithinMarquee(minBeat, maxBeat, minTrack, maxTrack, startContentY, upContentY);
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
                    this._clearSelectionAndNotify();
                    this._setMarquee(null);
                } else {
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
            startClientX: 0,
            startClientY: 0,
            clipResizeAllowStretch: false,
        };

        // ENTERPRISE FIX: Flush any setClips() calls that were deferred during drag.
        // React effects can fire during drag, queueing clip updates. Apply them now.
        if (this._pendingClips) {
            const pending = this._pendingClips;
            this._pendingClips = null;
            this.setClips(pending);
        }
    }

    private _onDoubleClick(e: MouseEvent): void {
        e.preventDefault();
        const hit = this.hitTest(e.clientX, e.clientY);

        switch (hit.type) {
            case 'clip':
                if (hit.clipId) {
                    if (hit.fadeHandle === 'in' || hit.fadeHandle === 'out') {
                        const clip = this._clipById.get(hit.clipId);
                        if (clip) {
                            if (hit.fadeHandle === 'in') clip.fadeIn = 0;
                            else clip.fadeOut = 0;
                            const durationFrames = Math.max(1, this._clipDurationFrames(clip));
                            const maxFadeFrames = durationFrames;
                            const fadeInFrames = Math.max(0, Math.min(maxFadeFrames, Math.round((clip.fadeIn ?? 0) * durationFrames)));
                            const fadeOutFrames = Math.max(0, Math.min(maxFadeFrames, Math.round((clip.fadeOut ?? 0) * durationFrames)));
                            this.onClipFades?.(clip.id, fadeInFrames, fadeOutFrames);
                            // ENTERPRISE: Sync pending clips with reset fade values
                            if (this._pendingClips) {
                                const resetId = clip.id;
                                const fi = clip.fadeIn ?? 0;
                                const fo = clip.fadeOut ?? 0;
                                this._pendingClips = this._pendingClips.map((c) => {
                                    if (c.id !== resetId) return c;
                                    const dur = Math.max(1, c.durationSamples ?? 0);
                                    return { ...c, fadeIn: Math.round(fi * dur), fadeOut: Math.round(fo * dur) };
                                });
                            }
                            this._requestRedraw();
                            break;
                        }
                    }
                    if (hit.fadeCurveHandle === 'in' || hit.fadeCurveHandle === 'out') {
                        const clip = this._clipById.get(hit.clipId);
                        if (clip) {
                            const flags = this._fadeCurvePoints[clip.id] ?? { in: false, out: false };
                            if (hit.fadeCurveHandle === 'in') {
                                flags.in = true;
                                clip.showFadeInCurvePoint = true;
                                clip.fadeInCurve = DEFAULT_FADE_CURVE;
                            } else {
                                flags.out = true;
                                clip.showFadeOutCurvePoint = true;
                                clip.fadeOutCurve = DEFAULT_FADE_CURVE;
                            }
                            this._fadeCurvePoints[clip.id] = flags;
                            this.onClipFadeCurves?.(
                                clip.id,
                                this._clampFadeCurve(clip.fadeInCurve ?? DEFAULT_FADE_CURVE),
                                this._clampFadeCurve(clip.fadeOutCurve ?? DEFAULT_FADE_CURVE),
                            );
                            // ENTERPRISE: Sync pending clips with reset fadeCurve values
                            if (this._pendingClips) {
                                const curveResetId = clip.id;
                                const nextInC = this._clampFadeCurve(clip.fadeInCurve ?? DEFAULT_FADE_CURVE);
                                const nextOutC = this._clampFadeCurve(clip.fadeOutCurve ?? DEFAULT_FADE_CURVE);
                                this._pendingClips = this._pendingClips.map((c) =>
                                    c.id === curveResetId
                                        ? { ...c, fadeInCurve: nextInC, fadeOutCurve: nextOutC }
                                        : c,
                                );
                            }
                            this._requestRedraw();
                            break;
                        }
                    }
                    if (hit.fadeZone === 'in' || hit.fadeZone === 'out') {
                        const clip = this._clipById.get(hit.clipId);
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
                    if (hit.region === 'body') {
                        const snapped = this._snapBeat(hit.beat);
                        this.onEditCursorChange?.(snapped, hit.trackIndex, hit.trackIndex);
                        // Clear selection on double-click body
                        this._clearSelectionAndNotify();
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
        if (hit.type !== 'clip' || !hit.clipId) {
            return; // let native menu show
        }

        const side = hit.fadeCurveHandle ?? hit.fadeZone;
        if (side !== 'in' && side !== 'out') {
            // SSOT FIX: Right-click must select the clip (DAW standard behavior)
            e.preventDefault();
            if (!this._clipById.get(hit.clipId)?.selected) {
                this._clearAllClipSelections();
                this._selectSingleClip(hit.clipId);
                this._requestRedraw();
                this.onClipClick?.(hit.clipId, false, false);
            }
            this.onClipContextMenu?.(hit.clipId, hit.beat ?? 0, hit.trackIndex ?? 0, e.clientX, e.clientY);
            return;
        }

        e.preventDefault();
        const clip = this._clipById.get(hit.clipId);
        if (!clip) return;

        const flags = this._fadeCurvePoints[clip.id] ?? { in: false, out: false };
        if (side === 'in') {
            flags.in = true;
            clip.showFadeInCurvePoint = true;
            clip.fadeInCurve = this._nextFadeCurvePreset(clip.fadeInCurve ?? DEFAULT_FADE_CURVE);
        } else {
            flags.out = true;
            clip.showFadeOutCurvePoint = true;
            clip.fadeOutCurve = this._nextFadeCurvePreset(clip.fadeOutCurve ?? DEFAULT_FADE_CURVE);
        }
        this._fadeCurvePoints[clip.id] = flags;

        this.onClipFadeCurves?.(
            clip.id,
            this._clampFadeCurve(clip.fadeInCurve ?? DEFAULT_FADE_CURVE),
            this._clampFadeCurve(clip.fadeOutCurve ?? DEFAULT_FADE_CURVE),
        );
        // ENTERPRISE: Sync pending clips with cycled fadeCurve values
        if (this._pendingClips) {
            const cycleId = clip.id;
            const nextInC = this._clampFadeCurve(clip.fadeInCurve ?? DEFAULT_FADE_CURVE);
            const nextOutC = this._clampFadeCurve(clip.fadeOutCurve ?? DEFAULT_FADE_CURVE);
            this._pendingClips = this._pendingClips.map((c) =>
                c.id === cycleId
                    ? { ...c, fadeInCurve: nextInC, fadeOutCurve: nextOutC }
                    : c,
            );
        }
        this._requestRedraw();
    }

    /**
     * Convert a pointer clientY to content-space Y for pixel-level marquee overlap detection.
     */
    private _pointerToContentY(clientY: number): number {
        const rect = this._canvas?.getBoundingClientRect();
        if (rect) {
            return this._viewport.screenToContentY(clientY, rect) - this._viewport.rulerHeight;
        }
        const world = this._clientToWorld(0, clientY);
        const track = Math.max(0, Math.min(this._viewport.trackCount - 1, world.trackIndex));
        return this._viewport.trackOffsetY(track) + this._viewport.trackHeightAt(track);
    }

    private _clampFadeFraction(value: number): number {
        return Math.max(0, Math.min(1.0, value));
    }

    private _clipDurationFrames(clip: TimelineClipData): number {
        if (clip.durationSamples && clip.durationSamples > 0) {
            return clip.durationSamples;
        }
        if (this._bpm <= 0 || this._sampleRate <= 0) return 1;
        return Math.max(1, beatDurationToFrames(clip.durationBeats, this._bpm, this._sampleRate));
    }

    private _prefetchVisibleWaveforms(): void {
        const range = this._viewport.getVisibleRange();
        const bufferBeats = 10;
        const clipIds: string[] = [];

        for (const clip of this._clips) {
            if (
                clip.type === 'audio' &&
                clip.durationSamples &&
                clip.startBeat + clip.durationBeats >= range.startBeat - bufferBeats &&
                clip.startBeat <= range.endBeat + bufferBeats
            ) {
                clipIds.push(clip.id);
            }
        }

        if (clipIds.length > 0) {
            const ppb = this._viewport.pixelsPerBeat;
            const hasValidTempo = this._bpm > 0 && this._sampleRate > 0;
            const samplesPerBeat = hasValidTempo ? (this._sampleRate * 60 / this._bpm) : 1024;
            const samplesPerPixel = ppb > 0 ? (samplesPerBeat / ppb) : 1024;

            this._waveformCache.prefetch(clipIds, samplesPerPixel);
            cancelIdle(this._prefetchDeferredId);
            this._prefetchDeferredId = scheduleIdle(() => {
                this._prefetchDeferredId = null;
                this._requestRedraw();
            }, { timeoutMs: 150, fallbackDelayMs: 200 });
        }
    }

    private _snapBeat(beat: number): number {
        if (this._metaKeyHeld) return beat;
        if (!this._snapEnabled || this._snapBeats <= 0) return beat;
        return Math.round(beat / this._snapBeats) * this._snapBeats;
    }

    // ────────────────────────────────────────────────────────────────────────
    // ENTERPRISE: Cmd+Drag visual state toggle.
    // Called from _onPointerMove (ClipMove), _onKeyDown, and _onKeyUp.
    // When Cmd/Ctrl is held:
    //   - Primary clip + co-movers stay at ORIGINAL positions
    //   - Ghost clones appear at TARGET positions (full opacity)
    //   - Cursor: 'copy'
    // When Cmd/Ctrl is NOT held:
    //   - Primary clip + co-movers move to TARGET positions (normal drag)
    //   - Ghost array is cleared
    //   - Cursor: 'grabbing'
    // ────────────────────────────────────────────────────────────────────────
    private _applyClipMoveVisuals(): void {
        const canvas = this._canvas;
        if (!canvas) return;

        const deltaBeat = this._drag.currentBeat - this._drag.startBeat;
        const deltaTrack = this._drag.currentTrack - this._drag.startTrack;
        const trackCount = this._viewport.trackCount;

        const computeTarget = (origBeat: number, origTrack: number) => ({
            beat: this._snapBeat(Math.max(0, origBeat + deltaBeat)),
            track: Math.max(0, Math.min(trackCount - 1, origTrack + deltaTrack)),
        });

        const primaryClip = this._drag.clipId ? this._clipById.get(this._drag.clipId) : undefined;
        if (!primaryClip) return;

        const primaryTarget = computeTarget(this._drag.clipOriginalBeat, this._drag.clipOriginalTrack);

        if (this._metaKeyHeld) {
            // ── DUPLICATE MODE ──
            canvas.style.cursor = 'copy';

            // Restore originals to their original positions
            primaryClip.startBeat = this._drag.clipOriginalBeat;
            primaryClip.trackIndex = this._drag.clipOriginalTrack;

            // Build ghost array: clone of primary at target position
            this._cmdDragGhosts.length = 0;
            this._cmdDragGhosts.push({
                ...primaryClip,
                id: `__ghost_${primaryClip.id}`,
                startBeat: primaryTarget.beat,
                trackIndex: primaryTarget.track,
                selected: false,
                primarySelected: false,
                hovered: false,
            });

            // Co-movers: restore + ghost
            if (this._drag.coMoverOrigins) {
                for (const [id, origin] of this._drag.coMoverOrigins) {
                    const co = this._clipById.get(id);
                    if (co) {
                        co.startBeat = origin.beat;
                        co.trackIndex = origin.track;
                        const target = computeTarget(origin.beat, origin.track);
                        this._cmdDragGhosts.push({
                            ...co,
                            id: `__ghost_${co.id}`,
                            startBeat: target.beat,
                            trackIndex: target.track,
                            selected: false,
                            primarySelected: false,
                            hovered: false,
                        });
                    }
                }
            }
        } else {
            // ── NORMAL MOVE MODE ──
            canvas.style.cursor = 'grabbing';

            // Move clips to target positions
            primaryClip.startBeat = primaryTarget.beat;
            primaryClip.trackIndex = primaryTarget.track;

            if (this._drag.coMoverOrigins) {
                for (const [id, origin] of this._drag.coMoverOrigins) {
                    const co = this._clipById.get(id);
                    if (co) {
                        const target = computeTarget(origin.beat, origin.track);
                        co.startBeat = target.beat;
                        co.trackIndex = target.track;
                    }
                }
            }

            // Clear any ghosts
            this._cmdDragGhosts.length = 0;
        }

        // Rebuild _clipsByTrack after in-place trackIndex mutations so hitTest works correctly during drag
        this._rebuildClipsByTrack();
        this._requestRedraw();
    }

    private _onKeyDown(e: KeyboardEvent): void {
        this._metaKeyHeld = e.metaKey || e.ctrlKey;

        // ENTERPRISE: Live toggle Cmd+Drag visual state
        if (this._drag.mode === DragMode.ClipMove && e.key === 'Meta') {
            this._applyClipMoveVisuals();
        }

        if (e.key === 'Escape') {
            if (this._drag.mode !== DragMode.None) {
                if (this._drag.clipId) {
                    const c = this._clipById.get(this._drag.clipId);
                    if (c) {
                        c.startBeat = this._drag.clipOriginalBeat;
                        c.trackIndex = this._drag.clipOriginalTrack;
                        if (this._isFadeDragMode(this._drag.mode)) {
                            c.fadeIn = this._drag.clipOriginalFadeIn ?? c.fadeIn;
                            c.fadeOut = this._drag.clipOriginalFadeOut ?? c.fadeOut;
                            c.fadeInCurve = this._drag.clipOriginalFadeInCurve ?? c.fadeInCurve;
                            c.fadeOutCurve = this._drag.clipOriginalFadeOutCurve ?? c.fadeOutCurve;
                            // ENTERPRISE: Sync pending clips with restored fade values
                            if (this._pendingClips) {
                                const escId = c.id;
                                const fi = c.fadeIn ?? 0;
                                const fo = c.fadeOut ?? 0;
                                const fic = c.fadeInCurve;
                                const foc = c.fadeOutCurve;
                                this._pendingClips = this._pendingClips.map((pc) => {
                                    if (pc.id !== escId) return pc;
                                    const dur = Math.max(1, pc.durationSamples ?? 0);
                                    return {
                                        ...pc,
                                        fadeIn: Math.round(fi * dur),
                                        fadeOut: Math.round(fo * dur),
                                        fadeInCurve: fic,
                                        fadeOutCurve: foc,
                                    };
                                });
                            }
                        }
                    }
                    if (this._drag.coMoverOrigins) {
                        for (const [id, origin] of this._drag.coMoverOrigins) {
                            const co = this._clipById.get(id);
                            if (co) {
                                co.startBeat = origin.beat;
                                co.trackIndex = origin.track;
                            }
                        }
                    }
                }
                this._trimPreview = null;
                this._cmdDragGhosts.length = 0;
                this._drag = { mode: DragMode.None, clipId: null, startBeat: 0, startTrack: 0, currentBeat: 0, currentTrack: 0, clipOriginalBeat: 0, clipOriginalTrack: 0, clipOriginalDuration: 0, clipResizeAllowStretch: false };
                if (this._canvas) this._canvas.style.cursor = 'default';
                // Rebuild _clipsByTrack after in-place position restore
                this._rebuildClipsByTrack();
                this._requestRedraw();
            } else if (this._marquee) {
                this._setMarquee(null);
            }
        }
    }

    private _onKeyUp(e: KeyboardEvent): void {
        this._metaKeyHeld = e.metaKey || e.ctrlKey;
        // ENTERPRISE: Live toggle Cmd+Drag visual state (Meta key only)
        if (this._drag.mode === DragMode.ClipMove && e.key === 'Meta') {
            this._applyClipMoveVisuals();
        }
    }

    private _onWindowBlur(): void {
        this._metaKeyHeld = false;
    }
}
