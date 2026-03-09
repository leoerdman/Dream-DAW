/**
 * PerformanceMonitor — Compact CPU / RAM / DSP display for the transport bar.
 *
 * PERF-OPT: Uses `useEngineStore.subscribe()` + direct DOM mutation instead
 * of selector-driven React re-renders. Performance metrics update at ~1/s
 * from the Rust telemetry thread via sysinfo, but the `performance` object
 * in the store was replaced on every telemetry_tick (~30fps). The old
 * `useShallow(s => s.performance)` caused 30fps re-renders for 5 simple text
 * metrics that only need ~1fps visual updates.
 *
 * Design: Ableton-style compact meters with animated bars.
 */
import React, { useEffect, useRef } from 'react';
import { useEngineStore } from '@/shared/stores/useEngineStore';

const CONTAINER_STYLE: React.CSSProperties = {
    display: 'flex',
    alignItems: 'center',
    gap: 8,
    padding: '0 6px',
    height: 22,
    borderRadius: 'var(--radius-md)',
    background: 'color-mix(in srgb, var(--color-bg-secondary) 60%, transparent)',
    border: '1px solid color-mix(in srgb, var(--color-border) 30%, transparent)',
    fontSize: 'var(--font-size-xs)',
    fontFamily: 'var(--font-role-data)',
    fontWeight: 500,
    color: 'var(--color-text-secondary)',
    userSelect: 'none',
    flexShrink: 0,
};

const STAT_CONTAINER_STYLE: React.CSSProperties = { display: 'flex', alignItems: 'center', gap: 3 };
const STAT_LABEL_STYLE: React.CSSProperties = { color: 'var(--color-text-tertiary)', fontSize: 'var(--font-size-2xs)', letterSpacing: '0.02em' };
const STAT_VALUE_STYLE: React.CSSProperties = { minWidth: 28, textAlign: 'right', fontVariantNumeric: 'tabular-nums' };
const MICRO_BAR_BG = 'color-mix(in srgb, var(--color-bg-tertiary) 70%, transparent)';

// ── Color thresholds ────────────────────────────────────────────────────
const COLOR_SUCCESS = 'var(--color-status-success)';
const COLOR_WARNING = 'var(--color-status-warning)';
const COLOR_ERROR = 'var(--color-status-error)';

function statusColor(pct: number, warnAt: number, errorAt: number): string {
    return pct > errorAt ? COLOR_ERROR : pct > warnAt ? COLOR_WARNING : COLOR_SUCCESS;
}

/**
 * PERF-OPT: Ref-based performance monitor — subscribes to store outside
 * React render cycle and updates all text + bar widths via direct DOM mutation.
 * Eliminates 30fps React re-renders for 5 metric displays.
 */
