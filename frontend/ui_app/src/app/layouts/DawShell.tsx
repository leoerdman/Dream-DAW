import { TransportBar } from '@/widgets/TransportBar/TransportBar';
import { AssetBrowser } from '@/widgets/AssetBrowser/AssetBrowser';
import { DeviceRack } from '@/widgets/DeviceRack/DeviceRack';
import { TrackInspector } from '@/widgets/TrackInspector/TrackInspector';
import { StatusBar } from '@/widgets/StatusBar/StatusBar';

/**
 * DawShell — The "Hole-Punch Architecture" Layout.
 * 
 * Ported from MainWindowController.swift → ArrangementViewController layout:
 * 
 *   ┌─────────────────────────────────────────────────┐
 *   │                  TransportBar                    │  ← 32px
 *   ├──────────┬────────────────────────┬─────────────┤
 *   │          │                        │             │
 *   │  Asset   │   WebGPU Timeline      │   Track     │
 *   │ Browser  │   (Hole-Punch)         │  Inspector  │
 *   │          │                        │             │
 *   ├──────────┴────────────────────────┴─────────────┤
 *   │                  DeviceRack                      │  ← 160-200px
 *   ├─────────────────────────────────────────────────┤
 *   │                  StatusBar                       │  ← 20px
 *   └─────────────────────────────────────────────────┘
 * 
 * Layer 0 (z-0):  WebGPU Timeline Canvas (Rust/WASM at 144Hz)
 * Layer 1 (z-10): React UI Overlay (pointer-events-none)
 * Glass panels re-enable pointer-events for mouse capture.
 */
export const DawShell = () => {
    return (
        <div className="relative w-screen h-screen overflow-hidden bg-bg-app text-text-primary">

            {/* ═══ LAYER 0: WEBGPU TIMELINE (Rust Backend) ═══ */}
            <div
                id="webgpu-timeline-canvas"
                className="absolute inset-0 z-0 bg-bg-canvas"
            >
                {/* Placeholder until Rust/WASM mounts */}
                <div className="absolute inset-0 flex items-center justify-center pointer-events-none select-none">
                    <div className="flex flex-col items-center gap-3 opacity-[0.07]">
                        <svg width="120" height="120" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="0.5" className="text-text-primary">
                            <polygon points="5 3 19 12 5 21 5 3" />
                        </svg>
                        <span className="text-6xl font-black tracking-[-0.05em] text-text-primary">
                            DREAM DAW
                        </span>
                    </div>
                </div>
            </div>

            {/* ═══ LAYER 1: REACT UI (Hole-Punch Overlay) ═══ */}
            <div className="absolute inset-0 z-10 flex flex-col pointer-events-none">

                {/* ── TOP: Transport Bar ── */}
                <header className="shrink-0 w-full flex items-center justify-center pointer-events-none z-50"
                    style={{ height: 'var(--daw-transport-height)' }}
                >
                    <div className="pointer-events-auto">
                        <TransportBar />
                    </div>
                </header>

                {/* ── CENTER: Split Layout (Browser | Timeline Hole | TrackList) ── */}
                <main className="flex flex-1 overflow-hidden" style={{ gap: 0 }}>

                    {/* Left Sidebar (Asset Browser) */}
                    <aside
                        className="shrink-0 pointer-events-auto h-full z-40 flex flex-col overflow-hidden"
                        style={{
                            width: 'var(--daw-sidebar-width)',
                            background: 'var(--color-bg-panel)',
                            borderRight: '1px solid var(--color-divider)',
                        }}
                    >
                        <AssetBrowser />
                    </aside>

                    {/* THE HOLE-PUNCH: Transparent zone → clicks fall to WebGPU */}
                    <div className="flex-1 bg-transparent pointer-events-none" />

                    {/* Right Sidebar (Track Inspector / Track List) */}
                    <aside
                        className="shrink-0 pointer-events-auto h-full z-40 flex flex-col overflow-hidden"
                        style={{
                            width: 'var(--daw-inspector-width)',
                            background: 'var(--color-bg-panel)',
                            borderLeft: '1px solid var(--color-divider)',
                        }}
                    >
                        <TrackInspector />
                    </aside>
                </main>

                {/* ── BOTTOM: Device Rack ── */}
                <footer
                    className="shrink-0 pointer-events-auto z-40 overflow-hidden"
                    style={{
                        height: 'var(--daw-device-rack-height)',
                        minHeight: 'var(--daw-device-rack-min-height)',
                        borderTop: '1px solid var(--color-divider)',
                    }}
                >
                    <DeviceRack />
                </footer>

                {/* ── VERY BOTTOM: Status Bar ── */}
                <div className="pointer-events-auto z-50">
                    <StatusBar />
                </div>

            </div>
        </div>
    );
};

export default DawShell;
