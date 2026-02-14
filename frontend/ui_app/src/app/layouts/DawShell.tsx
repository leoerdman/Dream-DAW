import { useState, useEffect, useCallback, useRef, useMemo, type CSSProperties } from 'react';
import throttle from 'lodash.throttle';
import { listen } from '@tauri-apps/api/event';
import { TransportBar } from '@/widgets/TransportBar/TransportBar';
import { useKeyboardShortcuts } from '@/shared/hooks/useKeyboardShortcuts';
import { useNativeMenu } from '@/shared/hooks/useNativeMenu';
import { useProjectManager } from '@/shared/hooks/useProjectManager';
import { ErrorBoundary } from '@/shared/ui/ErrorBoundary';
import { AssetBrowser } from '@/widgets/AssetBrowser/AssetBrowser';
import { DeviceRack } from '@/widgets/DeviceRack/DeviceRack';
import { TrackInspector } from '@/widgets/TrackInspector/TrackInspector';
import { StatusBar } from '@/widgets/StatusBar/StatusBar';
import { Timeline } from '@/widgets/Timeline/Timeline';
import { ClipRenderer } from '@/widgets/Timeline/ClipRenderer';
import type { BrowserDragItem } from '@/shared/types/Arrangement';
import { SettingsPanel } from '@/widgets/SettingsPanel/SettingsPanel';
import { PianoRoll, type MidiNote } from '@/widgets/PianoRoll/PianoRoll';
import { useEngineStore } from '@/shared/stores/useEngineStore';
import { useGridStore } from '@/shared/stores/useGridStore';
import { useAutomationStore } from '@/shared/stores/useAutomationStore';
import { ExportModal } from '@/widgets/ExportModal/ExportModal';
import * as engineApi from '@/shared/api/engine';
import { useBrowserDnDOrchestrator } from '@/shared/hooks/useBrowserDnDOrchestrator';
import { divisionToInterval } from '@/shared/lib/gridSnap';

/** Supported audio file extensions for drag-and-drop import. */
const AUDIO_EXTENSIONS = new Set([
    '.wav', '.mp3', '.flac', '.aiff', '.aif', '.ogg', '.m4a', '.aac',
]);

