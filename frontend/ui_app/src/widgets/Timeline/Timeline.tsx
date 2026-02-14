import { useState, useCallback, useRef, useEffect, useMemo } from 'react';
import { listen, type UnlistenFn } from '@tauri-apps/api/event';
import { ClipRenderer } from './ClipRenderer';
import { ClipFadeHandles } from './ClipFadeHandles';
import { AutomationLane } from './AutomationLane';
import { useGridStore } from '@/shared/stores/useGridStore';
import { useAutomationStore } from '@/shared/stores/useAutomationStore';
import { computeGridLines } from '@/shared/lib/gridSnap';

/**
 * Timeline — Central arrangement canvas with ruler, grid, clips, and playhead.
 *
 * Ported from ArrangementViewController.swift (1250 lines) + TimelineCanvasView.
 *
 * Layout:
 *   ┌──────────────── ruler (beat numbers + bar lines) ─────────────┐
 *   │  1   2   3   4  |  5   6   7   8  |  9  10  11  12 | ...    │
 *   ├───────────────────────────────────────────────────────────────┤
 *   │  [Track 0 lane]  [clip] [clip] [clip]                       │
 *   │  [Track 1 lane]       [clip]    [clip]                      │
 *   │  [Track 2 lane]  [midi clip] [midi clip]                    │
 *   │  ...                                                         │
 *   └───────────────────────────────────────────────────────────────┘
 *   ▲ playhead (vertical red line)
 */

// ── Types ──────────────────────────────────────────────────

export interface TimelineClip {
    id: string;
    name: string;
    trackIndex: number;
    startBeat: number;
    durationBeats: number;
    type: 'audio' | 'midi';
    color: string;
    selected?: boolean;
    /** Absolute path to source audio file (for waveform rendering). */
    filePath?: string;
    /** Duration in samples (for waveform rendering). */
    durationSamples?: number;
    /** Source offset in samples (for trimmed clips). */
    sourceOffset?: number;
    /** Fade-in duration (0..1, fraction of clip width). */
    fadeIn?: number;
    /** Fade-out duration (0..1, fraction of clip width). */
    fadeOut?: number;
}

/** Data transferred when dragging from AssetBrowser. */
export interface BrowserDragItem {
    id: string;
    name: string;
    type: string;
    path: string;
}

interface TimelineProps {
    bpm?: number;
    timeSignature?: [number, number];
    totalBars?: number;
    trackCount?: number;
    trackHeight?: number;
    clips?: TimelineClip[];
    playheadBeat?: number;
    isPlaying?: boolean;
    recordingActive?: boolean;
    recordingTrackIndex?: number;
    loopStart?: number;
    loopEnd?: number;
    loopEnabled?: boolean;
    onPlayheadChange?: (beat: number) => void;
    onClipSelect?: (clipId: string) => void;
    onClipMove?: (clipId: string, newStartBeat: number, newTrackIndex: number) => void;
    /** Called when an item is dropped from the AssetBrowser. */
    onDropBrowserItem?: (item: BrowserDragItem, trackIndex: number, beat: number) => void;
    /** Called when user double-clicks on a track lane to create a MIDI clip. */
    onDoubleClickTrack?: (trackIndex: number, beat: number) => void;
    /** Called on vertical scroll — for syncing TrackInspector. */
    onScrollTop?: (scrollTop: number) => void;
}




// ── Constants ──────────────────────────────────────────────

const RULER_HEIGHT = 24;
const MIN_PPB = 8;
const MAX_PPB = 120;
const DEFAULT_PPB = 20;

// ── Component ──────────────────────────────────────────

