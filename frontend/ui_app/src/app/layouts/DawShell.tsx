import { useState, useEffect, useCallback } from 'react';
import { TransportBar } from '@/widgets/TransportBar/TransportBar';
import { AssetBrowser } from '@/widgets/AssetBrowser/AssetBrowser';
import { DeviceRack } from '@/widgets/DeviceRack/DeviceRack';
import { TrackInspector } from '@/widgets/TrackInspector/TrackInspector';
import { StatusBar } from '@/widgets/StatusBar/StatusBar';
import { Timeline } from '@/widgets/Timeline/Timeline';
import { SettingsPanel } from '@/widgets/SettingsPanel/SettingsPanel';

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

    // ⌘, opens Settings
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

    const openSettings = useCallback(() => setSettingsOpen(true), []);
    const handleSelectTrack = useCallback((id: string) => setSelectedTrackId(id), []);

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
                        <Timeline />
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
        </div>
    );
};

export default DawShell;
