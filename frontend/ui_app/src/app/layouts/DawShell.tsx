import { lazy, Suspense, useState, useEffect, useCallback, useRef, useMemo } from 'react';
import throttle from 'lodash.throttle';
import { TransportBar } from '@/widgets/TransportBar/TransportBar';
import { useKeyboardShortcuts } from '@/shared/hooks/useKeyboardShortcuts';
import { useNativeMenu } from '@/shared/hooks/useNativeMenu';
import { useProjectManager } from '@/shared/hooks/useProjectManager';
import { ErrorBoundary } from '@/shared/ui/ErrorBoundary';
import { AssetBrowser } from '@/widgets/AssetBrowser/AssetBrowser';
import { AssistantChat } from '@/widgets/AssistantChat/AssistantChat';
import { AgentActionIndicator } from '@/widgets/AgentActionIndicator/AgentActionIndicator';
import { StatusBar } from '@/widgets/StatusBar/StatusBar';
import { Timeline } from '@/widgets/Timeline/Timeline';
import { DragOverlay } from '@/widgets/DragOverlay/DragOverlay';
import type { MidiNote } from '@/widgets/PianoRoll/PianoRoll';
import { useEngineStore } from '@/shared/stores/useEngineStore';
import { useAutomationStore } from '@/shared/stores/useAutomationStore';
import { useSettingsStore } from '@/shared/stores/useSettingsStore';
import * as engineApi from '@/shared/api/engine';
import { useBrowserDnDOrchestrator } from '@/shared/hooks/useBrowserDnDOrchestrator';
import { beatDurationToFrames, beatToFrame, frameToBeat, resolveSampleRate } from '@/shared/lib/audioMath';
import { EmptyClipEditor, SampleClipEditor, SessionWorkspace } from './DawShellPanels';
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

type ThrottledSender<T> = ((payload: T) => void) & {
    cancel: () => void;
    flush: () => void;
};

const TrackInspector = lazy(async () => ({
    default: (await import('@/widgets/TrackInspector/TrackInspector')).TrackInspector,
}));
const DeviceRack = lazy(async () => ({
    default: (await import('@/widgets/DeviceRack/DeviceRack')).DeviceRack,
}));
const PianoRoll = lazy(async () => ({
    default: (await import('@/widgets/PianoRoll/PianoRoll')).PianoRoll,
}));
const SettingsPanel = lazy(async () => ({
    default: (await import('@/widgets/SettingsPanel/SettingsPanel')).SettingsPanel,
}));
const ExportModal = lazy(async () => ({
    default: (await import('@/widgets/ExportModal/ExportModal')).ExportModal,
}));
const BlockingJobPopup = lazy(async () => ({
    default: (await import('@/widgets/BlockingJobPopup/BlockingJobPopup')).BlockingJobPopup,
}));
const MissingAssetsPanel = lazy(async () => ({
    default: (await import('@/widgets/MissingAssetsPanel/MissingAssetsPanel')).MissingAssetsPanel,
}));

const DEFAULT_BOTTOM_PANEL_HEIGHT = 220;

