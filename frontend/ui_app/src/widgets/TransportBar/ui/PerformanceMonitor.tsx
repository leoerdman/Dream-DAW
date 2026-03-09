/**
 * PerformanceMonitor — Clean, compact CPU / RAM / DSP / MEM display.
 *
 * PERF-OPT: Uses `useEngineStore.subscribe()` + direct DOM mutation instead
 * of selector-driven React re-renders. All metric text updates happen via
 * refs — zero React re-renders at runtime.
 *
 * Design: Clean inline labels with color-coded values. No bars.
 */
import { useEffect, useRef } from 'react';
import { useEngineStore } from '@/shared/stores/useEngineStore';

const CONTAINER_STYLE: React.CSSProperties = {
    display: 'flex',
    alignItems: 'center',
    gap: 14,
    padding: '0 8px',
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
    fontVariantNumeric: 'tabular-nums',
};

const LABEL_STYLE: React.CSSProperties = {
    color: 'var(--color-text-tertiary)',
    fontSize: 'var(--font-size-xs)',
    fontWeight: 600,
    letterSpacing: '0.03em',
};

// ── Color thresholds ────────────────────────────────────────────────────
const COLOR_OK = 'var(--color-status-success)';
const COLOR_WARN = 'var(--color-status-warning)';
const COLOR_CRIT = 'var(--color-status-error)';

function statusColor(pct: number, warnAt: number, errorAt: number): string {
    return pct > errorAt ? COLOR_CRIT : pct > warnAt ? COLOR_WARN : COLOR_OK;
}

/**
 * PERF-OPT: Ref-based performance monitor — subscribes to store outside
 * React render cycle and updates all text via direct DOM mutation.
 * Eliminates 30fps React re-renders for metric displays.
 */
export function PerformanceMonitor() {
    const dspLabelRef = useRef<HTMLSpanElement>(null);
    const dspValueRef = useRef<HTMLSpanElement>(null);
    const cpuValueRef = useRef<HTMLSpanElement>(null);
    const ramValueRef = useRef<HTMLSpanElement>(null);
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
            if (dspLabelRef.current) dspLabelRef.current.style.color = dspColor;
            if (dspValueRef.current) {
                const text = `${dspPct.toFixed(0)}%`;
                if (dspValueRef.current.textContent !== text) dspValueRef.current.textContent = text;
                dspValueRef.current.style.color = dspColor;
            }

            // CPU
            if (cpuValueRef.current) {
                const text = `${cpuPct.toFixed(0)}%`;
                if (cpuValueRef.current.textContent !== text) cpuValueRef.current.textContent = text;
                cpuValueRef.current.style.color = cpuColor;
            }

            // RAM
            if (ramValueRef.current) {
                const text = `${ramPct.toFixed(0)}%`;
                if (ramValueRef.current.textContent !== text) ramValueRef.current.textContent = text;
                ramValueRef.current.style.color = ramColor;
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
        <div style={CONTAINER_STYLE} title="Performance Monitor" id="performance-monitor">
            {/* DSP — audio thread utilization */}
            <div style={{ display: 'flex', alignItems: 'baseline', gap: 4 }}>
                <span ref={dspLabelRef} style={{ ...LABEL_STYLE, color: COLOR_OK }}>DSP</span>
                <span ref={dspValueRef} style={{ color: COLOR_OK }}>0%</span>
            </div>

            {/* CPU */}
            <div style={{ display: 'flex', alignItems: 'baseline', gap: 4 }}>
                <span style={LABEL_STYLE}>CPU</span>
                <span ref={cpuValueRef} style={{ color: COLOR_OK }}>0%</span>
            </div>

            {/* RAM */}
            <div style={{ display: 'flex', alignItems: 'baseline', gap: 4 }}>
                <span style={LABEL_STYLE}>RAM</span>
                <span ref={ramValueRef} style={{ color: COLOR_OK }}>0%</span>
            </div>

            {/* Process memory */}
            <div style={{ display: 'flex', alignItems: 'baseline', gap: 4 }}>
                <span style={LABEL_STYLE}>MEM</span>
                <span ref={memValueRef} style={{ color: 'var(--color-text-secondary)' }}>0M</span>
            </div>
        </div>
    );
}
