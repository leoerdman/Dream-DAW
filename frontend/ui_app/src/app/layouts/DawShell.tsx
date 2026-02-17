import { lazy, Suspense, useState, useEffect, useCallback, useRef, useMemo, type CSSProperties } from 'react';
import throttle from 'lodash.throttle';
import { listen } from '@tauri-apps/api/event';
import { TransportBar } from '@/widgets/TransportBar/TransportBar';
import { useKeyboardShortcuts } from '@/shared/hooks/useKeyboardShortcuts';
import { useNativeMenu } from '@/shared/hooks/useNativeMenu';
import { useProjectManager } from '@/shared/hooks/useProjectManager';
import { ErrorBoundary } from '@/shared/ui/ErrorBoundary';
import { AssetBrowser } from '@/widgets/AssetBrowser/AssetBrowser';
import { StatusBar } from '@/widgets/StatusBar/StatusBar';
import { Timeline } from '@/widgets/Timeline/Timeline';
import { ClipRenderer } from '@/widgets/Timeline/ClipRenderer';
import { DragOverlay } from '@/widgets/DragOverlay/DragOverlay';
import type { BrowserDragItem } from '@/shared/lib/arrangementTypes';
import type { MidiNote } from '@/widgets/PianoRoll/PianoRoll';
import { useEngineStore, type ProjectTrack } from '@/shared/stores/useEngineStore';
import { useGridStore } from '@/shared/stores/useGridStore';
import { useAutomationStore } from '@/shared/stores/useAutomationStore';
import * as engineApi from '@/shared/api/engine';
import { useBrowserDnDOrchestrator } from '@/shared/hooks/useBrowserDnDOrchestrator';
import { divisionToInterval } from '@/shared/lib/gridSnap';
import { getContrastColor } from '@/shared/lib/colorUtils';
import { ClipEditorShell } from '@/widgets/ClipEditor/ClipEditorShell';
import { ClipEditorMetaRow, ClipEditorSection, ClipEditorSidebar } from '@/widgets/ClipEditor/ClipEditorSidebar';

type ThrottledSender<T> = ((payload: T) => void) & {
    cancel: () => void;
    flush: () => void;
};

/** Supported audio file extensions for drag-and-drop import. */
const AUDIO_EXTENSIONS = new Set([
    '.wav', '.mp3', '.flac', '.aiff', '.aif', '.ogg', '.m4a', '.aac',
]);