/** Check if a file path is a supported audio format. */
const isAudioFile = (path: string): boolean => {
    const ext = path.slice(path.lastIndexOf('.')).toLowerCase();
    return AUDIO_EXTENSIONS.has(ext);
};

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
    const [settingsOpen, setSettingsOpen] = useState(false);
    const [selectedTrackId, setSelectedTrackId] = useState('');
    const [selectedClipId, setSelectedClipId] = useState<string | null>(null);
    const [selectedClipIds, setSelectedClipIds] = useState<string[]>([]);
    const [editCursorBeat, setEditCursorBeat] = useState(0);
    const [editCursorTrackIndex, setEditCursorTrackIndex] = useState(0);
    const [isDragOver, setIsDragOver] = useState(false);
    const [exportOpen, setExportOpen] = useState(false);
    const [bottomPanelMode, setBottomPanelMode] = useState<BottomPanelMode>('rack');
    const [recordingState, setRecordingState] = useState<{ active: boolean; trackIndex: number }>({
        active: false,
        trackIndex: 0,
    });
    const [followPlayhead, setFollowPlayhead] = useState(false);
    const [midiNotesByClip, setMidiNotesByClip] = useState<Record<string, MidiNote[]>>({});
    const [aiVariationBusy, setAiVariationBusy] = useState(false);
    const [browserWidth, setBrowserWidth] = useState(240);
    const [mixerFocusMode, setMixerFocusMode] = useState(false);
    const midiSaveThrottlesRef = useRef<Map<string, (notes: MidiNote[]) => void>>(new Map());
    const latestMidiNotesRef = useRef<Record<string, MidiNote[]>>({});
    const importFile = useEngineStore(s => s.importFile);
    const createMidiClip = useEngineStore(s => s.createMidiClip);
    const togglePlay = useEngineStore(s => s.togglePlay);
    const fetchProject = useEngineStore(s => s.fetchProject);
    const startTelemetryLoop = useEngineStore(s => s.startTelemetryLoop);
    const flushTrackControlFinals = useEngineStore(s => s.flushTrackControlFinals);
    const timelineClipsSnapshot = useEngineStore(s => s.timelineClips);
    const projectTracksSnapshot = useEngineStore(s => s.projectTracks);
    const automationVisible = useAutomationStore(s => s.globalVisible);
    const toggleAutomation = useAutomationStore(s => s.toggleGlobalVisible);
    const importingRef = useRef(false);
    const timelineRef = useRef<HTMLDivElement>(null);
    const mainSplitRef = useRef<HTMLElement>(null);
    const queuedStartBeatRef = useRef<number | null>(null);

    // ── Enterprise Project Manager (Cmd+S/⇧S/N/O, auto-backup, dirty state)
    // Hook has side effects (keyboard shortcuts, auto-backup timer) — value intentionally unused
    useProjectManager(fetchProject);

    // ── Native macOS Menu Bar (File, Edit, Window) ──
    useNativeMenu(fetchProject);

    // ── Global Keyboard Shortcuts (Space, Cmd+E, Delete) ──
    useKeyboardShortcuts({
        selectedClipId,
        selectedClipIds,
        selectedTrackId,
        projectTracks: projectTracksSnapshot,
        playheadFrames: Math.round(
            (useEngineStore.getState().transport.position_seconds ?? 0) *
            (useEngineStore.getState().projectSampleRate ?? 44100)
        ),
        timelineClips: timelineClipsSnapshot,
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
            if (e.key === 'Tab' && !e.shiftKey) {
                const target = e.target as HTMLElement | null;
                const tag = target?.tagName?.toLowerCase();
                const isTextInput =
                    tag === 'input' || tag === 'textarea' || target?.isContentEditable;
                if (isTextInput) return;
                e.preventDefault();
                setMixerFocusMode((prev) => !prev);
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
    const handleSelectTrack = useCallback((id: string) => setSelectedTrackId(id), []);
    const beginBrowserResize = useCallback((e: React.MouseEvent<HTMLDivElement>) => {
        e.preventDefault();
        const splitRoot = mainSplitRef.current;
        if (!splitRoot) return;
        const rootRect = splitRoot.getBoundingClientRect();
        const onMove = (me: MouseEvent) => {
            const nextWidth = Math.max(200, Math.min(460, Math.round(me.clientX - rootRect.left)));
            setBrowserWidth(nextWidth);
        };
        const onUp = () => {
            window.removeEventListener('mousemove', onMove);
            window.removeEventListener('mouseup', onUp);
        };
        window.addEventListener('mousemove', onMove);
        window.addEventListener('mouseup', onUp);
    }, []);

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
    const transport = useEngineStore(s => s.transport);
    const projectSampleRate = useEngineStore(s => s.projectSampleRate || 44100);
    const projectBpm = useEngineStore(s => s.projectBpm);
    const projectSampleRateFromStore = useEngineStore(s => s.projectSampleRate);
    const timelineClips = useEngineStore(s => s.timelineClips);
    const projectTracks = useEngineStore(s => s.projectTracks);
    const timelineClipsForView = useMemo(
        () =>
            timelineClips.map((clip) => {
                if (clip.type !== 'midi') return clip;
                const localNotes = midiNotesByClip[clip.id];
                if (!localNotes) return clip;
                return {
                    ...clip,
                    midiNotes: localNotes,
                };
            }),
        [timelineClips, midiNotesByClip],
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
        window.__dreamSelectedTrackId = selectedTrackId;
        return () => {
            if (window.__dreamSelectedTrackId === selectedTrackId) {
                delete window.__dreamSelectedTrackId;
            }
        };
    }, [selectedTrackId]);

    // Use position_beats directly from engine (single-source, no float round-trip)
    const playheadBeat = transport.position_beats ?? 0;

    const trackCount = Math.max(projectTracks.length, 8);
    const trackIds = useMemo(() => projectTracks.map((t) => t.id), [projectTracks]);
    const selectedTimelineClip = useMemo(
        () => timelineClipsForView.find((c) => c.id === selectedClipId) ?? null,
        [timelineClipsForView, selectedClipId],
    );
    const selectedMidiTotalBars = useMemo(() => {
        if (!selectedTimelineClip || selectedTimelineClip.type !== 'midi') return 8;
        return Math.max(1, Math.ceil(selectedTimelineClip.durationBeats / 4));
    }, [selectedTimelineClip]);
    const handleGenerateMidiVariation = useCallback(async () => {
        if (!selectedTimelineClip || selectedTimelineClip.type !== 'midi') return;
        const clip = selectedTimelineClip;
        const notes = midiNotesByClip[clip.id] ?? [];
        const track = projectTracks[clip.trackIndex];
        const bpm = projectBpm || transport.bpm || 120;
        const beatsPerBar = 4;
        const sampleRate = useEngineStore.getState().projectSampleRate || 44100;
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
        transport.bpm,
        fetchProject,
    ]);

    useEffect(() => {
        const incoming: Record<string, MidiNote[]> = {};
        for (const clip of timelineClips) {
            if (clip.type !== 'midi') continue;
            incoming[clip.id] = (clip.midiNotes ?? []).map((n) => ({
                id: n.id ?? `${clip.id}-${n.pitch}-${n.startBeat}`,
                pitch: n.pitch,
                startBeat: n.startBeat,
                durationBeats: n.durationBeats,
                velocity: n.velocity,
            }));
        }
        setMidiNotesByClip(incoming);
    }, [timelineClips]);

    useEffect(() => {
        latestMidiNotesRef.current = midiNotesByClip;
    }, [midiNotesByClip]);

    // ── Final unthrottled sends on pointer release ──
    useEffect(() => {
        const onPointerUp = () => {
            void flushTrackControlFinals();
            const clip = selectedTimelineClip;
            if (!clip || clip.type !== 'midi') return;
            const notes = latestMidiNotesRef.current[clip.id] ?? [];
            const bpm = projectBpm || transport.bpm || 120;
            const sr = useEngineStore.getState().projectSampleRate || 44100;
            const beatsPerSecond = bpm / 60;
            void engineApi
                .updateMidiClip(
                    clip.id,
                    notes.map((n) => ({
                        pitch: n.pitch,
                        velocity: n.velocity,
                        startFrames: Math.max(0, Math.round((n.startBeat / beatsPerSecond) * sr)),
                        durationFrames: Math.max(1, Math.round((n.durationBeats / beatsPerSecond) * sr)),
                    })),
                )
                .catch((err) => console.error('[DawShell] updateMidiClip final flush failed:', err));
        };
        window.addEventListener('pointerup', onPointerUp);
        return () => window.removeEventListener('pointerup', onPointerUp);
    }, [flushTrackControlFinals, selectedTimelineClip, projectBpm, transport.bpm]);

    // ── Shared layout constants (SSOT for height sync) ──────────────
    const TRACK_HEIGHT = mixerFocusMode ? 84 : 48;
    const RULER_HEIGHT = 28;

    // ── Scroll sync between Timeline and TrackInspector ─────────────
    const [timelineScrollTop, setTimelineScrollTop] = useState(0);
    const handleTimelineScrollTop = useCallback((st: number) => {
        setTimelineScrollTop(st);
    }, []);

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

    // Start playback from the edit cursor position.
    const prevIsPlayingRef = useRef(false);
    useEffect(() => {
        const justStarted = transport.is_playing && !prevIsPlayingRef.current;
        prevIsPlayingRef.current = transport.is_playing;
        if (!justStarted) return;
        const startBeat = queuedStartBeatRef.current ?? editCursorBeat;
        queuedStartBeatRef.current = null;
        // Playback start anchor: start from queued edit cursor (from paused state).
        void engineApi.seekToBeat(Math.max(0, startBeat)).catch((err) => {
            console.error('[DawShell] seek to edit cursor failed:', err);
        });
    }, [transport.is_playing, editCursorBeat]);

    // Clip selection callback
    const handleClipSelect = useCallback((clipId: string) => {
        setSelectedClipId(clipId);
        setSelectedClipIds([clipId]);
        // Mutual exclusivity: clip selection ⇒ hide edit cursor.
        setEditCursorBeat(-1);
    }, []);

    // Drop from AssetBrowser → Timeline
    const {
        dropBrowserItemOnTimeline,
        dropPluginOnTrack,
        addDefaultDeviceToTrack,
    } = useBrowserDnDOrchestrator({
        projectTracks,
        projectBpm,
        transportBpm: transport.bpm || 120,
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
        const bpm = projectBpm || transport.bpm || 120;
        const sr = useEngineStore.getState().projectSampleRate || 44100;
        const beatsPerBar = 4; // 4/4 time signature
        const posSeconds = beat / (bpm / 60);
        const barSeconds = beatsPerBar / (bpm / 60);
        const positionFrames = Math.round(posSeconds * sr);
        const durationFrames = Math.round(barSeconds * sr);
        createMidiClip(trackIndex, positionFrames, durationFrames);
    }, [createMidiClip, projectBpm, transport.bpm]);

    // Clip drag → move clip to new position in engine (syncs audio with visual)
    const handleClipMove = useCallback((clipId: string, newStartBeat: number, newTrackIndex: number) => {
        const bpm = projectBpm || transport.bpm || 120;
        const sr = useEngineStore.getState().projectSampleRate || 44100;
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
                fetchProject();
            })
            .catch(err => console.error('[DawShell] moveClip failed:', err));
    }, [projectBpm, transport.bpm, fetchProject, timelineClipsForView, selectedClipIds, trackCount]);

    // Clip resize → update position and duration in engine
    const handleClipResize = useCallback((clipId: string, newStartBeat: number, newDurationBeats: number) => {
        const bpm = projectBpm || transport.bpm || 120;
        const sr = useEngineStore.getState().projectSampleRate || 44100;
        const posSeconds = newStartBeat / (bpm / 60);
        const durSeconds = newDurationBeats / (bpm / 60);
        const newPositionFrames = Math.round(posSeconds * sr);
        const newDurationFrames = Math.max(128, Math.round(durSeconds * sr));

        engineApi.resizeClip(clipId, newPositionFrames, newDurationFrames)
            .then(() => {
                console.log('[DawShell] Clip resized', { clipId, newStartBeat, newDurationBeats });
                fetchProject(); // Refresh project state
            })
            .catch(err => console.error('[DawShell] resizeClip failed:', err));
    }, [projectBpm, transport.bpm, fetchProject]);

    const handleOpenMidiClip = useCallback((clipId: string) => {
        setSelectedClipId(clipId);
        setBottomPanelMode('clip');
    }, []);

    const flushPendingMidiEdits = useCallback(async () => {
        const bpm = projectBpm || transport.bpm || 120;
        const sr = useEngineStore.getState().projectSampleRate || 44100;
        const beatsPerSecond = bpm / 60;
        const tasks: Promise<unknown>[] = [];

        for (const [clipId, notes] of Object.entries(latestMidiNotesRef.current)) {
            tasks.push(
                engineApi.updateMidiClip(
                    clipId,
                    notes.map((n) => ({
                        pitch: n.pitch,
                        velocity: n.velocity,
                        startFrames: Math.max(0, Math.round((n.startBeat / beatsPerSecond) * sr)),
                        durationFrames: Math.max(1, Math.round((n.durationBeats / beatsPerSecond) * sr)),
                    })),
                )
            );
        }

        await Promise.allSettled(tasks);
    }, [projectBpm, transport.bpm]);

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
                                bpm={projectBpm || transport.bpm || 120}
                                clips={timelineClipsForView}
                                playheadBeat={playheadBeat}
                                editCursorBeat={editCursorBeat}
                                editCursorTrackIndex={editCursorTrackIndex}
                                isPlaying={transport.is_playing}
                                recordingActive={recordingState.active}
                                recordingTrackIndex={recordingState.trackIndex}
                                trackIds={trackIds}
                                loopStart={(transport.loop_start / projectSampleRate) * ((projectBpm || transport.bpm || 120) / 60)}
                                loopEnd={(transport.loop_end / projectSampleRate) * ((projectBpm || transport.bpm || 120) / 60)}
                                loopEnabled={transport.loop_enabled}
                                trackCount={trackCount}
                                trackHeight={TRACK_HEIGHT}
                                onPlayheadChange={handlePlayheadChange}
                                onEditCursorChange={handleEditCursorChange}
                                onClipSelect={handleClipSelect}
                                selectedClipIds={selectedClipIds}
                                onClipSelectionChange={(ids) => {
                                    setSelectedClipIds(ids);
                                    setSelectedClipId(ids[ids.length - 1] ?? null);
                                    // Mutual exclusivity: clip selection ⇒ hide edit cursor.
                                    if (ids.length > 0) setEditCursorBeat(-1);
                                }}
                                onClipMove={handleClipMove}
                                onClipResize={handleClipResize}
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
                            <TrackInspector
                                selectedTrackId={selectedTrackId}
                                onSelectTrack={handleSelectTrack}
                                trackHeight={TRACK_HEIGHT}
                                rulerHeight={RULER_HEIGHT}
                                scrollTop={timelineScrollTop}
                                mixerFocusMode={mixerFocusMode}
                            />
                        </ErrorBoundary>
                    </aside>
                </main>

                {/* ── BOTTOM: Rack / Clip Editor (Shift+Tab) ── */}
                <footer
                    className="shrink-0 z-40 overflow-hidden"
                    style={{
                        height: 'var(--daw-device-rack-height)',
                        minHeight: 'var(--daw-device-rack-min-height)',
                        borderTop: '1px solid var(--color-divider)',
                    }}
                >
                    {bottomPanelMode === 'rack' ? (
                        <ErrorBoundary module="Device Rack">
                            <DeviceRack
                                selectedTrackId={selectedTrackId}
                                onDropPluginToTrack={(item, trackId) => dropPluginOnTrack(item, trackId)}
                                onAddDefaultDeviceToTrack={(trackId) => addDefaultDeviceToTrack(trackId)}
                            />
                        </ErrorBoundary>
                    ) : (
                        <ErrorBoundary module="Clip Editor">
                            {selectedTimelineClip?.type === 'midi' ? (
                                <PianoRoll
                                    notes={midiNotesByClip[selectedTimelineClip.id] ?? []}
                                    onNotesChange={(notes) => {
                                        const clipId = selectedTimelineClip.id;
                                        setMidiNotesByClip((prev) => ({ ...prev, [clipId]: notes }));
                                        const bpm = projectBpm || transport.bpm || 120;
                                        const sr = useEngineStore.getState().projectSampleRate || 44100;
                                        const beatsPerSecond = bpm / 60;
                                        let send = midiSaveThrottlesRef.current.get(clipId);
                                        if (!send) {
                                            send = throttle((toSend: MidiNote[]) => {
                                                void engineApi
                                                    .updateMidiClip(
                                                        clipId,
                                                        toSend.map((n) => ({
                                                            pitch: n.pitch,
                                                            velocity: n.velocity,
                                                            startFrames: Math.max(0, Math.round((n.startBeat / beatsPerSecond) * sr)),
                                                            durationFrames: Math.max(1, Math.round((n.durationBeats / beatsPerSecond) * sr)),
                                                        })),
                                                    )
                                                    .catch((err) => console.error('[DawShell] updateMidiClip failed:', err));
                                            }, 80);
                                            midiSaveThrottlesRef.current.set(clipId, send);
                                        }
                                        send(notes);
                                    }}
                                    onGenerateVariation={handleGenerateMidiVariation}
                                    aiVariationBusy={aiVariationBusy}
                                    playheadBeat={playheadBeat}
                                    totalBars={selectedMidiTotalBars}
                                    clipLengthBeats={selectedTimelineClip.durationBeats}
                                />
                            ) : selectedTimelineClip?.type === 'audio' ? (
                                <SampleClipEditor key={selectedTimelineClip.id} clip={selectedTimelineClip} />
                            ) : (
                                <EmptyClipEditor />
                            )}
                        </ErrorBoundary>
                    )}
                </footer>

                <BottomPanelModeBar
                    mode={bottomPanelMode}
                    onChange={setBottomPanelMode}
                />

                {/* ── VERY BOTTOM: Status Bar ── */}
                <div className="z-50">
                    <StatusBar />
                </div>

            </div>

            {/* ═══ SETTINGS MODAL ═══ */}
            <SettingsPanel isOpen={settingsOpen} onClose={() => setSettingsOpen(false)} />

            {/* ═══ DRAG-OVER OVERLAY ═══ */}
            {isDragOver && (
                <div
                    className="absolute inset-0 z-[999] flex items-center justify-center pointer-events-none"
                    style={{
                        background: 'rgba(59, 130, 246, 0.12)',
                        border: '3px dashed rgba(59, 130, 246, 0.6)',
                        borderRadius: '12px',
                        margin: '8px',
                    }}
                >
                    <div style={{
                        background: 'rgba(0, 0, 0, 0.75)',
                        color: '#fff',
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
            <ExportModal
                isOpen={exportOpen}
                onClose={() => setExportOpen(false)}
                projectName="My Project"
            />

        </div>
    );
};

export default DawShell;

const BottomPanelModeBar = ({
    mode,
    onChange,
}: {
    mode: 'rack' | 'clip';
    onChange: (mode: 'rack' | 'clip') => void;
}) => (
    <div style={{
        height: 26,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'space-between',
        gap: 8,
        padding: '0 10px',
        borderTop: '1px solid var(--color-divider)',
        borderBottom: '1px solid var(--color-divider)',
        background: 'color-mix(in srgb, var(--color-bg-panel) 88%, #000)',
    }}>
        <div style={{
            display: 'inline-flex',
            alignItems: 'center',
            gap: 4,
            border: '1px solid var(--color-control-border)',
            borderRadius: 6,
            padding: 2,
            background: 'var(--color-bg-header)',
        }}>
            <button
                type="button"
                onClick={() => onChange('rack')}
                style={bottomModeBtnStyle(mode === 'rack')}
                title="Instrument & Effects Chain (Shift+Tab)"
            >
                Panel: Rack
            </button>
            <button
                type="button"
                onClick={() => onChange('clip')}
                style={bottomModeBtnStyle(mode === 'clip')}
                title="Clip Editor (Shift+Tab)"
            >
                Panel: Clip
            </button>
        </div>
        <span style={{
            fontSize: 10,
            color: 'var(--color-text-tertiary)',
            fontFamily: 'var(--font-mono)',
            letterSpacing: '0.03em',
        }}>
            SHIFT+TAB
        </span>
    </div>
);

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
            borderRadius: 10,
            background: 'color-mix(in srgb, var(--color-bg-header) 86%, #0a111f)',
            boxShadow: '0 10px 24px rgba(0,0,0,0.28)',
            maxWidth: 520,
        }}>
            <div style={{
                color: 'var(--color-text-primary)',
                fontSize: 18,
                fontWeight: 700,
                letterSpacing: '0.03em',
                marginBottom: 6,
            }}>
                No Clip Selected
            </div>
            <div style={{
                color: 'var(--color-text-secondary)',
                fontSize: 12,
                lineHeight: 1.5,
            }}>
                Select a MIDI or audio clip on the timeline to open the editor.
            </div>
            <div style={{
                marginTop: 8,
                fontSize: 10,
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
        sourceOffset?: number;
        fadeIn?: number;
        fadeOut?: number;
        isOffline?: boolean;
    };
}) => {
    const sampleRate = useEngineStore((s) => s.projectSampleRate || 44100);
    const bpm = useEngineStore((s) => s.projectBpm || s.transport.bpm || 120);
    const gridDivision = useGridStore((s) => s.division);
    const gridTriplet = useGridStore((s) => s.triplet);
    const [zoomX, setZoomX] = useState(1);
    const durationSamples = Math.max(0, clip.durationSamples ?? 0);
    const maxOffset = Math.max(0, durationSamples - 1);
    const maxFade = Math.max(0, Math.round(durationSamples * 0.5));
    const [draftOffset, setDraftOffset] = useState<number>(clip.sourceOffset ?? 0);
    const [draftFadeIn, setDraftFadeIn] = useState<number>(clip.fadeIn ?? 0);
    const [draftFadeOut, setDraftFadeOut] = useState<number>(clip.fadeOut ?? 0);
    const [isPreviewing, setIsPreviewing] = useState(false);

    useEffect(() => setDraftOffset(clip.sourceOffset ?? 0), [clip.id, clip.sourceOffset]);
    useEffect(() => setDraftFadeIn(clip.fadeIn ?? 0), [clip.id, clip.fadeIn]);
    useEffect(() => setDraftFadeOut(clip.fadeOut ?? 0), [clip.id, clip.fadeOut]);

    const commitOffset = useCallback(async (value: number) => {
        const next = Math.max(0, Math.min(maxOffset, Math.round(value)));
        setDraftOffset(next);
        try {
            await engineApi.setClipSourceOffset(clip.id, next);
        } catch (err) {
            console.error('[SampleClipEditor] setClipSourceOffset failed:', err);
        }
    }, [clip.id, maxOffset]);

    const commitFades = useCallback(async (nextFadeIn: number, nextFadeOut: number) => {
        const fadeInFrames = Math.max(0, Math.min(maxFade, Math.round(nextFadeIn)));
        const fadeOutFrames = Math.max(0, Math.min(maxFade, Math.round(nextFadeOut)));
        setDraftFadeIn(fadeInFrames);
        setDraftFadeOut(fadeOutFrames);
        try {
            await engineApi.setClipFades(clip.id, fadeInFrames, fadeOutFrames);
        } catch (err) {
            console.error('[SampleClipEditor] setClipFades failed:', err);
        }
    }, [clip.id, maxFade]);

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

    const beatsPerBar = 4;
    const beatsPerSecond = bpm / 60;
    const clipDurationBeats = Math.max(0.25, clip.durationBeats || ((durationSamples / sampleRate) * beatsPerSecond));
    const gridStep = Math.max(0.0625, divisionToInterval(gridDivision, beatsPerBar, gridTriplet));
    const pxPerBeat = 82 * zoomX;
    const waveformWidth = Math.max(420, Math.round(clipDurationBeats * pxPerBeat));
    const fadeInPx = durationSamples > 0 ? Math.round((draftFadeIn / durationSamples) * waveformWidth) : 0;
    const fadeOutPx = durationSamples > 0 ? Math.round((draftFadeOut / durationSamples) * waveformWidth) : 0;
    const gridLineCount = Math.min(512, Math.ceil(clipDurationBeats / gridStep));
    const fadeLabel = (frames: number) => `${(frames / sampleRate).toFixed(3)}s`;

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
                fontSize: 10,
                fontWeight: 700,
                letterSpacing: '0.05em',
                textTransform: 'uppercase',
            }}>
                <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                    Audio Clip Editor • {clip.name}
                </span>
                <span style={{ fontFamily: 'var(--font-mono)' }}>
                    {clipDurationBeats.toFixed(2)} beats
                </span>
            </div>

            <div style={{
                display: 'flex',
                alignItems: 'center',
                gap: 6,
                flexWrap: 'wrap',
                padding: '6px 10px',
                borderBottom: '1px solid var(--color-divider)',
                background: 'color-mix(in srgb, var(--color-bg-panel) 85%, #000)',
            }}>
                <button type="button" onClick={togglePreview} style={editorButtonStyle}>
                    {isPreviewing ? 'Stop Preview' : 'Preview'}
                </button>
                <button type="button" onClick={() => void commitOffset(draftOffset - 1024)} style={editorButtonStyle}>Offset -1024</button>
                <button type="button" onClick={() => void commitOffset(draftOffset + 1024)} style={editorButtonStyle}>Offset +1024</button>
                <button type="button" onClick={() => void commitOffset(0)} style={editorButtonStyle}>Offset Reset</button>
                <button type="button" onClick={() => void commitFades(0, 0)} style={editorButtonStyle}>Fades Reset</button>
                <div style={{ marginLeft: 'auto', display: 'inline-flex', alignItems: 'center', gap: 6 }}>
                    <span style={editorMetaTextStyle}>Zoom</span>
                    <input
                        type="range"
                        min={0.6}
                        max={4}
                        step={0.1}
                        value={zoomX}
                        onChange={(e) => setZoomX(Number(e.target.value))}
                    />
                    <span style={{ ...editorMetaTextStyle, minWidth: 34 }}>{zoomX.toFixed(1)}x</span>
                </div>
            </div>

            <div style={{
                display: 'grid',
                gridTemplateColumns: '1fr 1fr 1fr',
                gap: 8,
                alignItems: 'center',
                padding: '6px 10px',
                borderBottom: '1px solid var(--color-divider)',
                background: 'color-mix(in srgb, var(--color-bg-panel) 90%, #03070e)',
            }}>
                <label style={editorLabeledControlStyle}>
                    <span style={editorMetaTextStyle}>Source Offset</span>
                    <input
                        type="range"
                        min={0}
                        max={Math.max(1, maxOffset)}
                        value={Math.max(0, Math.min(maxOffset, draftOffset))}
                        onChange={(e) => setDraftOffset(Number(e.target.value))}
                        onMouseUp={() => void commitOffset(draftOffset)}
                        onTouchEnd={() => void commitOffset(draftOffset)}
                        style={{ width: '100%' }}
                    />
                    <span style={editorValueTextStyle}>{(draftOffset / sampleRate).toFixed(3)}s</span>
                </label>
                <label style={editorLabeledControlStyle}>
                    <span style={editorMetaTextStyle}>Fade In</span>
                    <input
                        type="range"
                        min={0}
                        max={Math.max(1, maxFade)}
                        value={Math.max(0, Math.min(maxFade, draftFadeIn))}
                        onChange={(e) => setDraftFadeIn(Number(e.target.value))}
                        onMouseUp={() => void commitFades(draftFadeIn, draftFadeOut)}
                        onTouchEnd={() => void commitFades(draftFadeIn, draftFadeOut)}
                        style={{ width: '100%' }}
                    />
                    <span style={editorValueTextStyle}>{fadeLabel(draftFadeIn)}</span>
                </label>
                <label style={editorLabeledControlStyle}>
                    <span style={editorMetaTextStyle}>Fade Out</span>
                    <input
                        type="range"
                        min={0}
                        max={Math.max(1, maxFade)}
                        value={Math.max(0, Math.min(maxFade, draftFadeOut))}
                        onChange={(e) => setDraftFadeOut(Number(e.target.value))}
                        onMouseUp={() => void commitFades(draftFadeIn, draftFadeOut)}
                        onTouchEnd={() => void commitFades(draftFadeIn, draftFadeOut)}
                        style={{ width: '100%' }}
                    />
                    <span style={editorValueTextStyle}>{fadeLabel(draftFadeOut)}</span>
                </label>
            </div>

            <div style={{
                flex: 1,
                padding: 10,
                display: 'flex',
                flexDirection: 'column',
                gap: 8,
            }}>
                {clip.filePath && durationSamples > 0 && !clip.isOffline ? (
                    <div style={{
                        height: '100%',
                        minHeight: 80,
                        border: '1px solid var(--color-divider)',
                        borderRadius: 4,
                        overflow: 'hidden',
                        background: 'rgba(5, 10, 18, 0.55)',
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
                                    borderBottom: '1px solid rgba(255,255,255,0.08)',
                                    background: 'rgba(9,13,22,0.6)',
                                }}>
                                    {Array.from({ length: gridLineCount }).map((_, i) => {
                                        const beat = i * gridStep;
                                        const x = beat * pxPerBeat;
                                        const isBar = Math.abs((beat / beatsPerBar) - Math.round(beat / beatsPerBar)) < 1e-6;
                                        return (
                                            <div key={`audio-ruler-${i}`} style={{ position: 'absolute', left: x, top: 0, bottom: 0, width: 1, background: isBar ? 'rgba(125,175,255,0.58)' : 'rgba(255,255,255,0.15)' }}>
                                                {isBar && (
                                                    <span style={{ position: 'absolute', top: 2, left: 3, fontSize: 9, color: 'var(--color-text-secondary)', fontFamily: 'var(--font-mono)' }}>
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
                                        sourceOffset={draftOffset}
                                        isSelected
                                    />
                                    {fadeInPx > 0 && (
                                        <div style={{
                                            position: 'absolute',
                                            left: 0,
                                            top: 0,
                                            bottom: 0,
                                            width: fadeInPx,
                                            background: 'linear-gradient(90deg, rgba(255,190,85,0.25) 0%, rgba(255,190,85,0.05) 100%)',
                                            borderRight: '1px solid rgba(255,190,85,0.6)',
                                            pointerEvents: 'none',
                                        }} />
                                    )}
                                    {fadeOutPx > 0 && (
                                        <div style={{
                                            position: 'absolute',
                                            right: 0,
                                            top: 0,
                                            bottom: 0,
                                            width: fadeOutPx,
                                            background: 'linear-gradient(270deg, rgba(255,190,85,0.25) 0%, rgba(255,190,85,0.05) 100%)',
                                            borderLeft: '1px solid rgba(255,190,85,0.6)',
                                            pointerEvents: 'none',
                                        }} />
                                    )}
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
                        fontSize: 12,
                        border: '1px dashed var(--color-divider)',
                        borderRadius: 6,
                    }}>
                        {clip.isOffline ? 'Media offline — resolve file in timeline (double-click clip).' : 'Audio source unavailable'}
                    </div>
                )}
            </div>
        </div>
    );
};

const editorButtonStyle = {
    border: '1px solid var(--color-divider)',
    borderRadius: 4,
    background: 'var(--color-bg-header)',
    color: 'var(--color-text-secondary)',
    fontSize: 10,
    fontWeight: 600,
    padding: '4px 8px',
    cursor: 'pointer',
};

const bottomModeBtnStyle = (active: boolean): CSSProperties => ({
    border: active ? '1px solid color-mix(in srgb, var(--color-accent-primary) 52%, transparent)' : '1px solid transparent',
    borderRadius: 4,
    background: active ? 'var(--color-accent-primary-dim)' : 'transparent',
    color: active ? 'var(--color-text-primary)' : 'var(--color-text-tertiary)',
    fontSize: 10,
    fontWeight: 700,
    letterSpacing: '0.02em',
    padding: '3px 8px',
    cursor: 'pointer',
});

const editorLabeledControlStyle: CSSProperties = {
    display: 'grid',
    gap: 3,
    alignItems: 'center',
};

const editorMetaTextStyle: CSSProperties = {
    fontSize: 10,
    color: 'var(--color-text-tertiary)',
    textTransform: 'uppercase',
    letterSpacing: '0.04em',
    fontWeight: 700,
};

const editorValueTextStyle: CSSProperties = {
    fontSize: 10,
    color: 'var(--color-text-secondary)',
    fontFamily: 'var(--font-mono)',
};
