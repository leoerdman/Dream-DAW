import { StatusGroup, StatusLabel, StatusText } from './statusBarParts';
import { ALL_DIVISIONS, type GridDivision } from '@/shared/lib/gridSnap';
import type { ReactNode, RefObject } from 'react';

interface HistoryEventItem {
    seq: number;
    kind: string;
    detail: string;
    timestampMs: number;
}

interface HistorySectionProps {
    latestHistory?: HistoryEventItem;
    historyItems: HistoryEventItem[];
    historyOpen: boolean;
    setHistoryOpen: (open: boolean) => void;
    historyRef: RefObject<HTMLDivElement | null>;
}

export function HistorySection({
    latestHistory,
    historyItems,
    historyOpen,
    setHistoryOpen,
    historyRef,
}: HistorySectionProps) {
    if (!latestHistory) return null;
    return (
        <div ref={historyRef} style={{ position: 'relative' }}>
            <StatusGroup>
                <StatusLabel>Event:</StatusLabel>
                <button
                    onClick={() => setHistoryOpen(!historyOpen)}
                    style={{
                        border: 'none',
                        background: 'transparent',
                        color: 'var(--color-text-primary)',
                        fontFamily: 'var(--font-mono)',
                        fontSize: 'var(--font-size-2xs)',
                        cursor: 'pointer',
                        padding: 0,
                    }}
                    title={latestHistory.detail}
                >
                    {latestHistory.kind}
                </button>
            </StatusGroup>
            {historyOpen && (
                <div
                    style={{
                        position: 'absolute',
                        left: 0,
                        bottom: 22,
                        width: 360,
                        maxHeight: 240,
                        overflowY: 'auto',
                        background: 'var(--color-bg-elevated)',
                        border: '1px solid var(--color-divider)',
                        borderRadius: 'var(--radius-md)',
                        boxShadow: '0 8px 18px var(--color-overlay-dark)',
                        zIndex: 'var(--z-tooltip)' as unknown as number,
                        padding: '6px 8px',
                    }}
                >
                    {historyItems.map((item) => {
                        const dt = new Date(item.timestampMs);
                        return (
                            <div key={item.seq} style={{ marginBottom: 6 }}>
                                <div style={{ color: 'var(--color-text-primary)', fontSize: 'var(--font-size-xs)' }}>
                                    #{item.seq} {item.kind}
                                </div>
                                <div style={{ color: 'var(--color-text-secondary)', fontSize: 'var(--font-size-xs)' }}>
                                    {dt.toLocaleTimeString()} • {item.detail}
                                </div>
                            </div>
                        );
                    })}
                </div>
            )}
        </div>
    );
}

interface InlineMessageProps {
    statusMessage: string;
    statusSeverity: 'error' | 'info';
    onClear: () => void;
}

export function InlineMessage({ statusMessage, statusSeverity, onClear }: InlineMessageProps) {
    return (
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, flex: 1, minWidth: 0, justifyContent: 'center' }}>
            <span
                style={{
                    color: statusSeverity === 'error' ? 'var(--color-status-error)' : 'var(--color-accent-primary)',
                    fontWeight: 600,
                    whiteSpace: 'nowrap',
                    overflow: 'hidden',
                    textOverflow: 'ellipsis',
                }}
            >
                {statusSeverity === 'error' ? '⚠ ' : 'ℹ '}{statusMessage}
            </span>
            <button
                onClick={onClear}
                style={{
                    background: 'none',
                    border: 'none',
                    color: statusSeverity === 'error' ? 'var(--color-status-error)' : 'var(--color-accent-primary)',
                    cursor: 'pointer',
                    fontSize: 'var(--font-size-xs)',
                    opacity: 0.7,
                    padding: '0 4px',
                    flexShrink: 0,
                }}
                title="Dismiss"
            >
                ✕
            </button>
        </div>
    );
}

interface GridMenuProps {
    gridRef: RefObject<HTMLDivElement | null>;
    gridOpen: boolean;
    setGridOpen: (open: boolean) => void;
    gridDivision: GridDivision;
    gridTriplet: boolean;
    setGridDivision: (division: GridDivision) => void;
}

