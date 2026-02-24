import { useState, useEffect, useCallback, useRef, useMemo } from 'react';
import { useKeyboardShortcuts } from '@/shared/hooks/useKeyboardShortcuts';
import { useNativeMenu } from '@/shared/hooks/useNativeMenu';
import { useProjectManager } from '@/shared/hooks/useProjectManager';
import { useEngineStore } from '@/shared/stores/useEngineStore';
import { useAutomationStore } from '@/shared/stores/useAutomationStore';
import { useGridStore } from '@/shared/stores/useGridStore';
import { useSettingsStore } from '@/shared/stores/useSettingsStore';
import { useBrowserDnDOrchestrator } from '@/shared/hooks/useBrowserDnDOrchestrator';
import { frameToBeat, resolveSampleRate } from '@/shared/lib/audioMath';
import {
    BOTTOM_PANEL_HEIGHT_DEFAULT_PX,
    BOTTOM_PANEL_HEIGHT_MAX_PX,
    BOTTOM_PANEL_HEIGHT_MIN_PX,
    BROWSER_WIDTH_DEFAULT_PX,
    BROWSER_WIDTH_MAX_PX,
    BROWSER_WIDTH_MIN_PX,
    DEFAULT_BPM,
} from '@/shared/config/layoutConstants';
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
    useAlsImportSummaryStatus,
    useDawShellGlobalShortcuts,
    useInitialLayoutSync,
    useSelectedTrackConsistency,
    useTauriFileDropImport,
    useTelemetryBootstrap,
} from './model/useDawShellEffects';
import { useProjectAutoRecovery } from './model/useProjectAutoRecovery';
import { useArrangementUiHandlers } from './model/useArrangementUiHandlers';
import { useDawShellMidiPersistence } from './model/useDawShellMidiPersistence';
import { useDawShellTimelineProps } from './model/useDawShellTimelineProps';
import { useDawShellUiPreferences } from './model/useDawShellUiPreferences';
import { DawShellContent } from './DawShellContent';
import { DawShellOverlays } from './DawShellOverlays';
type BottomPanelMode = 'rack' | 'clip' | 'mixer';
type MainViewMode = 'arrangement' | 'session';
export const DawShell = () => {
    const [settingsOpen, setSettingsOpen] = useState(false);
    const [selectedTrackId, setSelectedTrackId] = useState('');
    const [selectedTrackIds, setSelectedTrackIds] = useState<string[]>([]);
    const selectedTrackIdRef = useRef(selectedTrackId);
    const selectedTrackIdsRef = useRef(selectedTrackIds);
    selectedTrackIdRef.current = selectedTrackId;
    selectedTrackIdsRef.current = selectedTrackIds;
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
    const [followPlayhead, setFollowPlayhead] = useState(true); // BUG-26 FIX: default true (match Ableton/Logic)
    const [missingAssetsOpen, setMissingAssetsOpen] = useState(false);
    const [browserWidth, setBrowserWidth] = useState(
        () => Math.max(BROWSER_WIDTH_MIN_PX, Math.min(BROWSER_WIDTH_MAX_PX, BROWSER_WIDTH_DEFAULT_PX)),
    );
    const [fitTimelineToken, setFitTimelineToken] = useState(0);
    const [bottomPanelHeightPx, setBottomPanelHeightPx] = useState(
        () => Math.max(BOTTOM_PANEL_HEIGHT_MIN_PX, Math.min(BOTTOM_PANEL_HEIGHT_MAX_PX, BOTTOM_PANEL_HEIGHT_DEFAULT_PX)),
    );
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
    const projectSampleRate = useEngineStore(s => resolveSampleRate(s.projectSampleRate, s.transport.sample_rate));
    const automationVisible = useAutomationStore(s => s.globalVisible);
    const toggleAutomation = useAutomationStore(s => s.toggleGlobalVisible);
    const gridDivision = useGridStore((s) => s.division);
    const gridTriplet = useGridStore((s) => s.triplet);
    const gridSnapEnabled = useGridStore((s) => s.snapEnabled);
    const pianoPencilMode = useGridStore((s) => s.pianoPencilMode);
    const settingsLoaded = useSettingsStore((s) => s.loaded);
    const settings = useSettingsStore((s) => s.settings);
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
    useEffect(() => {
        document.documentElement.style.setProperty('--daw-bottom-panel-height', `${bottomPanelHeightPx}px`);
    }, [bottomPanelHeightPx]);
    useDawShellUiPreferences({
        settingsLoaded,
        settings,
        followPlayhead,
        automationVisible,
        pianoPencilMode,
        gridDivision,
        gridTriplet,
        gridSnapEnabled,
        setFollowPlayhead,
    });
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
    const { filePath: projectFilePath } = useProjectManager();
    useNativeMenu();
    useKeyboardShortcuts({
        selectedClipId,
        selectedClipIds,
        selectedTrackId,
        trackIds: tracksEntity.allIds,
        tracksById: tracksEntity.byId,
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
    const handleAssistantToggle = useCallback(() => setAssistantOpen((v) => {
        const next = !v;
        try { localStorage.setItem('dream-daw:assistant-open', next ? '1' : '0'); } catch { /* quota */ }
        return next;
    }), []);
    useSelectedTrackConsistency({ selectedTrackIds, selectedTrackId, setSelectedTrackId });
    useEffect(() => {
        const onOpenExport = () => setExportOpen(true);
        window.addEventListener('dream:open-export', onOpenExport as EventListener);
        window.__dreamOpenExportModal = onOpenExport;
        return () => {
            window.removeEventListener('dream:open-export', onOpenExport as EventListener);
            if (window.__dreamOpenExportModal === onOpenExport) {
                delete window.__dreamOpenExportModal;
            }
        };
    }, []);
    useAudioFailoverRecovery({ recoveringAudioRef, lastAudioRecoverAtRef });
    const { beginBrowserResize, beginBottomPanelResize } = usePaneResizeHandlers({
        mainSplitRef,
        setBrowserWidth,
        setBottomPanelHeightPx,
    });
    useTelemetryBootstrap(startTelemetryLoop);
    useAlsImportSummaryStatus();
    useInitialLayoutSync();
    useProjectAutoRecovery();
    const transportBpm = useEngineStore(s => s.transport.bpm);
    const transportIsPlaying = useEngineStore(s => s.transport.is_playing);
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
        transportBpm: transportBpm || DEFAULT_BPM,
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
    const selectedClipIdsForView = useMemo(() => {
        const existingIds = new Set(timelineClips.map((clip) => clip.id));
        return selectedClipIds.filter((id) => existingIds.has(id));
    }, [selectedClipIds, timelineClips]);
    const selectedClipIdForView = useMemo(
        () => selectedClipIdsForView.length > 0 ? selectedClipIdsForView[selectedClipIdsForView.length - 1] : null,
        [selectedClipIdsForView],
    );
    useEffect(() => {
        if (tracksEntity.allIds.length === 0) {
            if (selectedTrackId !== 'master') setSelectedTrackId('master');
            return;
        }
        const exists = Boolean(tracksEntity.byId[selectedTrackId]);
        if (!exists) {
            setSelectedTrackId(tracksEntity.allIds[0]);
        }
    }, [tracksEntity, selectedTrackId]);
    const {
        panelInfo,
        collapsedGroups,
        trackIds,
        hiddenTrackIndices,
        trackCountRaw,
        selectedTrackIndex,
        selectedTrackIndices,
        selectedTimelineClip,
        toggleGroupCollapse,
    } = useArrangementTrackViewModel({
        tracksEntity,
        selectedTrackId,
        selectedTrackIds,
        selectedClipId: selectedClipIdForView,
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
    const _loopBpm = useMemo(
        () => Math.max(1, projectBpm || transportBpm || DEFAULT_BPM),
        [projectBpm, transportBpm],
    );
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
        const parsed = parseInt(gridDivision.split('/')[0], 10);
        const beatsPerBar = parsed > 0 && isFinite(parsed) ? parsed : 4;
        return Math.max(1, Math.ceil(selectedTimelineClip.durationBeats / beatsPerBar));
    }, [selectedTimelineClip, gridDivision]);
    const hasResizableClipEditor = false;
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
        selectedClipIds: selectedClipIdsForView,
        timelineClipsForView,
        editCursorBeat,
        queuedStartBeatRef,
    });
    const {
        dropBrowserItemOnTimeline,
        dropPluginOnTrack,
    } = useBrowserDnDOrchestrator({
        tracks: tracksEntity,
        projectBpm,
        transportBpm: transportBpm || DEFAULT_BPM,
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
        transportBpm: transportBpm || DEFAULT_BPM,
        projectSampleRate,
        timelineClipsForView,
        selectedClipIds: selectedClipIdsForView,
        trackCountRaw,
        hiddenTrackIndices,
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
        bpm: projectBpm || transportBpm || DEFAULT_BPM,
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
        trackCount: trackCountRaw,
        trackHeight: TRACK_HEIGHT_BASE,
        trackHeights: timelineTrackHeights,
        onPlayheadChange: handlePlayheadChange,
        onEditCursorChange: handleEditCursorChange,
        onMarqueeSelectionStart: handleMarqueeSelectionStart,
        onMarqueeSelectionChange: setMarqueeSelection,
        onClipSelect: handleClipSelect,
        selectedClipIds: selectedClipIdsForView,
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
                handleRecordingStateChange={setRecordingState}
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
                setBottomPanelHeightPx={setBottomPanelHeightPx}
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
                projectName={projectFilePath ? projectFilePath.split(/[\/\\]/).pop()?.replace(/\.[^.]+$/, '') ?? 'Untitled' : 'Untitled'}
                selectedClipIds={selectedClipIdsForView}
                timelineClipsForView={timelineClipsForView}
                bpm={projectBpm || transportBpm || DEFAULT_BPM}
                sampleRate={projectSampleRate}
                loopStartBeat={loopStartBeat}
                loopEndBeat={loopEndBeat}
                marqueeSelection={marqueeSelection}
            />
        </div>
    );
};
export default DawShell;
