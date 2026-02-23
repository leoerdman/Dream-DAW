import { useState, useEffect, useCallback, useRef, useMemo } from 'react';
import { useKeyboardShortcuts } from '@/shared/hooks/useKeyboardShortcuts';
import { useNativeMenu } from '@/shared/hooks/useNativeMenu';
import { useProjectManager } from '@/shared/hooks/useProjectManager';
import { useEngineStore } from '@/shared/stores/useEngineStore';
import { useAutomationStore } from '@/shared/stores/useAutomationStore';
import { useBrowserDnDOrchestrator } from '@/shared/hooks/useBrowserDnDOrchestrator';
import { frameToBeat, resolveSampleRate } from '@/shared/lib/audioMath';
import { useTrackHeightControls } from './model/useTrackHeightControls';
import { usePointerUpFinalizer } from './model/usePointerUpFinalizer';
import { useTimelineClipHandlers } from './model/useTimelineClipHandlers';
import { usePendingMidiFlush } from './model/usePendingMidiFlush';
import { useArrangementSelectionHandlers } from './model/useArrangementSelectionHandlers';
import { usePlaybackStartAnchor } from './model/usePlaybackStartAnchor';
import { usePaneResizeHandlers } from './model/usePaneResizeHandlers';
import { useArrangementTrackViewModel } from './model/useArrangementTrackViewModel';
import {
    useAudioFailoverRecovery,
    useDawShellGlobalShortcuts,
    useInitialLayoutSync,
    useSelectedTrackConsistency,
    useTauriFileDropImport,
    useTelemetryBootstrap,
} from './model/useDawShellEffects';
import { useArrangementUiHandlers } from './model/useArrangementUiHandlers';
import { useDawShellMidiPersistence } from './model/useDawShellMidiPersistence';
import { useDawShellTimelineProps } from './model/useDawShellTimelineProps';
import { DawShellContent } from './DawShellContent';
import { DawShellOverlays } from './DawShellOverlays';
const DEFAULT_BOTTOM_PANEL_HEIGHT = 220;
export const DawShell = () => {
    type BottomPanelMode = 'rack' | 'clip';
    type MainViewMode = 'arrangement' | 'session';
    const [settingsOpen, setSettingsOpen] = useState(false);
    const [selectedTrackId, setSelectedTrackId] = useState('');
    const [selectedTrackIds, setSelectedTrackIds] = useState<string[]>([]);
    const selectedTrackIdRef = useRef(selectedTrackId);
    const selectedTrackIdsRef = useRef(selectedTrackIds);
    useEffect(() => { selectedTrackIdRef.current = selectedTrackId; selectedTrackIdsRef.current = selectedTrackIds; }, [selectedTrackId, selectedTrackIds]);
    const [selectedClipIds, setSelectedClipIds] = useState<string[]>([]);
    const selectedClipId = useMemo(
        () => selectedClipIds.length > 0 ? selectedClipIds[selectedClipIds.length - 1] : null,
        [selectedClipIds],
    );
    const [editCursorBeat, setEditCursorBeat] = useState(-1);
    const [editCursorTrackIndex, setEditCursorTrackIndex] = useState(0);
    const [editCursorTrackIndexEnd, setEditCursorTrackIndexEnd] = useState(0);
    const [exportOpen, setExportOpen] = useState(false);
    const [assistantOpen, setAssistantOpen] = useState(() => {
        try { return localStorage.getItem('dream-daw:assistant-open') === '1'; } catch { return false; }
    });
    const [bottomPanelMode, setBottomPanelMode] = useState<BottomPanelMode>('rack');
    const [bottomPanelModeByTrack, setBottomPanelModeByTrack] = useState<Record<string, BottomPanelMode>>({});
    const [mainViewMode, setMainViewMode] = useState<MainViewMode>('arrangement');
    const [recordingState, setRecordingState] = useState<{ active: boolean; trackIndex: number }>({
        active: false,
        trackIndex: 0,
    });
    const [followPlayhead, setFollowPlayhead] = useState(false);
    const [missingAssetsOpen, setMissingAssetsOpen] = useState(false);
    const [browserWidth, setBrowserWidth] = useState(320);
    const [fitTimelineToken, setFitTimelineToken] = useState(0);
    const [bottomPanelHeightPx, setBottomPanelHeightPx] = useState(DEFAULT_BOTTOM_PANEL_HEIGHT);
    const recoveringAudioRef = useRef(false);
    const lastAudioRecoverAtRef = useRef(0);
    const importFile = useEngineStore(s => s.importFile);
    const createMidiClip = useEngineStore(s => s.createMidiClip);
    const togglePlay = useEngineStore(s => s.togglePlay);
    const applyProjectDeltas = useEngineStore(s => s.applyProjectDeltas);
    const startTelemetryLoop = useEngineStore(s => s.startTelemetryLoop);
    const flushTrackControlFinals = useEngineStore(s => s.flushTrackControlFinals);
    const timelineClipsSnapshot = useEngineStore(s => s.timelineClips);
    const tracksEntity = useEngineStore(s => s.tracks);
    // PERF-FIX-1: removed transport.position_seconds subscription.
    // It changed every telemetry tick (~30fps), causing the entire DawShell
    // (2346 lines, all children) to re-render during playback.
    // Playhead position is now read on-demand in useKeyboardShortcuts.
    const projectSampleRate = useEngineStore(s => resolveSampleRate(s.projectSampleRate, s.transport.sample_rate));
    const automationVisible = useAutomationStore(s => s.globalVisible);
    const toggleAutomation = useAutomationStore(s => s.toggleGlobalVisible);
    const importingRef = useRef(false);
    const timelineRef = useRef<HTMLDivElement>(null);
    const mainSplitRef = useRef<HTMLElement>(null);
    const queuedStartBeatRef = useRef<number | null>(null);
    const [marqueeSelection, setMarqueeSelection] = useState<{
        startBeat: number;
        endBeat: number;
        startTrack: number;
        endTrack: number;
    } | null>(null);

    const activePanelTrackKey = selectedTrackId && selectedTrackId.length > 0
        ? selectedTrackId
        : 'master';

    const setBottomPanelModeForActiveTrack = useCallback(
        (next: BottomPanelMode | ((prev: BottomPanelMode) => BottomPanelMode)) => {
            setBottomPanelMode((prev) => {
                const resolved = typeof next === 'function'
                    ? (next as (prev: BottomPanelMode) => BottomPanelMode)(prev)
                    : next;
                setBottomPanelModeByTrack((byTrack) => ({
                    ...byTrack,
                    [activePanelTrackKey]: resolved,
                }));
                return resolved;
            });
        },
        [activePanelTrackKey],
    );

    // ── Enterprise Project Manager (Cmd+S/⇧S/N/O, auto-backup, dirty state)
    const { filePath: projectFilePath } = useProjectManager();

    // ── Native macOS Menu Bar (File, Edit, Window) ──
    // NOTE: onProjectChange callback not needed here.
    // Native menu performs snapshot-delta sync through store actions.
    useNativeMenu();

    // ── Global Keyboard Shortcuts (Space, Cmd+E, Delete) ──
    useKeyboardShortcuts({
        selectedClipId,
        selectedClipIds,
        selectedTrackId,
        trackIds: tracksEntity.allIds,
        tracksById: tracksEntity.byId,
        // PERF-FIX-1: playheadFrames is now read from the store on-demand
        // inside the hook, not passed as a reactive prop.
        editCursorBeat,
        timelineClips: timelineClipsSnapshot,
        marqueeSelection,
        onTogglePlayback: togglePlay,
        onClipSelectionChanged: setSelectedClipIds,
    });

    useDawShellGlobalShortcuts({
        setSettingsOpen,
        setExportOpen,
        setMainViewMode,
        setBottomPanelModeForActiveTrack,
    });
    useTauriFileDropImport(importFile, importingRef);

    const openSettings = useCallback(() => setSettingsOpen(true), []);
    const handleOpenExport = useCallback(() => setExportOpen(true), []);
    const handleRecordingStateChange = useCallback((state: { active: boolean; trackIndex: number }) => setRecordingState(state), []);
    const handleAssistantToggle = useCallback(() => setAssistantOpen((v) => {
        const next = !v;
        try { localStorage.setItem('dream-daw:assistant-open', next ? '1' : '0'); } catch { /* quota */ }
        return next;
    }), []);
    // selectedClipId is now a useMemo derived from selectedClipIds — no useEffect needed.

    useSelectedTrackConsistency({ selectedTrackIds, selectedTrackId, setSelectedTrackId });
    useAudioFailoverRecovery({ recoveringAudioRef, lastAudioRecoverAtRef });
    const { beginBrowserResize, beginBottomPanelResize } = usePaneResizeHandlers({
        mainSplitRef,
        setBrowserWidth,
        setBottomPanelHeightPx,
    });

    useTelemetryBootstrap(startTelemetryLoop);
    useInitialLayoutSync();

    // ── Engine state for Timeline ───────────────────────────────────
    const transportBpm = useEngineStore(s => s.transport.bpm);
    const transportIsPlaying = useEngineStore(s => s.transport.is_playing);
    // NOTE: transport.position_beats is intentionally NOT subscribed here.
    // DawShell is the root layout (2327 lines). Subscribing to position_beats
    // caused 30fps re-renders of the entire component tree. Timeline and
    // PianoRoll now subscribe directly via useEngineStore.
    const transportLoopStart = useEngineStore(s => s.transport.loop_start);
    const transportLoopEnd = useEngineStore(s => s.transport.loop_end);
    const transportLoopEnabled = useEngineStore(s => s.transport.loop_enabled);
    const projectBpm = useEngineStore(s => s.projectBpm);
    const timelineClips = useEngineStore(s => s.timelineClips);
    const {
        midiNotesByClip,
        clipFadeCurves,
        setClipFadeCurves,
        aiVariationBusy,
        handleGenerateMidiVariation,
        handlePianoRollNotesChange,
        handlePianoRollEnvelopesChange,
        latestMidiEnvelopesRef,
        latestMidiNotesRef,
        dirtyMidiNotesClipIdsRef,
        dirtyMidiEnvelopeClipIdsRef,
        serializeMidiNotesToFrames,
        flushMidiThrottles,
    } = useDawShellMidiPersistence({
        timelineClips,
        trackIds: tracksEntity.allIds,
        tracksById: tracksEntity.byId,
        projectBpm,
        transportBpm: transportBpm || 120,
        projectSampleRate,
        applyProjectDeltas,
    });
    const timelineClipsForView = useMemo(
        () =>
            timelineClips.map((clip) => {
                const curve = clipFadeCurves[clip.id];
                const withCurve = curve
                    ? {
                        ...clip,
                        fadeInCurve: curve.fadeInCurve,
                        fadeOutCurve: curve.fadeOutCurve,
                    }
                    : clip;
                if (clip.type !== 'midi') return withCurve;
                const localNotes = midiNotesByClip[clip.id];
                if (!localNotes) return withCurve;
                return {
                    ...withCurve,
                    midiNotes: localNotes,
                };
            }),
        [timelineClips, midiNotesByClip, clipFadeCurves],
    );

    // Keep a valid selected track at all times.
    useEffect(() => {
        if (tracksEntity.allIds.length === 0) {
            if (selectedTrackId !== 'master') queueMicrotask(() => setSelectedTrackId('master'));
            return;
        }
        const exists = Boolean(tracksEntity.byId[selectedTrackId]);
        if (!exists) {
            queueMicrotask(() => setSelectedTrackId(tracksEntity.allIds[0]));
        }
    }, [tracksEntity, selectedTrackId]);

    useEffect(() => {
        const key = selectedTrackId && selectedTrackId.length > 0 ? selectedTrackId : 'master';
        const saved = bottomPanelModeByTrack[key] ?? 'rack';
        queueMicrotask(() => setBottomPanelMode((prev) => (prev === saved ? prev : saved)));
    }, [selectedTrackId, bottomPanelModeByTrack]);

    useEffect(() => {
        window.__dreamSelectedTrackId = selectedTrackId;
        return () => {
            if (window.__dreamSelectedTrackId === selectedTrackId) {
                delete window.__dreamSelectedTrackId;
            }
        };
    }, [selectedTrackId]);

    const {
        panelInfo,
        collapsedGroups,
        trackIds,
        hiddenTrackIndices,
        trackCountRaw,
        trackCount,
        selectedTrackIndex,
        selectedTrackIndices,
        selectedTimelineClip,
        toggleGroupCollapse,
    } = useArrangementTrackViewModel({
        tracksEntity,
        selectedTrackId,
        selectedTrackIds,
        selectedClipId,
        timelineClipsForView,
        bottomPanelModeByTrack,
        setSelectedTrackId,
        setBottomPanelMode,
        applyProjectDeltas,
    });
    const {
        handleSelectTrack,
        handleSelectTracks,
        handleMarqueeSelectionStart,
        handleClipSelect,
        handleTimelineClipSelectionChange,
        handleTimelineTrackSelect,
    } = useArrangementSelectionHandlers({
        timelineClipsForView,
        trackIds,
        setSelectedClipIds,
        setSelectedTrackId,
        setSelectedTrackIds,
        setEditCursorTrackIndex,
        setMarqueeSelection,
        queuedStartBeatRef,
    });

    // Memoize loop region beat values to avoid recomputing inline in JSX on every render
    // (which would trigger spurious downstream effects during playback position updates).
    // BUG-C3 FIX: Ensure BPM is always >= 1 to prevent division by zero in
    // frameToBeat/beatToFrame conversions. The `||` fallback chain fails when
    // BPM is exactly 0 (empty project), but 0 is never a valid BPM.
    const _loopBpm = Math.max(1, projectBpm || transportBpm || 120);
    const loopStartBeat = useMemo(
        () => frameToBeat(transportLoopStart, _loopBpm, projectSampleRate),
        [transportLoopStart, _loopBpm, projectSampleRate],
    );
    const loopEndBeat = useMemo(
        () => frameToBeat(transportLoopEnd, _loopBpm, projectSampleRate),
        [transportLoopEnd, _loopBpm, projectSampleRate],
    );

    const missingMediaSummary = useMemo(() => {
        const offlineClipCount = timelineClipsForView.filter((c) => c.type === 'audio' && c.isOffline).length;
        let missingPluginCount = 0;
        for (const trackId of tracksEntity.allIds) {
            const track = tracksEntity.byId[trackId];
            if (!track) continue;
            if (track.instrument?.plugin_id?.startsWith('missing://')) missingPluginCount += 1;
            missingPluginCount += (track.effects ?? []).filter((fx) => fx.plugin_id?.startsWith('missing://')).length;
        }
        return {
            offlineClipCount,
            missingPluginCount,
            total: offlineClipCount + missingPluginCount,
        };
    }, [timelineClipsForView, tracksEntity]);

    // BUG-B7 FIX: Only open the resolver on transition from 0 → N (not on every
    // re-count). This prevents the panel from re-opening after the user dismisses
    // it, e.g. when a clip is fixed and another simultaneously goes offline.
    const prevMissingTotalRef = useRef(0);
    useEffect(() => {
        const prev = prevMissingTotalRef.current;
        prevMissingTotalRef.current = missingMediaSummary.total;
        if (missingMediaSummary.total > 0 && prev === 0) {
            queueMicrotask(() => setMissingAssetsOpen(true));
        }
    }, [missingMediaSummary.total]);
    const selectedMidiTotalBars = useMemo(() => {
        if (!selectedTimelineClip || selectedTimelineClip.type !== 'midi') return 8;
        return Math.max(1, Math.ceil(selectedTimelineClip.durationBeats / 4));
    }, [selectedTimelineClip]);
    const hasResizableClipEditor =
        bottomPanelMode === 'clip' && (selectedTimelineClip?.type === 'midi' || selectedTimelineClip?.type === 'audio');

    usePointerUpFinalizer({
        flushTrackControlFinals,
        flushMidiThrottles,
        dirtyMidiNotesClipIdsRef,
        dirtyMidiEnvelopeClipIdsRef,
        latestMidiNotesRef,
        latestMidiEnvelopesRef,
        serializeMidiNotesToFrames,
        applyProjectDeltas,
    });

    // ── Scroll sync ──────────────────────────────────────────────────
    // Scroll is synchronized via the scrollSync singleton (useScrollSync.ts).
    // NO React state here — avoids re-rendering the entire DawShell tree
    // on every scroll frame. Timeline and TrackInspector subscribe directly.
    const {
        trackHeightBase: TRACK_HEIGHT_BASE,
        timelineTrackHeights,
        resetTrackHeights: handleResetTrackHeights,
    } = useTrackHeightControls({
        tracksEntitySnapshot: tracksEntity,
        hiddenTrackIndices,
        selectedTrackIdRef,
        selectedTrackIdsRef,
        applyProjectDeltas,
    });

    usePlaybackStartAnchor({
        transportIsPlaying,
        selectedClipIds,
        timelineClipsForView,
        editCursorBeat,
        queuedStartBeatRef,
    });

    // Drop from AssetBrowser → Timeline
    const {
        dropBrowserItemOnTimeline,
        dropPluginOnTrack,
    } = useBrowserDnDOrchestrator({
        tracks: tracksEntity,
        projectBpm,
        transportBpm: transportBpm || 120,
        projectSampleRate,
        importFile,
        applyProjectDeltas,
    });

    const {
        handleFitTimelineHorizontally,
        handlePlayheadChange,
        handleEditCursorChange,
        handleBrowserDrop,
    } = useArrangementUiHandlers({
        setFitTimelineToken,
        setEditCursorBeat,
        setEditCursorTrackIndex,
        setEditCursorTrackIndexEnd,
        queuedStartBeatRef,
        dropBrowserItemOnTimeline,
    });

    const {
        handleDoubleClickTrack,
        handleClipMove,
        handleClipResize,
        handleClipFades,
        handleOpenMidiClip,
    } = useTimelineClipHandlers({
        projectBpm,
        transportBpm: transportBpm || 120,
        projectSampleRate,
        timelineClipsForView,
        selectedClipIds,
        trackCountRaw,
        createMidiClip,
        applyProjectDeltas,
        setSelectedClipIds,
        setBottomPanelModeForActiveTrack,
    });

    usePendingMidiFlush({
        flushTrackControlFinals,
        flushMidiThrottles,
        dirtyMidiNotesClipIdsRef,
        dirtyMidiEnvelopeClipIdsRef,
        latestMidiNotesRef,
        latestMidiEnvelopesRef,
        serializeMidiNotesToFrames,
        applyProjectDeltas,
    });

    const timelineProps = useDawShellTimelineProps({
        bpm: projectBpm || transportBpm || 120,
        clips: timelineClipsForView,
        editCursorBeat,
        editCursorTrackIndex,
        editCursorTrackIndexEnd,
        selectedTrackIndex,
        selectedTrackIndices,
        isPlaying: transportIsPlaying,
        recordingActive: recordingState.active,
        recordingTrackIndex: recordingState.trackIndex,
        trackIds,
        loopStart: loopStartBeat,
        loopEnd: loopEndBeat,
        loopEnabled: transportLoopEnabled,
        trackCount,
        trackHeight: TRACK_HEIGHT_BASE,
        trackHeights: timelineTrackHeights,
        onPlayheadChange: handlePlayheadChange,
        onEditCursorChange: handleEditCursorChange,
        onMarqueeSelectionStart: handleMarqueeSelectionStart,
        onMarqueeSelectionChange: setMarqueeSelection,
        onClipSelect: handleClipSelect,
        selectedClipIds,
        onClipSelectionChange: handleTimelineClipSelectionChange,
        onClipMove: handleClipMove,
        onClipResize: handleClipResize,
        onClipFades: handleClipFades,
        onClipFadeCurves: (clipId: string, fadeInCurve: number, fadeOutCurve: number) => {
            setClipFadeCurves((prev) => ({
                ...prev,
                [clipId]: {
                    fadeInCurve: Math.max(0.05, Math.min(0.95, fadeInCurve)),
                    fadeOutCurve: Math.max(0.05, Math.min(0.95, fadeOutCurve)),
                },
            }));
        },
        onDropBrowserItem: handleBrowserDrop,
        onDoubleClickTrack: handleDoubleClickTrack,
        onOpenMidiClip: handleOpenMidiClip,
        onTrackSelect: handleTimelineTrackSelect,
        followPlayhead,
        automationVisible,
        fitHorizontalToken: fitTimelineToken,
    });

    return (
        <div className="relative w-screen h-screen overflow-hidden bg-bg-app text-text-primary">
            <DawShellContent
                openSettings={openSettings}
                handleOpenExport={handleOpenExport}
                handleRecordingStateChange={handleRecordingStateChange}
                followPlayhead={followPlayhead}
                setFollowPlayhead={setFollowPlayhead}
                automationVisible={automationVisible}
                toggleAutomation={toggleAutomation}
                handleFitTimelineHorizontally={handleFitTimelineHorizontally}
                handleResetTrackHeights={handleResetTrackHeights}
                assistantOpen={assistantOpen}
                handleAssistantToggle={handleAssistantToggle}
                mainSplitRef={mainSplitRef}
                timelineRef={timelineRef}
                browserWidth={browserWidth}
                beginBrowserResize={beginBrowserResize}
                mainViewMode={mainViewMode}
                tracksEntity={tracksEntity}
                selectedTrackId={selectedTrackId}
                selectedTrackIds={selectedTrackIds}
                handleSelectTrack={handleSelectTrack}
                handleSelectTracks={handleSelectTracks}
                trackHeightBase={TRACK_HEIGHT_BASE}
                collapsedGroups={collapsedGroups}
                toggleGroupCollapse={toggleGroupCollapse}
                timelineProps={timelineProps}
                bottomPanelMode={bottomPanelMode}
                hasResizableClipEditor={hasResizableClipEditor}
                bottomPanelHeightPx={bottomPanelHeightPx}
                beginBottomPanelResize={beginBottomPanelResize}
                selectedTimelineClip={selectedTimelineClip ?? undefined}
                clipColor={selectedTimelineClip?.color || tracksEntity.byId[selectedTrackId]?.color || 'var(--color-accent-primary)'}
                midiNotes={selectedTimelineClip?.type === 'midi' ? (midiNotesByClip[selectedTimelineClip.id] ?? []) : []}
                aiVariationBusy={aiVariationBusy}
                selectedMidiTotalBars={selectedMidiTotalBars}
                dropPluginOnTrack={dropPluginOnTrack}
                handlePianoRollNotesChange={handlePianoRollNotesChange}
                handlePianoRollEnvelopesChange={handlePianoRollEnvelopesChange}
                handleGenerateMidiVariation={handleGenerateMidiVariation}
                missingAssetsOpen={missingAssetsOpen}
                missingMediaSummary={missingMediaSummary}
                setMissingAssetsOpen={setMissingAssetsOpen}
                setBottomPanelModeForActiveTrack={setBottomPanelModeForActiveTrack}
                panelInfo={panelInfo}
            />
            <DawShellOverlays
                settingsOpen={settingsOpen}
                onCloseSettings={() => setSettingsOpen(false)}
                assistantOpen={assistantOpen}
                onAssistantClose={() => {
                    setAssistantOpen(false);
                    try { localStorage.setItem('dream-daw:assistant-open', '0'); } catch { /* quota */ }
                }}
                onAssistantOpen={() => {
                    setAssistantOpen(true);
                    try { localStorage.setItem('dream-daw:assistant-open', '1'); } catch { /* quota */ }
                }}
                onSelectClips={setSelectedClipIds}
                missingAssetsOpen={missingAssetsOpen}
                missingTotal={missingMediaSummary.total}
                onCloseMissingAssets={() => setMissingAssetsOpen(false)}
                exportOpen={exportOpen}
                onCloseExport={() => setExportOpen(false)}
                projectName={projectFilePath ? projectFilePath.split('/').pop()?.replace(/\.[^.]+$/, '') ?? 'Untitled' : 'Untitled'}
                selectedClipIds={selectedClipIds}
                timelineClipsForView={timelineClipsForView}
                bpm={projectBpm || transportBpm || 120}
                sampleRate={projectSampleRate}
                loopStartBeat={loopStartBeat}
                loopEndBeat={loopEndBeat}
                marqueeSelection={marqueeSelection}
            />
        </div>
    );
};

export default DawShell;