/** Check if a file path is a supported audio format. */
const isAudioFile = (path: string): boolean => {
    const ext = path.slice(path.lastIndexOf('.')).toLowerCase();
    return AUDIO_EXTENSIONS.has(ext);
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

/**
 * DawShell — The "Hole-Punch Architecture" Layout with integrated Timeline.
 * 
 * Ported from MainWindowController.swift → ArrangementViewController layout:
 * 
 *   ┌─────────────────────────────────────────────────┐
 *   │                  TransportBar                    │  ← 32px
 *   ├──────────┬────────────────────────┬─────────────┤
 *   │          │   ┌─ Ruler ─────────┐  │             │
 *   │  Asset   │   │ 1  2  3  4 | 5  │  │   Track    │
 *   │ Browser  │   ├─────────────────┤  │  Inspector  │
 *   │          │   │ [clips][clips]  │  │             │
 *   │          │   │ [clips]  [clip] │  │             │
 *   │          │   │ ▲ playhead      │  │             │
 *   │          │   └─────────────────┘  │             │
 *   ├──────────┴────────────────────────┴─────────────┤
 *   │                  DeviceRack                      │  ← 160-200px
 *   ├─────────────────────────────────────────────────┤
 *   │                  StatusBar                       │  ← 20px
 *   └─────────────────────────────────────────────────┘
 * 
 * selectedTrackId is lifted here so TrackInspector and DeviceRack stay in sync:
 * - Clicking a track in TrackInspector updates the selected track
 * - DeviceRack shows the device chain for the currently selected track
 */
export const DawShell = () => {
    type BottomPanelMode = 'rack' | 'clip';
    type MainViewMode = 'arrangement' | 'session';
    const [settingsOpen, setSettingsOpen] = useState(false);
    const [selectedTrackId, setSelectedTrackId] = useState('');
    const [selectedTrackIds, setSelectedTrackIds] = useState<string[]>([]);
    const [selectedClipId, setSelectedClipId] = useState<string | null>(null);
    const [selectedClipIds, setSelectedClipIds] = useState<string[]>([]);
    const [editCursorBeat, setEditCursorBeat] = useState(0);
    const [editCursorTrackIndex, setEditCursorTrackIndex] = useState(0);
    const [isDragOver, setIsDragOver] = useState(false);
    const [exportOpen, setExportOpen] = useState(false);
    const [bottomPanelMode, setBottomPanelMode] = useState<BottomPanelMode>('rack');
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
    const DEFAULT_BOTTOM_PANEL_HEIGHT = 220;
    const [bottomPanelHeightPx, setBottomPanelHeightPx] = useState(DEFAULT_BOTTOM_PANEL_HEIGHT);
    const recoveringAudioRef = useRef(false);
    const lastAudioRecoverAtRef = useRef(0);
    const projectRefreshTimerRef = useRef<number | null>(null);
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
    const fetchProject = useEngineStore(s => s.fetchProject);
    const startTelemetryLoop = useEngineStore(s => s.startTelemetryLoop);
    const flushTrackControlFinals = useEngineStore(s => s.flushTrackControlFinals);
    const timelineClipsSnapshot = useEngineStore(s => s.timelineClips);
    const projectTracksSnapshot = useEngineStore(s => s.projectTracks);
    const transportPositionSeconds = useEngineStore(s => s.transport.position_seconds ?? 0);
    const projectSampleRate = useEngineStore(s => s.projectSampleRate || 44100);
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

    // ── Enterprise Project Manager (Cmd+S/⇧S/N/O, auto-backup, dirty state)
    // Hook has side effects (keyboard shortcuts, auto-backup timer) — value intentionally unused
    useProjectManager(fetchProject);

    // ── Native macOS Menu Bar (File, Edit, Window) ──
    // NOTE: Do NOT pass fetchProject as onProjectChange here.
    // useNativeMenu already calls fetchProject internally (via useEngineStore.getState()).
    // Passing fetchProject again caused a redundant second fetchProject call after
    // each project action, racing with the first via the stale-response guard.
    useNativeMenu();

    // ── Global Keyboard Shortcuts (Space, Cmd+E, Delete) ──
    useKeyboardShortcuts({
        selectedClipId,
        selectedClipIds,
        selectedTrackId,
        projectTracks: projectTracksSnapshot,
        playheadFrames: Math.round(transportPositionSeconds * projectSampleRate),
        editCursorBeat,
        timelineClips: timelineClipsSnapshot,
        marqueeSelection,
        onProjectMutated: fetchProject,
        onTogglePlayback: togglePlay,
    });

    // ── ⌘, opens Settings ──
    useEffect(() => {
        const handler = (e: KeyboardEvent) => {
            if (e.metaKey && e.key === ',') {
                e.preventDefault();
                setSettingsOpen(prev => !prev);
            }
            // Cmd/Ctrl + Shift + R: open render/export dialog
            if ((e.metaKey || e.ctrlKey) && e.shiftKey && e.key.toLowerCase() === 'r') {
                e.preventDefault();
                setExportOpen(true);
                return;
            }
            if (e.key === 'Tab' && !e.shiftKey) {
                const target = e.target as HTMLElement | null;
                const tag = target?.tagName?.toLowerCase();
                const isTextInput =
                    tag === 'input' || tag === 'textarea' || target?.isContentEditable;
                if (isTextInput) return;
                e.preventDefault();
                setMainViewMode((prev) => (prev === 'arrangement' ? 'session' : 'arrangement'));
                return;
            }
            // Shift+Tab: toggle bottom panel between Instrument Rack and Clip Editor.
            if (e.key === 'Tab' && e.shiftKey) {
                const target = e.target as HTMLElement | null;
                const tag = target?.tagName?.toLowerCase();
                const isTextInput =
                    tag === 'input' || tag === 'textarea' || target?.isContentEditable;
                if (isTextInput) return;
                e.preventDefault();
                setBottomPanelMode((prev) => (prev === 'rack' ? 'clip' : 'rack'));
            }
            // A key: toggle automation visibility
            if (e.key === 'a' && !e.metaKey && !e.ctrlKey && !e.altKey) {
                const target = e.target as HTMLElement | null;
                const tag = target?.tagName?.toLowerCase();
                const isTextInput =
                    tag === 'input' || tag === 'textarea' || target?.isContentEditable;
                if (isTextInput) return;
                e.preventDefault();
                useAutomationStore.getState().toggleGlobalVisible();
            }
        };
        window.addEventListener('keydown', handler);
        return () => window.removeEventListener('keydown', handler);
    }, []);

    // ── Tauri Drag & Drop → Import Audio ───────────────────────────
    useEffect(() => {
        let unlisten: (() => void) | undefined;

        const setup = async () => {
            // Listen for drag hover (visual feedback) — only for OS file drops, not in-app drags
            const unlistenHover = await listen('tauri://drag-over', () => {
                if (!window.__dreamInAppDrag) {
                    setIsDragOver(true);
                }
            });

            // Listen for drag leave
            const unlistenLeave = await listen('tauri://drag-leave', () => {
                setIsDragOver(false);
            });

            // Listen for file drop
            const unlistenDrop = await listen<{ paths: string[] }>('tauri://drag-drop', async (event) => {
                setIsDragOver(false);

                if (importingRef.current) return;
                importingRef.current = true;

                try {
                    const paths = event.payload.paths ?? [];
                    const audioFiles = paths.filter(isAudioFile);

                    if (audioFiles.length === 0) {
                        console.warn('[DawShell] No supported audio files in drop');
                        return;
                    }

                    // Import each file onto sequential tracks (track 0, 1, 2, ...)
                    for (let i = 0; i < audioFiles.length; i++) {
                        await importFile(audioFiles[i], i);
                    }

                    console.log(`[DawShell] Imported ${audioFiles.length} audio file(s)`);
                } finally {
                    importingRef.current = false;
                }
            });

            unlisten = () => {
                unlistenHover();
                unlistenLeave();
                unlistenDrop();
            };
        };

        setup();
        return () => unlisten?.();
    }, [importFile]);

    const openSettings = useCallback(() => setSettingsOpen(true), []);
    const handleSelectTrack = useCallback((id: string) => {
        setSelectedTrackId(id);
        setSelectedTrackIds(id && id !== 'master' ? [id] : []);
        const tracks = useEngineStore.getState().projectTracks;
        const index = tracks.findIndex((t) => t.id === id);
        if (index >= 0) {
            setEditCursorTrackIndex(index);
        }
        // Track selection should never auto-select clips.
        setSelectedClipIds([]);
        setSelectedClipId(null);
    }, []);

    const handleSelectTracks = useCallback((ids: string[], primaryId: string) => {
        const cleaned = Array.from(new Set(ids)).filter((t) => t && t !== 'master');
        setSelectedTrackIds(cleaned);
        setSelectedTrackId(primaryId);
        const tracks = useEngineStore.getState().projectTracks;
        const index = tracks.findIndex((t) => t.id === primaryId);
        if (index >= 0) {
            setEditCursorTrackIndex(index);
        }
        // Multi-track selection should never auto-select clips.
        setSelectedClipIds([]);
        setSelectedClipId(null);
    }, []);

    // Canonicalize clip selection source-of-truth:
    // selectedClipId is always derived from selectedClipIds tail.
    useEffect(() => {
        const derivedPrimary = selectedClipIds.length > 0
            ? selectedClipIds[selectedClipIds.length - 1]
            : null;
        if (selectedClipId !== derivedPrimary) {
            setSelectedClipId(derivedPrimary);
        }
    }, [selectedClipIds, selectedClipId]);

    // Keep selectedTrackId consistent with selectedTrackIds when multi-select changes.
    useEffect(() => {
        if (selectedTrackIds.length === 0) return;
        if (!selectedTrackIds.includes(selectedTrackId)) {
            setSelectedTrackId(selectedTrackIds[selectedTrackIds.length - 1]);
        }
    }, [selectedTrackIds, selectedTrackId]);

    // Event-driven audio failover: when backend reports stream errors
    // (device unplugged / backend failure), auto-switch to pinned fallback.
    useEffect(() => {
        let unlisten: (() => void) | undefined;

        const setup = async () => {
            unlisten = await listen<{ error?: string }>('audio_stream_error', async (event) => {
                const now = Date.now();
                if (recoveringAudioRef.current) return;
                if (now - lastAudioRecoverAtRef.current < 3000) return;

                recoveringAudioRef.current = true;
                lastAudioRecoverAtRef.current = now;

                try {
                    const settings = await engineApi.getSettings();
                    const fallback = settings.fallbackOutputDevice || 'Default Output';
                    const resolved = await engineApi.restartAudioEngine(fallback);

                    if (settings.outputDevice !== resolved) {
                        await engineApi.updateSettings({
                            ...settings,
                            outputDevice: resolved,
                        });
                    }

                    console.warn('[DawShell] Audio stream recovered via fallback:', {
                        streamError: event.payload?.error,
                        requestedFallback: fallback,
                        resolved,
                    });
                } catch (err) {
                    console.error('[DawShell] Audio fallback recovery failed:', err);
                } finally {
                    recoveringAudioRef.current = false;
                }
            });
        };

        void setup();
        return () => {
            if (unlisten) unlisten();
        };
    }, []);
    const beginBrowserResize = useCallback((e: React.MouseEvent<HTMLDivElement>) => {
        e.preventDefault();
        const splitRoot = mainSplitRef.current;
        if (!splitRoot) return;
        const rootRect = splitRoot.getBoundingClientRect();
        let rafId: number | null = null;
        let pendingWidth: number | null = null;

        const flushWidth = () => {
            rafId = null;
            if (pendingWidth === null) return;
            const nextWidth = pendingWidth;
            setBrowserWidth((prev) => {
                if (prev === nextWidth) return prev;
                return nextWidth;
            });
        };

        const onMove = (me: MouseEvent) => {
            const nextWidth = Math.max(240, Math.min(520, Math.round(me.clientX - rootRect.left)));
            pendingWidth = nextWidth;
            if (rafId === null) {
                rafId = window.requestAnimationFrame(flushWidth);
            }
        };
        const onUp = () => {
            if (rafId !== null) {
                window.cancelAnimationFrame(rafId);
                rafId = null;
            }
            flushWidth();
            window.removeEventListener('mousemove', onMove);
            window.removeEventListener('mouseup', onUp);
        };
        window.addEventListener('mousemove', onMove);
        window.addEventListener('mouseup', onUp);
    }, []);

    const beginBottomPanelResize = useCallback((e: React.MouseEvent<HTMLDivElement>) => {
        e.preventDefault();
        const minHeight = DEFAULT_BOTTOM_PANEL_HEIGHT;
        const maxHeight = Math.round(window.innerHeight * 0.72);

        let rafId: number | null = null;
        let pendingHeight: number | null = null;

        const flushHeight = () => {
            rafId = null;
            if (pendingHeight == null) return;
            const nextHeight = pendingHeight;
            setBottomPanelHeightPx((prev) => (prev === nextHeight ? prev : nextHeight));
        };

        const onMove = (me: MouseEvent) => {
            const nextHeight = Math.max(minHeight, Math.min(maxHeight, window.innerHeight - me.clientY));
            pendingHeight = nextHeight;
            if (rafId == null) {
                rafId = window.requestAnimationFrame(flushHeight);
            }
        };

        const onUp = () => {
            if (rafId != null) {
                window.cancelAnimationFrame(rafId);
                rafId = null;
            }
            flushHeight();
            window.removeEventListener('mousemove', onMove);
            window.removeEventListener('mouseup', onUp);
        };

        window.addEventListener('mousemove', onMove);
        window.addEventListener('mouseup', onUp);
    }, [DEFAULT_BOTTOM_PANEL_HEIGHT]);

    // Safety-net bootstrap: if splash transition missed telemetry startup,
    // mount of workspace guarantees playhead + meters start updating.
    useEffect(() => {
        startTelemetryLoop();
    }, [startTelemetryLoop]);

    // Force one layout sync pass right after workspace mount to avoid stale
    // cached sizes from splash geometry on first frame.
    useEffect(() => {
        const id = requestAnimationFrame(() => {
            window.dispatchEvent(new Event('resize'));
        });
        return () => cancelAnimationFrame(id);
    }, []);

    // ── Engine state for Timeline ───────────────────────────────────
    const transportBpm = useEngineStore(s => s.transport.bpm);
    const transportIsPlaying = useEngineStore(s => s.transport.is_playing);
    const transportPositionBeats = useEngineStore(s => s.transport.position_beats);
    const transportLoopStart = useEngineStore(s => s.transport.loop_start);
    const transportLoopEnd = useEngineStore(s => s.transport.loop_end);
    const transportLoopEnabled = useEngineStore(s => s.transport.loop_enabled);
    const projectBpm = useEngineStore(s => s.projectBpm);
    const projectSampleRateFromStore = useEngineStore(s => s.projectSampleRate);
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

    const scheduleProjectRefresh = useCallback((reason: string) => {
        if (!transportIsPlaying) {
            void fetchProject(reason);
            return;
        }
        if (projectRefreshTimerRef.current !== null) {
            window.clearTimeout(projectRefreshTimerRef.current);
        }
        projectRefreshTimerRef.current = window.setTimeout(() => {
            projectRefreshTimerRef.current = null;
            void fetchProject(reason);
        }, 240);
    }, [transportIsPlaying, fetchProject]);

    useEffect(() => () => {
        if (projectRefreshTimerRef.current !== null) {
            window.clearTimeout(projectRefreshTimerRef.current);
            projectRefreshTimerRef.current = null;
        }
    }, []);

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
        window.__dreamSelectedTrackId = selectedTrackId;
        return () => {
            if (window.__dreamSelectedTrackId === selectedTrackId) {
                delete window.__dreamSelectedTrackId;
            }
        };
    }, [selectedTrackId]);

    const panelInfo = useMemo(() => {
        const selected = selectedTrackId === 'master'
            ? null
            : (projectTracks.find((t) => t.id === selectedTrackId) ?? null);
        const name = selectedTrackId === 'master'
            ? 'Master'
            : (selected?.name || 'No Track');
        const deviceCount = selected
            ? ((selected.instrument ? 1 : 0) + (selected.effects?.length ?? 0))
            : 0;
        return `${name} · ${deviceCount} devices`;
    }, [projectTracks, selectedTrackId]);

    // Use position_beats directly from engine (single-source, no float round-trip)
    const playheadBeat = transportPositionBeats ?? 0;

    const trackCount = Math.max(projectTracks.length, 1);
    const trackIds = useMemo(() => projectTracks.map((t) => t.id), [projectTracks]);
    const selectedTrackIndex = useMemo(() => {
        if (!selectedTrackId || selectedTrackId === 'master') return -1;
        return projectTracks.findIndex((t) => t.id === selectedTrackId);
    }, [projectTracks, selectedTrackId]);
    const selectedTrackIndices = useMemo(() => {
        const byId = new Map(projectTracks.map((t, i) => [t.id, i] as const));
        const out: number[] = [];
        for (const id of selectedTrackIds) {
            const idx = byId.get(id);
            if (typeof idx === 'number' && idx >= 0) out.push(idx);
        }
        return out;
    }, [projectTracks, selectedTrackIds]);
    const selectedTimelineClip = useMemo(
        () => timelineClipsForView.find((c) => c.id === selectedClipId) ?? null,
        [timelineClipsForView, selectedClipId],
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

    useEffect(() => {
        if (missingMediaSummary.total > 0) {
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
        const beatsPerBar = 4;
        const sampleRate = projectSampleRate;
        const beatsPerSecond = bpm / 60;

        setAiVariationBusy(true);
        try {
            const variedNotes = await engineApi.generateMidiVariation({
                bpm,
                beatsPerBar,
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
            });

            const normalizedForUi: MidiNote[] = variedNotes.map((n, idx) => ({
                id: `ai_${Date.now()}_${idx}`,
                pitch: n.pitch,
                velocity: n.velocity,
                startBeat: n.startBeat,
                durationBeats: n.durationBeats,
            }));

            setMidiNotesByClip((prev) => ({ ...prev, [clip.id]: normalizedForUi }));
            await engineApi.updateMidiClip(
                clip.id,
                normalizedForUi.map((n) => ({
                    pitch: n.pitch,
                    velocity: n.velocity,
                    startFrames: Math.max(0, Math.round((n.startBeat / beatsPerSecond) * sampleRate)),
                    durationFrames: Math.max(1, Math.round((n.durationBeats / beatsPerSecond) * sampleRate)),
                })),
            );
            await fetchProject();
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
        fetchProject,
    ]);

    const serializeMidiNotesToFrames = useCallback((notes: MidiNote[]) => {
        const bpm = projectBpm || transportBpm || 120;
        const sr = projectSampleRate;
        const beatsPerSecond = bpm / 60;
        return notes.map((n) => ({
            pitch: n.pitch,
            velocity: n.velocity,
            startFrames: Math.max(0, Math.round((n.startBeat / beatsPerSecond) * sr)),
            durationFrames: Math.max(1, Math.round((n.durationBeats / beatsPerSecond) * sr)),
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
        setMidiNotesByClip(incoming);
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
        return () => {
            midiSaveThrottlesRef.current.forEach((send) => send.cancel());
            midiEnvelopeSaveThrottlesRef.current.forEach((send) => send.cancel());
            midiSaveThrottlesRef.current.clear();
            midiEnvelopeSaveThrottlesRef.current.clear();
            dirtyMidiNotesClipIdsRef.current.clear();
            dirtyMidiEnvelopeClipIdsRef.current.clear();
        };
    }, []);

    // ── Final unthrottled sends on pointer release ──
    useEffect(() => {
        const onPointerUp = () => {
            void flushTrackControlFinals();
            flushMidiThrottles();
            const clip = selectedTimelineClip;
            if (!clip || clip.type !== 'midi') return;
            if (dirtyMidiNotesClipIdsRef.current.has(clip.id)) {
                const notes = latestMidiNotesRef.current[clip.id] ?? [];
                void engineApi
                    .updateMidiClip(clip.id, serializeMidiNotesToFrames(notes), { pushUndoStep: true })
                    .then(() => {
                        dirtyMidiNotesClipIdsRef.current.delete(clip.id);
                    })
                    .catch((err) => console.error('[DawShell] updateMidiClip final flush failed:', err));
            }

            if (dirtyMidiEnvelopeClipIdsRef.current.has(clip.id)) {
                const envelopes = latestMidiEnvelopesRef.current[clip.id] ?? [];
                void engineApi
                    .setMidiClipEnvelopes(clip.id, envelopes, { pushUndoStep: true })
                    .then(() => {
                        dirtyMidiEnvelopeClipIdsRef.current.delete(clip.id);
                    })
                    .catch((err) => console.error('[DawShell] setMidiClipEnvelopes final flush failed:', err));
            }
        };
        window.addEventListener('pointerup', onPointerUp);
        return () => window.removeEventListener('pointerup', onPointerUp);
    }, [flushTrackControlFinals, flushMidiThrottles, selectedTimelineClip, serializeMidiNotesToFrames]);

    // ── Scroll sync between Timeline and TrackInspector ─────────────
    const [timelineScrollTop, setTimelineScrollTop] = useState(0);
    const handleTimelineScrollTop = useCallback((st: number) => {
        setTimelineScrollTop(st);
    }, []);

    // ── Track Height ────────────────────────────────────────────────
    const TRACK_HEIGHT_DEFAULT = 48;
    const TRACK_HEIGHT_MIN = 24;
    const TRACK_HEIGHT_MAX = 120;
    const TRACK_HEIGHT_STEP = 1;
    const TRACK_HEIGHT_BASE = TRACK_HEIGHT_DEFAULT;
    const RULER_HEIGHT = 28;
    const clampTrackHeight = useCallback((h: number) => {
        const snapped = Math.round(h / TRACK_HEIGHT_STEP) * TRACK_HEIGHT_STEP;
        return Math.max(TRACK_HEIGHT_MIN, Math.min(TRACK_HEIGHT_MAX, snapped));
    }, [TRACK_HEIGHT_MIN, TRACK_HEIGHT_MAX, TRACK_HEIGHT_STEP]);

    const resolveHeightTargetTrackIds = useCallback((target: EventTarget | null, clientY?: number) => {
        const element = target instanceof Element ? target : null;

        const inspectorRow = element?.closest?.('[data-track-row="true"][data-track-id]') as HTMLElement | null;
        const inspectorTrackId = inspectorRow?.getAttribute('data-track-id');
        if (inspectorTrackId && inspectorTrackId !== 'master') {
            return [inspectorTrackId];
        }

        const timelineRoot = element?.closest?.('[data-testid="timeline-view"]') as HTMLElement | null;
        if (timelineRoot && Number.isFinite(clientY)) {
            const rect = timelineRoot.getBoundingClientRect();
            const yInViewport = (clientY as number) - rect.top;
            const yInTracks = yInViewport - RULER_HEIGHT + timelineScrollTop;
            if (yInTracks >= 0) {
                let acc = 0;
                for (const track of projectTracksSnapshot) {
                    if (!track?.id || track.id === 'master') continue;
                    const h = clampTrackHeight(typeof track.height === 'number' ? track.height : TRACK_HEIGHT_DEFAULT);
                    const nextAcc = acc + h;
                    if (yInTracks < nextAcc) return [track.id];
                    acc = nextAcc;
                }
            }
        }

        const selected = selectedTrackIds.filter((id) => id && id !== 'master');
        if (selected.length > 0) return [selected[selected.length - 1]];
        if (selectedTrackId && selectedTrackId !== 'master') return [selectedTrackId];
        return [];
    }, [
        RULER_HEIGHT,
        timelineScrollTop,
        projectTracksSnapshot,
        clampTrackHeight,
        TRACK_HEIGHT_DEFAULT,
        selectedTrackIds,
        selectedTrackId,
    ]);

    const applyTrackHeightsOptimistic = useCallback((trackIds: string[], height: number) => {
        if (trackIds.length === 0) return;
        const idSet = new Set(trackIds);
        useEngineStore.setState((state) => ({
            projectTracks: state.projectTracks.map((track) => (
                idSet.has(track.id) ? { ...track, height } : track
            )),
        }));
    }, []);

    // Option(Alt)+Wheel: adjust selected track height.
    // Option(Alt)+0: reset selected track height.
    useEffect(() => {
        const WHEEL_STEP_THRESHOLD = 40;
        let wheelAccumulator = 0;
        let wheelRafId = 0;
        let lastWheelEventTarget: EventTarget | null = null;
        let lastWheelClientY = 0;

        const flushWheelZoom = () => {
            wheelRafId = 0;
            const steps = Math.floor(Math.abs(wheelAccumulator) / WHEEL_STEP_THRESHOLD);
            if (steps <= 0) return;

            const direction = wheelAccumulator < 0 ? 1 : -1;
            wheelAccumulator -= Math.sign(wheelAccumulator) * steps * WHEEL_STEP_THRESHOLD;

            const trackIds = resolveHeightTargetTrackIds(lastWheelEventTarget, lastWheelClientY);
            if (trackIds.length === 0) return;
            const current = projectTracksSnapshot.find((t) => t.id === trackIds[0]);
            const currentHeight = clampTrackHeight(
                typeof current?.height === 'number' ? current.height : TRACK_HEIGHT_DEFAULT,
            );
            const nextHeight = clampTrackHeight(currentHeight + direction * TRACK_HEIGHT_STEP * steps);
            if (nextHeight === currentHeight) return;

            applyTrackHeightsOptimistic(trackIds, nextHeight);
            void Promise.all(trackIds.map((id) => engineApi.setTrackHeight(id, nextHeight))).catch((err) => {
                console.warn('[DawShell] setTrackHeight failed:', err);
            });
        };

        const onWheel = (e: WheelEvent) => {
            if (!e.altKey) return;
            const target = e.target as HTMLElement | null;
            const inTimeline = !!target?.closest?.('[data-testid="timeline-view"]');
            const inInspector = !!target?.closest?.('[data-testid="track-inspector"]');
            if (!inTimeline && !inInspector) return;
            e.preventDefault();
            e.stopPropagation();

            lastWheelEventTarget = e.target;
            lastWheelClientY = e.clientY;

            wheelAccumulator += e.deltaY;
            if (!wheelRafId) {
                wheelRafId = window.requestAnimationFrame(flushWheelZoom);
            }
        };

        const onKeyDown = (e: KeyboardEvent) => {
            if (!e.altKey) return;
            if (e.key !== '0') return;
            const target = e.target as HTMLElement | null;
            const tag = target?.tagName?.toLowerCase();
            const isTextInput =
                tag === 'input' || tag === 'textarea' || target?.isContentEditable;
            if (isTextInput) return;
            e.preventDefault();
            const trackIds = resolveHeightTargetTrackIds(e.target);
            if (trackIds.length === 0) return;
            const nextHeight = clampTrackHeight(TRACK_HEIGHT_DEFAULT);
            applyTrackHeightsOptimistic(trackIds, nextHeight);
            void Promise.all(trackIds.map((id) => engineApi.setTrackHeight(id, nextHeight))).catch((err) => {
                console.warn('[DawShell] setTrackHeight reset failed:', err);
            });
        };

        window.addEventListener('wheel', onWheel, { passive: false, capture: true });
        window.addEventListener('keydown', onKeyDown, { capture: true });
        return () => {
            window.removeEventListener('wheel', onWheel, { capture: true } as EventListenerOptions);
            window.removeEventListener('keydown', onKeyDown, { capture: true } as EventListenerOptions);
            if (wheelRafId) {
                window.cancelAnimationFrame(wheelRafId);
            }
        };
    }, [
        TRACK_HEIGHT_DEFAULT,
        TRACK_HEIGHT_STEP,
        clampTrackHeight,
        resolveHeightTargetTrackIds,
        applyTrackHeightsOptimistic,
        projectTracksSnapshot,
    ]);

    // Keep timeline hit-test geometry identical to TrackInspector rows.
    const timelineTrackHeights = useMemo(() => {
        const clamp = (h: number) => Math.max(TRACK_HEIGHT_MIN, Math.min(TRACK_HEIGHT_MAX, Math.round(h)));
        return projectTracksSnapshot.map((t) => {
            const persisted = Number.isFinite(t.height) ? t.height : TRACK_HEIGHT_BASE;
            return clamp(persisted);
        });
    }, [projectTracksSnapshot, TRACK_HEIGHT_BASE, TRACK_HEIGHT_MIN, TRACK_HEIGHT_MAX]);

    const handleFitTimelineHorizontally = useCallback(() => {
        setFitTimelineToken((v) => v + 1);
    }, []);

    const handleResetTrackHeights = useCallback(() => {
        const trackIds = projectTracksSnapshot
            .map((t) => t.id)
            .filter((id) => id && id !== 'master');
        if (trackIds.length === 0) return;
        const nextHeight = clampTrackHeight(TRACK_HEIGHT_DEFAULT);
        applyTrackHeightsOptimistic(trackIds, nextHeight);
        void Promise.all(trackIds.map((id) => engineApi.setTrackHeight(id, nextHeight))).catch((err) => {
            console.warn('[DawShell] reset track heights failed:', err);
        });
    }, [TRACK_HEIGHT_DEFAULT, clampTrackHeight, applyTrackHeightsOptimistic, projectTracksSnapshot]);

    // Seek callback: Timeline ruler click → seek in engine (beat-precision)
    const handlePlayheadChange = useCallback((beat: number) => {
        engineApi.seekToBeat(Math.max(0, beat));
    }, []);

    const handleEditCursorChange = useCallback((beat: number, trackIndex: number) => {
        const clampedBeat = Math.max(0, beat);
        setEditCursorBeat(clampedBeat);
        setEditCursorTrackIndex(Math.max(0, trackIndex));
        // Mutual exclusivity: edit cursor ⇒ deselect clips.
        setSelectedClipId(null);
        setSelectedClipIds([]);
        // Queue the position — playhead jumps here when transport starts.
        queuedStartBeatRef.current = clampedBeat;
    }, []);

    const handleMarqueeSelectionStart = useCallback(() => {
        // Selection-box mode is mutually exclusive with cursor and clip selection.
        setEditCursorBeat(-1);
        setSelectedClipId(null);
        setSelectedClipIds([]);
        setMarqueeSelection(null);
    }, []);

    // Resolve playback start anchor on actual transport start.
    // Priority: selected clip(s) -> queued anchor -> edit cursor.
    const prevIsPlayingRef = useRef(false);
    useEffect(() => {
        const justStarted = transportIsPlaying && !prevIsPlayingRef.current;
        prevIsPlayingRef.current = transportIsPlaying;
        if (!justStarted) return;

        let startBeat: number | null = null;
        if (selectedClipIds.length > 0) {
            const selectedSet = new Set(selectedClipIds);
            let minBeat = Infinity;
            for (const clip of timelineClipsForView) {
                if (selectedSet.has(clip.id) && clip.startBeat < minBeat) {
                    minBeat = clip.startBeat;
                }
            }
            if (Number.isFinite(minBeat)) startBeat = minBeat;
        }

        if (startBeat === null && queuedStartBeatRef.current !== null) {
            startBeat = queuedStartBeatRef.current;
        }

        if (startBeat === null && editCursorBeat >= 0) {
            startBeat = editCursorBeat;
        }

        queuedStartBeatRef.current = null;
        if (startBeat === null) return;

        void engineApi.seekToBeat(Math.max(0, startBeat)).catch((err) => {
            console.error('[DawShell] seek to playback anchor failed:', err);
        });
    }, [transportIsPlaying, selectedClipIds, timelineClipsForView, editCursorBeat]);

    // Clip selection callback
    const handleClipSelect = useCallback((clipId: string) => {
        setSelectedClipId(clipId);
        setSelectedClipIds([clipId]);
        // Mutual exclusivity: clip selection ⇒ hide edit cursor.
        setEditCursorBeat(-1);
        // Queue playhead to clip start — next Space starts from here.
        const clip = timelineClipsForView.find(c => c.id === clipId);
        if (clip) {
            queuedStartBeatRef.current = clip.startBeat;
        }
    }, [timelineClipsForView]);

    // Drop from AssetBrowser → Timeline
    const {
        dropBrowserItemOnTimeline,
        dropPluginOnTrack,
    } = useBrowserDnDOrchestrator({
        projectTracks,
        projectBpm,
        transportBpm: transportBpm || 120,
        projectSampleRate: projectSampleRateFromStore || 44100,
        importFile,
        fetchProject,
    });

    const handleBrowserDrop = useCallback((item: BrowserDragItem, trackIndex: number, beat: number) => {
        console.log('[DawShell] handleBrowserDrop', { item, trackIndex, beat });
        void dropBrowserItemOnTimeline(item, trackIndex, beat)
            .catch((err) => console.error('[DawShell] browser drop failed:', err));
    }, [dropBrowserItemOnTimeline]);

    // Double-click on track lane → create 1-bar MIDI clip
    const handleDoubleClickTrack = useCallback((trackIndex: number, beat: number) => {
        console.log('[DawShell] handleDoubleClickTrack', { trackIndex, beat });
        const bpm = projectBpm || transportBpm || 120;
        const sr = projectSampleRate;
        const beatsPerBar = 4; // 4/4 time signature
        const posSeconds = beat / (bpm / 60);
        const barSeconds = beatsPerBar / (bpm / 60);
        const positionFrames = Math.round(posSeconds * sr);
        const durationFrames = Math.round(barSeconds * sr);
        createMidiClip(trackIndex, positionFrames, durationFrames);
    }, [createMidiClip, projectBpm, transportBpm, projectSampleRate]);

    // Clip drag → move clip to new position in engine (syncs audio with visual)
    const handleClipMove = useCallback((clipId: string, newStartBeat: number, newTrackIndex: number) => {
        const bpm = projectBpm || transportBpm || 120;
        const sr = projectSampleRate;
        const beatsPerSecond = bpm / 60;

        const dragged = timelineClipsForView.find((c) => c.id === clipId);
        if (!dragged) return;

        const selectedSet = new Set(selectedClipIds);
        const moveAsGroup = selectedSet.size > 1 && selectedSet.has(clipId);

        const moveOne = async (id: string, targetBeat: number, targetTrack: number) => {
            const posSeconds = Math.max(0, targetBeat) / beatsPerSecond;
            const positionFrames = Math.round(posSeconds * sr);
            await engineApi.moveClip(id, targetTrack, positionFrames);
        };

        const run = async () => {
            if (!moveAsGroup) {
                await moveOne(clipId, newStartBeat, newTrackIndex);
                return;
            }

            const deltaBeat = newStartBeat - dragged.startBeat;
            const deltaTrack = newTrackIndex - dragged.trackIndex;

            const selectedClips = timelineClipsForView.filter((c) => selectedSet.has(c.id));
            await Promise.all(
                selectedClips.map((clip) => {
                    const targetBeat = Math.max(0, clip.startBeat + deltaBeat);
                    const targetTrack = Math.max(0, Math.min(trackCount - 1, clip.trackIndex + deltaTrack));
                    return moveOne(clip.id, targetBeat, targetTrack);
                }),
            );
        };

        run()
            .then(() => {
                console.log('[DawShell] Clip move applied', {
                    clipId,
                    newTrackIndex,
                    newStartBeat,
                    mode: moveAsGroup ? 'group' : 'single',
                });
                scheduleProjectRefresh('clip-move');
            })
            .catch(err => console.error('[DawShell] moveClip failed:', err));
    }, [projectBpm, transportBpm, projectSampleRate, scheduleProjectRefresh, timelineClipsForView, selectedClipIds, trackCount]);

    // Clip resize → update position and duration in engine
    const handleClipResize = useCallback((clipId: string, newStartBeat: number, newDurationBeats: number) => {
        const bpm = projectBpm || transportBpm || 120;
        const sr = projectSampleRate;
        const posSeconds = newStartBeat / (bpm / 60);
        const durSeconds = newDurationBeats / (bpm / 60);
        const newPositionFrames = Math.round(posSeconds * sr);
        const newDurationFrames = Math.max(128, Math.round(durSeconds * sr));

        engineApi.resizeClip(clipId, newPositionFrames, newDurationFrames)
            .then(() => {
                console.log('[DawShell] Clip resized', { clipId, newStartBeat, newDurationBeats });
                scheduleProjectRefresh('clip-resize');
            })
            .catch(err => console.error('[DawShell] resizeClip failed:', err));
    }, [projectBpm, transportBpm, projectSampleRate, scheduleProjectRefresh]);

    const handleClipFades = useCallback((clipId: string, fadeInFrames: number, fadeOutFrames: number) => {
        engineApi.setClipFades(
            clipId,
            Math.max(0, Math.round(fadeInFrames)),
            Math.max(0, Math.round(fadeOutFrames)),
        )
            .then(() => {
                scheduleProjectRefresh('clip-fades');
            })
            .catch((err) => console.error('[DawShell] setClipFades failed:', err));
    }, [scheduleProjectRefresh]);

    const handleOpenMidiClip = useCallback((clipId: string) => {
        setSelectedClipId(clipId);
        setBottomPanelMode('clip');
    }, []);

    const flushPendingMidiEdits = useCallback(async () => {
        flushMidiThrottles();
        const noteClipIds = Array.from(dirtyMidiNotesClipIdsRef.current);
        const envelopeClipIds = Array.from(dirtyMidiEnvelopeClipIdsRef.current);
        const noteTasks = noteClipIds.map((clipId) =>
            engineApi
                .updateMidiClip(clipId, serializeMidiNotesToFrames(latestMidiNotesRef.current[clipId] ?? []), {
                    pushUndoStep: true,
                })
                .then(() => ({ ok: true as const, clipId }))
                .catch((err) => {
                    console.error('[DawShell] flushPendingMidiEdits updateMidiClip failed:', err);
                    return { ok: false as const, clipId };
                })
        );
        const envelopeTasks = envelopeClipIds.map((clipId) =>
            engineApi
                .setMidiClipEnvelopes(clipId, latestMidiEnvelopesRef.current[clipId] ?? [], { pushUndoStep: true })
                .then(() => ({ ok: true as const, clipId }))
                .catch((err) => {
                    console.error('[DawShell] flushPendingMidiEdits setMidiClipEnvelopes failed:', err);
                    return { ok: false as const, clipId };
                })
        );

        const [noteResults, envelopeResults] = await Promise.all([
            Promise.all(noteTasks),
            Promise.all(envelopeTasks),
        ]);
        for (const r of noteResults) {
            if (r.ok) dirtyMidiNotesClipIdsRef.current.delete(r.clipId);
        }
        for (const r of envelopeResults) {
            if (r.ok) dirtyMidiEnvelopeClipIdsRef.current.delete(r.clipId);
        }
    }, [flushMidiThrottles, serializeMidiNotesToFrames]);

    useEffect(() => {
        window.__dreamFlushPendingEdits = async () => {
            await flushTrackControlFinals();
            await flushPendingMidiEdits();
        };
        return () => {
            delete window.__dreamFlushPendingEdits;
        };
    }, [flushTrackControlFinals, flushPendingMidiEdits]);

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
                            onOpenExport={() => setExportOpen(true)}
                            onRecordingStateChange={(state) => setRecordingState(state)}
                            followPlayhead={followPlayhead}
                            onFollowPlayheadChange={setFollowPlayhead}
                            automationVisible={automationVisible}
                            onAutomationToggle={toggleAutomation}
                            onFitTimelineHorizontally={handleFitTimelineHorizontally}
                            onResetTrackHeights={handleResetTrackHeights}
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
                                        playheadBeat={playheadBeat}
                                        editCursorBeat={editCursorBeat}
                                        editCursorTrackIndex={editCursorTrackIndex}
                                        selectedTrackIndex={selectedTrackIndex}
                                        selectedTrackIndices={selectedTrackIndices}
                                        isPlaying={transportIsPlaying}
                                        recordingActive={recordingState.active}
                                        recordingTrackIndex={recordingState.trackIndex}
                                        trackIds={trackIds}
                                        loopStart={(transportLoopStart / projectSampleRate) * ((projectBpm || transportBpm || 120) / 60)}
                                        loopEnd={(transportLoopEnd / projectSampleRate) * ((projectBpm || transportBpm || 120) / 60)}
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
                                        onClipSelectionChange={(ids) => {
                                            setSelectedClipIds(ids);
                                            setSelectedClipId(ids[ids.length - 1] ?? null);
                                            // Mutual exclusivity: clip selection ⇒ hide edit cursor.
                                            if (ids.length > 0) setEditCursorBeat(-1);
                                            // Queue playhead to leftmost selected clip.
                                            if (ids.length > 0) {
                                                let minBeat = Infinity;
                                                for (const c of timelineClipsForView) {
                                                    if (ids.includes(c.id) && c.startBeat < minBeat) minBeat = c.startBeat;
                                                }
                                                if (Number.isFinite(minBeat)) queuedStartBeatRef.current = minBeat;
                                            }
                                        }}
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
                                        onTrackSelect={(trackId, trackIndex) => {
                                            const resolvedTrackId = trackIds[trackIndex] ?? trackId;
                                            handleSelectTrack(resolvedTrackId);
                                        }}
                                        onScrollTop={handleTimelineScrollTop}
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
                                            rulerHeight={RULER_HEIGHT}
                                            scrollTop={timelineScrollTop}
                                            mixerFocusMode={false}
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
                                        key={[
                                            selectedTimelineClip.id,
                                            Math.max(0, Math.round(selectedTimelineClip.fadeIn ?? 0)),
                                            Math.max(0, Math.round(selectedTimelineClip.fadeOut ?? 0)),
                                            selectedTimelineClip.fadeInCurve ?? 0.5,
                                            selectedTimelineClip.fadeOutCurve ?? 0.5,
                                        ].join(':')}
                                        notes={midiNotesByClip[selectedTimelineClip.id] ?? []}
                                        ghostNotes={[]}
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
                                                        .updateMidiClip(
                                                            clipId,
                                                            serializeMidiNotesToFrames(toSend),
                                                            { pushUndoStep: false },
                                                        )
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
                                        playheadBeat={playheadBeat}
                                        totalBars={selectedMidiTotalBars}
                                        clipLengthBeats={selectedTimelineClip.durationBeats}
                                    />
                                </Suspense>
                            ) : selectedTimelineClip?.type === 'audio' ? (
                                <SampleClipEditor
                                    key={[
                                        selectedTimelineClip.id,
                                        selectedTimelineClip.isWarped ? 'warp-on' : 'warp-off',
                                        selectedTimelineClip.warpMode ?? 0,
                                        selectedTimelineClip.warpBaseBpm ?? 120,
                                        selectedTimelineClip.sourceOffset ?? 0,
                                        selectedTimelineClip.fadeIn ?? 0,
                                        selectedTimelineClip.fadeOut ?? 0,
                                        selectedTimelineClip.fadeInCurve ?? 0.5,
                                        selectedTimelineClip.fadeOutCurve ?? 0.5,
                                    ].join(':')}
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
                            borderTop: '1px solid color-mix(in srgb, #ff6b6b 55%, transparent)',
                            borderBottom: '1px solid color-mix(in srgb, #ff6b6b 35%, transparent)',
                            background: 'linear-gradient(90deg, color-mix(in srgb, #ff5f5f 18%, var(--color-bg-panel)) 0%, color-mix(in srgb, #ff5f5f 8%, var(--color-bg-panel)) 100%)',
                            minHeight: 24,
                            display: 'flex',
                            alignItems: 'center',
                            justifyContent: 'space-between',
                            padding: '3px 10px',
                            gap: 10,
                        }}
                    >
                        <span style={{ fontSize: 11, fontWeight: 700, color: '#ffb3b3', letterSpacing: '0.02em' }}>
                            Missing media detected: {missingMediaSummary.offlineClipCount} files, {missingMediaSummary.missingPluginCount} plugins
                        </span>
                        <div style={{ display: 'flex', gap: 6 }}>
                            <button
                                onClick={() => setMissingAssetsOpen((v) => !v)}
                                style={{
                                    border: '1px solid color-mix(in srgb, #ff9b9b 45%, transparent)',
                                    background: 'color-mix(in srgb, #ff6b6b 20%, transparent)',
                                    color: '#ffd5d5',
                                    borderRadius: 6,
                                    fontSize: 10,
                                    fontWeight: 700,
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
                        onPanelModeChange={setBottomPanelMode}
                        panelInfo={panelInfo}
                    />
                </div>

            </div>

            {/* ═══ SETTINGS MODAL ═══ */}
            <Suspense fallback={null}>
                <SettingsPanel isOpen={settingsOpen} onClose={() => setSettingsOpen(false)} />
            </Suspense>

            <Suspense fallback={null}>
                <MissingAssetsPanel isOpen={missingAssetsOpen && missingMediaSummary.total > 0} onClose={() => setMissingAssetsOpen(false)} />
            </Suspense>

            {/* ═══ DRAG-OVER OVERLAY ═══ */}
            {isDragOver && (
                <div
                    className="absolute inset-0 z-[999] flex items-center justify-center pointer-events-none"
                    style={{
                        background: 'color-mix(in srgb, var(--color-accent-primary) 12%, transparent)',
                        border: '3px dashed color-mix(in srgb, var(--color-accent-primary) 60%, transparent)',
                        borderRadius: '12px',
                        margin: '8px',
                    }}
                >
                    <div style={{
                        background: 'color-mix(in srgb, var(--color-bg-elevated) 88%, transparent)',
                        color: 'var(--color-text-primary)',
                        padding: '12px 24px',
                        borderRadius: '8px',
                        fontSize: '14px',
                        fontWeight: 600,
                        backdropFilter: 'blur(8px)',
                    }}>
                        🎵 Drop audio file to import
                    </div>
                </div>
            )}
            {/* ── Export Modal ── */}
            <Suspense fallback={null}>
                <ExportModal
                    isOpen={exportOpen}
                    onClose={() => setExportOpen(false)}
                    projectName="My Project"
                />
            </Suspense>

            <Suspense fallback={null}>
                <BlockingJobPopup />
            </Suspense>

            <DragOverlay />

        </div>
    );
};

const SessionWorkspace = ({
    tracks,
    selectedTrackId,
    onSelectTrack,
}: {
    tracks: ProjectTrack[];
    selectedTrackId: string;
    onSelectTrack: (trackId: string) => void;
}) => {
    const meters = useEngineStore((s) => s.meters);
    const setTrackMute = useEngineStore((s) => s.setTrackMute);
    const setTrackSolo = useEngineStore((s) => s.setTrackSolo);
    const togglePlay = useEngineStore((s) => s.togglePlay);
    const isPlaying = useEngineStore((s) => s.transport.is_playing);
    const SESSION_TRACK_WIDTH = 116;
    const SESSION_MASTER_WIDTH = 104;
    const SESSION_SCENE_ROWS = 3;
    const scenes = useMemo(() => Array.from({ length: SESSION_SCENE_ROWS }, (_, i) => i), []);
    const [sessionClips, setSessionClips] = useState<Record<string, { id: string; name: string; color: string; looped: boolean }>>({});
    const [selectedSessionClipId, setSelectedSessionClipId] = useState<string | null>(null);
    const [playingSessionClipId, setPlayingSessionClipId] = useState<string | null>(null);

    const masterMeter = meters.master_left;
    const masterLevel = Math.max(0, Math.min(1, ((masterMeter?.peak ?? -60) + 60) / 60));

    return (
        <div style={{
            flex: 1,
            display: 'grid',
            gridTemplateRows: '1fr 170px',
            minWidth: 0,
            minHeight: 0,
            background: 'var(--color-bg-canvas)',
            borderLeft: '1px solid var(--color-divider)',
        }}>
            <div style={{ display: 'grid', gridTemplateColumns: `1fr ${SESSION_MASTER_WIDTH}px`, minHeight: 0, overflow: 'hidden' }}>
                <div style={{ overflow: 'auto', minHeight: 0 }}>
                    <div style={{ display: 'flex', minWidth: 'max-content', minHeight: '100%' }}>
                        {tracks.map((track) => {
                            const slotKey = (sceneIndex: number) => `${track.id}:${sceneIndex}`;
                            const contrast = getContrastColor(track.color) === 'black' ? '#151515' : '#f4f6f8';
                            const isSelectedTrack = selectedTrackId === track.id;
                            return (
                                <div key={track.id} style={{ width: SESSION_TRACK_WIDTH, borderRight: '1px solid #2b2b2b', display: 'flex', flexDirection: 'column' }}>
                                    <button
                                        onClick={() => onSelectTrack(track.id)}
                                        style={{
                                            height: 28,
                                            border: 'none',
                                            borderBottom: '1px solid var(--color-overlay-medium)',
                                            background: track.color,
                                            color: contrast,
                                            fontSize: 'var(--font-size-sm)',
                                            fontWeight: 700,
                                            textAlign: 'left',
                                            padding: '0 8px',
                                            boxShadow: isSelectedTrack ? 'inset 0 0 0 2px color-mix(in srgb, var(--color-accent-primary) 64%, transparent)' : 'none',
                                            cursor: 'pointer',
                                        }}
                                    >
                                        {track.name}
                                    </button>
                                    {scenes.map((sceneIndex) => {
                                        const clip = sessionClips[slotKey(sceneIndex)] ?? null;
                                        const isSelected = clip ? selectedSessionClipId === clip.id : false;
                                        const clipText = clip ? (getContrastColor(clip.color) === 'black' ? '#1a1a1a' : '#f3f5f8') : 'var(--color-text-tertiary)';
                                        const isPlayingClip = clip ? playingSessionClipId === clip.id && isPlaying : false;
                                        return (
                                            <div
                                                key={`${track.id}:${sceneIndex}`}
                                                onClick={() => onSelectTrack(track.id)}
                                                onDoubleClick={() => {
                                                    if (clip) return;
                                                    const id = `sess_${track.id}_${sceneIndex}_${Date.now()}`;
                                                    setSessionClips((prev) => ({
                                                        ...prev,
                                                        [slotKey(sceneIndex)]: {
                                                            id,
                                                            name: 'MIDI Loop',
                                                            color: track.color,
                                                            looped: true,
                                                        },
                                                    }));
                                                    setSelectedSessionClipId(id);
                                                }}
                                                style={{
                                                    height: 26,
                                                    border: 'none',
                                                    borderBottom: '1px solid #2a2a2a',
                                                    borderRight: '1px solid #262626',
                                                    background: clip
                                                        ? clip.color
                                                        : 'color-mix(in srgb, var(--color-bg-panel) 90%, #131313)',
                                                    color: clipText,
                                                    fontSize: 'var(--font-size-xs)',
                                                    fontWeight: clip ? 600 : 500,
                                                    textAlign: 'left',
                                                    padding: clip ? '0 6px' : '0 8px',
                                                    cursor: 'pointer',
                                                    boxShadow: isSelected ? 'inset 0 0 0 2px color-mix(in srgb, var(--color-accent-primary) 70%, transparent)' : 'none',
                                                    opacity: clip ? 1 : 0.72,
                                                    display: 'flex',
                                                    alignItems: 'center',
                                                    justifyContent: 'space-between',
                                                }}
                                            >
                                                {clip ? (
                                                    <>
                                                        <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', maxWidth: 70 }}>
                                                            {clip.name}
                                                        </span>
                                                        <div style={{ display: 'flex', gap: 4 }}>
                                                            <button
                                                                type="button"
                                                                onClick={(e) => {
                                                                    e.stopPropagation();
                                                                    setSelectedSessionClipId(clip.id);
                                                                    setPlayingSessionClipId(clip.id);
                                                                    if (!isPlaying) togglePlay();
                                                                }}
                                                                style={sessionClipTransportBtnStyle(isPlayingClip)}
                                                                title="Play Clip"
                                                            >
                                                                ▶
                                                            </button>
                                                            <button
                                                                type="button"
                                                                onClick={(e) => {
                                                                    e.stopPropagation();
                                                                    setSelectedSessionClipId(clip.id);
                                                                    setPlayingSessionClipId(null);
                                                                    if (isPlaying) togglePlay();
                                                                }}
                                                                style={sessionClipTransportBtnStyle(false)}
                                                                title="Stop Clip"
                                                            >
                                                                ■
                                                            </button>
                                                        </div>
                                                    </>
                                                ) : null}
                                            </div>
                                        );
                                    })}
                                </div>
                            );
                        })}
                    </div>
                </div>
                <div style={{ width: SESSION_MASTER_WIDTH, borderLeft: '1px solid #3a3a3a', background: 'color-mix(in srgb, var(--color-bg-panel) 80%, #111)' }}>
                    <div style={{
                        height: 28,
                        borderBottom: '1px solid var(--color-overlay-medium)',
                        background: '#f2f2f2',
                        color: '#111111',
                        fontSize: 'var(--font-size-sm)',
                        fontWeight: 800,
                        display: 'flex',
                        alignItems: 'center',
                        padding: '0 8px',
                    }}>
                        Master
                    </div>
                    {scenes.map((_, i) => (
                        <div key={`master-scene-${i}`} style={{ height: 26, borderBottom: '1px solid #2a2a2a' }} />
                    ))}
                </div>
            </div>
            <div style={{ display: 'grid', gridTemplateColumns: `1fr ${SESSION_MASTER_WIDTH}px`, minHeight: 0, overflow: 'hidden', borderTop: '1px solid var(--color-divider)', background: 'color-mix(in srgb, var(--color-bg-panel) 92%, #0e0e0e)' }}>
                <div style={{ display: 'flex', minHeight: 0, overflowX: 'auto' }}>
                    {tracks.map((track, trackIndex) => {
                        const meterPair = meters.tracks[trackIndex];
                        const peakDb = meterPair ? Math.max(meterPair[0].peak, meterPair[1].peak) : -60;
                        const trackMeterLevel = Math.max(0, Math.min(1, (peakDb + 60) / 60));
                        const peakLabel = `${peakDb >= 0 ? '+' : ''}${peakDb.toFixed(1)} dB`;
                        return (
                            <div key={`mix-${track.id}`} style={{ width: SESSION_TRACK_WIDTH, borderRight: '1px solid #2d2d2d', padding: '8px 8px 6px', display: 'grid', gridTemplateRows: 'auto 1fr auto', gap: 6 }}>
                                <div style={{ fontSize: 'var(--font-size-xs)', color: 'var(--color-text-secondary)', fontWeight: 700, textTransform: 'uppercase' }}>
                                    {track.track_type}
                                </div>
                                <div style={{ display: 'flex', alignItems: 'stretch', gap: 6 }}>
                                    <div style={{ display: 'flex', flexDirection: 'column', gap: 3, flexShrink: 0 }}>
                                        <button
                                            style={sessionMixerBtnStyle(track.is_mute)}
                                            onClick={() => { void setTrackMute(trackIndex, !track.is_mute); }}
                                            title={track.is_mute ? 'Unmute track' : 'Mute track'}
                                        >
                                            <span style={{ width: 8, height: 1, background: 'currentColor', display: 'block' }} />
                                        </button>
                                        <button
                                            style={sessionMixerBtnStyle(track.is_solo)}
                                            onClick={() => { void setTrackSolo(trackIndex, !track.is_solo); }}
                                            title="Solo"
                                        >S</button>
                                        <button style={sessionMixerBtnStyle(track.is_armed)}>R</button>
                                    </div>
                                    <div style={{
                                        flex: 1,
                                        minHeight: 82,
                                        borderRadius: 'var(--radius-xs)',
                                        border: '1px solid #3d3d3d',
                                        background: '#171717',
                                        position: 'relative',
                                        overflow: 'hidden',
                                    }}>
                                        <div style={{
                                            position: 'absolute',
                                            left: '50%',
                                            transform: 'translateX(-50%)',
                                            top: 4,
                                            bottom: 4,
                                            width: 18,
                                            background: 'var(--color-overlay-dark)',
                                        }} />
                                        <div style={{
                                            position: 'absolute',
                                            left: '50%',
                                            transform: 'translateX(-50%)',
                                            bottom: 4,
                                            width: 18,
                                            height: `${Math.max(2, trackMeterLevel * 100)}%`,
                                            background: 'linear-gradient(180deg, #8cff73 0%, #5ee162 45%, #30c451 100%)',
                                            boxShadow: '0 0 10px color-mix(in srgb, var(--color-status-success) 40%, transparent)',
                                            transition: `height var(--transition-linear)`,
                                        }} />
                                    </div>
                                </div>
                                <div style={{ fontSize: 'var(--font-size-xs)', color: 'var(--color-text-secondary)', fontFamily: 'var(--font-mono)' }}>
                                    {peakLabel}
                                </div>
                            </div>
                        );
                    })}
                </div>
                <div style={{ width: SESSION_MASTER_WIDTH, padding: '8px 8px 6px', borderLeft: '1px solid #3b3b3b', display: 'grid', gridTemplateRows: 'auto 1fr auto', gap: 6 }}>
                    <div style={{ fontSize: 'var(--font-size-xs)', color: 'var(--color-text-secondary)', fontWeight: 700 }}>MASTER</div>
                    <div style={{ position: 'relative', border: '1px solid var(--color-divider)', borderRadius: 'var(--radius-md)', background: 'var(--color-bg-base)' }}>
                        <div style={{ position: 'absolute', left: 0, right: 0, bottom: 0, height: `${Math.max(4, Math.min(100, masterLevel * 100))}%`, background: 'linear-gradient(180deg, #92ff73 0%, #3ac95b 80%, #ffe35e 100%)' }} />
                    </div>
                    <div style={{ fontSize: 'var(--font-size-xs)', color: 'var(--color-text-secondary)', fontFamily: 'var(--font-mono)' }}>Out</div>
                </div>
            </div>
        </div>
    );
};

const sessionMixerBtnStyle = (active: boolean): CSSProperties => ({
    minWidth: 24,
    height: 18,
    borderRadius: 'var(--radius-sm)',
    border: active ? '1px solid color-mix(in srgb, var(--color-accent-primary) 55%, transparent)' : '1px solid #4b4b4b',
    background: active ? 'var(--color-accent-primary-dim)' : 'var(--color-bg-header)',
    color: active ? 'var(--color-text-primary)' : 'var(--color-text-secondary)',
    fontSize: 'var(--font-size-xs)',
    fontWeight: 700,
    cursor: 'default',
});

const sessionClipTransportBtnStyle = (active: boolean): CSSProperties => ({
    minWidth: 16,
    height: 14,
    borderRadius: 'var(--radius-sm)',
    border: active ? '1px solid color-mix(in srgb, var(--color-accent-primary) 50%, transparent)' : '1px solid var(--color-overlay-medium)',
    background: active ? 'color-mix(in srgb, var(--color-text-bright) 25%, transparent)' : 'var(--color-overlay-dark)',
    color: active ? 'var(--color-text-bright)' : 'color-mix(in srgb, var(--color-text-bright) 90%, transparent)',
    fontSize: 'var(--font-size-2xs)',
    fontWeight: 700,
    lineHeight: 1,
    padding: 0,
    cursor: 'pointer',
});

export default DawShell;

const EmptyClipEditor = () => (
    <div style={{
        height: '100%',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        background: 'radial-gradient(circle at 50% 20%, color-mix(in srgb, var(--color-bg-panel) 88%, #2a3a55) 0%, var(--color-bg-panel) 66%)',
    }}>
        <div style={{
            textAlign: 'center',
            padding: '18px 26px',
            border: '1px solid color-mix(in srgb, var(--color-accent-primary) 24%, var(--color-divider))',
            borderRadius: 'var(--radius-xl)',
            background: 'color-mix(in srgb, var(--color-bg-header) 86%, #0a111f)',
            boxShadow: '0 10px 24px var(--color-overlay-dark)',
            maxWidth: 520,
        }}>
            <div style={{
                color: 'var(--color-text-primary)',
                fontSize: 'var(--font-size-2xl)',
                fontWeight: 700,
                letterSpacing: '0.03em',
                marginBottom: 6,
            }}>
                No Clip Selected
            </div>
            <div style={{
                color: 'var(--color-text-secondary)',
                fontSize: 'var(--font-size-base)',
                lineHeight: 1.5,
            }}>
                Select a MIDI or audio clip on the timeline to open the editor.
            </div>
            <div style={{
                marginTop: 8,
                fontSize: 'var(--font-size-xs)',
                color: 'var(--color-text-tertiary)',
                fontFamily: 'var(--font-mono)',
            }}>
                Shift+Tab switches Rack/Clip panel
            </div>
        </div>
    </div>
);

const SampleClipEditor = ({
    clip,
}: {
    clip: {
        id: string;
        name: string;
        durationBeats: number;
        filePath?: string;
        durationSamples?: number;
        isWarped?: boolean;
        warpMode?: number | null;
        warpBaseBpm?: number;
        warpSourceDurationFrames?: number;
        sourceOffset?: number;
        fadeIn?: number;
        fadeOut?: number;
        fadeInCurve?: number;
        fadeOutCurve?: number;
        isOffline?: boolean;
    };
}) => {
    const sampleRate = useEngineStore((s) => s.projectSampleRate || 44100);
    const bpm = useEngineStore((s) => s.projectBpm || s.transport.bpm || 120);
    const gridDivision = useGridStore((s) => s.division);
    const gridTriplet = useGridStore((s) => s.triplet);
    const [zoomX, setZoomX] = useState(1);
    const durationSamples = Math.max(0, clip.durationSamples ?? 0);
    const [draftWarpEnabled, setDraftWarpEnabled] = useState<boolean>(Boolean(clip.isWarped));
    const [draftWarpMode, setDraftWarpMode] = useState<number>((clip.warpMode ?? 0) > 0 ? 1 : 0);
    const [draftWarpBaseBpm, setDraftWarpBaseBpm] = useState<number>(Math.max(20, Math.round(clip.warpBaseBpm ?? bpm)));
    const [isPreviewing, setIsPreviewing] = useState(false);

    const togglePreview = useCallback(async () => {
        if (!clip.filePath) return;
        try {
            if (isPreviewing) {
                await engineApi.stopPreview();
                setIsPreviewing(false);
                return;
            }
            await engineApi.previewAudioFile(clip.filePath);
            setIsPreviewing(true);
        } catch (err) {
            console.error('[SampleClipEditor] preview failed:', err);
        }
    }, [clip.filePath, isPreviewing]);

    useEffect(() => () => {
        if (isPreviewing) {
            void engineApi.stopPreview();
        }
    }, [isPreviewing]);

    const commitWarp = useCallback(async (next: {
        enabled: boolean;
        mode: number;
        baseBpm: number;
    }) => {
        const base = Math.max(20, Math.min(300, Math.round(next.baseBpm)));
        const store = useEngineStore.getState();
        const sr = store.projectSampleRate || 44100;
        const projectTempo = store.projectBpm || store.transport.bpm || 120;
        const beatsPerSecond = projectTempo / 60;
        const sourceFrames = Math.max(1, clip.warpSourceDurationFrames ?? clip.durationSamples ?? 1);

        const nextDurationBeats = next.enabled
            ? (sourceFrames / sr) * (base / 60)
            : (sourceFrames / sr) * beatsPerSecond;
        const nextDurationSamples = next.enabled
            ? Math.max(1, Math.round((nextDurationBeats / beatsPerSecond) * sr))
            : sourceFrames;

        const previousClips = useEngineStore.getState().timelineClips;
        useEngineStore.setState((state) => ({
            timelineClips: state.timelineClips.map((c) => {
                if (c.id !== clip.id) return c;
                return {
                    ...c,
                    isWarped: next.enabled,
                    warpMode: next.mode > 0 ? 1 : 0,
                    warpBaseBpm: base,
                    warpSourceDurationFrames: sourceFrames,
                    durationBeats: nextDurationBeats,
                    durationSamples: nextDurationSamples,
                };
            }),
        }));

        setDraftWarpEnabled(next.enabled);
        setDraftWarpMode(next.mode > 0 ? 1 : 0);
        setDraftWarpBaseBpm(base);
        try {
            await engineApi.setClipWarp({
                clipId: clip.id,
                isWarped: next.enabled,
                warpMode: next.mode > 0 ? 1 : 0,
                warpBaseBpm: base,
            });
        } catch (err) {
            useEngineStore.setState({ timelineClips: previousClips });
            console.error('[SampleClipEditor] setClipWarp failed:', err);
        }
    }, [clip.id, clip.durationSamples, clip.warpSourceDurationFrames]);

    const beatsPerBar = 4;
    const beatsPerSecond = bpm / 60;
    const clipDurationBeats = Math.max(0.25, clip.durationBeats || ((durationSamples / sampleRate) * beatsPerSecond));
    const gridStep = Math.max(0.0625, divisionToInterval(gridDivision, beatsPerBar, gridTriplet));
    const pxPerBeat = 82 * zoomX;
    const waveformWidth = Math.max(420, Math.round(clipDurationBeats * pxPerBeat));
    const gridLineCount = Math.min(512, Math.ceil(clipDurationBeats / gridStep));

    return (
        <div style={{
            height: '100%',
            display: 'flex',
            flexDirection: 'column',
            background: 'var(--color-bg-panel)',
        }}>
            <div style={{
                height: 28,
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'space-between',
                gap: 8,
                padding: '0 10px',
                borderBottom: '1px solid var(--color-divider)',
                color: 'var(--color-text-secondary)',
                fontSize: 'var(--font-size-xs)',
                fontWeight: 700,
                letterSpacing: '0.05em',
                textTransform: 'uppercase',
            }}>
                <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                    {clip.name}
                </span>
                <span style={{ fontFamily: 'var(--font-mono)' }}>
                    {clipDurationBeats.toFixed(2)} beats
                </span>
            </div>

            <ClipEditorShell
                sidebar={(
                    <ClipEditorSidebar>
                        <ClipEditorSection title="Clip Setup">
                            <ClipEditorMetaRow label="Length" value={`${clipDurationBeats.toFixed(2)} beats`} />
                            <ClipEditorMetaRow label="Source" value={clip.filePath ? 'Linked' : 'Missing'} />
                        </ClipEditorSection>

                        <ClipEditorSection title="Warp">
                            <label style={{ ...editorMetaTextStyle, display: 'inline-flex', alignItems: 'center', gap: 6 }}>
                                <input
                                    type="checkbox"
                                    checked={draftWarpEnabled}
                                    onChange={(e) => {
                                        void commitWarp({
                                            enabled: e.target.checked,
                                            mode: draftWarpMode,
                                            baseBpm: draftWarpBaseBpm,
                                        });
                                    }}
                                />
                                Enabled
                            </label>
                            <select
                                value={draftWarpMode > 0 ? 'pro' : 'standard'}
                                disabled={!draftWarpEnabled}
                                onChange={(e) => {
                                    const mode = e.target.value === 'pro' ? 1 : 0;
                                    void commitWarp({
                                        enabled: draftWarpEnabled,
                                        mode,
                                        baseBpm: draftWarpBaseBpm,
                                    });
                                }}
                                style={{ ...editorButtonStyle, padding: '3px 6px' }}
                            >
                                <option value="standard">Standard</option>
                                <option value="pro">Pro</option>
                            </select>
                            <div style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}>
                                <span style={editorMetaTextStyle}>Base BPM</span>
                                <input
                                    type="number"
                                    min={20}
                                    max={300}
                                    value={draftWarpBaseBpm}
                                    disabled={!draftWarpEnabled}
                                    onChange={(e) => setDraftWarpBaseBpm(Number(e.target.value) || 120)}
                                    onBlur={() => {
                                        void commitWarp({
                                            enabled: draftWarpEnabled,
                                            mode: draftWarpMode,
                                            baseBpm: draftWarpBaseBpm,
                                        });
                                    }}
                                    style={{ width: 68, ...editorButtonStyle, padding: '2px 6px' }}
                                />
                            </div>
                        </ClipEditorSection>

                        <ClipEditorSection title="Performance">
                            <button type="button" onClick={togglePreview} style={{ ...editorButtonStyle, width: '100%' }}>
                                {isPreviewing ? 'Stop Preview' : 'Preview'}
                            </button>
                            <div style={{ display: 'grid', gap: 4 }}>
                                <span style={editorMetaTextStyle}>Zoom</span>
                                <input
                                    type="range"
                                    min={0.6}
                                    max={4}
                                    step={0.1}
                                    value={zoomX}
                                    onChange={(e) => setZoomX(Number(e.target.value))}
                                />
                                <span style={{ ...editorMetaTextStyle }}>{zoomX.toFixed(1)}x</span>
                            </div>
                        </ClipEditorSection>
                    </ClipEditorSidebar>
                )}
            >
            <div style={{
                flex: 1,
                padding: 10,
                display: 'flex',
                flexDirection: 'column',
                gap: 8,
                minHeight: 0,
            }}>
                {clip.filePath && durationSamples > 0 && !clip.isOffline ? (
                    <div style={{
                        flex: 1,
                        minHeight: 120,
                        border: '1px solid var(--color-divider)',
                        borderRadius: 'var(--radius-md)',
                        overflow: 'hidden',
                        background: 'color-mix(in srgb, var(--color-bg-panel) 82%, transparent)',
                        position: 'relative',
                    }}>
                        <div style={{ overflowX: 'auto', overflowY: 'hidden', height: '100%' }}>
                            <div style={{ width: waveformWidth, height: '100%', position: 'relative' }}>
                                <div style={{
                                    position: 'absolute',
                                    left: 0,
                                    top: 0,
                                    right: 0,
                                    height: 20,
                                    borderBottom: '1px solid color-mix(in srgb, var(--color-text-primary) 8%, transparent)',
                                    background: 'color-mix(in srgb, var(--color-bg-elevated) 86%, transparent)',
                                }}>
                                    {Array.from({ length: gridLineCount }).map((_, i) => {
                                        const beat = i * gridStep;
                                        const x = beat * pxPerBeat;
                                        const isBar = Math.abs((beat / beatsPerBar) - Math.round(beat / beatsPerBar)) < 1e-6;
                                        return (
                                            <div key={`audio-ruler-${i}`} style={{ position: 'absolute', left: x, top: 0, bottom: 0, width: 1, background: isBar ? 'color-mix(in srgb, var(--color-accent-primary) 58%, transparent)' : 'color-mix(in srgb, var(--color-text-primary) 15%, transparent)' }}>
                                                {isBar && (
                                                    <span style={{ position: 'absolute', top: 2, left: 3, fontSize: 'var(--font-size-2xs)', color: 'var(--color-text-secondary)', fontFamily: 'var(--font-mono)' }}>
                                                        {Math.floor(beat / beatsPerBar) + 1}
                                                    </span>
                                                )}
                                            </div>
                                        );
                                    })}
                                </div>
                                <div style={{ position: 'absolute', top: 20, left: 0, right: 0, bottom: 0 }}>
                                    <ClipRenderer
                                        filePath={clip.filePath}
                                        width={waveformWidth}
                                        height={Math.max(90, ((window.innerHeight * 0.18) | 0) - 20)}
                                        durationSamples={durationSamples}
                                        sourceOffset={clip.sourceOffset ?? 0}
                                        isSelected
                                    />
                                </div>
                            </div>
                        </div>
                    </div>
                ) : (
                    <div style={{
                        flex: 1,
                        display: 'flex',
                        alignItems: 'center',
                        justifyContent: 'center',
                        color: 'var(--color-text-tertiary)',
                        fontSize: 'var(--font-size-base)',
                        border: '1px dashed var(--color-divider)',
                        borderRadius: 'var(--radius-lg)',
                    }}>
                        {clip.isOffline ? 'Media offline — resolve file in timeline (double-click clip).' : 'Audio source unavailable'}
                    </div>
                )}
            </div>
            </ClipEditorShell>
        </div>
    );
};

const editorButtonStyle = {
    border: '1px solid var(--color-divider)',
    borderRadius: 'var(--radius-md)',
    background: 'var(--color-bg-header)',
    color: 'var(--color-text-secondary)',
    fontSize: 'var(--font-size-xs)',
    fontWeight: 600,
    padding: '4px 8px',
    cursor: 'pointer',
};

const editorMetaTextStyle: CSSProperties = {
    fontSize: 'var(--font-size-xs)',
    color: 'var(--color-text-tertiary)',
    textTransform: 'uppercase',
    letterSpacing: '0.04em',
    fontWeight: 700,
};
