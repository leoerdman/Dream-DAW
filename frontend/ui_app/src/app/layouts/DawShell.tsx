import { TransportBar } from '@/widgets/TransportBar/TransportBar';
import { AssetBrowser } from '@/widgets/AssetBrowser/AssetBrowser';
import { DeviceRack } from '@/widgets/DeviceRack/DeviceRack';
import { TrackInspector } from '@/widgets/TrackInspector/TrackInspector';

/**
 * DawShell — The "Hole-Punch" Architecture Layout.
 * 
 * Layer 0 (z-0):  WebGPU Timeline Canvas — Rust/WASM renders audio waveforms at 144Hz.
 * Layer 1 (z-10): React UI Overlay — pointer-events-none container that lets clicks
 *                 fall through to the canvas where no UI panels exist.
 * 
 * Glass panels (sidebar, inspector, transport, device rack) re-enable pointer-events
 * so they capture mouse clicks in their areas.
 * 
 * The center of the screen is the "hole" — transparent, no pointer events,
 * directly exposing the WebGPU canvas beneath.
 */
export const DawShell = () => {
    return (
        <div className="relative w-screen h-screen overflow-hidden bg-bg-app text-text-primary">

            {/* ═══ LAYER 0: WEBGPU TIMELINE (Rust Backend) ═══ */}
            <div
                id="webgpu-timeline-canvas"
                className="absolute inset-0 z-0 bg-bg-canvas"
            >
                {/* Placeholder: Rust/WASM will mount a 144Hz WebGPU canvas here */}
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
                <header className="h-[var(--daw-transport-height)] shrink-0 w-full flex items-center justify-center pointer-events-none z-50 pt-3">
                    <div className="pointer-events-auto">
                        <TransportBar />
                    </div>
                </header>

                {/* ── CENTER: Split Layout ── */}
                <main className="flex flex-1 overflow-hidden p-3 gap-3">

                    {/* Left Sidebar (Asset Browser) */}
                    <aside className="w-[var(--daw-sidebar-width)] shrink-0 pointer-events-auto h-full z-40 flex flex-col glass-panel shadow-panel overflow-hidden">
                        <AssetBrowser />
                    </aside>

                    {/* THE HOLE-PUNCH: Transparent zone → clicks fall to WebGPU */}
                    <div className="flex-1 bg-transparent pointer-events-none" />

                    {/* Right Sidebar (Track Inspector) */}
                    <aside className="w-[var(--daw-inspector-width)] shrink-0 pointer-events-auto h-full z-40 flex flex-col glass-panel shadow-panel overflow-hidden">
                        <TrackInspector />
                    </aside>
                </main>

                {/* ── BOTTOM: Device Rack ── */}
                <footer className="h-[var(--daw-device-rack-height)] min-h-[var(--daw-device-rack-min-height)] shrink-0 pointer-events-auto z-40 mx-3 mb-3 glass-panel shadow-panel overflow-hidden">
                    <DeviceRack />
                </footer>

            </div>
        </div>
    );
};

export default DawShell;
