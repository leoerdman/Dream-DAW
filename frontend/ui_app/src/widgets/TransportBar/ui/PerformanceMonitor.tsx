import React from 'react';
import { useEngineStore } from '@/shared/stores/useEngineStore';
import { useShallow } from 'zustand/react/shallow';

const CONTAINER_STYLE: React.CSSProperties = {
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
};

const STAT_CONTAINER_STYLE: React.CSSProperties = { display: 'flex', alignItems: 'center', gap: 3 };
const STAT_LABEL_STYLE: React.CSSProperties = { color: 'var(--color-text-tertiary)', fontSize: 9, letterSpacing: '0.02em' };
const STAT_VALUE_STYLE: React.CSSProperties = { minWidth: 28, textAlign: 'right', fontVariantNumeric: 'tabular-nums' };

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
            style={CONTAINER_STYLE}
            title={`DSP: ${dspPercent.toFixed(1)}% (audio thread load)\nCPU: ${cpuPercent.toFixed(1)}%\nRAM: ${ramUsedMb.toLocaleString()} / ${ramTotalMb.toLocaleString()} MB (${ramPercent.toFixed(0)}%)\nProcess: ${processMemoryMb.toLocaleString()} MB`}
        >
            {/* DSP load — the #1 DAW metric: audio thread utilization */}
            <div style={STAT_CONTAINER_STYLE}>
                <span style={{ color: dspColor, fontSize: 9, fontWeight: 600, letterSpacing: '0.02em' }}>DSP</span>
                <MicroBar percent={dspPercent} color={dspColor} width={36} />
                <span style={{ ...STAT_VALUE_STYLE, color: dspColor }}>
                    {dspPercent.toFixed(0)}%
                </span>
            </div>

            {/* CPU meter */}
            <div style={STAT_CONTAINER_STYLE}>
                <span style={STAT_LABEL_STYLE}>CPU</span>
                <MicroBar percent={cpuPercent} color={cpuColor} />
                <span style={{ ...STAT_VALUE_STYLE, color: cpuColor }}>
                    {cpuPercent.toFixed(0)}%
                </span>
            </div>

            {/* RAM meter */}
            <div style={STAT_CONTAINER_STYLE}>
                <span style={STAT_LABEL_STYLE}>RAM</span>
                <MicroBar percent={ramPercent} color={ramColor} />
                <span style={{ ...STAT_VALUE_STYLE, color: ramColor }}>
                    {ramPercent.toFixed(0)}%
                </span>
            </div>

            {/* Process memory */}
            <div style={STAT_CONTAINER_STYLE}>
                <span style={STAT_LABEL_STYLE}>MEM</span>
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
