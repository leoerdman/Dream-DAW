/**
 * DetailedPerformancePanel — Enterprise real-time performance diagnostics.
 *
 * Opens from a monitor button in the transport bar. Shows:
 * - System metrics: DSP, CPU, RAM, Process MEM
 * - Audio thread stats: callback duration, buffer size, sample rate
 * - Per-track plugin load (from track_plugin_metrics)
 * - Master bus plugin load (from master_plugin_metrics)
 *
 * PERF-OPT: All text updates happen via direct DOM mutation (refs).
 * Zero React re-renders at runtime after initial mount.
 */
import { useEffect, useRef } from 'react';
import { useEngineStore } from '@/shared/stores/useEngineStore';
import { getMetersRef } from '@/shared/stores/useEngineStore';

// ── Styles ──────────────────────────────────────────────────────────────

const PANEL_STYLE: React.CSSProperties = {
    position: 'fixed',
    top: 48,
    right: 12,
    width: 340,
    maxHeight: 'calc(100vh - 64px)',
    overflowY: 'auto',
    background: 'var(--color-bg-primary)',
    border: '1px solid var(--color-border)',
    borderRadius: 'var(--radius-lg)',
    boxShadow: '0 8px 32px rgba(0,0,0,0.4), 0 2px 8px rgba(0,0,0,0.3)',
    zIndex: 9999,
    padding: 0,
    fontFamily: 'var(--font-role-data)',
    fontSize: 'var(--font-size-xs)',
    color: 'var(--color-text-primary)',
    userSelect: 'none',
};

const HEADER_STYLE: React.CSSProperties = {
    padding: '10px 14px',
    borderBottom: '1px solid var(--color-border)',
    fontWeight: 700,
    fontSize: 'var(--font-size-sm)',
    color: 'var(--color-text-primary)',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
};

const SECTION_STYLE: React.CSSProperties = {
    padding: '8px 14px',
    borderBottom: '1px solid color-mix(in srgb, var(--color-border) 50%, transparent)',
};

const SECTION_TITLE_STYLE: React.CSSProperties = {
    fontSize: 'var(--font-size-2xs)',
    fontWeight: 700,
    color: 'var(--color-text-tertiary)',
    textTransform: 'uppercase',
    letterSpacing: '0.08em',
    marginBottom: 6,
};

const ROW_STYLE: React.CSSProperties = {
    display: 'flex',
    justifyContent: 'space-between',
    alignItems: 'center',
    padding: '2px 0',
    fontVariantNumeric: 'tabular-nums',
};

const LABEL_STYLE: React.CSSProperties = {
    color: 'var(--color-text-secondary)',
    fontSize: 'var(--font-size-xs)',
};

const VALUE_STYLE: React.CSSProperties = {
    fontWeight: 600,
    fontSize: 'var(--font-size-xs)',
    minWidth: 52,
    textAlign: 'right',
};

const BAR_BG_STYLE: React.CSSProperties = {
    width: 80,
    height: 4,
    borderRadius: 2,
    background: 'color-mix(in srgb, var(--color-bg-tertiary) 80%, transparent)',
    overflow: 'hidden',
    position: 'relative',
    flexShrink: 0,
};

const BAR_FILL_STYLE: React.CSSProperties = {
    position: 'absolute',
    top: 0,
    left: 0,
    height: '100%',
    borderRadius: 2,
    transition: 'width 300ms ease, background 300ms ease',
};

const COLOR_OK = 'var(--color-status-success)';
const COLOR_WARN = 'var(--color-status-warning)';
const COLOR_CRIT = 'var(--color-status-error)';

function statusColor(pct: number, warnAt = 50, errorAt = 80): string {
    return pct > errorAt ? COLOR_CRIT : pct > warnAt ? COLOR_WARN : COLOR_OK;
}

// ── Component ───────────────────────────────────────────────────────────

interface Props {
    onClose: () => void;
}

