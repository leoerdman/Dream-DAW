import React from 'react';
import { Play, Square, Circle, Settings, Activity } from 'lucide-react'; // Assuming lucide-react or similar icon set

export const TransportBar = () => {
    return (
        <header className="topbar">
            {/* Left Pill: Breadcrumbs / Project Name */}
            <div className="topbar-pill pointer-events-auto">
                <div className="font-semibold text-[var(--color-text-primary)]">Dream DAW Project</div>
                <span className="text-[var(--color-text-tertiary)]">/</span>
                <span className="text-[var(--color-text-secondary)]">Mastering</span>
            </div>

            {/* Center Pill: Transport Controls */}
            <div className="topbar-pill pointer-events-auto !gap-6 px-6">
                <button className="text-[var(--color-text-secondary)] hover:text-[var(--color-text-primary)] transition-colors">
                    <Settings size={18} />
                </button>

                <div className="flex items-center gap-4">
                    {/* Stop */}
                    <button className="w-8 h-8 flex items-center justify-center rounded-full hover:bg-[var(--color-bg-hover)] text-[var(--color-text-secondary)] transition-all">
                        <Square size={16} fill="currentColor" />
                    </button>

                    {/* Play */}
                    <button className="w-12 h-12 flex items-center justify-center rounded-full bg-[var(--color-accent-primary)] text-white hover:bg-[var(--color-accent-primary-hover)] shadow-[var(--shadow-button-glow)] transition-all hover:scale-105 active:scale-95">
                        <Play size={20} fill="currentColor" className="ml-1" />
                    </button>

                    {/* Record */}
                    <button className="w-8 h-8 flex items-center justify-center rounded-full hover:bg-[var(--color-bg-hover)] text-[var(--color-accent-red)] transition-all">
                        <Circle size={16} fill="currentColor" />
                    </button>
                </div>

                {/* Time / BPM */}
                <div className="flex flex-col items-end min-w-[80px]">
                    <div className="font-mono text-lg font-bold leading-none text-[var(--color-text-primary)]">128.00</div>
                    <div className="text-[10px] text-[var(--color-text-tertiary)] font-medium tracking-wide">BPM</div>
                </div>

                <div className="w-[1px] h-8 bg-[var(--color-border-subtle)]" />

                <div className="flex flex-col items-end min-w-[100px]">
                    <div className="font-mono text-lg font-bold leading-none text-[var(--color-text-primary)]">00:01:24</div>
                    <div className="text-[10px] text-[var(--color-text-tertiary)] font-medium tracking-wide">TIME</div>
                </div>
            </div>

            {/* Right Pill: User / System */}
            <div className="topbar-pill pointer-events-auto">
                <div className="flex items-center gap-2 text-[var(--color-accent-green)]">
                    <Activity size={14} />
                    <span className="text-xs font-mono">CPU 4%</span>
                </div>
                <div className="w-8 h-8 rounded-full bg-[var(--color-bg-input)] border border-[var(--color-border-subtle)]" />
            </div>
        </header>
    );
};