export function GridMenu({
    gridRef,
    gridOpen,
    setGridOpen,
    gridDivision,
    gridTriplet,
    setGridDivision,
}: GridMenuProps) {
    const gridLabel = gridDivision === 'ADAPTIVE' ? 'Auto' : gridTriplet ? `${gridDivision}T` : gridDivision;
    return (
        <div ref={gridRef} style={{ position: 'relative' }}>
            <button
                onClick={() => setGridOpen(!gridOpen)}
                style={{
                    border: '1px solid var(--color-control-border)',
                    borderRadius: 'var(--radius-md)',
                    background: 'var(--color-control-bg)',
                    color: 'var(--color-text-primary)',
                    fontSize: 'var(--font-size-xs)',
                    fontFamily: 'var(--font-mono)',
                    fontWeight: 600,
                    padding: '2px 6px',
                    cursor: 'pointer',
                }}
                title="Grid Size"
            >
                Grid {gridLabel}
            </button>
            {gridOpen && (
                <div
                    style={{
                        position: 'absolute',
                        right: 0,
                        bottom: 22,
                        minWidth: 100,
                        background: 'var(--color-bg-elevated)',
                        border: '1px solid var(--color-divider)',
                        borderRadius: 'var(--radius-md)',
                        boxShadow: '0 8px 18px var(--color-overlay-dark)',
                        zIndex: 'var(--z-tooltip)' as unknown as number,
                        padding: '4px 0',
                    }}
                >
                    {ALL_DIVISIONS.map((div) => {
                        const active = gridDivision === div;
                        const label = div === 'ADAPTIVE' ? 'Auto' : div;
                        return (
                            <button
                                key={div}
                                onClick={() => {
                                    setGridDivision(div);
                                    setGridOpen(false);
                                }}
                                style={{
                                    width: '100%',
                                    textAlign: 'left',
                                    border: 'none',
                                    background: active ? 'var(--color-accent-primary-dim)' : 'transparent',
                                    color: active ? 'var(--color-text-primary)' : 'var(--color-text-secondary)',
                                    fontSize: 'var(--font-size-xs)',
                                    fontFamily: 'var(--font-mono)',
                                    padding: '4px 8px',
                                    cursor: 'pointer',
                                }}
                            >
                                {label}
                            </button>
                        );
                    })}
                </div>
            )}
        </div>
    );
}

interface StatusRightSectionProps {
    connected: boolean;
    isPlaying: boolean;
    trackCount: number;
    bpm: number;
    sampleRate: number;
    pluginSandbox?: { enabled: boolean; instances: Array<{ status: string; bypass_requested: boolean }> } | null;
    crashedSandboxCount: number;
    onReloadCrashed: () => Promise<void>;
    gridMenu: ReactNode;
}

export function StatusRightSection({
    connected,
    isPlaying,
    trackCount,
    bpm,
    sampleRate,
    pluginSandbox,
    crashedSandboxCount,
    onReloadCrashed,
    gridMenu,
}: StatusRightSectionProps) {
    return (
        <div style={{ display: 'flex', alignItems: 'center', gap: 12, flexShrink: 0 }}>
            <span
                title={connected ? 'Engine connected' : 'Engine disconnected'}
                style={{
                    width: 6,
                    height: 6,
                    borderRadius: '50%',
                    background: connected ? 'var(--color-status-success)' : 'var(--color-status-error)',
                    flexShrink: 0,
                }}
            />
            <span style={{ color: isPlaying ? 'var(--color-accent-primary)' : 'var(--color-text-tertiary)', fontSize: 'var(--font-size-xs)' }}>
                {isPlaying ? '▶' : '■'}
            </span>

            <StatusText>{trackCount} tracks</StatusText>
            <StatusText>{bpm.toFixed(1)} BPM</StatusText>
            <StatusText>{(sampleRate / 1000).toFixed(1)} kHz</StatusText>
            {pluginSandbox && (
                <StatusText title={`Plugin Sandbox: ${pluginSandbox.enabled ? 'enabled' : 'disabled'}; instances=${pluginSandbox.instances.length}`}>
                    {pluginSandbox.enabled ? `Sandbox ${pluginSandbox.instances.length}` : 'Sandbox Off'}
                </StatusText>
            )}
            {pluginSandbox?.enabled && crashedSandboxCount > 0 && (
                <button
                    onClick={() => void onReloadCrashed()}
                    style={{
                        border: '1px solid var(--color-control-border)',
                        borderRadius: 'var(--radius-md)',
                        background: 'var(--color-control-bg)',
                        color: 'var(--color-status-error)',
                        fontSize: 'var(--font-size-xs)',
                        fontFamily: 'var(--font-mono)',
                        fontWeight: 600,
                        padding: '2px 6px',
                        cursor: 'pointer',
                    }}
                    title={`Reload ${crashedSandboxCount} crashed/timed-out sandbox plugin instance(s)`}
                >
                    Reload {crashedSandboxCount}
                </button>
            )}

            <div style={{ display: 'flex', alignItems: 'center', gap: 3 }}>
                <span style={{ width: 5, height: 5, borderRadius: '50%', background: 'var(--color-text-tertiary)' }} />
                <StatusText>Main</StatusText>
            </div>
            {gridMenu}
        </div>
    );
}