export function DetailedPerformancePanel({ onClose }: Props) {
    // System metrics refs
    const dspValueRef = useRef<HTMLSpanElement>(null);
    const dspBarRef = useRef<HTMLDivElement>(null);
    const cpuValueRef = useRef<HTMLSpanElement>(null);
    const cpuBarRef = useRef<HTMLDivElement>(null);
    const ramValueRef = useRef<HTMLSpanElement>(null);
    const ramBarRef = useRef<HTMLDivElement>(null);
    const ramDetailRef = useRef<HTMLSpanElement>(null);
    const memValueRef = useRef<HTMLSpanElement>(null);

    // Audio engine refs
    const sampleRateRef = useRef<HTMLSpanElement>(null);
    const latencyRef = useRef<HTMLSpanElement>(null);
    const trackCountRef = useRef<HTMLSpanElement>(null);
    const clipCountRef = useRef<HTMLSpanElement>(null);

    // Plugin & Sandbox refs
    const pluginMetricsRef = useRef<HTMLDivElement>(null);
    const masterMetricsRef = useRef<HTMLDivElement>(null);
    const sandboxStatsRef = useRef<HTMLSpanElement>(null);
    const cpuCoresRef = useRef<HTMLDivElement>(null);

    // Close on Escape
    useEffect(() => {
        const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
        window.addEventListener('keydown', onKey);
        return () => window.removeEventListener('keydown', onKey);
    }, [onClose]);

    // Subscribe to performance data
    useEffect(() => {
        const unsub = useEngineStore.subscribe((state) => {
            const { cpuUsage, cpuPerCore, ramUsedMb, ramTotalMb, processMemoryMb, dspLoad } = state.performance;
            const transport = state.transport;
            const sandbox = state.pluginSandbox;

            const dspPct = Math.min(100, Math.max(0, dspLoad));
            const cpuPct = Math.min(100, Math.max(0, cpuUsage));
            const ramPct = ramTotalMb > 0 ? Math.min(100, (ramUsedMb / ramTotalMb) * 100) : 0;

            // DSP
            updateMetric(dspValueRef, `${dspPct.toFixed(1)}%`, statusColor(dspPct));
            updateBar(dspBarRef, dspPct, statusColor(dspPct));

            // CPU
            updateMetric(cpuValueRef, `${cpuPct.toFixed(1)}%`, statusColor(cpuPct));
            updateBar(cpuBarRef, cpuPct, statusColor(cpuPct));
            if (cpuCoresRef.current) {
                const lines = cpuPerCore.map((c, i) => {
                    const color = statusColor(c, 50, 80);
                    return `<div style="display:flex;justify-content:space-between;padding:1px 0">` +
                        `<span style="color:var(--color-text-secondary)">Core ${i}</span>` +
                        `<span style="color:${color};font-weight:600;min-width:40px;text-align:right">${c.toFixed(0)}%</span>` +
                        `</div>`;
                });
                const html = lines.length > 0
                    ? `<div style="display:grid;grid-template-columns:1fr 1fr;gap:0 12px;margin-top:6px">` + lines.join('') + `</div>`
                    : '';
                if (cpuCoresRef.current.innerHTML !== html) {
                    cpuCoresRef.current.innerHTML = html;
                }
            }

            // RAM
            updateMetric(ramValueRef, `${ramPct.toFixed(1)}%`, statusColor(ramPct, 65, 85));
            updateBar(ramBarRef, ramPct, statusColor(ramPct, 65, 85));
            if (ramDetailRef.current) {
                const text = `${ramUsedMb.toLocaleString()} / ${ramTotalMb.toLocaleString()} MB`;
                if (ramDetailRef.current.textContent !== text) ramDetailRef.current.textContent = text;
            }

            // MEM
            if (memValueRef.current) {
                const text = processMemoryMb > 1024
                    ? `${(processMemoryMb / 1024).toFixed(2)} GB`
                    : `${processMemoryMb} MB`;
                if (memValueRef.current.textContent !== text) memValueRef.current.textContent = text;
            }

            // Audio engine info
            if (sampleRateRef.current) {
                const text = `${(transport.sample_rate / 1000).toFixed(1)} kHz`;
                if (sampleRateRef.current.textContent !== text) sampleRateRef.current.textContent = text;
            }
            if (latencyRef.current) {
                const latencyMs = transport.sample_rate > 0
                    ? (transport.output_latency_frames / transport.sample_rate * 1000).toFixed(1)
                    : '?';
                const text = `${latencyMs} ms (${transport.output_latency_frames} samples)`;
                if (latencyRef.current.textContent !== text) latencyRef.current.textContent = text;
            }

            // Track & clip counts
            if (trackCountRef.current) {
                const text = `${state.tracks.allIds.length}`;
                if (trackCountRef.current.textContent !== text) trackCountRef.current.textContent = text;
            }
            if (clipCountRef.current) {
                const text = `${state.clips.allIds.length}`;
                if (clipCountRef.current.textContent !== text) clipCountRef.current.textContent = text;
            }

            // Sandbox Stats
            if (sandboxStatsRef.current) {
                if (!sandbox || !sandbox.enabled) {
                    const text = 'Disabled (In-process)';
                    if (sandboxStatsRef.current.textContent !== text) sandboxStatsRef.current.textContent = text;
                } else {
                    let running = 0; let crashed = 0; let bypassed = 0; let other = 0;
                    for (const inst of sandbox.instances) {
                        if (inst.bypass_requested) bypassed++;
                        else if (inst.status === 'running') running++;
                        else if (inst.status === 'crashed') crashed++;
                        else other++;
                    }
                    const text = `${running} running, ${crashed} crashed, ${bypassed} bypassed` + (other > 0 ? `, ${other} starting` : '');
                    if (sandboxStatsRef.current.textContent !== text) sandboxStatsRef.current.textContent = text;
                }
            }

            // Per-track plugin metrics
            const meters = getMetersRef();
            if (pluginMetricsRef.current && meters.track_plugin_metrics.length > 0) {
                const lines: string[] = [];
                const trackIds = state.tracks.allIds;
                for (let ti = 0; ti < meters.track_plugin_metrics.length && ti < trackIds.length; ti++) {
                    const slots = meters.track_plugin_metrics[ti];
                    const totalUs = slots.reduce((s, v) => s + v, 0);
                    if (totalUs < 0.1) continue; // Skip inactive tracks
                    const trackName = state.tracks.byId[trackIds[ti]]?.name ?? `Track ${ti + 1}`;
                    const pct = transport.sample_rate > 0
                        ? (totalUs / (transport.output_latency_frames / transport.sample_rate * 1_000_000) * 100)
                        : 0;
                    const color = statusColor(pct, 30, 60);
                    lines.push(
                        `<div style="display:flex;justify-content:space-between;padding:1px 0">` +
                        `<span style="color:var(--color-text-secondary);overflow:hidden;text-overflow:ellipsis;white-space:nowrap;max-width:180px">${escapeHtml(trackName)}</span>` +
                        `<span style="color:${color};font-weight:600;min-width:60px;text-align:right">${totalUs.toFixed(0)} µs</span>` +
                        `</div>`
                    );
                }
                pluginMetricsRef.current.innerHTML = lines.length > 0
                    ? lines.join('')
                    : '<div style="color:var(--color-text-tertiary);font-style:italic">No active plugins</div>';
            }

            // Master bus plugin metrics
            if (masterMetricsRef.current && meters.master_plugin_metrics.length > 0) {
                const totalUs = meters.master_plugin_metrics.reduce((s, v) => s + v, 0);
                if (totalUs > 0.1) {
                    const pct = transport.sample_rate > 0
                        ? (totalUs / (transport.output_latency_frames / transport.sample_rate * 1_000_000) * 100)
                        : 0;
                    const color = statusColor(pct, 30, 60);
                    masterMetricsRef.current.innerHTML =
                        `<div style="display:flex;justify-content:space-between;padding:1px 0">` +
                        `<span style="color:var(--color-text-secondary)">Master Chain</span>` +
                        `<span style="color:${color};font-weight:600;min-width:60px;text-align:right">${totalUs.toFixed(0)} µs</span>` +
                        `</div>`;
                } else {
                    masterMetricsRef.current.innerHTML =
                        '<div style="color:var(--color-text-tertiary);font-style:italic">No active master plugins</div>';
                }
            }
        });
        return unsub;
    }, []);

    const handleCopy = () => {
        const state = useEngineStore.getState();
        const perf = state.performance;
        const transport = state.transport;
        const sandbox = state.pluginSandbox;
        const meters = getMetersRef();

        let sandboxStr = 'Disabled';
        if (sandbox && sandbox.enabled) {
            let running = 0; let crashed = 0; let bypassed = 0; let other = 0;
            for (const inst of sandbox.instances) {
                if (inst.bypass_requested) bypassed++;
                else if (inst.status === 'running') running++;
                else if (inst.status === 'crashed') crashed++;
                else other++;
            }
            sandboxStr = `${running} running, ${crashed} crashed, ${bypassed} bypassed, ${other} starting`;
        }

        const lines = [
            `--- Dream DAW Diagnostics ---`,
            `Time: ${new Date().toISOString()}`,
            ``,
            `[System]`,
            `DSP Load: ${perf.dspLoad.toFixed(1)}%`,
            `CPU Usage: ${perf.cpuUsage.toFixed(1)}%`,
            `RAM Usage: ${perf.ramUsedMb.toLocaleString()} / ${perf.ramTotalMb.toLocaleString()} MB`,
            `Process Memory: ${(perf.processMemoryMb / 1024).toFixed(2)} GB`,
            ...perf.cpuPerCore.map((c, i) => `  Core ${i}: ${c.toFixed(1)}%`),
            ``,
            `[Audio Engine]`,
            `Sample Rate: ${(transport.sample_rate / 1000).toFixed(1)} kHz`,
            `Output Latency: ${transport.sample_rate > 0 ? (transport.output_latency_frames / transport.sample_rate * 1000).toFixed(1) : '?'} ms (${transport.output_latency_frames} samples)`,
            `Tracks: ${state.tracks.allIds.length}`,
            `Clips: ${state.clips.allIds.length}`,
            ``,
            `[Plugin Sandbox]`,
            `Status: ${sandboxStr}`,
            ``,
            `[Track Plugin Load]`
        ];

        let hasPlugins = false;
        const trackIds = state.tracks.allIds;
        for (let ti = 0; ti < meters.track_plugin_metrics.length && ti < trackIds.length; ti++) {
            const slots = meters.track_plugin_metrics[ti];
            const totalUs = slots.reduce((s, v) => s + v, 0);
            if (totalUs < 0.1) continue;
            hasPlugins = true;
            const trackName = state.tracks.byId[trackIds[ti]]?.name ?? `Track ${ti + 1}`;
            lines.push(`  ${trackName}: ${totalUs.toFixed(0)} µs`);
        }
        if (!hasPlugins) lines.push('  No active track plugins');

        lines.push('');
        lines.push(`[Master Bus Load]`);
        const masterUs = meters.master_plugin_metrics.reduce((s, v) => s + v, 0);
        if (masterUs > 0.1) {
            lines.push(`  Master Chain: ${masterUs.toFixed(0)} µs`);
        } else {
            lines.push('  No active master plugins');
        }

        navigator.clipboard.writeText(lines.join('\\n')).catch(e => console.error('Failed to copy', e));
    };

    return (
        <div style={PANEL_STYLE} id="detailed-performance-panel">
            <div style={HEADER_STYLE}>
                <span>⚡ Performance Monitor</span>
                <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                    <button
                        onClick={handleCopy}
                        title="Copy diagnostic text"
                        style={{
                            background: 'none',
                            border: 'none',
                            color: 'var(--color-primary)',
                            cursor: 'pointer',
                            fontSize: 12,
                            fontWeight: 600,
                            padding: '2px 8px',
                            borderRadius: 'var(--radius-sm)',
                        }}
                    >Copy</button>
                    <button
                        onClick={onClose}
                        title="Close (Esc)"
                        style={{
                            background: 'none',
                            border: 'none',
                            color: 'var(--color-text-tertiary)',
                            cursor: 'pointer',
                            fontSize: 16,
                            padding: '0 2px',
                            lineHeight: 1,
                        }}
                    >✕</button>
                </div>
            </div>

            {/* System Metrics */}
            <div style={SECTION_STYLE}>
                <div style={SECTION_TITLE_STYLE}>System</div>
                <MetricRow label="DSP Load" valueRef={dspValueRef} barRef={dspBarRef} />
                <MetricRow label="CPU Usage" valueRef={cpuValueRef} barRef={cpuBarRef} />
                <MetricRow label="RAM Usage" valueRef={ramValueRef} barRef={ramBarRef} />
                <div style={{ ...ROW_STYLE, marginTop: 2 }}>
                    <span style={{ ...LABEL_STYLE, fontSize: 'var(--font-size-2xs)' }}>System RAM</span>
                    <span ref={ramDetailRef} style={{ ...VALUE_STYLE, color: 'var(--color-text-tertiary)', fontSize: 'var(--font-size-2xs)', minWidth: 120 }}>— / — MB</span>
                </div>
                <div style={ROW_STYLE}>
                    <span style={LABEL_STYLE}>Process Memory</span>
                    <span ref={memValueRef} style={{ ...VALUE_STYLE, color: 'var(--color-text-secondary)' }}>—</span>
                </div>
                <div ref={cpuCoresRef} style={{ fontSize: 'var(--font-size-2xs)', fontVariantNumeric: 'tabular-nums' }}></div>
            </div>

            {/* Audio Engine */}
            <div style={SECTION_STYLE}>
                <div style={SECTION_TITLE_STYLE}>Audio Engine</div>
                <div style={ROW_STYLE}>
                    <span style={LABEL_STYLE}>Sample Rate</span>
                    <span ref={sampleRateRef} style={{ ...VALUE_STYLE, color: 'var(--color-text-secondary)' }}>—</span>
                </div>
                <div style={ROW_STYLE}>
                    <span style={LABEL_STYLE}>Output Latency</span>
                    <span ref={latencyRef} style={{ ...VALUE_STYLE, color: 'var(--color-text-secondary)', minWidth: 120 }}>—</span>
                </div>
                <div style={ROW_STYLE}>
                    <span style={LABEL_STYLE}>Tracks</span>
                    <span ref={trackCountRef} style={{ ...VALUE_STYLE, color: 'var(--color-text-secondary)' }}>0</span>
                </div>
                <div style={ROW_STYLE}>
                    <span style={LABEL_STYLE}>Clips</span>
                    <span ref={clipCountRef} style={{ ...VALUE_STYLE, color: 'var(--color-text-secondary)' }}>0</span>
                </div>
            </div>

            {/* Plugin Sandbox */}
            <div style={SECTION_STYLE}>
                <div style={SECTION_TITLE_STYLE}>Plugin Sandbox</div>
                <div style={ROW_STYLE}>
                    <span style={LABEL_STYLE}>Status</span>
                    <span ref={sandboxStatsRef} style={{ ...VALUE_STYLE, color: 'var(--color-text-secondary)' }}>Disabled</span>
                </div>
            </div>

            {/* Per-Track Plugin Load */}
            <div style={SECTION_STYLE}>
                <div style={SECTION_TITLE_STYLE}>Track Plugin Load</div>
                <div ref={pluginMetricsRef} style={{ fontSize: 'var(--font-size-2xs)', fontVariantNumeric: 'tabular-nums' }}>
                    <div style={{ color: 'var(--color-text-tertiary)', fontStyle: 'italic' }}>Waiting for data…</div>
                </div>
            </div>

            {/* Master Bus Load */}
            <div style={{ ...SECTION_STYLE, borderBottom: 'none' }}>
                <div style={SECTION_TITLE_STYLE}>Master Bus Load</div>
                <div ref={masterMetricsRef} style={{ fontSize: 'var(--font-size-2xs)', fontVariantNumeric: 'tabular-nums' }}>
                    <div style={{ color: 'var(--color-text-tertiary)', fontStyle: 'italic' }}>Waiting for data…</div>
                </div>
            </div>
        </div>
    );
}

// ── Helpers ─────────────────────────────────────────────────────────────

function MetricRow({ label, valueRef, barRef }: {
    label: string;
    valueRef: React.RefObject<HTMLSpanElement | null>;
    barRef: React.RefObject<HTMLDivElement | null>;
}) {
    return (
        <div style={ROW_STYLE}>
            <span style={LABEL_STYLE}>{label}</span>
            <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                <div style={BAR_BG_STYLE}>
                    <div ref={barRef} style={{ ...BAR_FILL_STYLE, width: '0%', background: COLOR_OK }} />
                </div>
                <span ref={valueRef} style={{ ...VALUE_STYLE, color: COLOR_OK }}>0%</span>
            </div>
        </div>
    );
}

function updateMetric(ref: React.RefObject<HTMLSpanElement | null>, text: string, color: string) {
    if (!ref.current) return;
    if (ref.current.textContent !== text) ref.current.textContent = text;
    ref.current.style.color = color;
}

function updateBar(ref: React.RefObject<HTMLDivElement | null>, pct: number, color: string) {
    if (!ref.current) return;
    ref.current.style.width = `${pct}%`;
    ref.current.style.background = color;
}

function escapeHtml(str: string): string {
    return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}
