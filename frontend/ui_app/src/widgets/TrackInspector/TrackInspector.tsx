/**
 * TrackInspector — Right sidebar for track properties.
 * 
 * Shows: Track name, Volume, Pan, Send levels, I/O routing.
 * This is a placeholder that will be connected to the Rust engine state.
 */

export const TrackInspector = () => {
    return (
        <div className="flex flex-col h-full">

            {/* ── Header ── */}
            <div className="h-11 flex items-center px-4 border-b border-border-subtle shrink-0">
                <span className="text-xs font-semibold text-text-secondary uppercase tracking-[0.08em]">
                    Inspector
                </span>
            </div>

            {/* ── Track Info ── */}
            <div className="p-4 border-b border-border-subtle">
                <div className="text-sm font-semibold text-text-primary mb-1">Track 01</div>
                <div className="text-xs text-text-tertiary">Audio • Stereo</div>
            </div>

            {/* ── Volume / Pan ── */}
            <div className="p-4 border-b border-border-subtle flex flex-col gap-4">
                {/* Volume */}
                <div className="flex flex-col gap-1.5">
                    <div className="flex justify-between items-center">
                        <span className="text-[10px] text-text-tertiary uppercase tracking-[0.08em] font-semibold">Volume</span>
                        <span className="text-xs font-mono text-text-secondary">-6.2 dB</span>
                    </div>
                    <div className="w-full h-1.5 bg-bg-input rounded-full overflow-hidden">
                        <div className="h-full w-[72%] bg-accent rounded-full" />
                    </div>
                </div>

                {/* Pan */}
                <div className="flex flex-col gap-1.5">
                    <div className="flex justify-between items-center">
                        <span className="text-[10px] text-text-tertiary uppercase tracking-[0.08em] font-semibold">Pan</span>
                        <span className="text-xs font-mono text-text-secondary">C</span>
                    </div>
                    <div className="w-full h-1.5 bg-bg-input rounded-full overflow-hidden relative">
                        <div className="absolute left-1/2 top-0 h-full w-[2px] bg-accent rounded-full" />
                    </div>
                </div>
            </div>

            {/* ── Sends ── */}
            <div className="p-4 border-b border-border-subtle flex flex-col gap-3">
                <span className="text-[10px] text-text-tertiary uppercase tracking-[0.08em] font-semibold">Sends</span>

                {/* Send A */}
                <div className="flex items-center gap-2">
                    <div className="w-2.5 h-2.5 rounded-full bg-port-audio" />
                    <span className="text-xs text-text-secondary flex-1">Send A → Reverb</span>
                    <span className="text-[10px] font-mono text-text-tertiary">-12.0</span>
                </div>

                {/* Send B */}
                <div className="flex items-center gap-2">
                    <div className="w-2.5 h-2.5 rounded-full bg-port-midi" />
                    <span className="text-xs text-text-secondary flex-1">Send B → Delay</span>
                    <span className="text-[10px] font-mono text-text-tertiary">-18.0</span>
                </div>
            </div>

            {/* ── I/O Routing ── */}
            <div className="p-4 flex flex-col gap-3">
                <span className="text-[10px] text-text-tertiary uppercase tracking-[0.08em] font-semibold">I/O Routing</span>

                <div className="flex flex-col gap-2">
                    <div className="flex items-center justify-between">
                        <span className="text-xs text-text-tertiary">Input</span>
                        <span className="text-xs text-text-secondary font-mono">In 1-2</span>
                    </div>
                    <div className="flex items-center justify-between">
                        <span className="text-xs text-text-tertiary">Output</span>
                        <span className="text-xs text-text-secondary font-mono">Master</span>
                    </div>
                </div>
            </div>

            {/* ── Spacer ── */}
            <div className="flex-1" />

            {/* ── Footer ── */}
            <div className="h-7 flex items-center px-3 border-t border-border-subtle text-[10px] text-text-tertiary font-mono shrink-0">
                44.1 kHz • 24bit
            </div>
        </div>
    );
};
