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
                maxHeight: 'min(58vh, 540px)',
                display: 'flex',
                flexDirection: 'column',
                background: 'color-mix(in srgb, var(--color-bg-panel) 96%, #000 4%)',
                border: '1px solid var(--color-divider)',
                borderRadius: 'var(--radius-xl)',
                boxShadow: '0 16px 42px var(--color-overlay-dark)',
                backdropFilter: 'blur(8px)',
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
                    padding: '8px 10px',
                    borderBottom: '1px solid var(--color-divider)',
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
                    padding: '8px 10px',
                    fontFamily: 'var(--font-mono)',
                    fontSize: 'var(--font-size-xs)',
                    color: 'var(--color-text-secondary)',
                    borderBottom: '1px solid var(--color-divider)',
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
            <div style={{ display: 'flex', gap: 6, padding: '6px 10px', borderBottom: '1px solid var(--color-divider)' }}>
                <button style={debugTabBtnStyle(debugTab === 'overview')} onClick={() => setDebugTab('overview')}>Overview</button>
                <button style={debugTabBtnStyle(debugTab === 'pdc')} onClick={() => setDebugTab('pdc')}>PDC</button>
                <button style={debugTabBtnStyle(debugTab === 'sandbox')} onClick={() => setDebugTab('sandbox')}>Sandbox</button>
            </div>
            <div style={{ minHeight: 210, maxHeight: 'min(45vh, 380px)', overflow: 'auto' }}>
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
                        <div style={{ borderRight: '1px solid var(--color-divider)', overflow: 'auto' }}>
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
                        <div style={{ padding: '6px 8px', borderBottom: '1px solid var(--color-divider)' }}>
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
            <div style={{ padding: '6px 10px', borderTop: '1px solid var(--color-divider)', fontSize: 'var(--font-size-xs)', color: 'var(--color-text-secondary)' }}>
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
    padding: '6px 8px',
    fontSize: 'var(--font-size-xs)',
    fontWeight: 'var(--font-weight-bold)' as unknown as number,
    color: 'var(--color-text-primary)',
    background: 'color-mix(in srgb, var(--color-bg-panel) 92%, #000 8%)',
    borderBottom: '1px solid var(--color-divider)',
};

const rowStyle: CSSProperties = {
    padding: '6px 8px',
    borderBottom: '1px solid color-mix(in srgb, var(--color-divider) 55%, transparent)',
    fontFamily: 'var(--font-mono)',
    fontSize: 'var(--font-size-xs)',
    color: 'var(--color-text-secondary)',
    lineHeight: 1.35,
};

const debugTabBtnStyle = (active: boolean): CSSProperties => ({
    border: '1px solid var(--color-divider)',
    borderRadius: 'var(--radius-md)',
    height: 22,
    padding: '0 8px',
    background: active
        ? 'color-mix(in srgb, var(--color-accent-primary) 18%, transparent)'
        : 'transparent',
    color: active ? 'var(--color-accent-primary)' : 'var(--color-text-secondary)',
    fontSize: 'var(--font-size-xs)',
    fontWeight: 'var(--font-weight-bold)' as unknown as number,
    cursor: 'pointer',
});
