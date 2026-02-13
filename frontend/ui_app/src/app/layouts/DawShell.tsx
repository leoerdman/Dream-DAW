import React from 'react';
import { TransportBar } from '@/widgets/TransportBar';
import { AssetBrowser } from '@/widgets/AssetBrowser';
import { PluginMixer } from '@/widgets/PluginMixer';

export const DawShell = () => {
    return (
        <div className="app-shell dark relative w-screen h-screen overflow-hidden bg-[var(--color-bg-app)]">
            {/* 
         LAYER 0: WebGPU TIMELINE (The "Hole")
         This sits at z-0. The React layer above will have a transparent center
         allowing this canvas to be interacted with directly if we manage pointer events right,
         OR we treat this as pure display and capture events on a transparent div above.
         For Hole-Punch, we usually want the canvas to be visible.
      */}
            <div
                id="webgpu-canvas-container"
                className="absolute inset-0 w-full h-full z-0 bg-[var(--color-bg-canvas)]"
            >
                {/* Placeholder for Rust/WebGPU Canvas */}
                <div className="absolute inset-0 flex items-center justify-center text-[var(--color-text-tertiary)] opacity-20 pointer-events-none">
                    <h1 className="text-9xl font-black tracking-tighter">WebGPU</h1>
                </div>
            </div>

            {/* 
         LAYER 1: REACT OVERLAY (The "Glass")
         z-index 10. pointer-events-none by default so clicks pass through to canvas
         where there are no UI elements.
      */}
            <div className="absolute inset-0 z-10 flex flex-col pointer-events-none">

                {/* Top Navigation - Pointer Events Auto */}
                <div className="pointer-events-auto">
                    <TransportBar />
                </div>

                {/* Main Workspace Area */}
                <div className="flex flex-1 overflow-hidden pt-[var(--layout-header-height)]">

                    {/* Left Sidebar - Pointer Events Auto */}
                    <div className="pointer-events-auto h-full z-20 shadow-[var(--shadow-sidebar)]">
                        {/* Asset Browser / Tools */}
                        <AssetBrowser />
                    </div>

                    {/* 
             CENTER "HOLE" 
             Transparent. No pointer events (they fall through to WebGPU).
             Unless we need a transparent capture layer here.
          */}
                    <div className="flex-1 bg-transparent pointer-events-none relative">
                        {/* Floating Notifications or localized overlays could go here */}
                    </div>

                    {/* Right Sidebar (Inspector) - Placeholder */}
                    <div className="pointer-events-auto h-full z-20 w-[280px] border-l border-[var(--color-border-subtle)] bg-[var(--color-bg-panel-adjacent)] backdrop-blur-[var(--glass-blur)] hidden xl:flex flex-col">
                        <div className="h-10 border-b border-[var(--color-border-subtle)] flex items-center px-4 font-semibold text-xs text-[var(--color-text-secondary)] uppercase">
                            Inspector
                        </div>
                        {/* Inspector Content */}
                    </div>
                </div>

                {/* Bottom Panel (Mixer / Editor) - Pointer Events Auto */}
                <div className="pointer-events-auto h-[32vh] w-full z-20 bg-[var(--color-bg-panel-adjacent)] border-t border-[var(--color-border-subtle)] backdrop-blur-[var(--glass-blur)] shadow-[var(--shadow-lg)]">
                    <PluginMixer />
                </div>

            </div>
        </div>
    );
};

export default DawShell;
