/**
 * Timeline — Canvas-based arrangement timeline.
 *
 * Thin React shell around the TimelineEngine canvas.
 */

import { useRef, useEffect, useCallback } from 'react';
import { useTimelineEngine, type UseTimelineEngineConfig } from '@/shared/lib/useTimelineEngine';
import type { TimelineClipData } from '@/shared/lib/CanvasClipRenderer';
import { useDragStore } from '@/shared/stores/useDragStore';
import { useEngineStore } from '@/shared/stores/useEngineStore';
import { useGridStore } from '@/shared/stores/useGridStore';

// ── Types (exported for DawShell compatibility) ───────────────────────────

export interface TimelineClip {
    id: string;
    name: string;
    trackIndex: number;
    startBeat: number;
    durationBeats: number;
    type: 'audio' | 'midi';
    color: string;
    selected?: boolean;
    filePath?: string;
    durationSamples?: number;
    sourceOffset?: number;
    fadeIn?: number;
    fadeOut?: number;
    isOffline?: boolean;
    midiNotes?: Array<{
        id?: string;
        pitch: number;
        startBeat: number;
        durationBeats: number;
        velocity: number;
    }>;
}

/** Data transferred when dragging from AssetBrowser. */
export interface BrowserDragItem {
    id: string;
    name: string;
    type: string;
    path: string;
    durationSeconds?: number;
}

interface TimelineProps {
    bpm?: number;
    timeSignature?: [number, number];
    totalBars?: number;
    trackCount?: number;
    trackHeight?: number;
    clips?: TimelineClip[];
    playheadBeat?: number;
    editCursorBeat?: number;
    editCursorTrackIndex?: number;
    isPlaying?: boolean;
    recordingActive?: boolean;
    recordingTrackIndex?: number;
    trackIds?: string[];
    loopStart?: number;
    loopEnd?: number;
    loopEnabled?: boolean;
    onPlayheadChange?: (beat: number) => void;
    onEditCursorChange?: (beat: number, trackIndex: number) => void;
    onClipSelect?: (clipId: string) => void;
    selectedClipIds?: string[];
    onClipSelectionChange?: (clipIds: string[]) => void;
    onClipMove?: (clipId: string, newStartBeat: number, newTrackIndex: number) => void;
    onClipResize?: (clipId: string, newStartBeat: number, newDuration: number) => void;
    onDropBrowserItem?: (item: BrowserDragItem, trackIndex: number, beat: number) => void;
    onDoubleClickTrack?: (trackIndex: number, beat: number) => void;
    onOpenMidiClip?: (clipId: string, trackIndex: number) => void;
    onTrackSelect?: (trackId: string, trackIndex: number) => void;
    onScrollTop?: (scrollTop: number) => void;
    followPlayhead?: boolean;
}

// ── Constants ──────────────────────────────────────────────────────────────

const RULER_HEIGHT = 28;
const DEFAULT_PPB = 20;
const DEFAULT_TRACK_HEIGHT = 48;

// ── Component ──────────────────────────────────────────────────────────────

