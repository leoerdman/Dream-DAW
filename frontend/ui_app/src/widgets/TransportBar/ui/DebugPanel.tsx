import type * as engineApi from '@/shared/api/engine';
import { RefreshCw, X } from 'lucide-react';
import type { CSSProperties, MouseEvent, MutableRefObject } from 'react';

type DebugTab = 'overview' | 'pdc' | 'sandbox';

interface DebugPanelProps {
    panelRef: MutableRefObject<HTMLDivElement | null>;
    panelPos: { right: number; top: number };
    onDragStart: (e: MouseEvent<HTMLDivElement>) => void;
    onRefresh: () => void;
    onClose: () => void;
    debugTab: DebugTab;
    setDebugTab: (tab: DebugTab) => void;
    onTickWatchdog: () => void;
    pdcSnapshot: engineApi.PdcDebugSnapshot | null;
    rtSnapshot: engineApi.RtDebugSnapshot | null;
    sandboxSnapshot: engineApi.PluginSandboxSnapshot | null;
    sandboxRuntime: engineApi.PluginSandboxSnapshot | null;
    engineConnected: boolean;
    telemetryRunning: boolean;
    isPlaying: boolean;
    bpm: number;
    posString: string;
    sampleRate: number;
    trackCount: number;
    engineLastError: string;
    pdcLoading: boolean;
    rtLoading: boolean;
    sandboxLoading: boolean;
    pdcError: string | null;
    rtError: string | null;
    sandboxError: string | null;
}

