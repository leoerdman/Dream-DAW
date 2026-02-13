import { useState } from 'react';

/**
 * TransportBar — The center-floating glass pill.
 * 
 * Layout: [Time Display] | [◾ ▶ ⚫] | [BPM] | [CPU]
 * 
 * Uses glass-pill from glass.css for the frosted container.
 * Colors from tokens.css: --color-status-success (play), --color-status-record (rec).
 */

type PlayState = 'stopped' | 'playing' | 'recording';

export const TransportBar = () => {
    const [playState, setPlayState] = useState<PlayState>('stopped');

    const handlePlay = () => {
        setPlayState(prev => prev === 'playing' ? 'stopped' : 'playing');
    };

    const handleStop = () => {
        setPlayState('stopped');
    };

    const handleRecord = () => {
        setPlayState(prev => prev === 'recording' ? 'stopped' : 'recording');
    };

    return (
        <div className="glass-pill h-[48px] px-5 gap-5">

            {/* ── Time Display ── */}
            <div className="flex flex-col items-end min-w-[110px]">
                <div className="font-mono text-lg font-bold leading-none text-text-primary tracking-tight">
                    00:01:24:12
                </div>
                <div className="text-[9px] text-text-tertiary font-semibold tracking-[0.1em] mt-0.5">
                    TIMECODE
                </div>
            </div>

            {/* ── Divider ── */}
            <div className="glass-divider" />

            {/* ── Transport Controls ── */}
            <div className="flex items-center gap-3">
                {/* Stop */}
                <button
                    onClick={handleStop}
                    className="w-8 h-8 flex items-center justify-center rounded-full hover:bg-bg-hover transition-all"
                    title="Stop"
                >
                    <svg width="14" height="14" viewBox="0 0 14 14" fill="currentColor" className="text-text-secondary">
                        <rect x="2" y="2" width="10" height="10" rx="1" />
                    </svg>
                </button>

                {/* Play */}
                <button
                    onClick={handlePlay}
                    className={`w-11 h-11 flex items-center justify-center rounded-full transition-all hover:scale-105 active:scale-95 ${playState === 'playing'
                            ? 'bg-status-success text-white shadow-[0_0_20px_var(--color-accent-primary-glow)]'
                            : 'bg-accent text-white hover:bg-accent-hover'
                        }`}
                    title="Play"
                >
                    <svg width="18" height="18" viewBox="0 0 18 18" fill="currentColor" className="ml-0.5">
                        <polygon points="4,2 16,9 4,16" />
                    </svg>
                </button>

                {/* Record */}
                <button
                    onClick={handleRecord}
                    className={`w-8 h-8 flex items-center justify-center rounded-full transition-all ${playState === 'recording'
                            ? 'bg-status-record text-white animate-pulse'
                            : 'hover:bg-bg-hover text-status-record'
                        }`}
                    title="Record"
                >
                    <svg width="14" height="14" viewBox="0 0 14 14" fill="currentColor">
                        <circle cx="7" cy="7" r="5" />
                    </svg>
                </button>
            </div>

            {/* ── Divider ── */}
            <div className="glass-divider" />

            {/* ── BPM Display ── */}
            <div className="flex flex-col items-end min-w-[70px]">
                <div className="font-mono text-lg font-bold leading-none text-text-primary">
                    128.00
                </div>
                <div className="text-[9px] text-text-tertiary font-semibold tracking-[0.1em] mt-0.5">
                    BPM
                </div>
            </div>

            {/* ── Divider ── */}
            <div className="glass-divider" />

            {/* ── CPU Load ── */}
            <div className="flex items-center gap-2">
                {/* CPU Meter Bar */}
                <div className="flex flex-col items-end gap-0.5">
                    <div className="w-12 h-1 bg-bg-input rounded-full overflow-hidden">
                        <div className="h-full w-[12%] bg-status-success rounded-full transition-all" />
                    </div>
                    <span className="text-[9px] font-mono text-text-tertiary leading-none">CPU 4%</span>
                </div>
            </div>
        </div>
    );
};
