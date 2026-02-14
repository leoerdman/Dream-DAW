import { useState, useEffect, useCallback, useRef, useMemo } from 'react';
import { listen } from '@tauri-apps/api/event';
import { TransportBar } from '@/widgets/TransportBar/TransportBar';
import { useKeyboardShortcuts } from '@/shared/hooks/useKeyboardShortcuts';
import { useProjectManager } from '@/shared/hooks/useProjectManager';
import { ErrorBoundary } from '@/shared/ui/ErrorBoundary';
import { AssetBrowser } from '@/widgets/AssetBrowser/AssetBrowser';
import { DeviceRack } from '@/widgets/DeviceRack/DeviceRack';
import { TrackInspector } from '@/widgets/TrackInspector/TrackInspector';
import { StatusBar } from '@/widgets/StatusBar/StatusBar';
import { Timeline } from '@/widgets/Timeline/Timeline';
import type { BrowserDragItem } from '@/widgets/Timeline/Timeline';
import { SettingsPanel } from '@/widgets/SettingsPanel/SettingsPanel';
import { DragOverlay } from '@/widgets/DragOverlay/DragOverlay';
import { useEngineStore } from '@/shared/stores/useEngineStore';
import { useDragStore } from '@/shared/stores/useDragStore';
import { useGridStore } from '@/shared/stores/useGridStore';
import { ExportDialog } from '@/widgets/ExportDialog/ExportDialog';
import * as engineApi from '@/shared/api/engine';

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
    const [settingsOpen, setSettingsOpen] = useState(false);
    const [selectedTrackId, setSelectedTrackId] = useState('g-drums');
    const [selectedClipId, setSelectedClipId] = useState<string | null>(null);
    const [isDragOver, setIsDragOver] = useState(false);
    const [exportOpen, setExportOpen] = useState(false);
    const importFile = useEngineStore(s => s.importFile);
    const createMidiClip = useEngineStore(s => s.createMidiClip);
    const togglePlay = useEngineStore(s => s.togglePlay);
    const fetchProject = useEngineStore(s => s.fetchProject);
    const importingRef = useRef(false);
    const timelineRef = useRef<HTMLDivElement>(null);

    // ── Enterprise Project Manager (Cmd+S/⇧S/N/O, auto-backup, dirty state)
    // Hook has side effects (keyboard shortcuts, auto-backup timer) — value intentionally unused
    useProjectManager(fetchProject);

    // ── Global Keyboard Shortcuts (Space, Cmd+E, Delete) ──
    useKeyboardShortcuts({
        selectedClipId,
        playheadFrames: Math.round(
            (useEngineStore.getState().transport.position_seconds ?? 0) *
            (useEngineStore.getState().projectSampleRate ?? 44100)
        ),
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
        };
        window.addEventListener('keydown', handler);
        return () => window.removeEventListener('keydown', handler);
    }, []);

    // ── Store-based Drag → mouseup on Timeline imports audio ───────
    useEffect(() => {
        const handleGlobalMouseUp = (e: MouseEvent) => {
            const dragging = useDragStore.getState().draggingItem;
            if (!dragging) return;

            // Always end the drag
            useDragStore.getState().endDrag();

            // Check if cursor is over the Timeline area
            const tl = timelineRef.current;
            if (!tl) return;
            const rect = tl.getBoundingClientRect();
            const isOverTimeline =
                e.clientX >= rect.left && e.clientX <= rect.right &&
                e.clientY >= rect.top && e.clientY <= rect.bottom;

            if (!isOverTimeline) {
                console.log('[DawShell] Drag cancelled — not over Timeline');
                return;
            }

            // Read live values from stores (not stale closures)
            const state = useEngineStore.getState();
            const currentTrackCount = state.projectTracks.length || 9;

            // Calculate track index and beat from cursor position
            const y = e.clientY - rect.top;
            const x = e.clientX - rect.left;
            const trackIndex = Math.min(Math.floor(y / TRACK_HEIGHT), currentTrackCount - 1);

            // Pixels per beat (synchronized with Timeline's calculation)
            const ppb = 40; // matches Timeline default pixelsPerBeat
            const rawBeat = x / ppb;
            const beat = Math.max(0, useGridStore.getState().snapBeat(rawBeat, 4)); // magnetic snap

            console.log('[DawShell] Store-drag drop on Timeline', {
                name: dragging.name,
                path: dragging.path,
                trackIndex,
                beat,
            });

            if (dragging.path && dragging.type === 'audio') {
                const bpm = state.transport.bpm || 120;
                const sr = state.projectSampleRate || 44100;
                const posSeconds = beat / (bpm / 60);
                const positionFrames = Math.round(posSeconds * sr);
                state.importFile(dragging.path, trackIndex, positionFrames);
            }
        };

        window.addEventListener('mouseup', handleGlobalMouseUp);
        return () => window.removeEventListener('mouseup', handleGlobalMouseUp);
    }, []);

    // ── Tauri Drag & Drop → Import Audio ───────────────────────────
    useEffect(() => {
        let unlisten: (() => void) | undefined;

        const setup = async () => {
            // Listen for drag hover (visual feedback) — only for OS file drops, not in-app drags
            const unlistenHover = await listen('tauri://drag-over', () => {
                if (!(window as any).__dreamInAppDrag) {
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

    // ── Engine state for Timeline ───────────────────────────────────
    const transport = useEngineStore(s => s.transport);
    const timelineClips = useEngineStore(s => s.timelineClips);
    const projectTracks = useEngineStore(s => s.projectTracks);

    // Convert position_seconds → beats using BPM
    const playheadBeat = useMemo(() => {
        const bpm = transport.bpm || 120;
        return transport.position_seconds * (bpm / 60);
    }, [transport.position_seconds, transport.bpm]);

    const trackCount = Math.max(projectTracks.length, 8);

    // ── Shared layout constants (SSOT for height sync) ──────────────
    const TRACK_HEIGHT = 48;
    const RULER_HEIGHT = 24;

    // ── Scroll sync between Timeline and TrackInspector ─────────────
    const [timelineScrollTop, setTimelineScrollTop] = useState(0);
    const handleTimelineScrollTop = useCallback((st: number) => {
        setTimelineScrollTop(st);
    }, []);

    // Seek callback: Timeline click → seek in engine
    const handlePlayheadChange = useCallback((beat: number) => {
        const bpm = transport.bpm || 120;
        const seconds = beat / (bpm / 60);
        engineApi.seekSeconds(seconds);
    }, [transport.bpm]);

    // Clip selection callback
    const handleClipSelect = useCallback((clipId: string) => {
        setSelectedClipId(clipId);
    }, []);

    // Drop from AssetBrowser → Timeline
    const handleBrowserDrop = useCallback((item: BrowserDragItem, trackIndex: number, beat: number) => {
        console.log('[DawShell] handleBrowserDrop', { item, trackIndex, beat });
        if (item.path) {
            // Convert drop beat → sample frames so the clip lands at the exact drop position
            const bpm = transport.bpm || 120;
            const sr = useEngineStore.getState().projectSampleRate || 44100;
            const posSeconds = beat / (bpm / 60);
            const positionFrames = Math.round(posSeconds * sr);
            importFile(item.path, trackIndex, positionFrames);
        } else {
            console.error(`[DawShell] Cannot import '${item.name}': no file path (demo items are not real files)`);
        }
    }, [importFile, transport.bpm]);

    // Double-click on track lane → create 1-bar MIDI clip
    const handleDoubleClickTrack = useCallback((trackIndex: number, beat: number) => {
        console.log('[DawShell] handleDoubleClickTrack', { trackIndex, beat });
        const bpm = transport.bpm || 120;
        const sr = useEngineStore.getState().projectSampleRate || 44100;
        const beatsPerBar = 4; // 4/4 time signature
        const posSeconds = beat / (bpm / 60);
        const barSeconds = beatsPerBar / (bpm / 60);
        const positionFrames = Math.round(posSeconds * sr);
        const durationFrames = Math.round(barSeconds * sr);
        createMidiClip(trackIndex, positionFrames, durationFrames);
    }, [createMidiClip, transport.bpm]);

    // Clip drag → move clip to new position in engine (syncs audio with visual)
    const handleClipMove = useCallback((clipId: string, newStartBeat: number, newTrackIndex: number) => {
        const bpm = transport.bpm || 120;
        const sr = useEngineStore.getState().projectSampleRate || 44100;
        const posSeconds = newStartBeat / (bpm / 60);
        const newPositionFrames = Math.round(posSeconds * sr);

        engineApi.moveClip(clipId, newTrackIndex, newPositionFrames)
            .then(() => {
                console.log('[DawShell] Clip moved', { clipId, newTrackIndex, newStartBeat, newPositionFrames });
                fetchProject(); // Refresh project state to reflect new position
            })
            .catch(err => console.error('[DawShell] moveClip failed:', err));
    }, [transport.bpm, fetchProject]);

    return (
        <div className="relative w-screen h-screen overflow-hidden bg-bg-app text-text-primary">

            {/* ═══ FULL LAYOUT ═══ */}
            <div className="absolute inset-0 z-10 flex flex-col">

                {/* ── TOP: Transport Bar ── */}
                <header className="shrink-0 w-full flex items-center justify-center z-50"
                    style={{ height: 'var(--daw-transport-height)' }}
                >
                    <ErrorBoundary module="Transport">
                        <TransportBar onSettingsClick={openSettings} />
                    </ErrorBoundary>
                </header>

                {/* ── CENTER: Split Layout (Browser | Timeline | TrackList) ── */}
                <main className="flex flex-1 overflow-hidden" style={{ gap: 0 }}>

                    {/* Left Sidebar (Asset Browser) */}
                    <aside
                        className="shrink-0 h-full z-40 flex flex-col overflow-hidden"
                        style={{
                            width: 'var(--daw-sidebar-width)',
                            background: 'var(--color-bg-panel)',
                            borderRight: '1px solid var(--color-divider)',
                        }}
                    >
                        <ErrorBoundary module="Asset Browser">
                            <AssetBrowser />
                        </ErrorBoundary>
                    </aside>

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
                                clips={timelineClips}
                                playheadBeat={playheadBeat}
                                isPlaying={transport.is_playing}
                                trackCount={trackCount}
                                trackHeight={TRACK_HEIGHT}
                                onPlayheadChange={handlePlayheadChange}
                                onClipSelect={handleClipSelect}
                                onClipMove={handleClipMove}
                                onDropBrowserItem={handleBrowserDrop}
                                onDoubleClickTrack={handleDoubleClickTrack}
                                onScrollTop={handleTimelineScrollTop}
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
                            />
                        </ErrorBoundary>
                    </aside>
                </main>

                {/* ── BOTTOM: Device Rack ── */}
                <footer
                    className="shrink-0 z-40 overflow-hidden"
                    style={{
                        height: 'var(--daw-device-rack-height)',
                        minHeight: 'var(--daw-device-rack-min-height)',
                        borderTop: '1px solid var(--color-divider)',
                    }}
                >
                    <ErrorBoundary module="Device Rack">
                        <DeviceRack selectedTrackId={selectedTrackId} />
                    </ErrorBoundary>
                </footer>

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
            {/* Store-based drag overlay — floating label following cursor */}
            <DragOverlay />

            {/* ── Export Dialog ── */}
            <ExportDialog
                isOpen={exportOpen}
                onClose={() => setExportOpen(false)}
                onExport={(settings) => {
                    console.log('[DawShell] Exporting with settings:', settings);
                    setExportOpen(false);
                }}
                projectName="My Project"
            />
        </div>
    );
};

export default DawShell;
