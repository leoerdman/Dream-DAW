import { lazy, Suspense, useState, useEffect, useCallback, useRef, useMemo } from 'react';
import throttle from 'lodash.throttle';
import { listen } from '@tauri-apps/api/event';
import { TransportBar } from '@/widgets/TransportBar/TransportBar';
import { useKeyboardShortcuts } from '@/shared/hooks/useKeyboardShortcuts';
import { useNativeMenu } from '@/shared/hooks/useNativeMenu';
import { useProjectManager } from '@/shared/hooks/useProjectManager';
import { ErrorBoundary } from '@/shared/ui/ErrorBoundary';
import type { TimelineClip } from '@/shared/lib/arrangementTypes';
import { AssetBrowser } from '@/widgets/AssetBrowser/AssetBrowser';
import { AssistantChat } from '@/widgets/AssistantChat/AssistantChat';
import { AgentActionIndicator } from '@/widgets/AgentActionIndicator/AgentActionIndicator';
import { StatusBar } from '@/widgets/StatusBar/StatusBar';
import { Timeline } from '@/widgets/Timeline/Timeline';
import { DragOverlay } from '@/widgets/DragOverlay/DragOverlay';
import type { BrowserDragItem } from '@/shared/lib/arrangementTypes';
import type { MidiNote } from '@/widgets/PianoRoll/PianoRoll';
import { useEngineStore, type ProjectTrack } from '@/shared/stores/useEngineStore';
import { useGridStore } from '@/shared/stores/useGridStore';
import { useAutomationStore } from '@/shared/stores/useAutomationStore';
import { useSettingsStore } from '@/shared/stores/useSettingsStore';
import * as engineApi from '@/shared/api/engine';
import { useBrowserDnDOrchestrator } from '@/shared/hooks/useBrowserDnDOrchestrator';
import { divisionToInterval } from '@/shared/lib/gridSnap';
import { beatToFrame, resolveSampleRate } from '@/shared/lib/audioMath';
import { scrollSync } from '@/shared/lib/useScrollSync';
import { useStatusStore } from '@/shared/stores/useStatusStore';
import { EmptyClipEditor, SampleClipEditor, SessionWorkspace } from './DawShellPanels';

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
    const dotIdx = path.lastIndexOf('.');
    if (dotIdx < 0) return false; // BUG-7 fix: no extension → not audio
    const ext = path.slice(dotIdx).toLowerCase();
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
    // selectedClipId is always the last element of selectedClipIds — derived synchronously
    // via useMemo to eliminate the 1-render stale window that the old useEffect pattern had.
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
    // ── Group collapse state (lifted from TrackInspector for Timeline sync) ──
    const [collapsedGroups, setCollapsedGroups] = useState<Set<string>>(new Set());
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
    const { filePath: projectFilePath } = useProjectManager(syncProjectSnapshotDelta);

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
        onProjectMutated: () => void syncProjectSnapshotDelta('keyboard-shortcut'),
        onTogglePlayback: togglePlay,
        onClipSelectionChanged: setSelectedClipIds,
    });

    // ── ⌘, opens Settings ──
    useEffect(() => {
        const handler = (e: KeyboardEvent) => {
            if (e.metaKey && e.key === ',') {
                e.preventDefault();
                setSettingsOpen(prev => !prev);
            }
            // Cmd/Ctrl + Shift + R: open render/export dialog
            if ((e.metaKey || e.ctrlKey) && e.shiftKey && e.code === 'KeyR') {
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
                setBottomPanelModeForActiveTrack((prev) => (prev === 'rack' ? 'clip' : 'rack'));
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
    }, [setBottomPanelModeForActiveTrack, setSettingsOpen, setExportOpen, setMainViewMode]);

    // ── Tauri Drag & Drop → Import Audio ───────────────────────────
    useEffect(() => {
        let unlisten: (() => void) | undefined;
        // Guard against listener leak when component unmounts before setup() resolves.
        let cancelled = false;

        const setup = async () => {
            // Listen for drag hover (visual feedback) — only for OS file drops, not in-app drags
            const unlistenHover = await listen('tauri://drag-over', () => {
                if (!window.__dreamInAppDrag) {
                    // Intentionally no-op; visual drag overlay handled by timeline DnD layer.
                }
            });

            // Listen for drag leave
            const unlistenLeave = await listen('tauri://drag-leave', () => {
                // Intentionally no-op; visual drag overlay handled by timeline DnD layer.
            });

            // Listen for file drop
            const unlistenDrop = await listen<{ paths: string[] }>('tauri://drag-drop', async (event) => {
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

            const combinedUnlisten = () => {
                unlistenHover();
                unlistenLeave();
                unlistenDrop();
            };

            if (cancelled) {
                // Component unmounted before this resolved — clean up immediately.
                combinedUnlisten();
            } else {
                unlisten = combinedUnlisten;
            }
        };

        void setup();
        return () => {
            cancelled = true;
            unlisten?.();
        };
    }, [importFile]);

    const openSettings = useCallback(() => setSettingsOpen(true), []);
    const handleOpenExport = useCallback(() => setExportOpen(true), []);
    const handleRecordingStateChange = useCallback((state: { active: boolean; trackIndex: number }) => setRecordingState(state), []);
    const handleAssistantToggle = useCallback(() => setAssistantOpen((v) => {
        const next = !v;
        try { localStorage.setItem('dream-daw:assistant-open', next ? '1' : '0'); } catch { /* quota */ }
        return next;
    }), []);
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
    }, []);

    // selectedClipId is now a useMemo derived from selectedClipIds — no useEffect needed.

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
        let unlisten: (() => void) | null = null;
        let cancelled = false;

        const setup = async () => {
            const fn = await listen<{ error?: string }>('audio-stream-error', async (event) => {
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
            if (cancelled) fn(); else unlisten = fn;
        };

        void setup();
        return () => {
            cancelled = true;
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
    }, []);

    // Safety-net bootstrap: if splash transition missed telemetry startup,
    // mount of workspace guarantees playhead + meters start updating.
    // Retry every 500ms until telemetry is confirmed running — handles cases
    // where listen() fails due to Tauri IPC not being ready yet.
    useEffect(() => {
        startTelemetryLoop();
        const retryId = setInterval(() => {
            const running = useEngineStore.getState().telemetryRunning;
            if (!running) {
                console.warn('[DawShell] Telemetry not running — retrying startTelemetryLoop()');
                startTelemetryLoop();
            } else {
                clearInterval(retryId);
            }
        }, 500);
        return () => clearInterval(retryId);
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

    // playheadBeat removed — was: transportPositionBeats ?? 0
    // Timeline and PianoRoll now read transport.position_beats directly
    // from useEngineStore, avoiding 30fps re-renders of DawShell.

    const trackCountRaw = Math.max(projectTracks.length, 1);
    const trackIds = useMemo(() => projectTracks.map((t) => t.id), [projectTracks]);

    // ── Sync collapsed groups from backend is_expanded field ──
    useEffect(() => {
        const collapsed = new Set<string>();
        for (const pt of projectTracks) {
            const normalized = (pt.track_type ?? '').toLowerCase();
            if (normalized === 'group' && pt.is_expanded === false) {
                collapsed.add(pt.id);
            }
        }
        setCollapsedGroups(collapsed);
    }, [projectTracks]);

    const toggleGroupCollapse = useCallback((groupId: string) => {
        setCollapsedGroups(prev => {
            const next = new Set(prev);
            let expanded = true;
            if (next.has(groupId)) {
                next.delete(groupId);
                expanded = true;
            } else {
                next.add(groupId);
                expanded = false;
            }
            void engineApi.setGroupExpanded(groupId, expanded).catch((err) => {
                console.error('[DawShell] setGroupExpanded failed:', err);
            });
            return next;
        });
    }, []);

    // ── Compute which track indices are hidden due to group collapse ──
    const hiddenTrackIndices = useMemo(() => {
        const hidden = new Set<number>();
        if (collapsedGroups.size === 0) return hidden;
        const trackById = new Map(projectTracks.map(t => [t.id, t]));
        const isAncestorCollapsed = (trackId: string): boolean => {
            let parentId = trackById.get(trackId)?.parent_track_id;
            while (parentId) {
                if (collapsedGroups.has(parentId)) return true;
                parentId = trackById.get(parentId)?.parent_track_id;
            }
            return false;
        };
        for (let i = 0; i < projectTracks.length; i++) {
            if (isAncestorCollapsed(projectTracks[i].id)) {
                hidden.add(i);
            }
        }
        return hidden;
    }, [projectTracks, collapsedGroups]);
    // ── trackCount must reflect VISIBLE tracks only (excluding collapsed children) ──
    // Keeps Timeline canvas total height in sync with TrackInspector's visibleTracks.
    const trackCount = Math.max(trackCountRaw - hiddenTrackIndices.size, 1);
    const selectedTrackIndex = useMemo(() => {
        if (!selectedTrackId || selectedTrackId === 'master') return -1;
        const rawIndex = projectTracks.findIndex((t) => t.id === selectedTrackId);
        // BUG-D FIX: If the selected track is hidden (inside a collapsed group),
        // snap to the nearest visible track to keep highlight/edit cursor usable.
        if (rawIndex >= 0 && hiddenTrackIndices.has(rawIndex)) {
            // Search upward for the nearest visible track (likely the group header)
            for (let i = rawIndex - 1; i >= 0; i--) {
                if (!hiddenTrackIndices.has(i)) return i;
            }
            // Fallback: search downward
            for (let i = rawIndex + 1; i < projectTracks.length; i++) {
                if (!hiddenTrackIndices.has(i)) return i;
            }
        }
        return rawIndex;
    }, [projectTracks, selectedTrackId, hiddenTrackIndices]);
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

    useEffect(() => {
        const onPointerUp = () => {
            void flushTrackControlFinals();
            flushMidiThrottles();
            // BUG-C14 FIX: Early-exit if no dirty clips.
            if (dirtyMidiNotesClipIdsRef.current.size === 0 && dirtyMidiEnvelopeClipIdsRef.current.size === 0) return;

            // BUG-P13 FIX: Flush ALL dirty clips, not just the selected one.
            // If the user edits clip A then switches to clip B before releasing
            // the pointer, clip A's final undo-stamped save was being skipped.
            for (const clipId of Array.from(dirtyMidiNotesClipIdsRef.current)) {
                const notes = latestMidiNotesRef.current[clipId] ?? [];
                void engineApi
                    .updateMidiClipWithDeltas(clipId, serializeMidiNotesToFrames(notes), { pushUndoStep: true })
                    .then(async (response) => {
                        await applyProjectDeltas(response.deltas, 'midi-notes:pointerup');
                        dirtyMidiNotesClipIdsRef.current.delete(clipId);
                    })
                    .catch((err) => console.error('[DawShell] updateMidiClip final flush failed:', err));
            }

            for (const clipId of Array.from(dirtyMidiEnvelopeClipIdsRef.current)) {
                const envelopes = latestMidiEnvelopesRef.current[clipId] ?? [];
                void engineApi
                    .setMidiClipEnvelopes(clipId, envelopes, { pushUndoStep: true })
                    .then(() => {
                        dirtyMidiEnvelopeClipIdsRef.current.delete(clipId);
                    })
                    .catch((err) => console.error('[DawShell] setMidiClipEnvelopes final flush failed:', err));
            }
        };
        window.addEventListener('pointerup', onPointerUp);
        return () => window.removeEventListener('pointerup', onPointerUp);
    }, [flushTrackControlFinals, flushMidiThrottles, serializeMidiNotesToFrames, applyProjectDeltas]);

    // ── Scroll sync ──────────────────────────────────────────────────
    // Scroll is synchronized via the scrollSync singleton (useScrollSync.ts).
    // NO React state here — avoids re-rendering the entire DawShell tree
    // on every scroll frame. Timeline and TrackInspector subscribe directly.

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
    }, []);

    const resolveHeightTargetTrackIds = useCallback((target: EventTarget | null, clientY?: number) => {
        const element = target instanceof Element ? target : null;

        const inspectorRow = element?.closest?.('[data-track-row="true"][data-track-id]') as HTMLElement | null;
        const inspectorTrackId = inspectorRow?.getAttribute('data-track-id');
        if (inspectorTrackId && inspectorTrackId !== 'master') {
            return [inspectorTrackId];
        }

        const state = useEngineStore.getState();
        const projectTracksSnapshot = state.projectTracks;
        const selectedTrackIds = selectedTrackIdsRef.current;
        const selectedTrackId = selectedTrackIdRef.current;

        const timelineRoot = element?.closest?.('[data-testid="timeline-view"]') as HTMLElement | null;
        if (timelineRoot && Number.isFinite(clientY)) {
            const rect = timelineRoot.getBoundingClientRect();
            const yInViewport = (clientY as number) - rect.top;
            const yInTracks = yInViewport - RULER_HEIGHT + scrollSync.scrollY;
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
        clampTrackHeight,
        TRACK_HEIGHT_DEFAULT,
    ]);

    const applyTrackHeightsOptimistic = useCallback((trackIds: string[], height: number) => {
        if (trackIds.length === 0) return;
        const idSet = new Set(trackIds);
        useEngineStore.setState((state) => {
            const nextTracks = state.projectTracks.map((track) =>
                idSet.has(track.id) ? { ...track, height } : track
            );
            const nextById = Object.fromEntries(nextTracks.map((t) => [t.id, t]));
            return {
                projectTracks: nextTracks,
                tracksById: nextById,
                tracks: {
                    byId: nextById,
                    allIds: state.tracks.allIds,
                },
            };
        });
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
        return projectTracksSnapshot.map((t, idx) => {
            // Collapsed group children → 0 height in Timeline
            if (hiddenTrackIndices.has(idx)) return 0;
            const persisted = Number.isFinite(t.height) ? t.height : TRACK_HEIGHT_BASE;
            return clamp(persisted);
        });
    }, [projectTracksSnapshot, TRACK_HEIGHT_BASE, TRACK_HEIGHT_MIN, TRACK_HEIGHT_MAX, hiddenTrackIndices]);

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

    const handleEditCursorChange = useCallback((beat: number, trackStart: number, trackEnd: number) => {
        const clampedBeat = Math.max(0, beat);
        setEditCursorBeat(clampedBeat);
        setEditCursorTrackIndex(Math.max(0, trackStart));
        setEditCursorTrackIndexEnd(Math.max(0, trackEnd));
        // Breaking mutual exclusivity: edit cursor and clip selection can coexist.
        // Queue the position — playhead jumps here when transport starts.
        queuedStartBeatRef.current = clampedBeat;
    }, []);

    const handleMarqueeSelectionStart = useCallback(() => {
        // Selection-box mode is mutually exclusive with clip selection.
        // BUG-A10 FIX: Do NOT clear editCursorBeat here — it serves as the
        // anchor for Shift+Click time selection. Only clear clip selection
        // and prior marquee.
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
    const handleClipSelect = useCallback((clipId: string, isShift: boolean = false, isCtrl: boolean = false) => {
        setSelectedClipIds((prev) => {
            if (isCtrl) {
                // Toggle clicked clip
                if (prev.includes(clipId)) {
                    return prev.filter(id => id !== clipId);
                }
                return [...prev, clipId];
            } else if (isShift) {
                // Additive selection (simple push if not already there)
                // Note: full range-based shift selection requires timeline sorting,
                // but basic additive shift-select works for most use cases.
                if (prev.includes(clipId)) return prev;
                return [...prev, clipId];
            } else {
                // Single select
                return [clipId];
            }
        });

        // Derive parent track from clip and select it alongside the clip.
        const clip = timelineClipsForView.find(c => c.id === clipId);
        if (clip) {
            queuedStartBeatRef.current = clip.startBeat;
            const trackId = projectTracks[clip.trackIndex]?.id;
            if (trackId && trackId !== 'master') {
                setSelectedTrackId(trackId);
                setSelectedTrackIds([trackId]);
            }
        }
    }, [timelineClipsForView, projectTracks]);

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
        // BUG-C20 FIX: Read beatsPerBar from store when available, fall back to 4.
        const storeState = useEngineStore.getState();
        const beatsPerBar = (storeState as typeof storeState & { projectBeatsPerBar?: number }).projectBeatsPerBar ?? 4;
        const positionFrames = beatToFrame(beat, bpm, sr);
        const durationFrames = beatDurationToFrames(beatsPerBar, bpm, sr);
        createMidiClip(trackIndex, positionFrames, durationFrames);
    }, [createMidiClip, projectBpm, transportBpm, projectSampleRate]);

    // Clip drag → move clip to new position in engine (syncs audio with visual)
    const handleClipMove = useCallback((clipId: string, newStartBeat: number, newTrackIndex: number) => {
        const bpm = projectBpm || transportBpm || 120;
        const sr = projectSampleRate;

        const dragged = timelineClipsForView.find((c) => c.id === clipId);
        if (!dragged) return;

        const selectedSet = new Set(selectedClipIds);
        const moveAsGroup = selectedSet.size > 1 && selectedSet.has(clipId);

        const moveOne = async (id: string, targetBeat: number, targetTrack: number) => {
            const positionFrames = beatToFrame(Math.max(0, targetBeat), bpm, sr);
            const response = await engineApi.moveClipWithDeltas(id, targetTrack, positionFrames);
            await applyProjectDeltas(response.deltas, 'clip-move');
        };

        const run = async () => {
            if (!moveAsGroup) {
                await moveOne(clipId, newStartBeat, newTrackIndex);
                return;
            }

            const deltaBeat = newStartBeat - dragged.startBeat;
            const deltaTrack = newTrackIndex - dragged.trackIndex;

            const selectedClips = timelineClipsForView.filter((c) => selectedSet.has(c.id));
            // Sequential moves to avoid race conditions: each moveOne reads the current
            // clip state, so parallel moves would each see stale positions for other clips.
            for (const clip of selectedClips) {
                const targetBeat = Math.max(0, clip.startBeat + deltaBeat);
                // BUG-A5 FIX: Use trackCountRaw (raw project track count) instead of
                // trackCount (visible-only count). Clip trackIndex references raw project
                // indices, not visible-only indices. Using visible count could prevent
                // moves to tracks that exist but are inside collapsed groups.
                const targetTrack = Math.max(0, Math.min(trackCountRaw - 1, clip.trackIndex + deltaTrack));
                await moveOne(clip.id, targetBeat, targetTrack);
            }
        };

        run()
            .then(() => {
                console.log('[DawShell] Clip move applied', {
                    clipId,
                    newTrackIndex,
                    newStartBeat,
                    mode: moveAsGroup ? 'group' : 'single',
                });
            })
            .catch(err => {
                console.error('[DawShell] moveClip failed:', err);
                useStatusStore.getState().setError(
                    `Clip move failed: ${err instanceof Error ? err.message : String(err)}`
                );
            });
    }, [projectBpm, transportBpm, projectSampleRate, timelineClipsForView, selectedClipIds, trackCountRaw, applyProjectDeltas]);

    // Clip resize → update position and duration in engine
    const handleClipResize = useCallback((clipId: string, newStartBeat: number, newDurationBeats: number) => {
        const bpm = projectBpm || transportBpm || 120;
        const sr = projectSampleRate;
        const newPositionFrames = beatToFrame(newStartBeat, bpm, sr);
        const newDurationFrames = Math.max(128, beatDurationToFrames(newDurationBeats, bpm, sr));

        engineApi.resizeClipWithDeltas(clipId, newPositionFrames, newDurationFrames)
            .then(async (response) => {
                await applyProjectDeltas(response.deltas, 'clip-resize');
                console.log('[DawShell] Clip resized', { clipId, newStartBeat, newDurationBeats });
            })
            .catch(err => {
                console.error('[DawShell] resizeClip failed:', err);
                useStatusStore.getState().setError(
                    `Clip resize failed: ${err instanceof Error ? err.message : String(err)}`
                );
            });
    }, [projectBpm, transportBpm, projectSampleRate, applyProjectDeltas]);

    const handleClipFades = useCallback((clipId: string, fadeInFrames: number, fadeOutFrames: number) => {
        engineApi.setClipFadesWithDeltas(
            clipId,
            Math.max(0, Math.round(fadeInFrames)),
            Math.max(0, Math.round(fadeOutFrames)),
        )
            .then(async (response) => {
                await applyProjectDeltas(response.deltas, 'clip-fades');
            })
            .catch((err) => console.error('[DawShell] setClipFades failed:', err));
    }, [applyProjectDeltas]);

    const handleOpenMidiClip = useCallback((clipId: string) => {
        setSelectedClipIds([clipId]);
        setBottomPanelModeForActiveTrack('clip');
    }, [setBottomPanelModeForActiveTrack]);

    const flushPendingMidiEdits = useCallback(async () => {
        flushMidiThrottles();
        const noteClipIds = Array.from(dirtyMidiNotesClipIdsRef.current);
        const envelopeClipIds = Array.from(dirtyMidiEnvelopeClipIdsRef.current);
        const noteTasks = noteClipIds.map((clipId) =>
            engineApi
                .updateMidiClipWithDeltas(clipId, serializeMidiNotesToFrames(latestMidiNotesRef.current[clipId] ?? []), {
                    pushUndoStep: true,
                })
                .then(async (response) => {
                    await applyProjectDeltas(response.deltas, 'midi-notes:flush');
                    return { ok: true as const, clipId };
                })
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
    }, [flushMidiThrottles, serializeMidiNotesToFrames, applyProjectDeltas]);

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
                                        onClipSelectionChange={(ids) => {
                                            setSelectedClipIds(ids);
                                            // Mutual exclusivity: clip selection ⇒ hide edit cursor. (DEPRECATED)
                                            // if (ids.length > 0) setEditCursorBeat(-1);
                                            // Select tracks that own the selected clips.
                                            if (ids.length > 0) {
                                                const idSet = new Set(ids);
                                                const trackIdSet = new Set<string>();
                                                for (const c of timelineClipsForView) {
                                                    if (idSet.has(c.id)) {
                                                        const tid = projectTracks[c.trackIndex]?.id;
                                                        if (tid && tid !== 'master') trackIdSet.add(tid);
                                                    }
                                                }
                                                if (trackIdSet.size > 0) {
                                                    const arr = Array.from(trackIdSet);
                                                    setSelectedTrackIds(arr);
                                                    setSelectedTrackId(arr[arr.length - 1]);
                                                }
                                            }
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
