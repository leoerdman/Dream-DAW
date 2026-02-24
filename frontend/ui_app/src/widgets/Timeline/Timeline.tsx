import { useRef, useEffect, useMemo } from 'react';
import throttle from 'lodash.throttle';
import { useTimelineEngine, type UseTimelineEngineConfig } from '@/shared/lib/useTimelineEngine';
import { beatToFrame, resolveSampleRate } from '@/shared/lib/audioMath';
import type { TimelineClipData } from '@/shared/lib/CanvasClipRenderer';
import { divisionToInterval } from '@/shared/lib/gridSnap';
import { useDragStore } from '@/shared/stores/useDragStore';
import { useEngineStore } from '@/shared/stores/useEngineStore';
import { useTimelineStore } from '@/shared/stores/useTimelineStore';
import { useGridStore } from '@/shared/stores/useGridStore';
import type { BrowserDragItem, TimelineClip } from '@/shared/lib/arrangementTypes';
import { TimelineCommandBus } from '@/shared/lib/TimelineCommandBus';
import { isTrackActive } from '@/shared/utils/routing';
import { AutomationOverlay } from './AutomationOverlay';
import { useTimelineDnD } from './model/useTimelineDnD';
import { useTimelineCommandBusBindings, useTimelineEngineCommandBindings } from './model/useTimelineCommandBindings';

interface TimelineProps {
    bpm?: number;
    timeSignature?: [number, number];
    totalBars?: number;
    trackCount?: number;
    trackHeight?: number;
    trackHeights?: number[];
    clips?: TimelineClip[];
    playheadBeat?: number;
    editCursorBeat?: number;
    editCursorTrackIndex?: number;
    editCursorTrackIndexEnd?: number;
    selectedTrackIndex?: number;
    selectedTrackIndices?: number[];
    isPlaying?: boolean;
    recordingActive?: boolean;
    recordingTrackIndex?: number;
    trackIds?: string[];
    loopStart?: number;
    loopEnd?: number;
    loopEnabled?: boolean;
    onPlayheadChange?: (beat: number) => void;
    onEditCursorChange?: (beat: number, trackStart: number, trackEnd: number) => void;
    onClipSelect?: (clipId: string) => void;
    selectedClipIds?: string[];
    onClipSelectionChange?: (clipIds: string[]) => void;
    onClipMove?: (clipId: string, newStartBeat: number, newTrackIndex: number) => void;
    onClipResize?: (clipId: string, newStartBeat: number, newDuration: number, allowStretch: boolean) => void;
    onClipFades?: (clipId: string, fadeInFrames: number, fadeOutFrames: number) => void;
    onClipFadeCurves?: (clipId: string, fadeInCurve: number, fadeOutCurve: number) => void;
    onDropBrowserItem?: (item: BrowserDragItem, trackIndex: number, beat: number) => void;
    onDoubleClickTrack?: (trackIndex: number, beat: number) => void;
    onOpenMidiClip?: (clipId: string, trackIndex: number) => void;
    onTrackSelect?: (trackId: string, trackIndex: number) => void;
    onMarqueeSelectionStart?: () => void;
    onMarqueeSelectionChange?: (marquee: { startBeat: number; endBeat: number; startTrack: number; endTrack: number } | null) => void;
    followPlayhead?: boolean;
    automationVisible?: boolean;
    fitHorizontalToken?: number;
}

const RULER_HEIGHT = 28;
const DEFAULT_PPB = 20;
const DEFAULT_TRACK_HEIGHT = 48;
const TRAILING_EMPTY_TRACK_SLOTS = 1;

