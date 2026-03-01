import { useRef, useEffect, useMemo, useState } from 'react';
import throttle from 'lodash.throttle';
import { useTimelineEngine, type UseTimelineEngineConfig } from '@/shared/lib/useTimelineEngine';
import { beatToFrame, resolveBpm, resolveSampleRate, DEFAULT_BPM, DEFAULT_TIME_SIG_NUMERATOR, DEFAULT_TIME_SIG_DENOMINATOR } from '@/shared/lib/audioMath';
import { divisionToInterval } from '@/shared/lib/gridSnap';
import { useDragStore } from '@/shared/stores/useDragStore';
import { useEngineStore } from '@/shared/stores/useEngineStore';
import { useTimelineStore } from '@/shared/stores/useTimelineStore';
import { useGridStore } from '@/shared/stores/useGridStore';
import { useSettingsStore } from '@/shared/stores/useSettingsStore';
import { useFocusPanelStore } from '@/shared/stores/useFocusPanelStore';
import { clampTrackHeightPx } from '@/shared/config/layoutConstants';
import { TimelineCommandBus } from '@/shared/lib/TimelineCommandBus';
import { buildMasterLaneGridLines, buildMasterLaneGridStyle } from './lib/masterLaneGrid';
import { snapPhysical } from '@/shared/lib/renderUtils';

import { AutomationOverlay } from './AutomationOverlay';
import { TimelineMasterLane } from './TimelineMasterLane';
import type { TimelineProps } from './Timeline.types';
import { useTimelineCallbackRefs } from './model/useTimelineCallbackRefs';
import { useTimelineDnD } from './model/useTimelineDnD';
import { useTimelineCommandBusBindings, useTimelineEngineCommandBindings } from './model/useTimelineCommandBindings';
import { useTimelineClipSync } from './model/useTimelineClipSync';
import { useTimelineRegionEdit } from './model/useTimelineRegionEdit';
import { useTimelineViewportSync } from './model/useTimelineViewportSync';