export const Timeline = (props: TimelineProps) => {
    const {
        bpm = 120,
        timeSignature = [4, 4],
        totalBars = 128,
        trackCount = 8,
        trackHeight = DEFAULT_TRACK_HEIGHT,
        clips = [],
        playheadBeat = 0,
        editCursorBeat = 0,
        editCursorTrackIndex = 0,
        isPlaying = false,
        trackIds = [],
        loopStart = 0,
        loopEnd = 4,
        loopEnabled = false,
        selectedClipIds = [],
        onPlayheadChange,
        onEditCursorChange,
        onClipSelect,
        onClipSelectionChange,
        onClipMove,
        onDropBrowserItem,
        onDoubleClickTrack,
        onOpenMidiClip,
        onTrackSelect,
        onScrollTop,
        onClipResize,
        followPlayhead = false,
    } = props;

    const beatsPerBar = timeSignature[0];
    const totalBeats = totalBars * beatsPerBar;

    // Read live sample rate from engine (could be 44100, 48000, 96000+)
    const engineSampleRate = useEngineStore((s) => s.transport.sample_rate);

    // ── Grid store for dynamic snap ───────────────────────────────────
    const gridInterval = useGridStore((s) => s.gridInterval);
    const snapEnabled = useGridStore((s) => s.snapEnabled);
    const snapBeatsValue = gridInterval(beatsPerBar);

    // ── Engine config ─────────────────────────────────────────────────
    const engineConfig: UseTimelineEngineConfig = {
        beatsPerBar,
        bpm,
        sampleRate: engineSampleRate || 44100,
        totalBeats,
        trackCount,
        trackHeight,
        rulerHeight: RULER_HEIGHT,
        initialPpb: DEFAULT_PPB,
        snapBeats: snapBeatsValue,
        snapEnabled,
    };

    const { canvasRef, engineRef } = useTimelineEngine(engineConfig);
    const rootRef = useRef<HTMLDivElement | null>(null);
    const propsRef = useRef(props);
    propsRef.current = props;

    // ── Store refs for callbacks (avoid stale closures) ───────────────
    const callbacksRef = useRef({
        onPlayheadChange,
        onEditCursorChange,
        onClipSelect,
        onClipSelectionChange,
        onClipMove,
        onClipResize,
        onDropBrowserItem,
        onDoubleClickTrack,
        onOpenMidiClip,
        onTrackSelect,
        onScrollTop,
    });
    callbacksRef.current = {
        onPlayheadChange,
        onEditCursorChange,
        onClipSelect,
        onClipSelectionChange,
        onClipMove,
        onClipResize,
        onDropBrowserItem,
        onDoubleClickTrack,
        onOpenMidiClip,
        onTrackSelect,
        onScrollTop,
    };

    // ── Wire engine callbacks ─────────────────────────────────────────
    useEffect(() => {
        const engine = engineRef.current;
        if (!engine) return;

        engine.onPlayheadSeek = (beat) => {
            callbacksRef.current.onPlayheadChange?.(beat);
        };

        engine.onEditCursorChange = (beat, track) => {
            callbacksRef.current.onEditCursorChange?.(beat, track);
        };

        engine.onClipClick = (clipId, addToSelection) => {
            if (addToSelection) {
                const prev = selectedClipIdsRef.current;
                const next = prev.includes(clipId)
                    ? prev.filter(id => id !== clipId)
                    : [...prev, clipId];
                callbacksRef.current.onClipSelectionChange?.(next);
            } else {
                callbacksRef.current.onClipSelect?.(clipId);
            }
        };

        engine.onClipMove = (clipId, newBeat, newTrack) => {
            callbacksRef.current.onClipMove?.(clipId, newBeat, newTrack);
        };

        engine.onClipBoxSelection = (clipIds) => {
            callbacksRef.current.onClipSelectionChange?.(clipIds);
        };

        engine.onClipResize = (clipId, newStartBeat, newDuration) => {
            callbacksRef.current.onClipResize?.(clipId, newStartBeat, newDuration);
        };

        engine.onDoubleClickTrack = (trackIndex, beat) => {
            callbacksRef.current.onDoubleClickTrack?.(trackIndex, beat);
        };

        engine.onDoubleClickClip = (clipId, trackIndex) => {
            callbacksRef.current.onOpenMidiClip?.(clipId, trackIndex);
        };

        engine.onTrackSelect = (trackIndex) => {
            const id = trackIdsRef.current[trackIndex] ?? `track-${trackIndex}`;
            callbacksRef.current.onTrackSelect?.(id, trackIndex);
        };

        engine.onScrollTop = (scrollTop) => {
            callbacksRef.current.onScrollTop?.(scrollTop);
        };

        engine.onLoopChange = (loop) => {
            const currentBpm = propsRef.current.bpm || 120;
            const currentSampleRate = useEngineStore.getState().transport.sample_rate || 44100;

            // Convert beats back to frames for the engine
            const startFrames = Math.round((loop.start * 60 * currentSampleRate) / currentBpm);
            const endFrames = Math.round((loop.end * 60 * currentSampleRate) / currentBpm);

            // setLoop from useEngineStore
            useEngineStore.getState().setLoop(loop.enabled, startFrames, endFrames);
        };
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, []);

    // Refs for callback closure stability
    const selectedClipIdsRef = useRef(selectedClipIds);
    selectedClipIdsRef.current = selectedClipIds;
    const trackIdsRef = useRef(trackIds);
    trackIdsRef.current = trackIds;

    // ── Feed clips to engine ──────────────────────────────────────────
    useEffect(() => {
        const engine = engineRef.current;
        if (!engine) return;

        const selectedSet = new Set(selectedClipIds);
        const clipData: TimelineClipData[] = clips.map(c => ({
            id: c.id,
            name: c.name,
            trackIndex: c.trackIndex,
            startBeat: c.startBeat,
            durationBeats: c.durationBeats,
            type: c.type,
            color: c.color,
            selected: selectedSet.has(c.id),
            filePath: c.filePath,
            durationSamples: c.durationSamples,
            sourceOffset: c.sourceOffset,
            fadeIn: c.fadeIn,
            fadeOut: c.fadeOut,
            isOffline: c.isOffline,
            midiNotes: c.midiNotes,
        }));

        engine.setClips(clipData);
    }, [clips, selectedClipIds, engineRef]);

    // ── Feed playhead ─────────────────────────────────────────────────
    useEffect(() => {
        const engine = engineRef.current;
        if (!engine) return;
        engine.setPlayheadBeat(playheadBeat);
    }, [playheadBeat, engineRef]);

    // ── Feed edit cursor ──────────────────────────────────────────────
    useEffect(() => {
        const engine = engineRef.current;
        if (!engine) return;
        engine.setEditCursor(editCursorBeat, editCursorTrackIndex);
    }, [editCursorBeat, editCursorTrackIndex, engineRef]);

    // ── Feed loop region ──────────────────────────────────────────────
    useEffect(() => {
        const engine = engineRef.current;
        if (!engine) return;
        // Always pass loop markers so handles stay visible/interactive.
        engine.setLoop({
            start: loopStart,
            end: loopEnd,
            enabled: loopEnabled,
        });
    }, [loopStart, loopEnd, loopEnabled, engineRef]);

    // ── Playhead follow ───────────────────────────────────────────────
    useEffect(() => {
        if (!isPlaying || !followPlayhead) return;
        const engine = engineRef.current;
        if (!engine) return;
        engine.ensureBeatVisible(playheadBeat);
    }, [playheadBeat, isPlaying, followPlayhead, engineRef]);

    // ── Store-based drag overlay (DawShell → Timeline) ────────────────
    const draggingItem = useDragStore(s => s.draggingItem);
    const dragCursorX = useDragStore(s => s.cursorX);
    const dragCursorY = useDragStore(s => s.cursorY);

    const handleDragOver = useCallback((e: React.DragEvent) => {
        e.preventDefault();
        e.dataTransfer.dropEffect = 'copy';

        const engine = engineRef.current;
        const canvas = canvasRef.current;
        if (!engine || !canvas) return;

        const rect = canvas.getBoundingClientRect();
        const beat = engine.viewport.screenToBeats(e.clientX, rect);
        const track = engine.viewport.screenToTrack(e.clientY, rect);

        engine.setDropTarget({ track, beat: Math.max(0, Math.round(beat)) });
    }, [engineRef, canvasRef]);

    const handleDragLeave = useCallback(() => {
        engineRef.current?.setDropTarget(null);
    }, [engineRef]);

    const handleDrop = useCallback((e: React.DragEvent) => {
        e.preventDefault();
        engineRef.current?.setDropTarget(null);

        // Try store-based drag first
        const storeDrag = useDragStore.getState().draggingItem;
        const engine = engineRef.current;
        const canvas = canvasRef.current;
        if (!engine || !canvas) return;

        const rect = canvas.getBoundingClientRect();
        const beat = Math.max(0, Math.round(engine.viewport.screenToBeats(e.clientX, rect)));
        const track = engine.viewport.screenToTrack(e.clientY, rect);

        if (storeDrag) {
            if (storeDrag.type !== 'audio' && storeDrag.type !== 'midi') {
                useDragStore.getState().endDrag();
                return;
            }
            const browserItem: BrowserDragItem = {
                id: storeDrag.id,
                name: storeDrag.name,
                type: storeDrag.type ?? 'audio',
                path: storeDrag.path ?? '',
            };
            callbacksRef.current.onDropBrowserItem?.(browserItem, track, beat);
            useDragStore.getState().endDrag();
            return;
        }

        // Try HTML5 DataTransfer
        try {
            const raw = e.dataTransfer.getData('application/json');
            if (raw) {
                const item = JSON.parse(raw) as BrowserDragItem;
                callbacksRef.current.onDropBrowserItem?.(item, track, beat);
            }
        } catch {
            // Not a valid drop
        }
    }, [engineRef, canvasRef]);

    // Store-based DnD (mouse-driven, non-HTML5):
    // update drop target while dragging and commit on global mouseup.
    useEffect(() => {
        const engine = engineRef.current;
        const root = rootRef.current;
        if (!engine || !root || !draggingItem) return;

        const rect = root.getBoundingClientRect();
        const inside =
            dragCursorX >= rect.left &&
            dragCursorX <= rect.right &&
            dragCursorY >= rect.top &&
            dragCursorY <= rect.bottom;

        if (inside && (draggingItem.type === 'audio' || draggingItem.type === 'midi')) {
            const beat = Math.max(0, Math.round(engine.viewport.screenToBeats(dragCursorX, rect)));
            const track = engine.viewport.screenToTrack(dragCursorY, rect);
            engine.setDropTarget(null);
            const widthBeats = draggingItem.durationSeconds
                ? Math.max(0.25, draggingItem.durationSeconds * (bpm / 60))
                : 4;
            engine.setGhostClip({
                trackIndex: track,
                beat,
                widthBeats,
                name: draggingItem.name,
                type: draggingItem.type === 'midi' ? 'midi' : 'audio',
            });
        } else {
            engine.setDropTarget(null);
            engine.setGhostClip(null);
        }
    }, [draggingItem, dragCursorX, dragCursorY, engineRef, bpm]);

    useEffect(() => {
        if (!draggingItem) return;

        const onMouseUp = (e: MouseEvent) => {
            const engine = engineRef.current;
            const root = rootRef.current;
            if (!engine || !root) {
                useDragStore.getState().endDrag();
                return;
            }

            const rect = root.getBoundingClientRect();
            const inside =
                e.clientX >= rect.left &&
                e.clientX <= rect.right &&
                e.clientY >= rect.top &&
                e.clientY <= rect.bottom;

            if (inside && (draggingItem.type === 'audio' || draggingItem.type === 'midi')) {
                const beat = Math.max(0, Math.round(engine.viewport.screenToBeats(e.clientX, rect)));
                const track = engine.viewport.screenToTrack(e.clientY, rect);
                callbacksRef.current.onDropBrowserItem?.(
                    {
                        id: draggingItem.id,
                        name: draggingItem.name,
                        type: draggingItem.type,
                        path: draggingItem.path,
                        durationSeconds: draggingItem.durationSeconds,
                    },
                    track,
                    beat,
                );
            }

            engine.setDropTarget(null);
            engine.setGhostClip(null);
            useDragStore.getState().endDrag();
        };

        window.addEventListener('mouseup', onMouseUp, { capture: true });
        return () => {
            window.removeEventListener('mouseup', onMouseUp, { capture: true });
        };
    }, [draggingItem, engineRef]);

    // Ghost clip is handled together with cursor-tracked drop target effect above.

    // ═══════════════════════════════════════════════════════════════════
    // RENDER — A single <canvas> element. That's it.
    // ═══════════════════════════════════════════════════════════════════

    return (
        <div
            ref={rootRef}
            style={{
                width: '100%',
                height: '100%',
                position: 'relative',
                overflow: 'hidden',
                background: '#1a1a2e',
            }}
            onDragOver={handleDragOver}
            onDragLeave={handleDragLeave}
            onDrop={handleDrop}
        >
            <canvas
                ref={canvasRef}
                style={{
                    display: 'block',
                    width: '100%',
                    height: '100%',
                }}
            />
        </div>
    );
};
