import { useEngineStore } from '@/shared/stores/useEngineStore';
import { useShallow } from 'zustand/react/shallow';

/**
 * Compact CPU / RAM performance monitor for the transport bar.
 *
 * Reads system metrics from the engine store (updated ~1/s from
 * the Rust telemetry thread via sysinfo).
 *
 * Design: Ableton-style compact meters with animated bars.
 */
export function PerformanceMonitor() {
    const { cpuUsage, ramUsedMb, ramTotalMb, processMemoryMb, dspLoad } = useEngineStore(
        useShallow((s) => s.performance),
    );

    const dspPercent = Math.min(100, Math.max(0, dspLoad));
    const cpuPercent = Math.min(100, Math.max(0, cpuUsage));
    const ramPercent = ramTotalMb > 0 ? Math.min(100, (ramUsedMb / ramTotalMb) * 100) : 0;

    const dspColor = dspPercent > 80 ? 'var(--color-status-error)' : dspPercent > 50 ? 'var(--color-status-warning)' : 'var(--color-status-success)';
    const cpuColor = cpuPercent > 80 ? 'var(--color-status-error)' : cpuPercent > 50 ? 'var(--color-status-warning)' : 'var(--color-status-success)';
    const ramColor = ramPercent > 85 ? 'var(--color-status-error)' : ramPercent > 65 ? 'var(--color-status-warning)' : 'var(--color-status-success)';

    return (
        <div
            style={{
                display: 'flex',
                alignItems: 'center',
                gap: 8,
                padding: '0 6px',
                height: 22,
                borderRadius: 4,
                background: 'color-mix(in srgb, var(--color-bg-secondary) 60%, transparent)',
                border: '1px solid color-mix(in srgb, var(--color-border) 30%, transparent)',
                fontSize: 10,
                fontFamily: 'var(--font-role-data)',
                fontWeight: 500,
                color: 'var(--color-text-secondary)',
                userSelect: 'none',
                flexShrink: 0,
            }}
            title={`DSP: ${dspPercent.toFixed(1)}% (audio thread load)\nCPU: ${cpuPercent.toFixed(1)}%\nRAM: ${ramUsedMb.toLocaleString()} / ${ramTotalMb.toLocaleString()} MB (${ramPercent.toFixed(0)}%)\nProcess: ${processMemoryMb.toLocaleString()} MB`}
        >
            {/* DSP load — the #1 DAW metric: audio thread utilization */}
            <div style={{ display: 'flex', alignItems: 'center', gap: 3 }}>
                <span style={{ color: dspColor, fontSize: 9, fontWeight: 600, letterSpacing: '0.02em' }}>DSP</span>
                <MicroBar percent={dspPercent} color={dspColor} width={36} />
                <span style={{ minWidth: 28, textAlign: 'right', color: dspColor, fontVariantNumeric: 'tabular-nums' }}>
                    {dspPercent.toFixed(0)}%
                </span>
            </div>

            {/* CPU meter */}
            <div style={{ display: 'flex', alignItems: 'center', gap: 3 }}>
                <span style={{ color: 'var(--color-text-tertiary)', fontSize: 9, letterSpacing: '0.02em' }}>CPU</span>
                <MicroBar percent={cpuPercent} color={cpuColor} />
                <span style={{ minWidth: 28, textAlign: 'right', color: cpuColor, fontVariantNumeric: 'tabular-nums' }}>
                    {cpuPercent.toFixed(0)}%
                </span>
            </div>

            {/* RAM meter */}
            <div style={{ display: 'flex', alignItems: 'center', gap: 3 }}>
                <span style={{ color: 'var(--color-text-tertiary)', fontSize: 9, letterSpacing: '0.02em' }}>RAM</span>
                <MicroBar percent={ramPercent} color={ramColor} />
                <span style={{ minWidth: 28, textAlign: 'right', color: ramColor, fontVariantNumeric: 'tabular-nums' }}>
                    {ramPercent.toFixed(0)}%
                </span>
            </div>

            {/* Process memory */}
            <div style={{ display: 'flex', alignItems: 'center', gap: 3 }}>
                <span style={{ color: 'var(--color-text-tertiary)', fontSize: 9, letterSpacing: '0.02em' }}>MEM</span>
                <span style={{ fontVariantNumeric: 'tabular-nums', color: 'var(--color-text-secondary)' }}>
                    {processMemoryMb > 1024
                        ? `${(processMemoryMb / 1024).toFixed(1)}G`
                        : `${processMemoryMb}M`}
                </span>
            </div>
        </div>
    );
}

/** Tiny horizontal bar meter — configurable width, 6px tall */
function MicroBar({ percent, color, width = 30 }: { percent: number; color: string; width?: number }) {
    return (
        <div
            style={{
                width,
                height: 6,
                borderRadius: 3,
                background: 'color-mix(in srgb, var(--color-bg-tertiary) 70%, transparent)',
                overflow: 'hidden',
                position: 'relative',
            }}
        >
            <div
                style={{
                    position: 'absolute',
                    top: 0,
                    left: 0,
                    height: '100%',
                    width: `${percent}%`,
                    borderRadius: 3,
                    background: color,
                    transition: 'width 600ms cubic-bezier(0.22, 1, 0.36, 1), background 300ms ease',
                    boxShadow: `0 0 4px color-mix(in srgb, ${color} 40%, transparent)`,
                }}
            />
        </div>
    );
}