export function DebugPanel({
    panelRef,
    panelPos,
    onDragStart,
    onRefresh,
    onClose,
    debugTab,
    setDebugTab,
    onTickWatchdog,
    pdcSnapshot,
    rtSnapshot,
    sandboxSnapshot,
    sandboxRuntime,
    engineConnected,
    telemetryRunning,
    isPlaying,
    bpm,
    posString,
    sampleRate,
    trackCount,
    engineLastError,
    pdcLoading,
    rtLoading,
    sandboxLoading,
    pdcError,
    rtError,
    sandboxError,
}: DebugPanelProps) {
    return (
        <div
            ref={panelRef}
            style={{
                position: 'fixed',
                right: panelPos.right,
                top: panelPos.top,
                width: 440,
                maxHeight: 'min(58vh, var(--token-size-px-540))',
                display: 'flex',
                flexDirection: 'column',
                background: 'color-mix(in srgb, var(--color-bg-panel) 96%, var(--token-color-hex-000000) 4%)',
                border: 'var(--space-px) solid var(--color-divider)',
                borderRadius: 'var(--radius-xl)',
                boxShadow: '0 var(--space-4) var(--token-size-px-42) var(--color-overlay-dark)',
                backdropFilter: 'blur(var(--space-2))',
                zIndex: 'var(--z-tooltip)' as unknown as number,
                overflow: 'hidden',
            }}
        >
            <div
                onMouseDown={onDragStart}
                style={{
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'space-between',
                    padding: 'var(--space-2) var(--space-2-5)',
                    borderBottom: 'var(--space-px) solid var(--color-divider)',
                    cursor: 'move',
                    userSelect: 'none',
                }}
            >
                <div style={{ fontSize: 'var(--font-size-xs)', fontWeight: 'var(--font-weight-bold)' as unknown as number, color: 'var(--color-text-primary)' }}>
                    Debug Panel
                </div>
                <div style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
                    <button onClick={onRefresh} title="Refresh" style={miniButtonStyle}>
                        <RefreshCw size={13} />
                    </button>
                    <button onClick={onClose} title="Close" style={miniButtonStyle}>
                        <X size={13} />
                    </button>
                </div>
            </div>
            <div
                style={{
                    padding: 'var(--space-2) var(--space-2-5)',
                    fontFamily: 'var(--font-mono)',
                    fontSize: 'var(--font-size-xs)',
                    color: 'var(--color-text-secondary)',
                    borderBottom: 'var(--space-px) solid var(--color-divider)',
                    display: 'grid',
                    gridTemplateColumns: '1fr 1fr',
                    gap: 4,
                }}
            >
                <div>Engine: <strong style={{ color: 'var(--color-text-primary)' }}>{engineConnected ? 'online' : 'offline'}</strong></div>
                <div>Telemetry: <strong style={{ color: 'var(--color-text-primary)' }}>{telemetryRunning ? 'running' : 'stopped'}</strong></div>
                <div>PDC Nodes: <strong style={{ color: 'var(--color-text-primary)' }}>{pdcSnapshot?.node_count ?? '—'}</strong></div>
                <div>Sandbox: <strong style={{ color: 'var(--color-text-primary)' }}>{(sandboxRuntime ?? sandboxSnapshot)?.enabled ? 'enabled' : 'disabled'}</strong></div>
            </div>
            <div style={{ display: 'flex', gap: 6, padding: 'var(--space-1-5) var(--space-2-5)', borderBottom: 'var(--space-px) solid var(--color-divider)' }}>
                <button style={debugTabBtnStyle(debugTab === 'overview')} onClick={() => setDebugTab('overview')}>Overview</button>
                <button style={debugTabBtnStyle(debugTab === 'pdc')} onClick={() => setDebugTab('pdc')}>PDC</button>
                <button style={debugTabBtnStyle(debugTab === 'sandbox')} onClick={() => setDebugTab('sandbox')}>Sandbox</button>
            </div>
            <div style={{ minHeight: 210, maxHeight: 'min(45vh, var(--token-size-px-380))', overflow: 'auto' }}>
                {debugTab === 'overview' && (
                    <div>
                        <div style={sectionHeaderStyle}>Runtime Overview</div>
                        <div style={rowStyle}>
                            <div style={{ color: 'var(--color-text-primary)' }}>Playback: {isPlaying ? 'playing' : 'stopped'}</div>
                            <div>BPM: {bpm.toFixed(2)} · Pos: {posString}</div>
                            <div>Sample Rate: {sampleRate || '—'} Hz · Tracks: {trackCount}</div>
                            <div>Last Error: {engineLastError || 'none'}</div>
                            <div>RT callback: {rtSnapshot?.callbackDurationUsLast ?? '—'} us (max {rtSnapshot?.callbackDurationUsMax ?? '—'} us)</div>
                            <div>RT commands: {rtSnapshot?.commandCountLast ?? '—'} last / {rtSnapshot?.commandCountMax ?? '—'} max</div>
                            <div>Queue rejects: {rtSnapshot?.queueFullRejectTotal ?? '—'} · Host lock misses: {rtSnapshot?.pluginHostLockMissTotal ?? '—'}</div>
                            <div>Deferred topology: {rtSnapshot?.deferredTopologyLenLast ?? '—'}</div>
                        </div>
                    </div>
                )}
                {debugTab === 'pdc' && (
                    <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr' }}>
                        <div style={{ borderRight: 'var(--space-px) solid var(--color-divider)', overflow: 'auto' }}>
                            <div style={sectionHeaderStyle}>Node Delays</div>
                            {(pdcSnapshot?.nodes ?? []).map((n) => (
                                <div key={`node-${n.node_id}`} style={rowStyle}>
                                    <div style={{ color: 'var(--color-text-primary)' }}>{n.name}</div>
                                    <div>#{n.node_id} · {n.kind}</div>
                                    <div>own {n.own_latency_samples} / pdc {n.node_delay_samples} smp</div>
                                </div>
                            ))}
                        </div>
                        <div style={{ overflow: 'auto' }}>
                            <div style={sectionHeaderStyle}>Edge Compensation</div>
                            {(pdcSnapshot?.edges ?? []).map((e, idx) => (
                                <div key={`edge-${e.from_node_id}-${e.to_node_id}-${idx}`} style={rowStyle}>
                                    <div style={{ color: 'var(--color-text-primary)' }}>{e.from_name} → {e.to_name}</div>
                                    <div>{e.from_node_id}→{e.to_node_id}</div>
                                    <div>{e.edge_delay_samples} smp</div>
                                </div>
                            ))}
                        </div>
                    </div>
                )}
                {debugTab === 'sandbox' && (
                    <div>
                        <div style={sectionHeaderStyle}>Plugin Sandbox</div>
                        <div style={{ padding: 'var(--space-1-5) var(--space-2)', borderBottom: 'var(--space-px) solid var(--color-divider)' }}>
                            <button onClick={onTickWatchdog} style={miniButtonStyle} title="Tick watchdog">
                                <RefreshCw size={13} />
                            </button>
                        </div>
                        {((sandboxRuntime ?? sandboxSnapshot)?.instances ?? []).map((inst) => (
                            <div key={inst.plugin_instance_id} style={rowStyle}>
                                <div style={{ color: 'var(--color-text-primary)' }}>{inst.plugin_name}</div>
                                <div>{inst.status} · crashes {inst.crash_count} · restarts {inst.restart_count}</div>
                                <div>{inst.last_error || inst.plugin_path}</div>
                            </div>
                        ))}
                    </div>
                )}
            </div>
            <div style={{ padding: 'var(--space-1-5) var(--space-2-5)', borderTop: 'var(--space-px) solid var(--color-divider)', fontSize: 'var(--font-size-xs)', color: 'var(--color-text-secondary)' }}>
                {(pdcLoading || rtLoading || sandboxLoading)
                    ? 'Updating…'
                    : (pdcError || rtError || sandboxError)
                        ? `Error: ${pdcError ?? rtError ?? sandboxError}`
                        : (debugTab === 'pdc'
                            ? (pdcSnapshot?.edge_summary || 'No PDC diagnostics')
                            : 'Unified runtime debug panel')}
            </div>
        </div>
    );
}

