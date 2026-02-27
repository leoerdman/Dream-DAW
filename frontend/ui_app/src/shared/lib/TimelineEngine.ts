
import { ViewportMatrix, type ViewportSnapshot } from './ViewportMatrix';
import { CanvasClipRenderer, type TimelineClipData, type LoopRegion, type GhostClipData } from './CanvasClipRenderer';
import { WaveformCache } from './WaveformCache';
import { beatDurationToFrames } from './audioMath';
import { normalizeTimelineClips } from './clipNormalization';
import { cancelIdle, scheduleIdle, type IdleHandle } from './idleScheduler';
import {
    CLIP_DRAG_START_THRESHOLD_PX,
    CLIP_HEADER_HEIGHT_PX,
    DragMode,
    EDGE_GRIP_PX,
    FADE_CURVE_HANDLE_RADIUS_PX,
    FADE_CURVE_PRESETS,
    FADE_HANDLE_HOTSPOT_PX,
    MIN_LOOP_BEATS,
    type DragState,
    type HitTestResult,
    type MarqueeSelection,
    type TimelineEngineConfig,
    type TrimPreviewState,
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
    private _boundMouseDown: (e: MouseEvent) => void;
    private _boundMouseMove: (e: MouseEvent) => void;
    private _boundMouseUp: (e: MouseEvent) => void;
    private _boundDblClick: (e: MouseEvent) => void;
    private _boundContextMenu: (e: MouseEvent) => void;
    private _boundKeyDown: (e: KeyboardEvent) => void;
    private _boundKeyUp: (e: KeyboardEvent) => void;
    private _boundWindowBlur: () => void;

    /** Deferred prefetch redraw handle (idle callback or fallback timeout). */
    private _prefetchDeferredId: IdleHandle | null = null;

    onClipClick?: (clipId: string, isShift: boolean, isCtrl: boolean) => void;
    onClipMove?: (clipId: string, newBeat: number, newTrack: number) => void;
    onClipDuplicate?: (clipId: string, newBeat: number, newTrack: number) => void;
    onClipResize?: (clipId: string, newStartBeat: number, newDuration: number, allowStretch: boolean) => void;
    onClipFades?: (clipId: string, fadeInFrames: number, fadeOutFrames: number) => void;
    onClipFadeCurves?: (clipId: string, fadeInCurve: number, fadeOutCurve: number) => void;
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
        this._boundMouseDown = this._onMouseDown.bind(this);
        this._boundMouseMove = this._onMouseMove.bind(this);
        this._boundMouseUp = this._onMouseUp.bind(this);
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
        canvas.addEventListener('mousedown', this._boundMouseDown);
        canvas.addEventListener('dblclick', this._boundDblClick);
        canvas.addEventListener('contextmenu', this._boundContextMenu);

        window.addEventListener('mousemove', this._boundMouseMove);
        window.addEventListener('mouseup', this._boundMouseUp);
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
            canvas.removeEventListener('mousedown', this._boundMouseDown);
            canvas.removeEventListener('dblclick', this._boundDblClick);
            canvas.removeEventListener('contextmenu', this._boundContextMenu);
        }

        window.removeEventListener('mousemove', this._boundMouseMove);
        window.removeEventListener('mouseup', this._boundMouseUp);
        window.removeEventListener('keydown', this._boundKeyDown, { capture: true });
        window.removeEventListener('keyup', this._boundKeyUp, { capture: true });
        window.removeEventListener('blur', this._boundWindowBlur);

        cancelIdle(this._prefetchDeferredId);
        this._prefetchDeferredId = null;

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
        const prevClips = this._clips;
        const normalizedInput = normalizeTimelineClips(clips);
        this._clips = normalizedInput.map((clip) => {
            const flags = this._fadeCurvePoints[clip.id];
            return {
                ...clip,
                hovered: this._hoverClipId === clip.id,
                showFadeInCurvePoint: Boolean(flags?.in),
                showFadeOutCurvePoint: Boolean(flags?.out),
            };
        });

        const currentIds = new Set(normalizedInput.map((c) => c.id));
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

        this._clips = this._clips.map((clip) => {
            const nextSelected = selected.has(clip.id);
            const nextPrimarySelected = primarySelectedId === clip.id;
            if (clip.selected === nextSelected && clip.primarySelected === nextPrimarySelected) return clip;
            changed = true;
            return { ...clip, selected: nextSelected, primarySelected: nextPrimarySelected };
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
        if (config.automationVisible !== undefined) this._automationVisible = config.automationVisible;
        if (config.viewport) {
            this._viewport.updateConfig(config.viewport);
        }
        this._requestRedraw();
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
                        nextClip.durationSamples = previewFrames;
                        if (preview.edge === 'left') {
                            const trimmedBeats = Math.max(0, preview.startBeat - preview.originalStartBeat);
                            const trimmedFrames = Math.max(0, beatDurationToFrames(trimmedBeats, this._bpm, this._sampleRate));
                            nextClip.sourceOffset = Math.max(0, clipSourceOffset + trimmedFrames);
                        }
                    }
                } else {
                    const ratio = preview.durationBeats / (clip.durationBeats || 1);
                    nextClip.durationSamples = Math.max(1, Math.round(clip.durationSamples * ratio));
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
            if ((a.fadeInCurve ?? 0.5) !== (b.fadeInCurve ?? 0.5)) return true;
            if ((a.fadeOutCurve ?? 0.5) !== (b.fadeOutCurve ?? 0.5)) return true;
            if ((a.muted ?? false) !== (b.muted ?? false)) return true;
            if ((a.isOffline ?? false) !== (b.isOffline ?? false)) return true;
            if ((a.color ?? '') !== (b.color ?? '')) return true;
            if ((a.name ?? '') !== (b.name ?? '')) return true;
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

        this._prefetchVisibleWaveforms();
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

                if (Math.abs(localX - startPx) <= EDGE_GRIP_PX + 4) {
                    return { type: 'ruler', beat, trackIndex: -1, loopHandle: 'start' };
                }
                if (Math.abs(localX - endPx) <= EDGE_GRIP_PX + 4) {
                    return { type: 'ruler', beat, trackIndex: -1, loopHandle: 'end' };
                }
            }

            return { type: 'ruler', beat, trackIndex: -1 };
        }

        const world = this._clientToWorld(clientX, clientY);
        const beat = world.beat;
        const trackIndex = world.trackIndex;

        for (let i = this._clips.length - 1; i >= 0; i--) {
            const clip = this._clips[i];
            if (clip.trackIndex !== trackIndex) continue;

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
        startContentY?: number,
        endContentY?: number,
    ): void {
        const minBeat = Math.min(startBeat, endBeat);
        const maxBeat = Math.max(startBeat, endBeat);
        const minTrack = Math.min(startTrack, endTrack);
        const maxTrack = Math.max(startTrack, endTrack);

        // Pixel-level Y overlap: if content-Y coordinates are available, use
        // them to exclude clips whose visual bounding box doesn't actually
        // overlap the marquee rectangle. This prevents selecting clips when
        // the marquee only barely grazes the edge of a boundary track.
        const usePixelY = startContentY != null && endContentY != null;
        const marqueeYMin = usePixelY ? Math.min(startContentY, endContentY) : 0;
        const marqueeYMax = usePixelY ? Math.max(startContentY, endContentY) : 0;

        const selectedIds = this._clips
            .filter((clip) => {
                const clipStart = clip.startBeat;
                const clipEnd = clip.startBeat + clip.durationBeats;
                // Skip clips on hidden (zero-height) tracks — e.g. collapsed group children
                const clipTrackHeight = this._viewport.trackHeightAt(clip.trackIndex);
                if (clipTrackHeight <= 0) return false;
                // Beat axis overlap
                if (clipEnd <= minBeat || clipStart >= maxBeat) return false;

                if (usePixelY) {
                    // Pixel-level Y overlap check
                    const clipTopPx = this._viewport.trackOffsetY(clip.trackIndex);
                    const clipBottomPx = clipTopPx + clipTrackHeight;
                    return clipBottomPx > marqueeYMin && clipTopPx < marqueeYMax;
                }

                // Fallback: integer track index range check
                return clip.trackIndex >= minTrack && clip.trackIndex <= maxTrack;
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
        if (this._hoverClipId === clipId) return;
        this._hoverClipId = clipId;
        const activeFadeClipId = this._isFadeDragMode(this._drag.mode) ? this._drag.clipId : null;

        for (const clip of this._clips) {
            const next = clip.id === this._hoverClipId || (Boolean(activeFadeClipId) && clip.id === activeFadeClipId);
            clip.hovered = next; // This flag is only used for rendering — not for React state.
        }
        this._requestRedraw();
    }

    private _onMouseDown(e: MouseEvent): void {
        if (e.button !== 0) return; // Left click only
        if (!this._canvas) return;

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

                const clip = this._clips.find(c => c.id === hit.clipId);
                if (!clip) break;

                if (hit.fadeCurveHandle === 'in' || hit.fadeCurveHandle === 'out') {
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
                        clipOriginalFadeInCurve: this._clampFadeCurve(clip.fadeInCurve ?? 0.5),
                        clipOriginalFadeOutCurve: this._clampFadeCurve(clip.fadeOutCurve ?? 0.5),
                    };
                    break;
                }

                if (hit.fadeHandle === 'in' || hit.fadeHandle === 'out') {
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
                    break;
                }

                const isAlreadySelected = clip.selected === true;
                const multipleSelected = this._clips.filter(c => c.selected).length > 1;
                const preserveMultiSelect = isAlreadySelected && multipleSelected && !isAdditive;

                if (!preserveMultiSelect) {
                    this.onClipClick?.(hit.clipId, isShift, isCtrl);
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
                const hasSelectedClips = this._clips.some((c) => c.selected);

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
                        const selectedClips = this._clips.filter((c) => c.selected);
                        if (selectedClips.length > 0) {
                            anchorBeat = selectedClips[0].startBeat;
                            anchorTrack = selectedClips[0].trackIndex;
                            hasAnchor = true;
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

    private _onMouseMove(e: MouseEvent): void {
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
                canvas.style.cursor = 'w-resize';
            } else if (hit.type === 'clip' && hit.edge === 'right') {
                canvas.style.cursor = 'e-resize';
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
                const clip = this._clips.find(c => c.id === this._drag.clipId);
                if (clip) {
                    clip.startBeat = newBeat;
                    clip.trackIndex = newTrack;
                }
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
                canvas.style.cursor = 'w-resize';
                if (!this._drag.clipId) break;
                const deltaBeat = beat - this._drag.startBeat;
                const rawNewStart = this._drag.clipOriginalBeat + deltaBeat;
                const clipEnd = this._drag.clipOriginalBeat + this._drag.clipOriginalDuration;
                const maxNewStart = clipEnd - 0.25;

                const clipTrack = this._drag.clipOriginalTrack;
                let leftBound = 0;
                for (const c of this._clips) {
                    if (c.id === this._drag.clipId || c.trackIndex !== clipTrack) continue;
                    const cEnd = c.startBeat + c.durationBeats;
                    if (cEnd <= this._drag.clipOriginalBeat + 0.001 && cEnd > leftBound) {
                        leftBound = cEnd;
                    }
                }
                const clampedStart = Math.max(leftBound, Math.min(maxNewStart, rawNewStart));
                const newStart = this._snapBeat(clampedStart);
                const safeStart = Math.max(leftBound, newStart);
                const newDuration = Math.max(0.25, clipEnd - safeStart);
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
                canvas.style.cursor = 'e-resize';
                if (!this._drag.clipId) break;
                const rawNewEnd = beat;

                const rClipTrack = this._drag.clipOriginalTrack;
                const originalEnd = this._drag.clipOriginalBeat + this._drag.clipOriginalDuration;
                let rightBound = Infinity;
                for (const c of this._clips) {
                    if (c.id === this._drag.clipId || c.trackIndex !== rClipTrack) continue;
                    if (c.startBeat >= originalEnd - 0.001 && c.startBeat < rightBound) {
                        rightBound = c.startBeat;
                    }
                }
                const clampedEnd = Math.min(rightBound, rawNewEnd);
                const snappedEnd = this._snapBeat(Math.max(this._drag.clipOriginalBeat + 0.25, clampedEnd));
                const finalEnd = rightBound < Infinity ? Math.min(rightBound, snappedEnd) : snappedEnd;
                const newDuration = Math.max(0.25, finalEnd - this._drag.clipOriginalBeat);
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
                if (
                    this._drag.deferSingleSelectOnMouseUp
                    && this._drag.clipId
                    && this._drag.coMoverOrigins
                    && this._drag.coMoverOrigins.size > 0
                ) {
                    this.onClipClick?.(this._drag.clipId, false, false);
                }
                break;
            }
            case DragMode.ClipMove: {
                if (this._drag.clipId) {
                    if (!canvas) {
                        const clipToRestore = this._clips.find(c => c.id === this._drag.clipId);
                        if (clipToRestore) {
                            clipToRestore.startBeat = this._drag.clipOriginalBeat;
                            clipToRestore.trackIndex = this._drag.clipOriginalTrack;
                        }
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
                        const clipToRestore = this._clips.find(c => c.id === this._drag.clipId);
                        if (clipToRestore) {
                            clipToRestore.startBeat = this._drag.clipOriginalBeat;
                            clipToRestore.trackIndex = this._drag.clipOriginalTrack;
                        }
                        if (this._drag.coMoverOrigins) {
                            for (const [id, origin] of this._drag.coMoverOrigins) {
                                const co = this._clips.find(c => c.id === id);
                                if (co) {
                                    co.startBeat = origin.beat;
                                    co.trackIndex = origin.track;
                                }
                            }
                        }
                        this._trimPreview = null;
                        this._ghost = null;
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
                            this.onClipResize?.(
                                this._drag.clipId,
                                preview.startBeat,
                                preview.durationBeats,
                                preview.allowStretch,
                            );
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
                    this.onClipBoxSelection?.([]);
                    this._setMarquee(null);
                } else if (isVerticalLine) {
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
                    this.onClipBoxSelection?.([]);
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
    }

    private _onDoubleClick(e: MouseEvent): void {
        e.preventDefault();
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
    // Called from _onMouseMove (ClipMove), _onKeyDown, and _onKeyUp.
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

        const primaryClip = this._clips.find(c => c.id === this._drag.clipId);
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
                    const co = this._clips.find(c => c.id === id);
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
                    const co = this._clips.find(c => c.id === id);
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
                    const c = this._clips.find(cl => cl.id === this._drag.clipId);
                    if (c) {
                        c.startBeat = this._drag.clipOriginalBeat;
                        c.trackIndex = this._drag.clipOriginalTrack;
                        if (this._isFadeDragMode(this._drag.mode)) {
                            c.fadeIn = this._drag.clipOriginalFadeIn ?? c.fadeIn;
                            c.fadeOut = this._drag.clipOriginalFadeOut ?? c.fadeOut;
                            c.fadeInCurve = this._drag.clipOriginalFadeInCurve ?? c.fadeInCurve;
                            c.fadeOutCurve = this._drag.clipOriginalFadeOutCurve ?? c.fadeOutCurve;
                        }
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
                this._trimPreview = null;
                this._cmdDragGhosts.length = 0;
                this._drag = { mode: DragMode.None, clipId: null, startBeat: 0, startTrack: 0, currentBeat: 0, currentTrack: 0, clipOriginalBeat: 0, clipOriginalTrack: 0, clipOriginalDuration: 0, clipResizeAllowStretch: false };
                if (this._canvas) this._canvas.style.cursor = 'default';
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