export const Timeline = ({
    timeSignature = [4, 4],
    totalBars = 32,
    trackCount = 9,
    trackHeight = 48,
    clips: externalClips,
    playheadBeat: externalPlayhead,
    isPlaying = false,
    recordingActive = false,
    recordingTrackIndex = 0,
    loopStart = 4,
    loopEnd = 20,
    loopEnabled = true,
    onPlayheadChange,
    onClipSelect,
    onClipMove,
    onDropBrowserItem,
    onDoubleClickTrack,
    onScrollTop,
}: TimelineProps) => {
    const [pixelsPerBeat, setPixelsPerBeat] = useState(DEFAULT_PPB);
    const [scrollLeft, setScrollLeft] = useState(0);
    const [internalPlayhead, setInternalPlayhead] = useState(0);
    const [selectedClipId, setSelectedClipId] = useState<string | null>(null);
    const [draggingClip, setDraggingClip] = useState<{
        clipId: string;
        offsetX: number;
        offsetY: number;
        startBeat: number;
        startTrack: number;
    } | null>(null);

    // Drop target state for visual feedback
    const [dropTargetTrack, setDropTargetTrack] = useState<number | null>(null);
    const [dropTargetBeat, setDropTargetBeat] = useState<number | null>(null);

    // Use external playhead (from engine telemetry) when available
    const playheadBeat = externalPlayhead ?? internalPlayhead;
    const setPlayheadBeat = (beat: number) => {
        setInternalPlayhead(beat);
    };

    // Use clips from engine store (passed via DawShell) — no demo fallback
    const clips = externalClips ?? [];
    const containerRef = useRef<HTMLDivElement>(null);
    const canvasRef = useRef<HTMLDivElement>(null);
    const scrollContainerRef = useRef<HTMLDivElement>(null);
    const phantomClipRef = useRef<HTMLDivElement>(null);
    const phantomCanvasRef = useRef<HTMLCanvasElement>(null);
    const peakQueueRef = useRef<number[]>([]);
    const drawCursorRef = useRef(0);
    const phantomStartBeatRef = useRef(0);
    const liveUnlistenRef = useRef<UnlistenFn | null>(null);
    const liveRafRef = useRef<number | null>(null);

    const beatsPerBar = timeSignature[0];
    const totalBeats = totalBars * beatsPerBar;
    const canvasWidth = totalBeats * pixelsPerBeat;
    const canvasHeight = trackCount * trackHeight;

    // ── Grid snap ──
    const snapBeat = useGridStore((s) => s.snapBeat);
    const gridLines = useMemo(
        () => computeGridLines(totalBeats, beatsPerBar, pixelsPerBeat),
        [totalBeats, beatsPerBar, pixelsPerBeat],
    );

    const clearLiveLoop = useCallback(() => {
        if (liveRafRef.current !== null) {
            cancelAnimationFrame(liveRafRef.current);
            liveRafRef.current = null;
        }
        if (liveUnlistenRef.current) {
            liveUnlistenRef.current();
            liveUnlistenRef.current = null;
        }
    }, []);

    // Subscribe to live peaks and draw directly to canvas (no React state path).
    useEffect(() => {
        clearLiveLoop();
        if (!recordingActive) {
            return;
        }

        phantomStartBeatRef.current = playheadBeat;
        peakQueueRef.current = [];
        drawCursorRef.current = 0;

        const phantomEl = phantomClipRef.current;
        const canvas = phantomCanvasRef.current;
        if (!phantomEl || !canvas) {
            return;
        }

        const startX = phantomStartBeatRef.current * pixelsPerBeat;
        const maxWidth = Math.max(1, canvasWidth - startX);
        phantomEl.style.display = 'block';
        phantomEl.style.left = `${startX}px`;
        phantomEl.style.top = `${recordingTrackIndex * trackHeight + 2}px`;
        phantomEl.style.height = `${trackHeight - 4}px`;
        phantomEl.style.width = '2px';

        const dpr = window.devicePixelRatio || 1;
        canvas.width = Math.ceil(maxWidth * dpr);
        canvas.height = Math.ceil((trackHeight - 4) * dpr);
        canvas.style.width = `${maxWidth}px`;
        canvas.style.height = `${trackHeight - 4}px`;
        const ctx = canvas.getContext('2d');
        if (ctx) {
            ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
            ctx.clearRect(0, 0, maxWidth, trackHeight - 4);
        }

        void listen<Record<string, unknown>>('live_audio_peaks', (event) => {
            const payload = event.payload || {};
            const trackIdx = Number(
                payload.track_index ?? payload.trackIndex ?? payload.track ?? recordingTrackIndex,
            );
            if (trackIdx !== recordingTrackIndex) return;
            const peak =
                typeof payload.peak === 'number'
                    ? payload.peak
                    : Array.isArray(payload.peaks)
                        ? payload.peaks.reduce((acc, v) => acc + Math.abs(Number(v) || 0), 0) / Math.max(1, payload.peaks.length)
                        : 0;
            peakQueueRef.current.push(Math.max(0, Math.min(1, Math.abs(peak))));
        }).then((unlisten) => {
            liveUnlistenRef.current = unlisten;
        }).catch((err) => {
            console.error('[Timeline] live_audio_peaks listener failed:', err);
        });

        const loop = () => {
            const localCanvas = phantomCanvasRef.current;
            const localCtx = localCanvas?.getContext('2d');
            if (localCanvas && localCtx) {
                const h = trackHeight - 4;
                const centerY = h / 2;
                for (let i = 0; i < 8 && peakQueueRef.current.length > 0; i++) {
                    const amp = peakQueueRef.current.shift() ?? 0;
                    const x = drawCursorRef.current;
                    if (x >= localCanvas.width / dpr) break;
                    const ph = Math.max(1, amp * centerY);
                    localCtx.strokeStyle = 'rgba(255, 105, 105, 0.95)';
                    localCtx.beginPath();
                    localCtx.moveTo(x + 0.5, centerY - ph);
                    localCtx.lineTo(x + 0.5, centerY + ph);
                    localCtx.stroke();
                    drawCursorRef.current += 1;
                }
            }
            liveRafRef.current = requestAnimationFrame(loop);
        };

        liveRafRef.current = requestAnimationFrame(loop);
        return clearLiveLoop;
    }, [
        recordingActive,
        recordingTrackIndex,
        trackHeight,
        pixelsPerBeat,
        canvasWidth,
        playheadBeat,
        clearLiveLoop,
    ]);

    // Stretch phantom clip width to current playhead (DOM mutation only).
    useEffect(() => {
        const phantomEl = phantomClipRef.current;
        if (!phantomEl || !recordingActive) return;
        const startX = phantomStartBeatRef.current * pixelsPerBeat;
        const currentX = playheadBeat * pixelsPerBeat;
        phantomEl.style.width = `${Math.max(2, currentX - startX)}px`;
    }, [recordingActive, playheadBeat, pixelsPerBeat]);

    useEffect(() => {
        if (!recordingActive && phantomClipRef.current) {
            phantomClipRef.current.style.display = 'none';
        }
    }, [recordingActive]);

    useEffect(() => clearLiveLoop, [clearLiveLoop]);

    // ── Scroll handler ──
    const handleScroll = useCallback((e: React.UIEvent<HTMLDivElement>) => {
        const target = e.currentTarget;
        setScrollLeft(target.scrollLeft);
        onScrollTop?.(target.scrollTop);
    }, [onScrollTop]);

    // ── Zoom (Ctrl+Scroll or pinch) ──
    useEffect(() => {
        const el = containerRef.current;
        if (!el) return;

        const onWheel = (e: WheelEvent) => {
            if (e.ctrlKey || e.metaKey) {
                e.preventDefault();
                const delta = e.deltaY > 0 ? -2 : 2;
                setPixelsPerBeat(prev => Math.max(MIN_PPB, Math.min(MAX_PPB, prev + delta)));
            }
        };
        el.addEventListener('wheel', onWheel, { passive: false });
        return () => el.removeEventListener('wheel', onWheel);
    }, []);

    // ── Auto-scroll to follow playhead during playback ──
    useEffect(() => {
        if (!isPlaying || externalPlayhead === undefined) return;
        const scrollEl = scrollContainerRef.current;
        if (!scrollEl) return;

        const playheadX = externalPlayhead * pixelsPerBeat;
        const viewLeft = scrollEl.scrollLeft;
        const viewRight = viewLeft + scrollEl.clientWidth;
        const margin = scrollEl.clientWidth * 0.15; // 15% margin

        // If playhead goes past 85% of visible area, scroll to follow
        if (playheadX > viewRight - margin) {
            scrollEl.scrollLeft = playheadX - scrollEl.clientWidth * 0.3;
        }
        // If playhead wraps back (e.g. loop), scroll back
        if (playheadX < viewLeft) {
            scrollEl.scrollLeft = Math.max(0, playheadX - margin);
        }
    }, [externalPlayhead, isPlaying, pixelsPerBeat]);

    // ── Ruler click → set playhead ──
    const handleRulerClick = useCallback((e: React.MouseEvent) => {
        const rect = e.currentTarget.getBoundingClientRect();
        const x = e.clientX - rect.left + scrollLeft;
        const beat = x / pixelsPerBeat;
        setPlayheadBeat(beat);
        onPlayheadChange?.(beat);
    }, [pixelsPerBeat, scrollLeft, onPlayheadChange]);

    // ── Canvas click → set playhead + deselect ──
    const handleCanvasClick = useCallback((e: React.MouseEvent) => {
        if ((e.target as HTMLElement).dataset.clip) return;
        const rect = e.currentTarget.getBoundingClientRect();
        const x = e.clientX - rect.left;
        const beat = x / pixelsPerBeat;
        setPlayheadBeat(beat);
        setSelectedClipId(null);
        onPlayheadChange?.(beat);
    }, [pixelsPerBeat, onPlayheadChange]);

    // ── Clip selection ──
    const handleClipClick = useCallback((e: React.MouseEvent, clipId: string) => {
        e.stopPropagation();
        setSelectedClipId(clipId);
        onClipSelect?.(clipId);
    }, [onClipSelect]);

    // ── Clip drag start ──
    const handleClipMouseDown = useCallback((e: React.MouseEvent, clip: TimelineClip) => {
        e.stopPropagation();
        setSelectedClipId(clip.id);
        onClipSelect?.(clip.id);

        const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
        setDraggingClip({
            clipId: clip.id,
            offsetX: e.clientX - rect.left,
            offsetY: e.clientY - rect.top,
            startBeat: clip.startBeat,
            startTrack: clip.trackIndex,
        });
    }, [onClipSelect]);

    // ── Global mouse move/up for drag ──
    useEffect(() => {
        if (!draggingClip) return;

        const onMove = (e: MouseEvent) => {
            if (!canvasRef.current) return;
            const rect = canvasRef.current.getBoundingClientRect();
            const x = e.clientX - rect.left - draggingClip.offsetX;
            const y = e.clientY - rect.top - draggingClip.offsetY;
            const newBeat = Math.max(0, e.altKey
                ? (x / pixelsPerBeat)
                : snapBeat(x / pixelsPerBeat, beatsPerBar)
            );
            const newTrack = Math.max(0, Math.min(trackCount - 1, Math.floor(y / trackHeight)));
            // Update in real-time for visual feedback via CSS transform
            const el = document.getElementById(`clip-${draggingClip.clipId}`);
            if (el) {
                el.style.left = `${newBeat * pixelsPerBeat}px`;
                el.style.top = `${newTrack * trackHeight}px`;
            }
        };

        const onUp = (e: MouseEvent) => {
            if (!canvasRef.current) return;
            const rect = canvasRef.current.getBoundingClientRect();
            const x = e.clientX - rect.left - draggingClip.offsetX;
            const y = e.clientY - rect.top - draggingClip.offsetY;
            const newBeat = Math.max(0, e.altKey
                ? (x / pixelsPerBeat)
                : snapBeat(x / pixelsPerBeat, beatsPerBar)
            );
            const newTrack = Math.max(0, Math.min(trackCount - 1, Math.floor(y / trackHeight)));
            onClipMove?.(draggingClip.clipId, newBeat, newTrack);
            setDraggingClip(null);
        };

        window.addEventListener('mousemove', onMove);
        window.addEventListener('mouseup', onUp);
        return () => {
            window.removeEventListener('mousemove', onMove);
            window.removeEventListener('mouseup', onUp);
        };
    }, [draggingClip, pixelsPerBeat, trackHeight, trackCount, onClipMove]);

    // Ruler marks
    const rulerMarks = useMemo(() => {
        const marks: { beat: number; label: string; isBar: boolean }[] = [];
        for (let beat = 0; beat <= totalBeats; beat++) {
            const barIndex = Math.floor(beat / beatsPerBar) + 1;
            const beatInBar = beat % beatsPerBar;
            if (beatInBar === 0) {
                marks.push({ beat, label: `${barIndex}`, isBar: true });
            } else {
                marks.push({ beat, label: '', isBar: false });
            }
        }
        return marks;
    }, [totalBeats, beatsPerBar]);

    return (
        <div
            ref={containerRef}
            style={{
                width: '100%',
                height: '100%',
                display: 'flex',
                flexDirection: 'column',
                background: 'var(--color-bg-canvas)',
                position: 'relative',
                overflow: 'hidden',
            }}
        >
            {/* ── Ruler ── */}
            <div
                onClick={handleRulerClick}
                style={{
                    height: RULER_HEIGHT,
                    flexShrink: 0,
                    position: 'relative',
                    overflow: 'hidden',
                    background: 'var(--color-bg-header)',
                    borderBottom: '1px solid var(--color-divider)',
                    cursor: 'pointer',
                }}
            >
                <div style={{
                    position: 'absolute',
                    top: 0,
                    left: -scrollLeft,
                    width: canvasWidth,
                    height: '100%',
                    display: 'flex',
                    alignItems: 'flex-end',
                }}>
                    {rulerMarks.map(mark => (
                        <div
                            key={mark.beat}
                            style={{
                                position: 'absolute',
                                left: mark.beat * pixelsPerBeat,
                                height: '100%',
                                display: 'flex',
                                flexDirection: 'column',
                                justifyContent: 'space-between',
                            }}
                        >
                            {mark.isBar && (
                                <span style={{
                                    fontSize: 9,
                                    fontFamily: 'var(--font-mono)',
                                    color: 'var(--color-text-secondary)',
                                    padding: '2px 3px 0',
                                    fontWeight: 500,
                                }}>
                                    {mark.label}
                                </span>
                            )}
                            <div style={{
                                width: 1,
                                height: mark.isBar ? 10 : 5,
                                background: mark.isBar ? 'var(--color-text-tertiary)' : 'var(--color-divider)',
                                alignSelf: 'flex-start',
                            }} />
                        </div>
                    ))}

                    {/* Playhead indicator on ruler */}
                    <div style={{
                        position: 'absolute',
                        left: playheadBeat * pixelsPerBeat - 4,
                        bottom: 0,
                        width: 0,
                        height: 0,
                        borderLeft: '5px solid transparent',
                        borderRight: '5px solid transparent',
                        borderBottom: '6px solid var(--color-accent-primary)',
                    }} />
                </div>

                {/* Loop region on ruler */}
                {loopEnabled && (
                    <div style={{
                        position: 'absolute',
                        left: loopStart * pixelsPerBeat - scrollLeft,
                        width: (loopEnd - loopStart) * pixelsPerBeat,
                        top: 0,
                        height: '100%',
                        background: 'color-mix(in srgb, var(--color-accent-primary) 15%, transparent)',
                        borderLeft: '1px solid var(--color-accent-primary)',
                        borderRight: '1px solid var(--color-accent-primary)',
                        pointerEvents: 'none',
                    }} />
                )}
            </div>

            {/* ── Canvas (scrollable) ── */}
            <div
                ref={scrollContainerRef}
                onScroll={handleScroll}
                className="scrollbar-hide"
                onDragOver={(e) => {
                    if (e.dataTransfer.types.includes('application/x-dream-browser-item')) {
                        e.preventDefault();
                        e.dataTransfer.dropEffect = 'copy';
                    }
                }}
                onDrop={(e) => {
                    e.preventDefault();
                    const raw = e.dataTransfer.getData('application/x-dream-browser-item');
                    if (!raw) return;
                    try {
                        const item = JSON.parse(raw) as BrowserDragItem;
                        const rect = e.currentTarget.getBoundingClientRect();
                        const y = e.clientY - rect.top;
                        const x = e.clientX - rect.left;
                        const track = Math.min(Math.floor(y / trackHeight), trackCount - 1);
                        const beat = Math.max(0, snapBeat(x / pixelsPerBeat, beatsPerBar));
                        console.log('[Timeline] Drop on scroll container', { item, track, beat });
                        onDropBrowserItem?.(item, track, beat);
                    } catch (err) {
                        console.error('[Timeline] Scroll container drop parse error:', err);
                    } finally {
                        setDropTargetTrack(null);
                        setDropTargetBeat(null);
                    }
                }}
                style={{
                    flex: 1,
                    overflow: 'auto',
                    position: 'relative',
                }}
            >
                <div
                    ref={canvasRef}
                    onClick={handleCanvasClick}
                    onDoubleClick={(e) => {
                        // Double-click on a track lane → create MIDI clip
                        const rect = e.currentTarget.getBoundingClientRect();
                        const y = e.clientY - rect.top;
                        const x = e.clientX - rect.left;
                        const track = Math.min(Math.floor(y / trackHeight), trackCount - 1);
                        const beat = Math.max(0, e.altKey
                            ? (x / pixelsPerBeat)
                            : snapBeat(x / pixelsPerBeat, beatsPerBar)
                        );
                        onDoubleClickTrack?.(track, beat);
                    }}
                    onDragOver={(e) => {
                        // Accept drops only if we have browser item data
                        if (e.dataTransfer.types.includes('application/x-dream-browser-item')) {
                            e.preventDefault();
                            e.dataTransfer.dropEffect = 'copy';
                            // Compute target track from cursor Y
                            const rect = e.currentTarget.getBoundingClientRect();
                            const y = e.clientY - rect.top;
                            const x = e.clientX - rect.left;
                            const track = Math.min(Math.floor(y / trackHeight), trackCount - 1);
                            const beat = Math.max(0, snapBeat(x / pixelsPerBeat, beatsPerBar)); // magnetic snap
                            setDropTargetTrack(track);
                            setDropTargetBeat(beat);
                        }
                    }}
                    onDragLeave={() => {
                        setDropTargetTrack(null);
                        setDropTargetBeat(null);
                    }}
                    onDrop={(e) => {
                        e.preventDefault();
                        const raw = e.dataTransfer.getData('application/x-dream-browser-item');
                        if (!raw) return;
                        try {
                            const item = JSON.parse(raw) as BrowserDragItem;
                            const rect = e.currentTarget.getBoundingClientRect();
                            const y = e.clientY - rect.top;
                            const x = e.clientX - rect.left;
                            const track = Math.min(Math.floor(y / trackHeight), trackCount - 1);
                            const beat = Math.max(0, snapBeat(x / pixelsPerBeat, beatsPerBar));
                            onDropBrowserItem?.(item, track, beat);
                        } catch (err) {
                            console.error('[Timeline] Drop parse error:', err);
                        } finally {
                            setDropTargetTrack(null);
                            setDropTargetBeat(null);
                        }
                    }}
                    style={{
                        position: 'relative',
                        width: canvasWidth,
                        height: canvasHeight,
                        minHeight: '100%',
                    }}
                >
                    {/* ── Grid lines (adaptive sub-division) ── */}
                    <svg
                        width={canvasWidth}
                        height={canvasHeight}
                        style={{ position: 'absolute', top: 0, left: 0, pointerEvents: 'none' }}
                    >
                        {/* Horizontal track dividers */}
                        {Array.from({ length: trackCount + 1 }, (_, i) => (
                            <line
                                key={`h-${i}`}
                                x1={0}
                                y1={i * trackHeight}
                                x2={canvasWidth}
                                y2={i * trackHeight}
                                stroke="var(--color-divider)"
                                strokeWidth={1}
                            />
                        ))}

                        {/* Vertical grid lines — dynamic resolution based on zoom */}
                        {gridLines.map((gl, idx) => {
                            const opacity = gl.isBar ? 0.6
                                : gl.isMainBeat ? 0.3
                                    : gl.depth === 2 ? 0.15
                                        : gl.depth === 3 ? 0.1
                                            : 0.07;
                            return (
                                <line
                                    key={`v-${idx}`}
                                    x1={gl.beat * pixelsPerBeat}
                                    y1={0}
                                    x2={gl.beat * pixelsPerBeat}
                                    y2={canvasHeight}
                                    stroke={gl.isBar ? 'var(--color-divider)' : 'var(--color-divider-light)'}
                                    strokeWidth={gl.isBar ? 1 : 0.5}
                                    opacity={opacity}
                                />
                            );
                        })}
                    </svg>

                    {/* ── Loop region overlay ── */}
                    {loopEnabled && (
                        <div style={{
                            position: 'absolute',
                            left: loopStart * pixelsPerBeat,
                            width: (loopEnd - loopStart) * pixelsPerBeat,
                            top: 0,
                            height: '100%',
                            background: 'color-mix(in srgb, var(--color-accent-primary) 5%, transparent)',
                            pointerEvents: 'none',
                            zIndex: 1,
                        }} />
                    )}

                    {/* ── Clips ── */}
                    {clips.map(clip => {
                        const isSelected = selectedClipId === clip.id;
                        const left = clip.startBeat * pixelsPerBeat;
                        const width = clip.durationBeats * pixelsPerBeat;
                        const top = clip.trackIndex * trackHeight;

                        return (
                            <div
                                id={`clip-${clip.id}`}
                                key={clip.id}
                                data-clip="true"
                                onClick={e => handleClipClick(e, clip.id)}
                                onMouseDown={e => handleClipMouseDown(e, clip)}
                                style={{
                                    position: 'absolute',
                                    left,
                                    top: top + 2,
                                    width: Math.max(2, width - 1),
                                    height: trackHeight - 4,
                                    background: clip.color,
                                    opacity: isSelected ? 1 : 0.85,
                                    borderRadius: 2,
                                    border: isSelected
                                        ? '1.5px solid var(--color-text-primary)'
                                        : '1px solid rgba(255,255,255,0.1)',
                                    cursor: draggingClip ? 'grabbing' : 'grab',
                                    zIndex: isSelected ? 10 : 2,
                                    overflow: 'hidden',
                                    display: 'flex',
                                    flexDirection: 'column',
                                    transition: draggingClip ? 'none' : 'opacity 0.1s',
                                }}
                            >
                                {/* Clip title */}
                                <span style={{
                                    fontSize: 9,
                                    fontWeight: 600,
                                    color: '#fff',
                                    textShadow: '0 1px 2px rgba(0,0,0,0.5)',
                                    padding: '2px 4px',
                                    whiteSpace: 'nowrap',
                                    overflow: 'hidden',
                                    textOverflow: 'ellipsis',
                                }}>
                                    {clip.name}
                                </span>

                                {/* Waveform / MIDI note visualization */}
                                <div style={{
                                    flex: 1,
                                    position: 'relative',
                                    overflow: 'hidden',
                                }}>
                                    {clip.type === 'audio' && clip.filePath && clip.durationSamples ? (
                                        <ClipRenderer
                                            filePath={clip.filePath}
                                            width={width}
                                            height={trackHeight - 16}
                                            durationSamples={clip.durationSamples}
                                            sourceOffset={clip.sourceOffset}
                                            isSelected={isSelected}
                                        />
                                    ) : clip.type === 'audio' ? (
                                        <AudioWaveformFallback width={width} />
                                    ) : (
                                        <MidiNoteFallback width={width} height={trackHeight - 16} />
                                    )}
                                </div>

                                {/* Fade handles + Resize edges + Slip edit */}
                                <ClipFadeHandles
                                    width={Math.max(2, width - 1)}
                                    height={trackHeight - 4}
                                    fadeIn={clip.fadeIn ?? 0}
                                    fadeOut={clip.fadeOut ?? 0}
                                    isSelected={isSelected}
                                    color={clip.color}
                                />
                            </div>
                        );
                    })}

                    {/* ── Live Recording Phantom Clip (canvas-driven, no React state drawing) ── */}
                    <div
                        ref={phantomClipRef}
                        style={{
                            position: 'absolute',
                            display: 'none',
                            border: '1px solid rgba(255, 105, 105, 0.95)',
                            borderRadius: 2,
                            background: 'rgba(255, 65, 65, 0.22)',
                            overflow: 'hidden',
                            zIndex: 12,
                            pointerEvents: 'none',
                        }}
                    >
                        <canvas
                            ref={phantomCanvasRef}
                            style={{
                                display: 'block',
                                pointerEvents: 'none',
                                background: 'rgba(255, 30, 30, 0.1)',
                            }}
                        />
                    </div>

                    {/* ── Automation Lanes (SVG overlays per track) ── */}
                    {Array.from({ length: trackCount }, (_, trackIdx) => {
                        const trackId = `track-${trackIdx}`;
                        const expanded = useAutomationStore.getState().expandedTracks.has(trackId);
                        if (!expanded) return null;
                        const lanes = useAutomationStore.getState().getLanesForTrack(trackId);
                        return lanes.filter(l => l.visible).map(lane => (
                            <div
                                key={lane.id}
                                style={{
                                    position: 'absolute',
                                    left: 0,
                                    top: trackIdx * trackHeight,
                                    width: canvasWidth,
                                    height: trackHeight,
                                    zIndex: 12,
                                    pointerEvents: 'none',
                                }}
                            >
                                <AutomationLane
                                    lane={lane}
                                    width={canvasWidth}
                                    height={trackHeight}
                                    pixelsPerBeat={pixelsPerBeat}
                                    scrollOffsetBeats={scrollLeft / pixelsPerBeat}
                                />
                            </div>
                        ));
                    })}

                    {/* ── Drop target indicator ── */}
                    {dropTargetTrack !== null && (
                        <div style={{
                            position: 'absolute',
                            left: 0,
                            top: dropTargetTrack * trackHeight,
                            width: '100%',
                            height: trackHeight,
                            background: 'color-mix(in srgb, var(--color-accent-primary) 15%, transparent)',
                            border: '1px dashed var(--color-accent-primary)',
                            borderRadius: 2,
                            zIndex: 15,
                            pointerEvents: 'none',
                            animation: 'pulse 1s ease-in-out infinite',
                        }}>
                            {dropTargetBeat !== null && (
                                <div style={{
                                    position: 'absolute',
                                    left: dropTargetBeat * pixelsPerBeat,
                                    top: 2,
                                    bottom: 2,
                                    width: 2,
                                    background: 'var(--color-accent-primary)',
                                    borderRadius: 1,
                                }} />
                            )}
                        </div>
                    )}

                    {/* ── Playhead ── */}
                    <div style={{
                        position: 'absolute',
                        left: playheadBeat * pixelsPerBeat,
                        top: 0,
                        width: 1.5,
                        height: '100%',
                        background: 'var(--color-accent-primary)',
                        zIndex: 20,
                        pointerEvents: 'none',
                        boxShadow: '0 0 6px var(--color-accent-primary)',
                    }} />
                </div>
            </div>
        </div>
    );
};

