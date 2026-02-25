import { StatusGroup, StatusLabel, StatusText } from './statusBarParts';
import type { RefObject } from 'react';

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
                        fontFamily: 'var(--font-role-data)',
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
                        border: 'var(--space-px) solid var(--color-divider)',
                        borderRadius: 'var(--radius-md)',
                        boxShadow: '0 var(--space-2) var(--token-size-px-18) var(--color-overlay-dark)',
                        zIndex: 'var(--z-tooltip)',
                        padding: 'var(--space-1-5) var(--space-2)',
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
                    padding: '0 var(--space-1)',
                    flexShrink: 0,
                }}
                title="Dismiss"
            >
                ✕
            </button>
        </div>
    );
}

interface StatusRightSectionProps {
    sampleRate: number;
    pluginSandbox?: { enabled: boolean; instances: Array<{ status: string; bypass_requested: boolean }> } | null;
    crashedSandboxCount: number;
    onReloadCrashed: () => Promise<void>;
}

export function StatusRightSection({
    sampleRate,
    pluginSandbox,
    crashedSandboxCount,
    onReloadCrashed,
}: StatusRightSectionProps) {
    return (
        <div style={{ display: 'flex', alignItems: 'center', gap: 12, flexShrink: 0 }}>
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
                        border: 'var(--space-px) solid var(--color-control-border)',
                        borderRadius: 'var(--radius-md)',
                        background: 'var(--color-control-bg)',
                        color: 'var(--color-status-error)',
                        fontSize: 'var(--font-size-xs)',
                        fontFamily: 'var(--font-role-data)',
                        fontWeight: 600,
                        padding: 'var(--space-0-5) var(--space-1-5)',
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
        </div>
    );
}
