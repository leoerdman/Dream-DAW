import { useState, useEffect, useCallback, useRef, useMemo } from 'react';
import { listen } from '@tauri-apps/api/event';
import { TransportBar } from '@/widgets/TransportBar/TransportBar';
import { AssetBrowser } from '@/widgets/AssetBrowser/AssetBrowser';
import { DeviceRack } from '@/widgets/DeviceRack/DeviceRack';
import { TrackInspector } from '@/widgets/TrackInspector/TrackInspector';
import { StatusBar } from '@/widgets/StatusBar/StatusBar';
import { Timeline } from '@/widgets/Timeline/Timeline';
import type { BrowserDragItem } from '@/widgets/Timeline/Timeline';
import { SettingsPanel } from '@/widgets/SettingsPanel/SettingsPanel';
import { useEngineStore } from '@/shared/stores/useEngineStore';
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
    const [isDragOver, setIsDragOver] = useState(false);
    const importFile = useEngineStore(s => s.importFile);
    const togglePlay = useEngineStore(s => s.togglePlay);
    const importingRef = useRef(false);

    // ── Space bar → Play/Stop ──────────────────────────────────────
    useEffect(() => {
        const handler = (e: KeyboardEvent) => {
            // ⌘, opens Settings
            if (e.metaKey && e.key === ',') {
                e.preventDefault();
                setSettingsOpen(prev => !prev);
                return;
            }

            // Space → Play/Stop (skip when typing in inputs)
            if (e.code === 'Space') {
                const tag = (e.target as HTMLElement)?.tagName;
                if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return;
                e.preventDefault();
                togglePlay();
            }
        };
        window.addEventListener('keydown', handler);
        return () => window.removeEventListener('keydown', handler);
    }, [togglePlay]);

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

    // Seek callback: Timeline click → seek in engine
    const handlePlayheadChange = useCallback((beat: number) => {
        const bpm = transport.bpm || 120;
        const seconds = beat / (bpm / 60);
        engineApi.seekSeconds(seconds);
    }, [transport.bpm]);

    // Drop from AssetBrowser → Timeline
    const handleBrowserDrop = useCallback((item: BrowserDragItem, trackIndex: number, _beat: number) => {
        if (item.path) {
            importFile(item.path, trackIndex);
        } else {
            console.warn(`[DawShell] Browser item '${item.name}' has no file path — demo items cannot be imported yet`);
        }
    }, [importFile]);

    return (
        <div className="relative w-screen h-screen overflow-hidden bg-bg-app text-text-primary">

            {/* ═══ FULL LAYOUT ═══ */}
            <div className="absolute inset-0 z-10 flex flex-col">

                {/* ── TOP: Transport Bar ── */}
                <header className="shrink-0 w-full flex items-center justify-center z-50"
                    style={{ height: 'var(--daw-transport-height)' }}
                >
                    <TransportBar onSettingsClick={openSettings} />
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
                        <AssetBrowser />
                    </aside>

                    {/* ═ TIMELINE (replaces the "hole-punch" transparent zone) ═ */}
                    <div
                        className="flex-1 overflow-hidden"
                        style={{
                            background: 'var(--color-bg-canvas)',
                        }}
                    >
                        <Timeline
                            clips={timelineClips}
                            playheadBeat={playheadBeat}
                            isPlaying={transport.is_playing}
                            trackCount={trackCount}
                            onPlayheadChange={handlePlayheadChange}
                            onDropBrowserItem={handleBrowserDrop}
                        />
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
                        <TrackInspector
                            selectedTrackId={selectedTrackId}
                            onSelectTrack={handleSelectTrack}
                        />
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
                    <DeviceRack selectedTrackId={selectedTrackId} />
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
        </div>
    );
};

export default DawShell;
