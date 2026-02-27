import { useEffect, useCallback, useRef, useMemo } from 'react';
import { useKeyboardShortcuts } from '@/shared/hooks/useKeyboardShortcuts';
import * as engineApi from '@/shared/api/engine';
import { useNativeMenu } from '@/shared/hooks/useNativeMenu';
import { useProjectManager } from '@/shared/hooks/useProjectManager';
import { useEngineStore } from '@/shared/stores/useEngineStore';
import { useShallow } from 'zustand/react/shallow';
import { useBrowserDnDOrchestrator } from '@/shared/hooks/useBrowserDnDOrchestrator';
import { resolveBpm } from '@/shared/lib/audioMath';

import { useTrackHeightControls } from './model/useTrackHeightControls';
import { useDawShellState } from './model/useDawShellState';
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
import { writeAssistantOpenPref } from './model/assistantUiPrefs';
import { dreamGlobals } from '@/shared/lib/dreamGlobals';
import { useDawShellViewModel } from './model/useDawShellViewModel';
import { useBottomPanelModeByTrack } from './model/useBottomPanelModeByTrack';
import { cancelIdle, scheduleIdle } from './model/idleWarmup';
import { DawShellContent } from './DawShellContent';
import { DawShellOverlays } from './DawShellOverlays';
export const DawShell = ({ onMounted }: { onMounted?: () => void }) => {
    const {
        settingsOpen, setSettingsOpen,
        selectedTrackId, setSelectedTrackId,
        selectedTrackIds, setSelectedTrackIds,
        selectedTrackIdRef, selectedTrackIdsRef,
        selectedClipIds, setSelectedClipIds, selectedClipId,
        editCursorBeat, setEditCursorBeat,
        editCursorTrackIndex, setEditCursorTrackIndex,
        editCursorTrackIndexEnd, setEditCursorTrackIndexEnd,
        exportOpen, setExportOpen,
        assistantOpen, setAssistantOpen,
        bottomPanelMode, setBottomPanelMode,
        bottomPanelModeByTrack, setBottomPanelModeByTrack,
        mainViewMode, setMainViewMode,
        recordingState, setRecordingState,
        followPlayhead, setFollowPlayhead,
        missingAssetsOpen, setMissingAssetsOpen,
        browserWidth, setBrowserWidth,
        fitTimelineToken, setFitTimelineToken,
        bottomPanelHeightPx, setBottomPanelHeightPx,
        marqueeSelection, setMarqueeSelection,
        recoveringAudioRef, lastAudioRecoverAtRef, importingRef,
        timelineRef, mainSplitRef, queuedStartBeatRef,
        projectSampleRate,
        automationVisible, toggleAutomation,
        gridDivision, gridTriplet, gridSnapEnabled, pianoPencilMode,
        settingsLoaded, settings,
    } = useDawShellState();

    const importFile = useEngineStore(s => s.importFile);
    const createMidiClip = useEngineStore(s => s.createMidiClip);
    const storeTogglePlay = useEngineStore(s => s.togglePlay);
    const storeStop = useEngineStore(s => s.stop);

    // ENTERPRISE FIX: Ref-stable wrapper for atomic toggle play.
    const atomicTogglePlayRef = useRef<() => Promise<void>>(storeTogglePlay);
    const atomicTogglePlay = useCallback(() => atomicTogglePlayRef.current(), []);
    const applyProjectDeltas = useEngineStore(s => s.applyProjectDeltas);
    const startTelemetryLoop = useEngineStore(s => s.startTelemetryLoop);
    const flushTrackControlFinals = useEngineStore(s => s.flushTrackControlFinals);
    const timelineClipsSnapshot = useEngineStore(s => s.timelineClips);
    const tracksEntity = useEngineStore(s => s.tracks);
    useEffect(() => {
        document.documentElement.style.setProperty('--daw-bottom-panel-height', `${bottomPanelHeightPx}px`);
    }, [bottomPanelHeightPx]);

    // Signal high-level layout readiness
    useEffect(() => {
        onMounted?.();
    }, [onMounted]);

    // BUG-M003 & BUG-M004 FIX: Prune component state & store dictionaries for deleted tracks.
    useEffect(() => {
        setBottomPanelModeByTrack((prev) => {
            let changed = false;
            const next = { ...prev };
            for (const id in next) {
                if (!tracksEntity.allIds.includes(id)) {
                    delete next[id];
                    changed = true;
                }
            }
            return changed ? next : prev;
        });

        // BUG-M004 FIX: Prune global open plugin editors for deleted tracks.
        const openEditors = useEngineStore.getState().openEditorsByTrack;
        let editorsChanged = false;
        const nextEditors = { ...openEditors };
        for (const id in nextEditors) {
            if (!tracksEntity.allIds.includes(id)) {
                delete nextEditors[id];
                editorsChanged = true;
            }
        }
        if (editorsChanged) {
            useEngineStore.setState({ openEditorsByTrack: nextEditors });
        }
    }, [tracksEntity.allIds]);

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
    const setBottomPanelModeForActiveTrack = useBottomPanelModeByTrack({
        selectedTrackId,
        setBottomPanelMode,
        setBottomPanelModeByTrack,
    });
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
        onTogglePlayback: atomicTogglePlay,
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
        writeAssistantOpenPref(next);
        return next;
    }), []);
    useSelectedTrackConsistency({ selectedTrackIds, selectedTrackId, setSelectedTrackId });
    useEffect(() => {
        if (tracksEntity.allIds.length === 0) return selectedTrackId !== 'master' ? setSelectedTrackId('master') : undefined;

        // BUG-M003 FIX: Prevent getting stuck on a deleted track or random ID.
        if (selectedTrackId === 'master' || !tracksEntity.allIds.includes(selectedTrackId)) {
            setSelectedTrackId(tracksEntity.allIds[0]);
        }
    }, [tracksEntity.allIds, selectedTrackId]);
    useEffect(() => {
        // BUG-M003 FIX: Clean up selectedTrackIds when tracks are deleted.
        // This prevents the track multiselection logic from throwing when looping over missing IDs.
        const next = selectedTrackIds.filter((id) => tracksEntity.allIds.includes(id));
        if (next.length !== selectedTrackIds.length) setSelectedTrackIds(next);
    }, [selectedTrackIds, tracksEntity.allIds]);

    useEffect(() => {
        const onOpenExport = () => setExportOpen(true);
        window.addEventListener('dream:open-export', onOpenExport as EventListener);
        document.addEventListener('dream:open-export', onOpenExport as EventListener);
        dreamGlobals.setOpenExportModal(onOpenExport);
        return () => {
            window.removeEventListener('dream:open-export', onOpenExport as EventListener);
            document.removeEventListener('dream:open-export', onOpenExport as EventListener);
            dreamGlobals.clearOpenExportModal(onOpenExport);
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
    useEffect(() => {
        if (!settingsLoaded) return;
        const idleHandle = scheduleIdle(() => {
            void import('@/widgets/TrackInspector/TrackInspector');
            void import('@/widgets/DeviceRack/DeviceRack');
            void import('@/widgets/PianoRoll/PianoRoll');
            void import('@/widgets/SettingsPanel/SettingsPanel');
            void import('@/widgets/MissingAssetsPanel/MissingAssetsPanel');
            void import('@/widgets/BlockingJobPopup/BlockingJobPopup');
        });
        return () => cancelIdle(idleHandle);
    }, [settingsLoaded]);
    const {
        bpm: transportBpm,
        is_playing: transportIsPlaying,
        loop_start: transportLoopStart,
        loop_end: transportLoopEnd,
        loop_enabled: transportLoopEnabled,
    } = useEngineStore(
        useShallow(s => ({
            bpm: s.transport.bpm,
            is_playing: s.transport.is_playing,
            loop_start: s.transport.loop_start,
            loop_end: s.transport.loop_end,
            loop_enabled: s.transport.loop_enabled,
        }))
    );
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
        transportBpm: resolveBpm(transportBpm),
        projectSampleRate,
        applyProjectDeltas,
    });
    const {
        timelineClipsForView,
        selectedClipIdsForView,
        selectedClipIdForView,
        loopStartBeat,
        loopEndBeat,
        missingMediaSummary,
    } = useDawShellViewModel({
        projectBpm,
        transportBpm,
        projectSampleRate,
        transportLoopStart,
        transportLoopEnd,
        timelineClips,
        selectedClipIds,
        clipFadeCurves,
        midiNotesByClip,
        tracksEntity,
    });

    const {
        panelInfo,
        collapsedGroups,
        trackIds,
        hiddenTrackIndices,
        trackCountRaw,
        selectedTrackIndex,
        selectedTrackIndices,
        selectedTimelineClip: newSelectedTimelineClip,
        toggleGroupCollapse,
    } = useArrangementTrackViewModel({
        tracksEntity,
        selectedTrackId,
        selectedTrackIds,
        selectedClipId: selectedClipIdForView,
        timelineClipsForView, // using the one from useDawShellViewModel
        bottomPanelModeByTrack,
        setSelectedTrackId,
        setBottomPanelMode,
        applyProjectDeltas,
    });

    const selectedMidiTotalBars = useMemo(() => {
        if (!newSelectedTimelineClip || newSelectedTimelineClip.type !== 'midi') return 8;
        const timeSig = useEngineStore.getState().transport.time_sig_numerator;
        const beatsPerBar = timeSig > 0 && isFinite(timeSig) ? timeSig : 4;
        return Math.max(1, Math.ceil(newSelectedTimelineClip.durationBeats / beatsPerBar));
    }, [newSelectedTimelineClip]);
    useEffect(() => {
        if (tracksEntity.allIds.length === 0) return selectedTrackId !== 'master' ? setSelectedTrackId('master') : undefined;
        // BUG-U001 FIX: Only re-evaluate auto-selection when the actual list of tracks changes
        // (allIds), rather than on every entity update (rename/color change), avoiding selection fighting.
        if (selectedTrackId === 'master' || !tracksEntity.allIds.includes(selectedTrackId)) {
            setSelectedTrackId(tracksEntity.allIds[0]);
        }
    }, [tracksEntity.allIds, selectedTrackId]);
    useEffect(() => {
        if (selectedTrackIds.length === 0) return;
        // BUG-U002 FIX: Prune using allIds instead of byId dependency to avoid flicker during undo/redo.
        const next = selectedTrackIds.filter((id) => tracksEntity.allIds.includes(id));
        if (next.length !== selectedTrackIds.length) setSelectedTrackIds(next);
    }, [selectedTrackIds, tracksEntity.allIds]);

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

    const prevMissingTotalRef = useRef(0);
    const closedMissingAssetsTotalRef = useRef(-1);
    useEffect(() => {
        const prev = prevMissingTotalRef.current;
        prevMissingTotalRef.current = missingMediaSummary.total;
        // BUG-U003 FIX: Only pop open the panel if count > 0 AND it's a new occurrence
        // (i.e. strictly greater than the count when the user last explicitly closed it).
        if (missingMediaSummary.total > 0 && missingMediaSummary.total > closedMissingAssetsTotalRef.current && prev === 0) {
            // BUG-049 FIX: Direct setState instead of queueMicrotask.
            setMissingAssetsOpen(true);
        }
    }, [missingMediaSummary.total]);

    // BUG-U005 FIX: hasResizableClipEditor removed — always false, dead code path.
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
    const { resolveAnchorBeat } = usePlaybackStartAnchor({
        transportIsPlaying,
        selectedClipIds: selectedClipIdsForView,
        timelineClipsForView,
        queuedStartBeatRef,
        editCursorBeat,
    });

    // ENTERPRISE FIX: Keep the ref-stable atomicTogglePlay implementation
    // in sync with the latest closures.
    useEffect(() => {
        atomicTogglePlayRef.current = async () => {
            if (transportIsPlaying) {
                await storeStop();
                return;
            }
            const anchorBeat = resolveAnchorBeat();
            if (anchorBeat !== null) {
                try {
                    await engineApi.playFromBeat(Math.max(0, anchorBeat));
                    useEngineStore.setState((s) => ({
                        transport: { ...s.transport, is_playing: true },
                        lastError: null,
                    }));
                } catch (e) {
                    useEngineStore.setState({ lastError: String(e) });
                }
            } else {
                await storeTogglePlay();
            }
        };
    }, [transportIsPlaying, resolveAnchorBeat, storeStop, storeTogglePlay]);
    const {
        dropBrowserItemOnTimeline,
        dropPluginOnTrack,
    } = useBrowserDnDOrchestrator({
        tracks: tracksEntity,
        projectBpm,
        transportBpm: resolveBpm(transportBpm),
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
        handleClipDuplicate,
        handleClipResize,
        handleClipFades,
        handleOpenMidiClip,
    } = useTimelineClipHandlers({
        projectBpm,
        transportBpm: resolveBpm(transportBpm),
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
    // BUG-011 FIX: Extracted from inline arrow in timelineProps to prevent
    // re-creating the function on every render (causes downstream re-renders).
    const handleClipFadeCurves = useCallback(
        (clipId: string, fadeInCurve: number, fadeOutCurve: number) => {
            setClipFadeCurves((prev) => ({
                ...prev,
                [clipId]: {
                    fadeInCurve: Math.max(0.05, Math.min(0.95, fadeInCurve)),
                    fadeOutCurve: Math.max(0.05, Math.min(0.95, fadeOutCurve)),
                },
            }));
        },
        [setClipFadeCurves],
    );
    const timelineProps = useDawShellTimelineProps({
        bpm: resolveBpm(transportBpm),
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
        marqueeSelection,
        onClipSelect: handleClipSelect,
        selectedClipIds: selectedClipIdsForView,
        onClipSelectionChange: handleTimelineClipSelectionChange,
        onClipMove: handleClipMove,
        onClipDuplicate: handleClipDuplicate,
        onClipResize: handleClipResize,
        onClipFades: handleClipFades,
        onClipFadeCurves: handleClipFadeCurves,
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
                hasResizableClipEditor={false}
                bottomPanelHeightPx={bottomPanelHeightPx}
                setBottomPanelHeightPx={setBottomPanelHeightPx}
                beginBottomPanelResize={beginBottomPanelResize}
                selectedTimelineClip={newSelectedTimelineClip ?? undefined}
                clipColor={newSelectedTimelineClip?.color ?? tracksEntity.byId[selectedTrackId]?.color ?? 'var(--color-accent-primary)'}
                midiNotes={newSelectedTimelineClip?.type === 'midi' ? (midiNotesByClip[newSelectedTimelineClip.id] ?? newSelectedTimelineClip.midiNotes ?? []) : []}
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
                missingAssetsOpen={missingAssetsOpen}
                missingTotal={missingMediaSummary.total}
                onCloseMissingAssets={() => {
                    setMissingAssetsOpen(false);
                    closedMissingAssetsTotalRef.current = missingMediaSummary.total;
                }}
                exportOpen={exportOpen}
                onCloseExport={() => setExportOpen(false)}
                projectName={projectFilePath ? projectFilePath.split(/[/\\]/).pop()?.replace(/\.[^.]+$/, '') ?? 'Untitled' : 'Untitled'}
                selectedClipIds={selectedClipIdsForView}
                timelineClipsForView={timelineClipsForView}
                bpm={resolveBpm(transportBpm)}
                sampleRate={projectSampleRate}
                loopStartBeat={loopStartBeat}
                loopEndBeat={loopEndBeat}
            />
        </div>
    );
};
export default DawShell;