const RULER_HEIGHT = 28;
const DEFAULT_PPB = 20;
const DEFAULT_TRACK_HEIGHT = 48;
const TRAILING_EMPTY_TRACK_SLOTS = 1;
const MASTER_LANE_ALIGNMENT_OFFSET_PX = 0;
export const Timeline = (props: TimelineProps) => {
    const {
        bpm = DEFAULT_BPM,
        timeSignature = [DEFAULT_TIME_SIG_NUMERATOR, DEFAULT_TIME_SIG_DENOMINATOR],
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
        loopEnd = DEFAULT_TIME_SIG_NUMERATOR,
        loopEnabled = false,
        selectedClipIds = [],
        onPlayheadChange,
        onEditCursorChange,
        onClipSelect,
        onClipSelectionChange,
        onClipMove,
        onClipDuplicate,
        onClipFades,
        onDropBrowserItem,
        onClipFadeCurves,
        onDoubleClickTrack,
        onOpenMidiClip,
        onTrackSelect,
        onMarqueeSelectionStart,
        onMarqueeSelectionChange,
        marqueeSelection = null,
        onClipResize,
        fitHorizontalToken = 0,
    } = props;
    const normalizedTrackHeight = clampTrackHeightPx(trackHeight);
    const normalizedTrackHeights = useMemo(
        () => trackHeights?.map((h) => clampTrackHeightPx(h)),
        [trackHeights],
    );
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
    const timelineScrollTop = useTimelineStore((s) => (props.automationVisible ? s.scrollTop : 0));
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
        trackHeight: normalizedTrackHeight,
        trackHeights: normalizedTrackHeights,
        rulerHeight: RULER_HEIGHT,
        // BUG-058 FIX: Empty track slots at bottom should use settings or fallback to 1
        bottomPaddingPx: normalizedTrackHeight * (((useSettingsStore.getState().settings as { trailingEmptyTrackSlots?: number }).trailingEmptyTrackSlots) ?? TRAILING_EMPTY_TRACK_SLOTS),
        initialPpb: DEFAULT_PPB,
        snapBeats: snapBeatsValue,
        snapEnabled,
        automationVisible: props.automationVisible ?? false,
    };
    const { canvasRef, engineRef, viewportState } = useTimelineEngine(engineConfig);
    const [arrangementWidth, setArrangementWidth] = useState(800);
    const effectiveScrollX = viewportState.scrollX;
    const effectiveViewportWidth = Math.max(1, viewportState.viewportWidth || arrangementWidth);
    const effectivePixelsPerBeat = viewportState.ppb > 0 ? viewportState.ppb : pixelsPerBeat;
    const effectiveSnapBeatsValue = useMemo(
        () => divisionToInterval(gridDivision, beatsPerBar, gridTriplet, effectivePixelsPerBeat),
        [gridDivision, beatsPerBar, gridTriplet, effectivePixelsPerBeat],
    );
    const masterLaneGridStyle = useMemo(
        () => buildMasterLaneGridStyle(),
        [],
    );
    const loopStartLineX = snapPhysical(loopStart * effectivePixelsPerBeat - effectiveScrollX + MASTER_LANE_ALIGNMENT_OFFSET_PX);
    const loopEndLineX = snapPhysical(loopEnd * effectivePixelsPerBeat - effectiveScrollX + MASTER_LANE_ALIGNMENT_OFFSET_PX);
    const loopLeftX = Math.min(loopStartLineX, loopEndLineX);
    const loopRightX = Math.max(loopStartLineX, loopEndLineX);
    const loopVisible = loopEnabled && loopRightX > 0 && loopLeftX < effectiveViewportWidth;
    const masterLaneGridLines = useMemo(
        () => buildMasterLaneGridLines(
            effectivePixelsPerBeat,
            beatsPerBar,
            effectiveSnapBeatsValue,
            effectiveScrollX,
            effectiveViewportWidth,
            MASTER_LANE_ALIGNMENT_OFFSET_PX,
        ),
        [
            beatsPerBar,
            effectivePixelsPerBeat,
            effectiveSnapBeatsValue,
            effectiveScrollX,
            effectiveViewportWidth,
        ],
    );
    const rootRef = useRef<HTMLDivElement | null>(null);
    const arrangementRef = useRef<HTMLDivElement | null>(null);
    const masterLaneRef = useRef<HTMLDivElement | null>(null);
    const commandBusRef = useRef<TimelineCommandBus>(new TimelineCommandBus());
    const callbacks = useMemo(() => ({
        onPlayheadChange,
        onEditCursorChange,
        onClipSelect,
        onClipSelectionChange,
        onClipMove,
        onClipDuplicate,
        onClipResize,
        onClipFades,
        onDropBrowserItem,
        onClipFadeCurves,
        onDoubleClickTrack,
        onOpenMidiClip,
        onTrackSelect,
        onMarqueeSelectionStart,
        onMarqueeSelectionChange,
    }), [
        onPlayheadChange,
        onEditCursorChange,
        onClipSelect,
        onClipSelectionChange,
        onClipMove,
        onClipDuplicate,
        onClipResize,
        onClipFades,
        onDropBrowserItem,
        onClipFadeCurves,
        onDoubleClickTrack,
        onOpenMidiClip,
        onTrackSelect,
        onMarqueeSelectionStart,
        onMarqueeSelectionChange,
    ]);
    const { propsRef, callbacksRef, selectedClipIdsRef, trackIdsRef } = useTimelineCallbackRefs(
        props,
        callbacks,
        selectedClipIds,
        trackIds,
    );
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
    const { hasPendingRestore } = useTimelineViewportSync({
        engineRef,
        viewportState,
        setTimelineLayout,
        restoreSeq,
        restorePixelsPerBeat,
        restoreScrollLeft,
        restoreScrollTop,
        clearViewportRestore,
        selectedTrackIndex,
        selectedTrackIndices,
        loopStart,
        loopEnd,
        loopEnabled,
    });
    const pendingLoopRef = useRef<{ start: number; end: number; enabled: boolean } | null>(null);
    const commitLoopRef = useRef<(loop: { start: number; end: number; enabled: boolean }) => void>(() => { });
    useEffect(() => {
        commitLoopRef.current = (loop) => {
            const currentBpm = resolveBpm(propsRef.current.bpm);
            const currentSampleRate = resolveSampleRate(useEngineStore.getState().transport.sample_rate);
            const startFrames = beatToFrame(loop.start, currentBpm, currentSampleRate);
            const endFrames = beatToFrame(loop.end, currentBpm, currentSampleRate);
            useEngineStore.getState().setLoop(loop.enabled, startFrames, endFrames);
        };
    }, [propsRef]);
    const throttledLoopCommitRef = useRef<ReturnType<typeof throttle> | null>(null);
    useEffect(() => {
        const throttled = throttle(() => {
            const pending = pendingLoopRef.current;
            if (!pending) return;
            commitLoopRef.current(pending);
        }, 33, { leading: true, trailing: true });
        throttledLoopCommitRef.current = throttled;
        return () => {
            throttled.cancel();
            throttledLoopCommitRef.current = null;
        };
    }, []);
    useEffect(() => {
        const throttledLoopCommit = throttledLoopCommitRef.current;
        if (!throttledLoopCommit) return;
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
        };
    }, []);
    useEffect(() => {
        const node = arrangementRef.current;
        if (!node) return;
        const observer = new ResizeObserver((entries) => {
            const width = entries[0]?.contentRect.width;
            if (width && Number.isFinite(width)) {
                setArrangementWidth(Math.max(1, Math.round(width)));
            }
        });
        observer.observe(node);
        return () => observer.disconnect();
    }, []);
    useEffect(() => {
        const engine = engineRef.current;
        if (!engine) return;
        engine.onFrameDrawn = (snapshot) => {
            const lane = masterLaneRef.current;
            if (!lane) return;
            const x = snapPhysical((snapshot.playheadBeat * snapshot.pixelsPerBeat) - snapshot.scrollX + MASTER_LANE_ALIGNMENT_OFFSET_PX);
            const visible = x >= -10 && x <= snapshot.viewportWidth + 10 ? '1' : '0';
            lane.style.setProperty('--master-playhead-x', `${x}px`);
            lane.style.setProperty('--master-playhead-visible', visible);
        };
        return () => {
            if (engine.onFrameDrawn) engine.onFrameDrawn = undefined;
        };
    }, [engineRef]);
    useTimelineClipSync({
        engineRef,
        clips,
        selectedClipIdsRef,
    });
    useEffect(() => {
        // Skip fit-to-clips when a viewport restore is pending — the saved
        // viewport should take priority over auto-fit on project open.
        if (hasPendingRestore.current) return;
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
    }, [fitHorizontalToken, beatsPerBar, engineRef, propsRef, hasPendingRestore]);
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
    }, [engineRef, propsRef]);
    useEffect(() => {
        const engine = engineRef.current;
        if (!engine) return;
        engine.setEditCursor(editCursorBeat, editCursorTrackIndex, editCursorTrackIndexEnd ?? editCursorTrackIndex);
    }, [editCursorBeat, editCursorTrackIndex, editCursorTrackIndexEnd, engineRef]);
    useEffect(() => {
        const engine = engineRef.current;
        if (!engine) return;
        engine.onLoopChange = (loop) => {
            pendingLoopRef.current = loop;
            throttledLoopCommitRef.current?.();
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
    const regionEdit = useTimelineRegionEdit({
        marqueeSelection,
        effectivePixelsPerBeat,
        viewportScrollX: viewportState.scrollX,
        trackHeight: normalizedTrackHeight,
        beatsPerBar,
        masterLaneRef,
    });
    return (
        <div
            ref={rootRef}
            data-testid="timeline-view"
            data-track-count={trackCount}
            data-track-ids-count={trackIds.length}
            className="timeline-layer-root"
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
            onMouseDownCapture={() => useFocusPanelStore.getState().setActivePanel('arrangement')}
        >
            <div
                ref={arrangementRef}
                className="timeline-layer-canvas"
                style={{
                    position: 'relative',
                    flex: 1,
                    minHeight: 0,
                    overflow: 'visible',
                }}
            >
                <div
                    className="timeline-layer-bg"
                    aria-hidden
                    style={{
                        position: 'absolute',
                        inset: 0,
                        pointerEvents: 'none',
                    }}
                />
                <canvas
                    ref={canvasRef}
                    style={{
                        position: 'absolute',
                        left: 0,
                        top: 0,
                        width: '100%',
                        height: '100%',
                        display: 'block',
                        zIndex: 'var(--z-timeline-canvas)',
                    }}
                />
                {/* ── Loop bracket lines above clips ── */}
                {loopVisible && (
                    <div
                        style={{
                            position: 'absolute',
                            inset: 0,
                            pointerEvents: 'none',
                            zIndex: 'var(--z-timeline-overlays)',
                        }}
                    >
                        {/* Loop region fill */}
                        <div style={{
                            position: 'absolute',
                            top: 0,
                            bottom: 0,
                            left: Math.max(0, loopLeftX),
                            width: Math.max(0, Math.min(effectiveViewportWidth, loopRightX) - Math.max(0, loopLeftX)),
                            background: 'var(--color-timeline-loop-fill)',
                            opacity: 0.35,
                        }} />
                        {/* Loop start line */}
                        <div style={{
                            position: 'absolute',
                            top: 0,
                            bottom: 0,
                            left: loopStartLineX,
                            width: 1,
                            background: 'var(--color-timeline-loop-border)',
                            opacity: 0.8,
                        }} />
                        {/* Loop end line */}
                        <div style={{
                            position: 'absolute',
                            top: 0,
                            bottom: 0,
                            left: loopEndLineX,
                            width: 1,
                            background: 'var(--color-timeline-loop-border)',
                            opacity: 0.8,
                        }} />
                    </div>
                )}
                {props.automationVisible && (
                    <div
                        className="timeline-layer-overlays"
                        style={{
                            position: 'absolute',
                            inset: 0,
                            pointerEvents: 'none',
                            zIndex: 'var(--z-timeline-overlays)',
                        }}
                    >
                        <AutomationOverlay
                            visible
                            trackCount={trackCount}
                            trackHeight={normalizedTrackHeight}
                            trackHeights={normalizedTrackHeights}
                            scrollTop={timelineScrollTop}
                            width={arrangementWidth}
                            bpm={bpm}
                        />
                    </div>
                )}
            </div>
            <TimelineMasterLane
                masterLaneRef={masterLaneRef}
                trackHeight={normalizedTrackHeight}
                masterLaneGridStyle={masterLaneGridStyle}
                masterGridViewportWidth={effectiveViewportWidth}
                masterLaneGridLines={masterLaneGridLines}
                loopVisible={loopVisible}
                loopLeftX={loopLeftX}
                loopRightX={loopRightX}
                loopStartLineX={loopStartLineX}
                loopEndLineX={loopEndLineX}
                regionEdit={regionEdit}
            />
        </div>
    );
};