export const DawShell = () => {
    type BottomPanelMode = 'rack' | 'clip';
    type MainViewMode = 'arrangement' | 'session';
    const [settingsOpen, setSettingsOpen] = useState(false);
    const [selectedTrackId, setSelectedTrackId] = useState('');
    const [selectedTrackIds, setSelectedTrackIds] = useState<string[]>([]);
    const selectedTrackIdRef = useRef(selectedTrackId);
    selectedTrackIdRef.current = selectedTrackId;
    const selectedTrackIdsRef = useRef(selectedTrackIds);
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
    const [followPlayhead, setFollowPlayhead] = useState(false);
    const [midiNotesByClip, setMidiNotesByClip] = useState<Record<string, MidiNote[]>>({});
    const [clipFadeCurves, setClipFadeCurves] = useState<Record<string, { fadeInCurve: number; fadeOutCurve: number }>>({});
    const [aiVariationBusy, setAiVariationBusy] = useState(false);
    const [missingAssetsOpen, setMissingAssetsOpen] = useState(false);
    const [browserWidth, setBrowserWidth] = useState(320);
    const [fitTimelineToken, setFitTimelineToken] = useState(0);
    const [bottomPanelHeightPx, setBottomPanelHeightPx] = useState(DEFAULT_BOTTOM_PANEL_HEIGHT);
    const recoveringAudioRef = useRef(false);
    const lastAudioRecoverAtRef = useRef(0);
    const midiSaveThrottlesRef = useRef<Map<string, ThrottledSender<MidiNote[]>>>(new Map());
    const midiEnvelopeSaveThrottlesRef = useRef<
        Map<string, ThrottledSender<Array<{ paramId: string; points: Array<{ beat: number; value: number }> }>>>
    >(new Map());
    const latestMidiEnvelopesRef = useRef<
        Record<string, Array<{ paramId: string; points: Array<{ beat: number; value: number }> }>>
    >({});
    const latestMidiNotesRef = useRef<Record<string, MidiNote[]>>({});
    const dirtyMidiNotesClipIdsRef = useRef<Set<string>>(new Set());
    const dirtyMidiEnvelopeClipIdsRef = useRef<Set<string>>(new Set());
    const importFile = useEngineStore(s => s.importFile);
    const createMidiClip = useEngineStore(s => s.createMidiClip);
    const togglePlay = useEngineStore(s => s.togglePlay);
    const applyProjectDeltas = useEngineStore(s => s.applyProjectDeltas);
    const startTelemetryLoop = useEngineStore(s => s.startTelemetryLoop);
    const flushTrackControlFinals = useEngineStore(s => s.flushTrackControlFinals);
    const timelineClipsSnapshot = useEngineStore(s => s.timelineClips);
    const projectTracksSnapshot = useEngineStore(s => s.projectTracks);
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
        projectTracks: projectTracksSnapshot,
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
    const projectTracks = useEngineStore(s => s.projectTracks);
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
        if (projectTracks.length === 0) {
            if (selectedTrackId !== 'master') setSelectedTrackId('master');
            return;
        }
        const exists = projectTracks.some((t) => t.id === selectedTrackId);
        if (!exists) {
            setSelectedTrackId(projectTracks[0].id);
        }
    }, [projectTracks, selectedTrackId]);

    useEffect(() => {
        const key = selectedTrackId && selectedTrackId.length > 0 ? selectedTrackId : 'master';
        const saved = bottomPanelModeByTrack[key] ?? 'rack';
        setBottomPanelMode((prev) => (prev === saved ? prev : saved));
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
        projectTracks,
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
        projectTracks,
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
        for (const track of projectTracks) {
            if (track.instrument?.plugin_id?.startsWith('missing://')) missingPluginCount += 1;
            missingPluginCount += (track.effects ?? []).filter((fx) => fx.plugin_id?.startsWith('missing://')).length;
        }
        return {
            offlineClipCount,
            missingPluginCount,
            total: offlineClipCount + missingPluginCount,
        };
    }, [timelineClipsForView, projectTracks]);

    // BUG-B7 FIX: Only open the resolver on transition from 0 → N (not on every
    // re-count). This prevents the panel from re-opening after the user dismisses
    // it, e.g. when a clip is fixed and another simultaneously goes offline.
    const prevMissingTotalRef = useRef(0);
    useEffect(() => {
        const prev = prevMissingTotalRef.current;
        prevMissingTotalRef.current = missingMediaSummary.total;
        if (missingMediaSummary.total > 0 && prev === 0) {
            setMissingAssetsOpen(true);
        }
    }, [missingMediaSummary.total]);
    const selectedMidiTotalBars = useMemo(() => {
        if (!selectedTimelineClip || selectedTimelineClip.type !== 'midi') return 8;
        return Math.max(1, Math.ceil(selectedTimelineClip.durationBeats / 4));
    }, [selectedTimelineClip]);
    const hasResizableClipEditor =
        bottomPanelMode === 'clip' && (selectedTimelineClip?.type === 'midi' || selectedTimelineClip?.type === 'audio');
    const handleGenerateMidiVariation = useCallback(async () => {
        if (!selectedTimelineClip || selectedTimelineClip.type !== 'midi') return;
        const clip = selectedTimelineClip;
        const notes = midiNotesByClip[clip.id] ?? [];
        const track = projectTracks[clip.trackIndex];
        const bpm = projectBpm || transportBpm || 120;
        // Time signature: beatsPerBar is always 4/4 for now (the backend transport
        // state does not include time signature yet — when it does, read it here)
        const beatsPerBarVal = 4;
        const sampleRate = projectSampleRate;

        // Use the same model as the chat panel — claude-sonnet-4-5 via OpenRouter.
        // Falls back to the user's configured openRouterModel if set.
        const settingsModel = useSettingsStore.getState().settings.openRouterModel;
        const variationModel = (settingsModel && settingsModel !== 'openai/gpt-4o-mini')
            ? settingsModel
            : 'minimax/minimax-m2.5';

        setAiVariationBusy(true);
        try {
            const variedNotes = await engineApi.generateMidiVariation({
                bpm,
                beatsPerBar: beatsPerBarVal,
                clipName: clip.name,
                clipDurationBeats: clip.durationBeats,
                notes,
                trackContext: {
                    trackName: track?.name ?? `Track ${clip.trackIndex + 1}`,
                    trackType: track?.track_type ?? 'Midi',
                    instrumentName: track?.instrument?.name ?? null,
                    effectNames: (track?.effects ?? []).map((e) => e.name),
                    samplerSamplePath: track?.sampler?.sample_path ?? null,
                },
                model: variationModel,
            });

            const normalizedForUi: MidiNote[] = variedNotes.map((n, idx) => ({
                id: `ai_${Date.now()}_${idx}`,
                pitch: n.pitch,
                velocity: n.velocity,
                startBeat: n.startBeat,
                durationBeats: n.durationBeats,
            }));

            setMidiNotesByClip((prev) => ({ ...prev, [clip.id]: normalizedForUi }));
            const response = await engineApi.updateMidiClipWithDeltas(
                clip.id,
                normalizedForUi.map((n) => ({
                    pitch: n.pitch,
                    velocity: n.velocity,
                    startFrames: Math.max(0, beatToFrame(n.startBeat, bpm, sampleRate)),
                    durationFrames: Math.max(1, beatDurationToFrames(n.durationBeats, bpm, sampleRate)),
                })),
            );
            await applyProjectDeltas(response.deltas, 'daw-shell:midi-variation');
        } catch (err) {
            console.error('[DawShell] AI MIDI variation failed:', err);
            const message = err instanceof Error ? err.message : 'Unknown AI error';
            window.alert(`Не удалось сгенерировать вариацию: ${message}`);
        } finally {
            setAiVariationBusy(false);
        }
    }, [
        selectedTimelineClip,
        midiNotesByClip,
        projectTracks,
        projectBpm,
        transportBpm,
        projectSampleRate,
        applyProjectDeltas,
    ]);

    const serializeMidiNotesToFrames = useCallback((notes: MidiNote[]) => {
        const bpm = projectBpm || transportBpm || 120;
        const sr = projectSampleRate;
        return notes.map((n) => ({
            pitch: n.pitch,
            velocity: n.velocity,
            startFrames: Math.max(0, beatToFrame(n.startBeat, bpm, sr)),
            durationFrames: Math.max(1, beatDurationToFrames(n.durationBeats, bpm, sr)),
        }));
    }, [projectBpm, transportBpm, projectSampleRate]);

    const flushMidiThrottles = useCallback(() => {
        midiSaveThrottlesRef.current.forEach((send) => send.flush());
        midiEnvelopeSaveThrottlesRef.current.forEach((send) => send.flush());
    }, []);

    useEffect(() => {
        const incoming: Record<string, MidiNote[]> = {};
        for (const clip of timelineClips) {
            if (clip.type !== 'midi') continue;
            if (dirtyMidiNotesClipIdsRef.current.has(clip.id)) {
                incoming[clip.id] = latestMidiNotesRef.current[clip.id] ?? [];
            } else {
                incoming[clip.id] = (clip.midiNotes ?? []).map((n) => ({
                    id: n.id ?? `${clip.id}-${n.pitch}-${n.startBeat}`,
                    pitch: n.pitch,
                    startBeat: n.startBeat,
                    durationBeats: n.durationBeats,
                    velocity: n.velocity,
                }));
            }
        }
        // BUG-C15 FIX: Only update state if the incoming data actually differs.
        // Replacing the entire map on every timelineClips change forces PianoRoll
        // to re-render even when the currently edited clip's notes are identical.
        setMidiNotesByClip((prev) => {
            const prevKeys = Object.keys(prev);
            const incomingKeys = Object.keys(incoming);
            if (prevKeys.length !== incomingKeys.length) return incoming;
            for (const key of incomingKeys) {
                if (prev[key] !== incoming[key]) {
                    // Only replace if truly different (reference check is sufficient
                    // since dirty clips keep their ref and clean clips get new arrays).
                    return incoming;
                }
            }
            return prev; // No change — skip re-render
        });
    }, [timelineClips]);

    useEffect(() => {
        latestMidiNotesRef.current = midiNotesByClip;
    }, [midiNotesByClip]);

    useEffect(() => {
        const activeMidiClipIds = new Set(
            timelineClips.filter((clip) => clip.type === 'midi').map((clip) => clip.id)
        );
        for (const [clipId, send] of midiSaveThrottlesRef.current.entries()) {
            if (!activeMidiClipIds.has(clipId)) {
                send.cancel();
                midiSaveThrottlesRef.current.delete(clipId);
                dirtyMidiNotesClipIdsRef.current.delete(clipId);
            }
        }
        for (const [clipId, send] of midiEnvelopeSaveThrottlesRef.current.entries()) {
            if (!activeMidiClipIds.has(clipId)) {
                send.cancel();
                midiEnvelopeSaveThrottlesRef.current.delete(clipId);
                dirtyMidiEnvelopeClipIdsRef.current.delete(clipId);
            }
        }
    }, [timelineClips]);

    useEffect(() => {
        const midiSaveThrottles = midiSaveThrottlesRef.current;
        const midiEnvelopeSaveThrottles = midiEnvelopeSaveThrottlesRef.current;
        const dirtyMidiNotes = dirtyMidiNotesClipIdsRef.current;
        const dirtyMidiEnvelopes = dirtyMidiEnvelopeClipIdsRef.current;
        return () => {
            midiSaveThrottles.forEach((send) => send.cancel());
            midiEnvelopeSaveThrottles.forEach((send) => send.cancel());
            midiSaveThrottles.clear();
            midiEnvelopeSaveThrottles.clear();
            dirtyMidiNotes.clear();
            dirtyMidiEnvelopes.clear();
        };
    }, []);

    // ── Final unthrottled sends on pointer release ──
    // PERF-FIX-7: Use a ref for selectedTimelineClip so this effect doesn't
    // re-register the global listener on every clip selection change.
    const selectedTimelineClipRef = useRef(selectedTimelineClip);
    selectedTimelineClipRef.current = selectedTimelineClip;

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
        projectTracksSnapshot,
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
        projectTracks,
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

    return (
        <div className="relative w-screen h-screen overflow-hidden bg-bg-app text-text-primary">

            {/* ═══ FULL LAYOUT ═══ */}
            <div className="absolute inset-0 z-10 flex flex-col">

                {/* ── TOP: Transport Bar ── */}
                <header className="shrink-0 w-full flex items-center justify-center z-50"
                    style={{ height: 'var(--daw-transport-height)' }}
                >
                    <ErrorBoundary module="Transport">
                        <TransportBar
                            onSettingsClick={openSettings}
                            onOpenExport={handleOpenExport}
                            onRecordingStateChange={handleRecordingStateChange}
                            followPlayhead={followPlayhead}
                            onFollowPlayheadChange={setFollowPlayhead}
                            automationVisible={automationVisible}
                            onAutomationToggle={toggleAutomation}
                            onFitTimelineHorizontally={handleFitTimelineHorizontally}
                            onResetTrackHeights={handleResetTrackHeights}
                            assistantOpen={assistantOpen}
                            onAssistantToggle={handleAssistantToggle}
                        />
                    </ErrorBoundary>
                </header>

                {/* ── CENTER: Split Layout (Browser | Timeline | TrackList) ── */}
                <main ref={mainSplitRef} className="flex flex-1 overflow-hidden" style={{ gap: 0 }}>

                    {/* Left Sidebar (Asset Browser) */}
                    <aside
                        className="shrink-0 h-full z-40 flex flex-col overflow-hidden"
                        style={{
                            width: browserWidth,
                            background: 'var(--color-bg-panel)',
                            borderRight: '1px solid var(--color-divider)',
                        }}
                    >
                        <ErrorBoundary module="Asset Browser">
                            <AssetBrowser />
                        </ErrorBoundary>
                    </aside>
                    <div
                        onMouseDown={beginBrowserResize}
                        style={{
                            width: 6,
                            cursor: 'ew-resize',
                            background: 'transparent',
                            flexShrink: 0,
                        }}
                    />

                    {mainViewMode === 'arrangement' ? (
                        <>
                            {/* ═ TIMELINE (replaces the "hole-punch" transparent zone) ═ */}
                            <div
                                ref={timelineRef}
                                className="flex-1 overflow-hidden"
                                style={{
                                    background: 'var(--color-bg-canvas)',
                                }}
                            >
                                <ErrorBoundary module="Timeline">
                                    <Timeline
                                        bpm={projectBpm || transportBpm || 120}
                                        clips={timelineClipsForView}
                                        /* playheadBeat — now read from store directly by Timeline */
                                        editCursorBeat={editCursorBeat}
                                        editCursorTrackIndex={editCursorTrackIndex}
                                        editCursorTrackIndexEnd={editCursorTrackIndexEnd}
                                        selectedTrackIndex={selectedTrackIndex}
                                        selectedTrackIndices={selectedTrackIndices}
                                        isPlaying={transportIsPlaying}
                                        recordingActive={recordingState.active}
                                        recordingTrackIndex={recordingState.trackIndex}
                                        trackIds={trackIds}
                                        loopStart={loopStartBeat}
                                        loopEnd={loopEndBeat}
                                        loopEnabled={transportLoopEnabled}
                                        trackCount={trackCount}
                                        trackHeight={TRACK_HEIGHT_BASE}
                                        trackHeights={timelineTrackHeights}
                                        onPlayheadChange={handlePlayheadChange}
                                        onEditCursorChange={handleEditCursorChange}
                                        onMarqueeSelectionStart={handleMarqueeSelectionStart}
                                        onMarqueeSelectionChange={setMarqueeSelection}
                                        onClipSelect={handleClipSelect}
                                        selectedClipIds={selectedClipIds}
                                        onClipSelectionChange={handleTimelineClipSelectionChange}
                                        onClipMove={handleClipMove}
                                        onClipResize={handleClipResize}
                                        onClipFades={handleClipFades}
                                        onClipFadeCurves={(clipId, fadeInCurve, fadeOutCurve) => {
                                            setClipFadeCurves((prev) => ({
                                                ...prev,
                                                [clipId]: {
                                                    fadeInCurve: Math.max(0.05, Math.min(0.95, fadeInCurve)),
                                                    fadeOutCurve: Math.max(0.05, Math.min(0.95, fadeOutCurve)),
                                                },
                                            }));
                                        }}
                                        onDropBrowserItem={handleBrowserDrop}
                                        onDoubleClickTrack={handleDoubleClickTrack}
                                        onOpenMidiClip={handleOpenMidiClip}
                                        onTrackSelect={handleTimelineTrackSelect}

                                        followPlayhead={followPlayhead}
                                        automationVisible={automationVisible}
                                        fitHorizontalToken={fitTimelineToken}
                                    />
                                </ErrorBoundary>
                            </div>

                            {/* Right Sidebar (Track Inspector / Track List) */}
                            <aside
                                className="shrink-0 h-full z-40 flex flex-col overflow-hidden"
                                style={{
                                    width: 'var(--daw-inspector-width)',
                                    background: 'var(--color-bg-panel)',
                                    borderLeft: '1px solid var(--color-divider)',
                                }}
                            >
                                <ErrorBoundary module="Track Inspector">
                                    <Suspense fallback={null}>
                                        <TrackInspector
                                            selectedTrackId={selectedTrackId}
                                            selectedTrackIds={selectedTrackIds}
                                            onSelectTracks={handleSelectTracks}
                                            onSelectTrack={handleSelectTrack}
                                            trackHeight={TRACK_HEIGHT_BASE}
                                            rulerHeight={28}

                                            mixerFocusMode={false}
                                            collapsedGroups={collapsedGroups}
                                            onToggleGroupCollapse={toggleGroupCollapse}
                                        />
                                    </Suspense>
                                </ErrorBoundary>
                            </aside>
                        </>
                    ) : (
                        <SessionWorkspace
                            tracks={projectTracks}
                            selectedTrackId={selectedTrackId}
                            onSelectTrack={handleSelectTrack}
                        />
                    )}
                </main>

                {/* ── BOTTOM: Rack / Clip Editor (Shift+Tab) ── */}
                <footer
                    className="shrink-0 z-40 overflow-hidden"
                    style={{
                        height: hasResizableClipEditor ? `${bottomPanelHeightPx}px` : 'var(--daw-device-rack-height)',
                        minHeight: hasResizableClipEditor ? 'var(--daw-device-rack-height)' : 'var(--daw-device-rack-min-height)',
                        borderTop: '1px solid var(--color-divider)',
                        position: 'relative',
                    }}
                >
                    {hasResizableClipEditor && (
                        <div
                            onMouseDown={beginBottomPanelResize}
                            title="Resize Clip Editor"
                            style={{
                                position: 'absolute',
                                top: 0,
                                left: 0,
                                right: 0,
                                height: 8,
                                cursor: 'ns-resize',
                                zIndex: 'var(--z-modal)' as unknown as number,
                                background: 'transparent',
                            }}
                        >
                            <div
                                style={{
                                    width: 56,
                                    height: 2,
                                    borderRadius: 'var(--radius-xs)',
                                    background: 'color-mix(in srgb, var(--color-text-secondary) 45%, transparent)',
                                    margin: '2px auto 0',
                                }}
                            />
                        </div>
                    )}
                    {bottomPanelMode === 'rack' ? (
                        <ErrorBoundary module="Device Rack">
                            <Suspense fallback={null}>
                                <DeviceRack
                                    selectedTrackId={selectedTrackId}
                                    onDropPluginToTrack={(item, trackId) => dropPluginOnTrack(item, trackId)}
                                />
                            </Suspense>
                        </ErrorBoundary>
                    ) : (
                        <ErrorBoundary module="Clip Editor">
                            {selectedTimelineClip?.type === 'midi' ? (
                                <Suspense fallback={null}>
                                    <PianoRoll
                                        // Audit #97 fix: removed fade params from key to prevent
                                        // full remount (losing selection, scroll, zoom) on fade changes.
                                        key={selectedTimelineClip.id}
                                        notes={midiNotesByClip[selectedTimelineClip.id] ?? []}
                                        ghostNotes={[]} // TODO: wire up ghost notes from adjacent clips
                                        midiEnvelopes={selectedTimelineClip.midiEnvelopes ?? []}
                                        trackIndex={selectedTimelineClip.trackIndex}
                                        onNotesChange={(notes) => {
                                            const clipId = selectedTimelineClip.id;
                                            setMidiNotesByClip((prev) => ({ ...prev, [clipId]: notes }));
                                            latestMidiNotesRef.current[clipId] = notes;
                                            dirtyMidiNotesClipIdsRef.current.add(clipId);
                                            let send = midiSaveThrottlesRef.current.get(clipId);
                                            if (!send) {
                                                send = throttle((toSend: MidiNote[]) => {
                                                    void engineApi
                                                        .updateMidiClipWithDeltas(
                                                            clipId,
                                                            serializeMidiNotesToFrames(toSend),
                                                            { pushUndoStep: false },
                                                        )
                                                        .then((response) => applyProjectDeltas(response.deltas, 'midi-notes:throttle'))
                                                        .catch((err) => console.error('[DawShell] updateMidiClip failed:', err));
                                                }, 80) as ThrottledSender<MidiNote[]>;
                                                midiSaveThrottlesRef.current.set(clipId, send);
                                            }
                                            send(notes);
                                        }}
                                        onSetMidiEnvelopes={(envelopes) => {
                                            const clipId = selectedTimelineClip.id;
                                            latestMidiEnvelopesRef.current[clipId] = envelopes;

                                            let send = midiEnvelopeSaveThrottlesRef.current.get(clipId);
                                            if (!send) {
                                                send = throttle((toSend) => {
                                                    void engineApi
                                                        .setMidiClipEnvelopes(clipId, toSend, { pushUndoStep: false })
                                                        .catch((err) => console.error('[DawShell] setMidiClipEnvelopes failed:', err));
                                                }, 100) as ThrottledSender<Array<{ paramId: string; points: Array<{ beat: number; value: number }> }>>;
                                                midiEnvelopeSaveThrottlesRef.current.set(clipId, send);
                                            }
                                            dirtyMidiEnvelopeClipIdsRef.current.add(clipId);
                                            send(envelopes);
                                        }}
                                        onGenerateVariation={handleGenerateMidiVariation}
                                        aiVariationBusy={aiVariationBusy}
                                        clipStartBeat={selectedTimelineClip.startBeat}
                                        totalBars={selectedMidiTotalBars}
                                        clipLengthBeats={selectedTimelineClip.durationBeats}
                                        color={selectedTimelineClip.color || projectTracks.find((t) => t.id === selectedTrackId)?.color || 'var(--color-accent-primary)'}
                                    />
                                </Suspense>
                            ) : selectedTimelineClip?.type === 'audio' ? (
                                <SampleClipEditor
                                    key={`${selectedTimelineClip.id}:${selectedTimelineClip.pitchShiftSemitones ?? 0}:${selectedTimelineClip.isWarped ? 1 : 0}:${selectedTimelineClip.warpMode ?? 0}:${Math.round(selectedTimelineClip.warpBaseBpm ?? 0)}`}
                                    clip={selectedTimelineClip}
                                />
                            ) : (
                                <EmptyClipEditor />
                            )}
                        </ErrorBoundary>
                    )}
                </footer>

                {/* ── VERY BOTTOM: Status Bar ── */}
                {missingMediaSummary.total > 0 && (
                    <div
                        className="z-50"
                        style={{
                            borderTop: '1px solid color-mix(in srgb, var(--color-status-error) 55%, transparent)',
                            borderBottom: '1px solid color-mix(in srgb, var(--color-status-error) 35%, transparent)',
                            background: 'linear-gradient(90deg, color-mix(in srgb, var(--color-status-error) 18%, var(--color-bg-panel)) 0%, color-mix(in srgb, var(--color-status-error) 8%, var(--color-bg-panel)) 100%)',
                            minHeight: 24,
                            display: 'flex',
                            alignItems: 'center',
                            justifyContent: 'space-between',
                            padding: '3px 10px',
                            gap: 10,
                        }}
                    >
                        <span style={{ fontSize: 'var(--font-size-sm)', fontWeight: 'var(--font-weight-bold)' as unknown as number, color: 'var(--color-status-error)', letterSpacing: '0.02em' }}>
                            Missing media detected: {missingMediaSummary.offlineClipCount} files, {missingMediaSummary.missingPluginCount} plugins
                        </span>
                        <div style={{ display: 'flex', gap: 6 }}>
                            <button
                                onClick={() => setMissingAssetsOpen((v) => !v)}
                                style={{
                                    border: '1px solid color-mix(in srgb, var(--color-status-error) 45%, transparent)',
                                    background: 'color-mix(in srgb, var(--color-status-error) 20%, transparent)',
                                    color: 'color-mix(in srgb, var(--color-status-error) 30%, var(--color-text-primary))',
                                    borderRadius: 'var(--radius-lg)',
                                    fontSize: 'var(--font-size-xs)',
                                    fontWeight: 'var(--font-weight-bold)' as unknown as number,
                                    padding: '3px 8px',
                                    cursor: 'pointer',
                                }}
                            >
                                {missingAssetsOpen ? 'Hide Resolver' : 'Open Resolver'}
                            </button>
                        </div>
                    </div>
                )}
                <div className="z-50">
                    <StatusBar
                        panelMode={bottomPanelMode}
                        onPanelModeChange={setBottomPanelModeForActiveTrack}
                        panelInfo={panelInfo}
                    />
                </div>

            </div>

            {/* ═══ SETTINGS MODAL ═══ */}
            <ErrorBoundary module="Settings">
                <Suspense fallback={null}>
                    <SettingsPanel isOpen={settingsOpen} onClose={() => setSettingsOpen(false)} />
                </Suspense>
            </ErrorBoundary>

            {/* ═══ AI ASSISTANT CHAT ═══ */}
            <AssistantChat
                open={assistantOpen}
                onClose={() => {
                    setAssistantOpen(false);
                    try { localStorage.setItem('dream-daw:assistant-open', '0'); } catch { /* quota */ }
                }}
                onOpen={() => {
                    setAssistantOpen(true);
                    try { localStorage.setItem('dream-daw:assistant-open', '1'); } catch { /* quota */ }
                }}
                onSelectClips={setSelectedClipIds}
            />

            {/* ═══ AGENT ACTION INDICATORS ═══ */}
            <AgentActionIndicator />

            <ErrorBoundary module="Resolver">
                <Suspense fallback={null}>
                    <MissingAssetsPanel isOpen={missingAssetsOpen && missingMediaSummary.total > 0} onClose={() => setMissingAssetsOpen(false)} />
                </Suspense>
            </ErrorBoundary>

            {/* Drop overlay removed — asset drops handled directly by Timeline/AssetBrowser */}
            {/* ── Export Modal ── */}
            <ErrorBoundary module="Export">
                <Suspense fallback={null}>
                    <ExportModal
                        isOpen={exportOpen}
                        onClose={() => setExportOpen(false)}
                        projectName={
                            projectFilePath
                                ? projectFilePath.split('/').pop()?.replace(/\.[^.]+$/, '') ?? 'Untitled'
                                : 'Untitled'
                        }
                        selectedClipIds={selectedClipIds}
                        allClips={timelineClipsForView}
                        bpm={projectBpm || transportBpm || 120}
                        sampleRate={projectSampleRate}
                        loopStartBeat={loopStartBeat}
                        loopEndBeat={loopEndBeat}
                        marqueeSelection={marqueeSelection}
                    />
                </Suspense>
            </ErrorBoundary>

            <Suspense fallback={null}>
                <BlockingJobPopup />
            </Suspense>

            <DragOverlay />

        </div>
    );
};

export default DawShell;