/** Minimal waveform bars — used when peaks data is unavailable */
const AudioWaveformFallback = ({ width }: { width: number }) => {
    const segmentCount = Math.max(4, Math.floor(width / 3));
    return (
        <svg
            width="100%"
            height="100%"
            viewBox={`0 0 ${segmentCount} 20`}
            preserveAspectRatio="none"
            style={{ opacity: 0.4 }}
        >
            {Array.from({ length: segmentCount }, (_, i) => {
                const h = 3 + Math.random() * 14;
                const y = 10 - h / 2;
                return (
                    <rect
                        key={i}
                        x={i}
                        y={y}
                        width={0.7}
                        height={h}
                        fill="rgba(255,255,255,0.6)"
                    />
                );
            })}
        </svg>
    );
};

/** MIDI note blocks — compact piano-roll style */
const MidiNoteFallback = ({ width }: { width: number; height?: number }) => {
    const noteCount = Math.max(2, Math.floor(width / 8));
    // Deterministic pseudo-random: seed-based hash so notes don't jump on re-render
    const seed = (i: number) => {
        let h = i * 2654435761; // Knuth multiplicative hash
        h = ((h >>> 16) ^ h) * 0x45d9f3b;
        h = ((h >>> 16) ^ h) * 0x45d9f3b;
        h = (h >>> 16) ^ h;
        return (h & 0xffff) / 0xffff; // 0..1
    };
    return (
        <svg
            width="100%"
            height="100%"
            viewBox={`0 0 ${noteCount * 3} 12`}
            preserveAspectRatio="none"
            style={{ opacity: 0.5 }}
        >
            {Array.from({ length: noteCount }, (_, i) => {
                const y = 1 + Math.floor(seed(i) * 9);
                const w = 0.8 + seed(i + 1000) * 1.5;
                return (
                    <rect
                        key={i}
                        x={i * 3}
                        y={y}
                        width={w}
                        height={1.5}
                        fill="rgba(255,255,255,0.7)"
                        rx={0.3}
                    />
                );
            })}
        </svg>
    );
};