const miniButtonStyle: CSSProperties = {
    width: 22,
    height: 22,
    border: 'none',
    borderRadius: 'var(--radius-md)',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    background: 'transparent',
    color: 'var(--color-text-secondary)',
    cursor: 'pointer',
};

const sectionHeaderStyle: CSSProperties = {
    position: 'sticky',
    top: 0,
    zIndex: 'var(--z-local)' as unknown as number,
    padding: 'var(--space-1-5) var(--space-2)',
    fontSize: 'var(--font-size-xs)',
    fontWeight: 'var(--font-weight-bold)' as unknown as number,
    color: 'var(--color-text-primary)',
    background: 'color-mix(in srgb, var(--color-bg-panel) 92%, var(--token-color-hex-000000) 8%)',
    borderBottom: 'var(--space-px) solid var(--color-divider)',
};

const rowStyle: CSSProperties = {
    padding: 'var(--space-1-5) var(--space-2)',
    borderBottom: 'var(--space-px) solid color-mix(in srgb, var(--color-divider) 55%, transparent)',
    fontFamily: 'var(--font-mono)',
    fontSize: 'var(--font-size-xs)',
    color: 'var(--color-text-secondary)',
    lineHeight: 1.35,
};

const debugTabBtnStyle = (active: boolean): CSSProperties => ({
    border: 'var(--space-px) solid var(--color-divider)',
    borderRadius: 'var(--radius-md)',
    height: 22,
    padding: '0 var(--space-2)',
    background: active
        ? 'color-mix(in srgb, var(--color-accent-primary) 18%, transparent)'
        : 'transparent',
    color: active ? 'var(--color-accent-primary)' : 'var(--color-text-secondary)',
    fontSize: 'var(--font-size-xs)',
    fontWeight: 'var(--font-weight-bold)' as unknown as number,
    cursor: 'pointer',
});