export function PerformanceMonitor() {
    // DSP refs
    const dspLabelRef = useRef<HTMLSpanElement>(null);
    const dspValueRef = useRef<HTMLSpanElement>(null);
    const dspBarRef = useRef<HTMLDivElement>(null);
    // CPU refs
    const cpuValueRef = useRef<HTMLSpanElement>(null);
    const cpuBarRef = useRef<HTMLDivElement>(null);
    // RAM refs
    const ramValueRef = useRef<HTMLSpanElement>(null);
    const ramBarRef = useRef<HTMLDivElement>(null);
    // MEM ref
    const memValueRef = useRef<HTMLSpanElement>(null);

    useEffect(() => {
        const unsub = useEngineStore.subscribe((state) => {
            const { cpuUsage, ramUsedMb, ramTotalMb, processMemoryMb, dspLoad } = state.performance;

            const dspPct = Math.min(100, Math.max(0, dspLoad));
            const cpuPct = Math.min(100, Math.max(0, cpuUsage));
            const ramPct = ramTotalMb > 0 ? Math.min(100, (ramUsedMb / ramTotalMb) * 100) : 0;

            const dspColor = statusColor(dspPct, 50, 80);
            const cpuColor = statusColor(cpuPct, 50, 80);
            const ramColor = statusColor(ramPct, 65, 85);

            // DSP
            if (dspLabelRef.current) {
                dspLabelRef.current.style.color = dspColor;
            }
            if (dspValueRef.current) {
                const text = `${dspPct.toFixed(0)}%`;
                if (dspValueRef.current.textContent !== text) dspValueRef.current.textContent = text;
                dspValueRef.current.style.color = dspColor;
            }
            if (dspBarRef.current) {
                dspBarRef.current.style.width = `${dspPct}%`;
                dspBarRef.current.style.background = dspColor;
                dspBarRef.current.style.boxShadow = `0 0 4px color-mix(in srgb, ${dspColor} 40%, transparent)`;
            }

            // CPU
            if (cpuValueRef.current) {
                const text = `${cpuPct.toFixed(0)}%`;
                if (cpuValueRef.current.textContent !== text) cpuValueRef.current.textContent = text;
                cpuValueRef.current.style.color = cpuColor;
            }
            if (cpuBarRef.current) {
                cpuBarRef.current.style.width = `${cpuPct}%`;
                cpuBarRef.current.style.background = cpuColor;
                cpuBarRef.current.style.boxShadow = `0 0 4px color-mix(in srgb, ${cpuColor} 40%, transparent)`;
            }

            // RAM
            if (ramValueRef.current) {
                const text = `${ramPct.toFixed(0)}%`;
                if (ramValueRef.current.textContent !== text) ramValueRef.current.textContent = text;
                ramValueRef.current.style.color = ramColor;
            }
            if (ramBarRef.current) {
                ramBarRef.current.style.width = `${ramPct}%`;
                ramBarRef.current.style.background = ramColor;
                ramBarRef.current.style.boxShadow = `0 0 4px color-mix(in srgb, ${ramColor} 40%, transparent)`;
            }

            // MEM
            if (memValueRef.current) {
                const text = processMemoryMb > 1024
                    ? `${(processMemoryMb / 1024).toFixed(1)}G`
                    : `${processMemoryMb}M`;
                if (memValueRef.current.textContent !== text) memValueRef.current.textContent = text;
            }
        });
        return unsub;
    }, []);

    return (
        <div style={CONTAINER_STYLE} title="Performance Monitor">
            {/* DSP load — the #1 DAW metric: audio thread utilization */}
            <div style={STAT_CONTAINER_STYLE}>
                <span ref={dspLabelRef} style={{ color: COLOR_SUCCESS, fontSize: 'var(--font-size-2xs)', fontWeight: 600, letterSpacing: '0.02em' }}>DSP</span>
                <MicroBar barRef={dspBarRef} width={36} />
                <span ref={dspValueRef} style={{ ...STAT_VALUE_STYLE, color: COLOR_SUCCESS }}>0%</span>
            </div>

            {/* CPU meter */}
            <div style={STAT_CONTAINER_STYLE}>
                <span style={STAT_LABEL_STYLE}>CPU</span>
                <MicroBar barRef={cpuBarRef} width={30} />
                <span ref={cpuValueRef} style={{ ...STAT_VALUE_STYLE, color: COLOR_SUCCESS }}>0%</span>
            </div>

            {/* RAM meter */}
            <div style={STAT_CONTAINER_STYLE}>
                <span style={STAT_LABEL_STYLE}>RAM</span>
                <MicroBar barRef={ramBarRef} width={30} />
                <span ref={ramValueRef} style={{ ...STAT_VALUE_STYLE, color: COLOR_SUCCESS }}>0%</span>
            </div>

            {/* Process memory */}
            <div style={STAT_CONTAINER_STYLE}>
                <span style={STAT_LABEL_STYLE}>MEM</span>
                <span ref={memValueRef} style={{ fontVariantNumeric: 'tabular-nums', color: 'var(--color-text-secondary)' }}>
                    0M
                </span>
            </div>
        </div>
    );
}

/** Tiny horizontal bar meter — ref-driven for PERF-OPT */
function MicroBar({ barRef, width = 30 }: { barRef: React.RefObject<HTMLDivElement | null>; width?: number }) {
    return (
        <div
            style={{
                width,
                height: 6,
                borderRadius: 'var(--radius-sm)',
                background: MICRO_BAR_BG,
                overflow: 'hidden',
                position: 'relative',
            }}
        >
            <div
                ref={barRef}
                style={{
                    position: 'absolute',
                    top: 0,
                    left: 0,
                    height: '100%',
                    width: '0%',
                    borderRadius: 'var(--radius-sm)',
                    background: COLOR_SUCCESS,
                    transition: 'width 600ms cubic-bezier(0.22, 1, 0.36, 1), background 300ms ease, box-shadow 300ms ease',
                    boxShadow: `0 0 4px color-mix(in srgb, ${COLOR_SUCCESS} 40%, transparent)`,
                }}
            />
        </div>
    );
}
