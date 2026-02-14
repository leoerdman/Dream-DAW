/**
 * Timeline — Canvas-based arrangement timeline.
 *
 * Thin React shell around the TimelineEngine canvas.
 */

import { useRef, useEffect, useCallback } from 'react';
import { useTimelineEngine, type UseTimelineEngineConfig } from '@/shared/lib/useTimelineEngine';
import type { TimelineClipData, GhostClipData } from '@/shared/lib/CanvasClipRenderer';
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
        loopEnd = 0,
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
    };

    const { canvasRef, engineRef } = useTimelineEngine(engineConfig);

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
        engine.setLoop(
            loopEnabled
                ? { start: loopStart, end: loopEnd, enabled: true }
                : null,
        );
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

    // ── Ghost clip for in-app drag ────────────────────────────────────
    useEffect(() => {
        const engine = engineRef.current;
        if (!engine) return;

        if (draggingItem) {
            const ghost: GhostClipData = {
                trackIndex: 0,
                beat: 0,
                widthBeats: 4,
                name: draggingItem.name,
                type: (draggingItem.type as 'audio' | 'midi') ?? 'audio',
            };
            engine.setGhostClip(ghost);
        } else {
            engine.setGhostClip(null);
        }
    }, [draggingItem, engineRef]);

    // ═══════════════════════════════════════════════════════════════════
    // RENDER — A single <canvas> element. That's it.
    // ═══════════════════════════════════════════════════════════════════

    return (
        <div
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
