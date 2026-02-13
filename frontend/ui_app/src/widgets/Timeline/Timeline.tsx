import { useState, useCallback, useRef, useEffect, useMemo } from 'react';

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
    loopStart?: number;
    loopEnd?: number;
    loopEnabled?: boolean;
    onPlayheadChange?: (beat: number) => void;
    onClipSelect?: (clipId: string) => void;
    onClipMove?: (clipId: string, newStartBeat: number, newTrackIndex: number) => void;
}

// ── Demo Data (matching the Swift DAW screenshot) ──────────

const TRACK_COLORS = [
    '#c93c38', '#c93c38', '#2d8fa5', '#2d8fa5',
    '#d97028', '#a2a835', '#38a84f', '#c850a0',
    '#4466cc',
];

const DEMO_CLIPS: TimelineClip[] = [
    // DRUMS group
    { id: 'c1', name: 'MIDI 1', trackIndex: 0, startBeat: 4, durationBeats: 32, type: 'midi', color: TRACK_COLORS[0] },
    { id: 'c1b', name: 'MIDI 1', trackIndex: 0, startBeat: 40, durationBeats: 8, type: 'midi', color: TRACK_COLORS[0] },
    { id: 'c1c', name: 'MIDI 1', trackIndex: 0, startBeat: 52, durationBeats: 8, type: 'midi', color: TRACK_COLORS[0] },
    { id: 'c1d', name: 'MIDI 1', trackIndex: 0, startBeat: 64, durationBeats: 8, type: 'midi', color: TRACK_COLORS[0] },
    { id: 'c1e', name: 'MIDI 1', trackIndex: 0, startBeat: 76, durationBeats: 8, type: 'midi', color: TRACK_COLORS[0] },
    { id: 'c1f', name: 'MIDI 1', trackIndex: 0, startBeat: 88, durationBeats: 8, type: 'midi', color: TRACK_COLORS[0] },
    { id: 'c1g', name: 'MIDI 1', trackIndex: 0, startBeat: 100, durationBeats: 8, type: 'midi', color: TRACK_COLORS[0] },

    // Kick
    { id: 'c2', name: 'MIDI 2', trackIndex: 1, startBeat: 16, durationBeats: 16, type: 'midi', color: '#d9a428' },
    { id: 'c2b', name: 'MIDI 2', trackIndex: 1, startBeat: 36, durationBeats: 8, type: 'midi', color: '#d9a428' },
    { id: 'c2c', name: 'MIDI 2', trackIndex: 1, startBeat: 48, durationBeats: 8, type: 'midi', color: '#d9a428' },
    { id: 'c2d', name: 'MIDI 2', trackIndex: 1, startBeat: 60, durationBeats: 8, type: 'midi', color: '#d9a428' },

    // Snare
    { id: 'c3', name: 'MID...', trackIndex: 2, startBeat: 8, durationBeats: 4, type: 'midi', color: '#6baa55' },
    { id: 'c3b', name: 'MID...', trackIndex: 2, startBeat: 16, durationBeats: 4, type: 'midi', color: '#6baa55' },
    { id: 'c3c', name: 'MID...', trackIndex: 2, startBeat: 24, durationBeats: 4, type: 'midi', color: '#6baa55' },
    { id: 'c3d', name: 'MID...', trackIndex: 2, startBeat: 32, durationBeats: 4, type: 'midi', color: '#6baa55' },
    { id: 'c3e', name: 'MID...', trackIndex: 2, startBeat: 40, durationBeats: 4, type: 'midi', color: '#6baa55' },
    { id: 'c3f', name: 'MID...', trackIndex: 2, startBeat: 48, durationBeats: 4, type: 'midi', color: '#6baa55' },
    { id: 'c3g', name: 'MID...', trackIndex: 2, startBeat: 56, durationBeats: 4, type: 'midi', color: '#6baa55' },
    { id: 'c3h', name: 'MID...', trackIndex: 2, startBeat: 64, durationBeats: 4, type: 'midi', color: '#6baa55' },
    { id: 'c3i', name: 'MID...', trackIndex: 2, startBeat: 72, durationBeats: 4, type: 'midi', color: '#6baa55' },
    { id: 'c3j', name: 'MID...', trackIndex: 2, startBeat: 80, durationBeats: 4, type: 'midi', color: '#6baa55' },

    // Hihat - Metropolis Pad
    { id: 'c4', name: 'Metropolis Pad - 3B', trackIndex: 3, startBeat: 0, durationBeats: 16, type: 'audio', color: '#d97028' },
    { id: 'c4b', name: 'Metropolis Pad - 3B', trackIndex: 3, startBeat: 20, durationBeats: 16, type: 'audio', color: '#d97028' },
    { id: 'c4c', name: 'Metropolis Pad - 3B', trackIndex: 3, startBeat: 40, durationBeats: 16, type: 'audio', color: '#d97028' },
    { id: 'c4d', name: 'Metropolis Pad - 3B', trackIndex: 3, startBeat: 60, durationBeats: 16, type: 'audio', color: '#d97028' },
    { id: 'c4e', name: 'Metropolis Pad - 3B', trackIndex: 3, startBeat: 80, durationBeats: 16, type: 'audio', color: '#d97028' },

    // Hihat Pad (green-yellow waveform)
    { id: 'c5', name: 'Hihat Pad', trackIndex: 4, startBeat: 0, durationBeats: 32, type: 'audio', color: '#a2a835' },
    { id: 'c5b', name: 'Hihat Pad', trackIndex: 4, startBeat: 36, durationBeats: 32, type: 'audio', color: '#a2a835' },
    { id: 'c5c', name: 'Hihat Pad', trackIndex: 4, startBeat: 72, durationBeats: 32, type: 'audio', color: '#a2a835' },

    // BASS
    { id: 'c6', name: '10_AB_VOL51_bassloop_E', trackIndex: 5, startBeat: 32, durationBeats: 12, type: 'audio', color: '#c850a0' },
    { id: 'c6b', name: '10_AB_VOL51_bassloop_E', trackIndex: 5, startBeat: 48, durationBeats: 12, type: 'audio', color: '#c850a0' },
    { id: 'c6c', name: '10_AB_VOL51_bassloop_E', trackIndex: 5, startBeat: 64, durationBeats: 12, type: 'audio', color: '#c850a0' },

    // MIDI 7
    { id: 'c7', name: 'MIDI 7', trackIndex: 6, startBeat: 0, durationBeats: 40, type: 'midi', color: '#4466cc' },
    { id: 'c7b', name: 'MIDI 7', trackIndex: 6, startBeat: 44, durationBeats: 40, type: 'midi', color: '#4466cc' },

    // MIDI 8
    { id: 'c8', name: 'MIDI 8', trackIndex: 7, startBeat: 0, durationBeats: 40, type: 'midi', color: '#8844aa' },
    { id: 'c8b', name: 'MIDI 8', trackIndex: 7, startBeat: 44, durationBeats: 20, type: 'midi', color: '#8844aa' },
];

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
    loopStart = 4,
    loopEnd = 20,
    loopEnabled = true,
    onPlayheadChange,
    onClipSelect,
    onClipMove,
}: TimelineProps) => {
    const [pixelsPerBeat, setPixelsPerBeat] = useState(DEFAULT_PPB);
    const [scrollLeft, setScrollLeft] = useState(0);
    const [playheadBeat, setPlayheadBeat] = useState(externalPlayhead ?? 40);
    const [selectedClipId, setSelectedClipId] = useState<string | null>(null);
    const [draggingClip, setDraggingClip] = useState<{
        clipId: string;
        offsetX: number;
        offsetY: number;
        startBeat: number;
        startTrack: number;
    } | null>(null);

    const clips = externalClips ?? DEMO_CLIPS;
    const containerRef = useRef<HTMLDivElement>(null);
    const canvasRef = useRef<HTMLDivElement>(null);

    const beatsPerBar = timeSignature[0];
    const totalBeats = totalBars * beatsPerBar;
    const canvasWidth = totalBeats * pixelsPerBeat;
    const canvasHeight = trackCount * trackHeight;

    // ── Scroll handler ──
    const handleScroll = useCallback((e: React.UIEvent<HTMLDivElement>) => {
        const target = e.currentTarget;
        setScrollLeft(target.scrollLeft);
    }, []);

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
            const newBeat = Math.max(0, Math.round((x / pixelsPerBeat) * 4) / 4);
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
            const newBeat = Math.max(0, Math.round((x / pixelsPerBeat) * 4) / 4);
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
                onScroll={handleScroll}
                className="scrollbar-hide"
                style={{
                    flex: 1,
                    overflow: 'auto',
                    position: 'relative',
                }}
            >
                <div
                    ref={canvasRef}
                    onClick={handleCanvasClick}
                    style={{
                        position: 'relative',
                        width: canvasWidth,
                        height: canvasHeight,
                        minHeight: '100%',
                    }}
                >
                    {/* ── Grid lines ── */}
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

                        {/* Vertical beat lines */}
                        {Array.from({ length: totalBeats + 1 }, (_, beat) => {
                            const isBar = beat % beatsPerBar === 0;
                            return (
                                <line
                                    key={`v-${beat}`}
                                    x1={beat * pixelsPerBeat}
                                    y1={0}
                                    x2={beat * pixelsPerBeat}
                                    y2={canvasHeight}
                                    stroke={isBar ? 'var(--color-divider)' : 'var(--color-divider-light)'}
                                    strokeWidth={isBar ? 1 : 0.5}
                                    opacity={isBar ? 0.6 : 0.25}
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

                                {/* Waveform / MIDI note placeholder */}
                                <div style={{
                                    flex: 1,
                                    position: 'relative',
                                    overflow: 'hidden',
                                }}>
                                    {clip.type === 'audio' ? (
                                        <WaveformPlaceholder color={clip.color} width={width} />
                                    ) : (
                                        <MidiNotePlaceholder color={clip.color} width={width} height={trackHeight - 16} />
                                    )}
                                </div>
                            </div>
                        );
                    })}

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

// ── Sub-components ──────────────────────────────────────

/** Fake waveform representation inside audio clips */
const WaveformPlaceholder = ({ width }: { color?: string; width: number }) => {
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

/** MIDI note blocks inside midi clips */
const MidiNotePlaceholder = ({ width }: { color?: string; width: number; height?: number }) => {
    const noteCount = Math.max(2, Math.floor(width / 8));
    return (
        <svg
            width="100%"
            height="100%"
            viewBox={`0 0 ${noteCount * 3} 12`}
            preserveAspectRatio="none"
            style={{ opacity: 0.5 }}
        >
            {Array.from({ length: noteCount }, (_, i) => {
                const y = 1 + Math.floor(Math.random() * 9);
                const w = 0.8 + Math.random() * 1.5;
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
