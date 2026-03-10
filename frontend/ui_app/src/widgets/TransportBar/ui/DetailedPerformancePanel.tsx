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
import * as engineApi from '@/shared/api/engine';

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
    // Audio Thread diagnostics refs
    const callbackDurationRef = useRef<HTMLSpanElement>(null);
    const callbackMaxRef = useRef<HTMLSpanElement>(null);
    const dspPeakRef = useRef<HTMLSpanElement>(null);
    const xrunCountRef = useRef<HTMLSpanElement>(null);
    const bufferBudgetRef = useRef<HTMLSpanElement>(null);
    const callbackCountRef = useRef<HTMLSpanElement>(null);
    const budgetUtilRef = useRef<HTMLSpanElement>(null);

    // Auto-diagnostics & event log refs
    const diagnosticsRef = useRef<HTMLDivElement>(null);
    const eventLogRef = useRef<HTMLDivElement>(null);
    const prevXrunCountRef = useRef(0);
    const eventLogEntriesRef = useRef<{ time: string; msg: string; severity: 'info' | 'warn' | 'crit' }[]>([]);
    const MAX_LOG_ENTRIES = 50;
    const lastSpikeLogMsRef = useRef(0);
    const DSP_SPIKE_LOG_INTERVAL_MS = 5000; // throttle DSP spike logs to 1 per 5 seconds

    // Close on Escape
    useEffect(() => {
        const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
        window.addEventListener('keydown', onKey);
        return () => window.removeEventListener('keydown', onKey);
    }, [onClose]);

    // Auto-enable RT debug stats (callback timing, callback count) when panel opens.
    // These stats are opt-in because Instant::now() has ~20ns overhead per audio callback.
    // Disable on unmount to avoid unnecessary overhead when monitor is closed.
    useEffect(() => {
        void engineApi.setRtDebugEnabled(true).catch((err) => {
            console.warn('[Dream] setRtDebugEnabled(true) failed:', err);
        });
        return () => {
            void engineApi.setRtDebugEnabled(false).catch((err) => {
                console.warn('[Dream] setRtDebugEnabled(false) failed:', err);
            });
        };
    }, []);

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

            // Audio Thread diagnostics
            const { dspLoadInstant, callbackDurationUs, callbackDurationMaxUs, xrunCount: xruns, callbackCount: cbCount } = state.performance;
            const budgetUs = transport.sample_rate > 0 && transport.output_latency_frames > 0
                ? (transport.output_latency_frames / transport.sample_rate * 1_000_000)
                : 0;
            const budgetUtilPct = budgetUs > 0 ? (callbackDurationUs / budgetUs * 100) : 0;
            if (callbackDurationRef.current) {
                const text = `${callbackDurationUs} µs`;
                if (callbackDurationRef.current.textContent !== text) callbackDurationRef.current.textContent = text;
                callbackDurationRef.current.style.color = budgetUs > 0
                    ? statusColor(budgetUtilPct, 50, 80)
                    : 'var(--color-text-secondary)';
            }
            if (callbackMaxRef.current) {
                const text = `${callbackDurationMaxUs} µs`;
                if (callbackMaxRef.current.textContent !== text) callbackMaxRef.current.textContent = text;
                callbackMaxRef.current.style.color = budgetUs > 0
                    ? statusColor(callbackDurationMaxUs / budgetUs * 100, 50, 80)
                    : 'var(--color-text-secondary)';
            }
            if (dspPeakRef.current) {
                const text = `${dspLoadInstant.toFixed(1)}%`;
                if (dspPeakRef.current.textContent !== text) dspPeakRef.current.textContent = text;
                dspPeakRef.current.style.color = statusColor(Math.min(dspLoadInstant, 100), 50, 80);
            }
            if (xrunCountRef.current) {
                const text = `${xruns}`;
                if (xrunCountRef.current.textContent !== text) xrunCountRef.current.textContent = text;
                xrunCountRef.current.style.color = xruns > 0 ? COLOR_CRIT : 'var(--color-text-secondary)';
            }
            if (bufferBudgetRef.current) {
                const text = budgetUs > 0 ? `${budgetUs.toFixed(0)} µs` : '—';
                if (bufferBudgetRef.current.textContent !== text) bufferBudgetRef.current.textContent = text;
            }
            if (budgetUtilRef.current) {
                const text = budgetUs > 0 ? `${budgetUtilPct.toFixed(1)}%` : '—';
                if (budgetUtilRef.current.textContent !== text) budgetUtilRef.current.textContent = text;
                budgetUtilRef.current.style.color = budgetUs > 0
                    ? statusColor(budgetUtilPct, 50, 80)
                    : 'var(--color-text-secondary)';
            }
            if (callbackCountRef.current) {
                const text = cbCount.toLocaleString();
                if (callbackCountRef.current.textContent !== text) callbackCountRef.current.textContent = text;
            }

            // ── Auto-Diagnostics ──────────────────────────────────────
            const nowStr = new Date().toLocaleTimeString('en-US', { hour12: false, hour: '2-digit', minute: '2-digit', second: '2-digit' });

            // Detect new xruns
            if (xruns > prevXrunCountRef.current) {
                const newXruns = xruns - prevXrunCountRef.current;
                appendLogEntry(eventLogEntriesRef, eventLogRef, MAX_LOG_ENTRIES, {
                    time: nowStr,
                    msg: `Buffer overrun (xrun) × ${newXruns} — DSP ${dspLoadInstant.toFixed(0)}%, callback ${callbackDurationUs}µs/${budgetUs.toFixed(0)}µs`,
                    severity: 'crit',
                });
            }
            prevXrunCountRef.current = xruns;

            // Detect DSP spikes (>90%) — throttled to prevent log flooding at 30Hz tick rate
            const nowMs = performance.now();
            if (dspLoadInstant > 90 && (nowMs - lastSpikeLogMsRef.current) > DSP_SPIKE_LOG_INTERVAL_MS) {
                lastSpikeLogMsRef.current = nowMs;
                appendLogEntry(eventLogEntriesRef, eventLogRef, MAX_LOG_ENTRIES, {
                    time: nowStr,
                    msg: `DSP spike: ${dspLoadInstant.toFixed(1)}% — callback ${callbackDurationUs}µs`,
                    severity: 'warn',
                });
            }

            // Update smart diagnostics panel
            if (diagnosticsRef.current) {
                const alerts: string[] = [];
                if (xruns > 0) {
                    alerts.push(alertHtml('crit', `${xruns} xrun${xruns > 1 ? 's' : ''} detected — audio dropouts occurring. Consider increasing buffer size.`));
                }
                if (dspPct > 80) {
                    alerts.push(alertHtml('warn', `DSP load ${dspPct.toFixed(0)}% — nearing limit. Freeze tracks or increase buffer size.`));
                } else if (dspPct > 60) {
                    alerts.push(alertHtml('info', `DSP load ${dspPct.toFixed(0)}% — moderate. Headroom is limited.`));
                }
                if (budgetUtilPct > 80 && callbackDurationUs > 0) {
                    alerts.push(alertHtml('warn', `Callback uses ${budgetUtilPct.toFixed(0)}% of budget (${callbackDurationUs}µs / ${budgetUs.toFixed(0)}µs).`));
                }
                if (ramPct > 85) {
                    alerts.push(alertHtml('warn', `RAM usage ${ramPct.toFixed(0)}% — close other apps to prevent swapping.`));
                }
                const html = alerts.length > 0
                    ? alerts.join('')
                    : '<div style="color:var(--color-status-success);font-size:11px">✓ All systems nominal</div>';
                if (diagnosticsRef.current.innerHTML !== html) diagnosticsRef.current.innerHTML = html;
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
                    : '<div style="color:var(--color-text-tertiary);font-style:italic">No per-plugin timing (requires sandbox mode)</div>';
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
                        '<div style="color:var(--color-text-tertiary);font-style:italic">No per-plugin timing (requires sandbox mode)</div>';
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
            `DSP Load (Peak): ${perf.dspLoadInstant.toFixed(1)}%`,
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
            `[Audio Thread]`,
            `Callback Duration: ${perf.callbackDurationUs} µs`,
            `Callback Max: ${perf.callbackDurationMaxUs} µs`,
            `Buffer Budget: ${transport.sample_rate > 0 && transport.output_latency_frames > 0 ? (transport.output_latency_frames / transport.sample_rate * 1_000_000).toFixed(0) : '?'} µs`,
            `Xruns: ${perf.xrunCount}`,
            `Total Callbacks: ${perf.callbackCount.toLocaleString()}`,
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
        if (!hasPlugins) lines.push('  No per-plugin timing (requires sandbox mode)');

        lines.push('');
        lines.push(`[Master Bus Load]`);
        const masterUs = meters.master_plugin_metrics.reduce((s, v) => s + v, 0);
        if (masterUs > 0.1) {
            lines.push(`  Master Chain: ${masterUs.toFixed(0)} µs`);
        } else {
            lines.push('  No per-plugin timing (requires sandbox mode)');
        }

        navigator.clipboard.writeText(lines.join('\n')).catch(e => console.error('[Dream] Failed to copy diagnostics:', e));
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

            {/* Smart Diagnostics — auto-detected alerts */}
            <div style={{ ...SECTION_STYLE, padding: '6px 14px' }}>
                <div ref={diagnosticsRef}>
                    <div style={{ color: 'var(--color-text-tertiary)', fontStyle: 'italic', fontSize: 'var(--font-size-2xs)' }}>Analyzing…</div>
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

            {/* Audio Thread Diagnostics */}
            <div style={SECTION_STYLE}>
                <div style={SECTION_TITLE_STYLE}>Audio Thread</div>
                <div style={ROW_STYLE}>
                    <span style={LABEL_STYLE}>Callback Duration</span>
                    <span ref={callbackDurationRef} style={{ ...VALUE_STYLE, color: 'var(--color-text-secondary)' }}>— µs</span>
                </div>
                <div style={ROW_STYLE}>
                    <span style={LABEL_STYLE}>Callback Max</span>
                    <span ref={callbackMaxRef} style={{ ...VALUE_STYLE, color: 'var(--color-text-secondary)' }}>— µs</span>
                </div>
                <div style={ROW_STYLE}>
                    <span style={LABEL_STYLE}>DSP Load (Peak)</span>
                    <span ref={dspPeakRef} style={{ ...VALUE_STYLE, color: 'var(--color-text-secondary)' }}>—</span>
                </div>
                <div style={ROW_STYLE}>
                    <span style={LABEL_STYLE}>Buffer Budget</span>
                    <span ref={bufferBudgetRef} style={{ ...VALUE_STYLE, color: 'var(--color-text-secondary)' }}>—</span>
                </div>
                <div style={ROW_STYLE}>
                    <span style={LABEL_STYLE}>Xruns</span>
                    <span ref={xrunCountRef} style={{ ...VALUE_STYLE, color: 'var(--color-text-secondary)' }}>0</span>
                </div>
                <div style={ROW_STYLE}>
                    <span style={LABEL_STYLE}>Total Callbacks</span>
                    <span ref={callbackCountRef} style={{ ...VALUE_STYLE, color: 'var(--color-text-secondary)' }}>0</span>
                </div>
                <div style={ROW_STYLE}>
                    <span style={LABEL_STYLE}>Budget Utilization</span>
                    <span ref={budgetUtilRef} style={{ ...VALUE_STYLE, color: 'var(--color-text-secondary)' }}>—</span>
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
            <div style={SECTION_STYLE}>
                <div style={SECTION_TITLE_STYLE}>Master Bus Load</div>
                <div ref={masterMetricsRef} style={{ fontSize: 'var(--font-size-2xs)', fontVariantNumeric: 'tabular-nums' }}>
                    <div style={{ color: 'var(--color-text-tertiary)', fontStyle: 'italic' }}>Waiting for data…</div>
                </div>
            </div>

            {/* Event Log — timestamped xrun/spike events */}
            <div style={{ ...SECTION_STYLE, borderBottom: 'none' }}>
                <div style={SECTION_TITLE_STYLE}>Event Log</div>
                <div
                    ref={eventLogRef}
                    style={{
                        fontSize: 'var(--font-size-2xs)',
                        fontVariantNumeric: 'tabular-nums',
                        maxHeight: 120,
                        overflowY: 'auto',
                        fontFamily: 'var(--font-role-data)',
                    }}
                >
                    <div style={{ color: 'var(--color-text-tertiary)', fontStyle: 'italic' }}>No events yet</div>
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

// ── Auto-Diagnostics Helpers ─────────────────────────────────────────────

interface LogEntry { time: string; msg: string; severity: 'info' | 'warn' | 'crit'; }

const SEVERITY_COLORS: Record<string, string> = {
    crit: 'var(--color-status-error)',
    warn: 'var(--color-status-warning)',
    info: 'var(--color-text-tertiary)',
};

const SEVERITY_ICONS: Record<string, string> = {
    crit: '🔴',
    warn: '⚠️',
    info: 'ℹ️',
};

function appendLogEntry(
    entriesRef: React.MutableRefObject<LogEntry[]>,
    containerRef: React.RefObject<HTMLDivElement | null>,
    maxEntries: number,
    entry: LogEntry,
): void {
    entriesRef.current.push(entry);
    if (entriesRef.current.length > maxEntries) {
        entriesRef.current = entriesRef.current.slice(-maxEntries);
    }
    if (containerRef.current) {
        const html = entriesRef.current
            .slice()
            .reverse()
            .map((e) => {
                const color = SEVERITY_COLORS[e.severity] ?? 'var(--color-text-tertiary)';
                const icon = SEVERITY_ICONS[e.severity] ?? '';
                return `<div style="padding:1px 0;color:${color};display:flex;gap:4px;align-items:flex-start">`
                    + `<span style="color:var(--color-text-tertiary);flex-shrink:0">${e.time}</span>`
                    + `<span>${icon} ${escapeHtml(e.msg)}</span>`
                    + `</div>`;
            })
            .join('');
        containerRef.current.innerHTML = html;
        containerRef.current.scrollTop = 0;
    }
}

function alertHtml(severity: 'crit' | 'warn' | 'info', msg: string): string {
    const color = SEVERITY_COLORS[severity] ?? 'var(--color-text-tertiary)';
    const icon = SEVERITY_ICONS[severity] ?? '';
    return `<div style="color:${color};font-size:11px;padding:1px 0;display:flex;gap:4px;align-items:flex-start">`
        + `<span style="flex-shrink:0">${icon}</span>`
        + `<span>${escapeHtml(msg)}</span>`
        + `</div>`;
}