export const Timeline = (props: TimelineProps) => {
    const {
        bpm = 120,
        timeSignature = [4, 4],
        totalBars = 128,
        trackCount = 8,
        trackHeight = DEFAULT_TRACK_HEIGHT,
        trackHeights,
        clips = [],
        editCursorBeat = 0,
        editCursorTrackIndex = 0,
        editCursorTrackIndexEnd = 0,
        selectedTrackIndex = -1,
        selectedTrackIndices,
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
        onClipFades,
        onDropBrowserItem,
        onClipFadeCurves,
        onDoubleClickTrack,
        onOpenMidiClip,
        onTrackSelect,
        onMarqueeSelectionStart,
        onMarqueeSelectionChange,
        onClipResize,
        fitHorizontalToken = 0,
    } = props;

    const beatsPerBar = timeSignature[0];
    const totalBeats = totalBars * beatsPerBar;
    const engineSampleRate = useEngineStore((s) => s.transport.sample_rate);

    const gridDivision = useGridStore((s) => s.division);
    const gridTriplet = useGridStore((s) => s.triplet);
    const snapEnabled = useGridStore((s) => s.snapEnabled);
    const pixelsPerBeat = useTimelineStore((s) => s.pixelsPerBeat);
    const restoreSeq = useTimelineStore((s) => s.restoreSeq);
    const restorePixelsPerBeat = useTimelineStore((s) => s.restorePixelsPerBeat);
    const restoreScrollLeft = useTimelineStore((s) => s.restoreScrollLeft);
    const restoreScrollTop = useTimelineStore((s) => s.restoreScrollTop);
    const setTimelineLayout = useTimelineStore((s) => s.setLayout);
    const clearViewportRestore = useTimelineStore((s) => s.clearViewportRestore);
    const snapBeatsValue = useMemo(
        () => divisionToInterval(gridDivision, beatsPerBar, gridTriplet, pixelsPerBeat),
        [gridDivision, beatsPerBar, gridTriplet, pixelsPerBeat],
    );

    const engineConfig: UseTimelineEngineConfig = {
        beatsPerBar,
        bpm,
        sampleRate: resolveSampleRate(engineSampleRate),
        totalBeats,
        trackCount,
        trackHeight,
        trackHeights,
        rulerHeight: RULER_HEIGHT,
        bottomPaddingPx: trackHeight * TRAILING_EMPTY_TRACK_SLOTS,
        initialPpb: DEFAULT_PPB,
        snapBeats: snapBeatsValue,
        snapEnabled,
    };

    const { canvasRef, engineRef, viewportState } = useTimelineEngine(engineConfig);
    const masterGridStepBeats = useMemo(() => {
        if (snapBeatsValue > 0) return snapBeatsValue;
        // Keep master lane grid behavior identical to CanvasClipRenderer._drawGrid.
        if (pixelsPerBeat < 8) return beatsPerBar * 4;
        if (pixelsPerBeat < 15) return beatsPerBar;
        if (pixelsPerBeat < 40) return beatsPerBar;
        if (pixelsPerBeat < 80) return 1;
        return 0.5;
    }, [snapBeatsValue, pixelsPerBeat, beatsPerBar]);
    const masterGridStepPx = Math.max(1, masterGridStepBeats * pixelsPerBeat);
    const masterBarStepPx = Math.max(1, beatsPerBar * pixelsPerBeat);
    const masterGridOffsetPx = -(viewportState.scrollX ?? 0);
    const rootRef = useRef<HTMLDivElement | null>(null);
    const arrangementRef = useRef<HTMLDivElement | null>(null);
    const propsRef = useRef(props);
    propsRef.current = props;
    const commandBusRef = useRef<TimelineCommandBus>(new TimelineCommandBus());

    const callbacksRef = useRef({
        onPlayheadChange,
        onEditCursorChange,
        onClipSelect,
        onClipSelectionChange,
        onClipMove,
        onClipResize,
        onClipFades,
        onDropBrowserItem,
        onClipFadeCurves,
        onDoubleClickTrack,
        onOpenMidiClip,
        onTrackSelect,
        onMarqueeSelectionStart,
        onMarqueeSelectionChange,
    });
    callbacksRef.current = {
        onPlayheadChange,
        onEditCursorChange,
        onClipSelect,
        onClipSelectionChange,
        onClipMove,
        onClipResize,
        onClipFades,
        onDropBrowserItem,
        onClipFadeCurves,
        onDoubleClickTrack,
        onOpenMidiClip,
        onTrackSelect,
        onMarqueeSelectionStart,
        onMarqueeSelectionChange,
    };

    const selectedClipIdsRef = useRef(selectedClipIds);
    selectedClipIdsRef.current = selectedClipIds;
    const trackIdsRef = useRef(trackIds);
    trackIdsRef.current = trackIds;

    useTimelineCommandBusBindings({
        commandBusRef,
        callbacksRef,
        selectedClipIdsRef,
        trackIdsRef,
        propsRef,
    });

    useTimelineEngineCommandBindings({
        engineRef,
        commandBusRef,
        callbacksRef,
    });
    const pendingLoopRef = useRef<{ start: number; end: number; enabled: boolean } | null>(null);
    const commitLoopRef = useRef<(loop: { start: number; end: number; enabled: boolean }) => void>(() => { });

    useEffect(() => {
        commitLoopRef.current = (loop) => {
            const currentBpm = propsRef.current.bpm || 120;
            const currentSampleRate = resolveSampleRate(useEngineStore.getState().transport.sample_rate);
            const startFrames = beatToFrame(loop.start, currentBpm, currentSampleRate);
            const endFrames = beatToFrame(loop.end, currentBpm, currentSampleRate);
            useEngineStore.getState().setLoop(loop.enabled, startFrames, endFrames);
        };
    }, []);

    const throttledLoopCommitRef = useRef(
        throttle(() => {
            const pending = pendingLoopRef.current;
            if (!pending) return;
            commitLoopRef.current(pending);
        }, 33, { leading: true, trailing: true }),
    );

    useEffect(() => {
        const throttledLoopCommit = throttledLoopCommitRef.current;
        const flush = () => {
            throttledLoopCommit.flush();
            const pending = pendingLoopRef.current;
            if (!pending) return;
            commitLoopRef.current(pending);
            pendingLoopRef.current = null;
        };
        window.addEventListener('mouseup', flush, true);
        window.addEventListener('touchend', flush, true);
        return () => {
            window.removeEventListener('mouseup', flush, true);
            window.removeEventListener('touchend', flush, true);
            throttledLoopCommit.cancel();
        };
    }, []);

    const tracksEntity = useEngineStore((s) => s.tracks);
    const trackActiveStates = useMemo(() => {
        const orderedTracks = tracksEntity.allIds
            .map((id) => tracksEntity.byId[id])
            .filter((track): track is NonNullable<typeof track> => Boolean(track));
        return orderedTracks.map((_t, i, arr) => isTrackActive(i, arr));
    }, [tracksEntity]);

    useEffect(() => {
        const engine = engineRef.current;
        if (!engine) return;
        const clipData: TimelineClipData[] = clips.map(c => ({
            fadeIn: (c.durationSamples && c.durationSamples > 0)
                ? Math.max(0, Math.min(1, (c.fadeIn ?? 0) / c.durationSamples))
                : 0,
            fadeOut: (c.durationSamples && c.durationSamples > 0)
                ? Math.max(0, Math.min(1, (c.fadeOut ?? 0) / c.durationSamples))
                : 0,
            id: c.id,
            name: c.name,
            trackIndex: c.trackIndex,
            startBeat: c.startBeat,
            durationBeats: c.durationBeats,
            type: c.type,
            color: c.color,
            selected: false,
            filePath: c.filePath,
            durationSamples: c.durationSamples,
            sourceOffset: c.sourceOffset,
            fadeInCurve: c.fadeInCurve,
            fadeOutCurve: c.fadeOutCurve,
            isOffline: c.isOffline,
            muted: c.muted,
            trackMuted: !trackActiveStates[c.trackIndex],
            isWarped: c.isWarped,
            warpSourceDurationFrames: c.warpSourceDurationFrames,
            pitchShiftSemitones: c.pitchShiftSemitones,
            midiNotes: c.midiNotes,
        }));

        engine.setClips(clipData);
        engine.setClipSelection(selectedClipIdsRef.current);
    }, [clips, engineRef, trackActiveStates]);

    useEffect(() => {
        const engine = engineRef.current;
        if (!engine) return;
        const viewport = engine.viewport;
        const viewportWidth = viewport.viewportWidth;
        if (viewportWidth <= 8) return;

        const currentClips = propsRef.current.clips ?? [];
        const currentBeatsPerBar = Math.max(1, propsRef.current.timeSignature?.[0] ?? beatsPerBar);

        let minBeat = 0;
        let maxBeat = Math.max(4, currentBeatsPerBar * 4);

        if (currentClips.length > 0) {
            minBeat = Infinity;
            maxBeat = -Infinity;
            for (const clip of currentClips) {
                const start = clip.startBeat;
                const end = clip.startBeat + Math.max(0.01, clip.durationBeats);
                if (start < minBeat) minBeat = start;
                if (end > maxBeat) maxBeat = end;
            }
            if (!Number.isFinite(minBeat) || !Number.isFinite(maxBeat)) {
                minBeat = 0;
                maxBeat = Math.max(4, currentBeatsPerBar * 4);
            }
        }

        const span = Math.max(1, maxBeat - minBeat);
        const pad = Math.max(0.5, span * 0.05);
        const paddedStart = Math.max(0, minBeat - pad);
        const paddedEnd = Math.max(paddedStart + 1, maxBeat + pad);
        const targetPpb = viewportWidth / (paddedEnd - paddedStart);

        viewport.setZoom(targetPpb);
        viewport.scrollTo(paddedStart * viewport.pixelsPerBeat, viewport.scrollY);
    }, [fitHorizontalToken, beatsPerBar, engineRef]);

    useEffect(() => {
        const engine = engineRef.current;
        if (!engine) return;
        engine.setClipSelection(selectedClipIds);
    }, [selectedClipIds, engineRef]);

    useEffect(() => {
        const engine = engineRef.current;
        if (!engine) return;

        const unsub = useEngineStore.subscribe((state, prevState) => {
            const beats = state.transport.position_beats ?? 0;
            const prevBeats = prevState?.transport.position_beats ?? 0;
            const playing = state.transport.is_playing;

            if (beats !== prevBeats) {
                engine.setPlayheadBeat(beats);
                if (playing && propsRef.current.followPlayhead) {
                    engine.ensureBeatVisible(beats);
                }
            }
        });

        return unsub;
    }, [engineRef]);

    useEffect(() => {
        const engine = engineRef.current;
        if (!engine) return;
        engine.setEditCursor(editCursorBeat, editCursorTrackIndex, editCursorTrackIndexEnd ?? editCursorTrackIndex);
    }, [editCursorBeat, editCursorTrackIndex, editCursorTrackIndexEnd, engineRef]);

    useEffect(() => {
        setTimelineLayout({
            pixelsPerBeat: viewportState.ppb,
            scrollLeft: viewportState.scrollX,
            scrollTop: viewportState.scrollY,
        });
    }, [viewportState, setTimelineLayout]);

    useEffect(() => {
        if (restorePixelsPerBeat == null || restoreScrollLeft == null) return;
        const engine = engineRef.current;
        if (!engine) return;
        engine.viewport.setZoom(restorePixelsPerBeat);
        engine.viewport.scrollTo(restoreScrollLeft, restoreScrollTop ?? engine.viewport.scrollY);
        clearViewportRestore();
    }, [restoreSeq, restorePixelsPerBeat, restoreScrollLeft, restoreScrollTop, engineRef, clearViewportRestore]);

    useEffect(() => {
        const engine = engineRef.current;
        if (!engine) return;
        const list = (selectedTrackIndices && selectedTrackIndices.length > 0)
            ? selectedTrackIndices
            : (selectedTrackIndex >= 0 ? [selectedTrackIndex] : []);
        engine.setSelectedTracks(selectedTrackIndex, list);
    }, [selectedTrackIndex, selectedTrackIndices, engineRef]);

    useEffect(() => {
        const engine = engineRef.current;
        if (!engine) return;
        engine.setLoop({
            start: loopStart,
            end: loopEnd,
            enabled: loopEnabled,
        });
    }, [loopStart, loopEnd, loopEnabled, engineRef]);

    useEffect(() => {
        const engine = engineRef.current;
        if (!engine) return;
        engine.onLoopChange = (loop) => {
            pendingLoopRef.current = loop;
            throttledLoopCommitRef.current();
        };
    }, [engineRef]);

    const draggingItem = useDragStore(s => s.draggingItem);
    const dragCursorX = useDragStore(s => s.cursorX);
    const dragCursorY = useDragStore(s => s.cursorY);

    const { handleDragOver, handleDragLeave, handleDrop } = useTimelineDnD({
        engineRef,
        canvasRef,
        commandBusRef,
        bpm,
        draggingItem,
        dragCursorX,
        dragCursorY,
    });

    return (
        <div
            ref={rootRef}
            data-testid="timeline-view"
            data-track-count={trackCount}
            data-track-ids-count={trackIds.length}
            style={{
                width: '100%',
                height: '100%',
                position: 'relative',
                display: 'flex',
                flexDirection: 'column',
                overflow: 'hidden',
                background: 'var(--surface-1)',
            }}
            onDragOver={handleDragOver}
            onDragLeave={handleDragLeave}
            onDrop={handleDrop}
        >
            <div
                ref={arrangementRef}
                style={{
                    position: 'relative',
                    flex: 1,
                    minHeight: 0,
                    overflow: 'visible',
                }}
            >
                <canvas
                    ref={canvasRef}
                    style={{
                        position: 'absolute',
                        left: 0,
                        top: 0,
                        width: '100%',
                        // Keep viewport height equal to arrangement viewport height.
                        // Extra vertical scroll room is owned by ViewportMatrix.bottomPaddingPx.
                        height: '100%',
                        display: 'block',
                    }}
                />
                {props.automationVisible && (
                    <AutomationOverlay
                        visible
                        trackCount={trackCount}
                        trackHeight={trackHeight}
                        trackHeights={trackHeights}
                        scrollTop={useTimelineStore.getState().scrollTop ?? 0}
                        width={arrangementRef.current?.clientWidth ?? 800}
                        bpm={bpm}
                    />
                )}
            </div>
            <div
                data-testid="timeline-master-lane"
                style={{
                    height: trackHeight,
                    flexShrink: 0,
                    borderTop: 'none',
                    boxShadow: 'inset 0 var(--space-px) 0 var(--color-border-subtle)',
                    backgroundColor: 'var(--color-timeline-track-default, var(--surface-1))',
                    backgroundImage: `
                        repeating-linear-gradient(
                            to right,
                            var(--color-timeline-grid-bar, rgba(74, 158, 255, 0.18)) 0 1px,
                            transparent 1px ${masterBarStepPx}px
                        ),
                        repeating-linear-gradient(
                            to right,
                            var(--color-timeline-grid-line, rgba(255, 255, 255, 0.06)) 0 1px,
                            transparent 1px ${masterGridStepPx}px
                        )
                    `,
                    backgroundSize: `${masterBarStepPx}px 100%, ${masterGridStepPx}px 100%`,
                    backgroundPosition: `${masterGridOffsetPx}px 0, ${masterGridOffsetPx}px 0`,
                    pointerEvents: 'none',
                    position: 'relative',
                    zIndex: 'var(--z-local)' as unknown as number,
                }}
            />
        </div>
    );
};
