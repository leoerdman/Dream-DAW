/**
 * StatusBar — Bottom status bar (Ableton Live style).
 *
 * Ported from StatusBarView.swift (142 lines).
 * NOW WIRED to Zustand engine store for live playhead data.
 * Shows global errors/notices from useStatusStore.
 *
 * Layout:
 *   [Arrangement] [Position: 1.1.24] [End: 48.1.00] [Length: 2:28.430]
 *   ...spacer...
 *   [▶/■] [9 tracks] [44100 Hz] [Main ▾]
 *   ─── Error line (when active) ───
 */

import { useStatusStore } from '@/shared/stores/useStatusStore';
import { useGridStore } from '@/shared/stores/useGridStore';
import { ALL_DIVISIONS } from '@/shared/lib/gridSnap';
import { resolveSampleRate, secondsToBeat } from '@/shared/lib/audioMath';
import { useState, useRef, useEffect } from 'react';
import { useStatusEngineSlice } from './model/useStatusEngineSlice';

interface StatusBarProps {
    projectEnd?: string;
    duration?: string;
    trackCount?: number;
    panelMode?: 'rack' | 'clip';
    onPanelModeChange?: (mode: 'rack' | 'clip') => void;
    panelInfo?: string;
}

export const StatusBar = ({
    projectEnd = '48.1.00',
    duration = '2:28.430',
    panelMode,
    onPanelModeChange,
    panelInfo,
}: StatusBarProps) => {
    // Live engine data
    const {
        isPlaying,
        positionSeconds,
        bpm,
        connected,
        projectSampleRate,
        projectTracks,
        latestHistory,
        projectHistory,
        pluginSandbox,
    } = useStatusEngineSlice();

    // Status bar messages
    const statusMessage = useStatusStore((s) => s.message);
    const statusSeverity = useStatusStore((s) => s.severity);
    const statusClear = useStatusStore((s) => s.clear);

    // Live values from engine store
    const sampleRate = resolveSampleRate(projectSampleRate);
    const trackCount = projectTracks.length;
    const gridDivision = useGridStore((s) => s.division);
    const gridTriplet = useGridStore((s) => s.triplet);
    const setGridDivision = useGridStore((s) => s.setDivision);
    const [gridOpen, setGridOpen] = useState(false);
    const [historyOpen, setHistoryOpen] = useState(false);
    const gridRef = useRef<HTMLDivElement | null>(null);
    const historyRef = useRef<HTMLDivElement | null>(null);

    // Compute bar.beat.sub from live playhead
    const totalBeats = secondsToBeat(positionSeconds, bpm);
    const bar = Math.floor(totalBeats / 4) + 1;
    const beat = Math.floor(totalBeats % 4) + 1;
    const sub = Math.floor((totalBeats % 1) * 96);
    const position = `${bar}.${beat}.${sub.toString().padStart(2, '0')}`;
    const gridLabel = gridDivision === 'ADAPTIVE' ? 'Auto' : gridTriplet ? `${gridDivision}T` : gridDivision;

    useEffect(() => {
        if (!gridOpen) return;
        const onDown = (e: MouseEvent) => {
            if (gridRef.current && !gridRef.current.contains(e.target as Node)) {
                setGridOpen(false);
            }
        };
        document.addEventListener('mousedown', onDown);
        return () => document.removeEventListener('mousedown', onDown);
    }, [gridOpen]);

    useEffect(() => {
        if (!historyOpen) return;
        const onDown = (e: MouseEvent) => {
            if (historyRef.current && !historyRef.current.contains(e.target as Node)) {
                setHistoryOpen(false);
            }
        };
        document.addEventListener('mousedown', onDown);
        return () => document.removeEventListener('mousedown', onDown);
    }, [historyOpen]);

    const historyItems = projectHistory.slice(-10).reverse();

    return (
        <div style={{ flexShrink: 0 }}>
            {/* ── Main Status Row ── */}
            <div style={{
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'space-between',
                height: 26,
                background: 'var(--color-bg-header)',
                borderTop: '1px solid var(--color-divider)',
                padding: '0 10px',
                fontSize: 'var(--font-size-2xs)',
                zIndex: 'var(--z-transport)',
            }}>

                {/* Left section */}
                <div style={{
                    display: 'flex',
                    alignItems: 'center',
                    gap: 12,
                    flexShrink: 0,
                }}>
                    {panelMode && onPanelModeChange && (
                        <div style={{
                            display: 'inline-flex',
                            alignItems: 'center',
                            gap: 4,
                            border: '1px solid var(--color-control-border)',
                            borderRadius: 'var(--radius-lg)',
                            padding: 2,
                            background: 'var(--color-bg-header)',
                            marginRight: 2,
                        }}>
                            <button
                                type="button"
                                onClick={() => onPanelModeChange('rack')}
                                style={panelModeBtnStyle(panelMode === 'rack')}
                                title="Instrument & Effects Chain (Shift+Tab)"
                            >
                                Rack
                            </button>
                            <button
                                type="button"
                                onClick={() => onPanelModeChange('clip')}
                                style={panelModeBtnStyle(panelMode === 'clip')}
                                title="Clip Editor (Shift+Tab)"
                            >
                                Clip
                            </button>
                        </div>
                    )}
                    {!statusMessage && panelInfo && (
                        <StatusText>{panelInfo}</StatusText>
                    )}
                    {!statusMessage && (
                        <>
                            <StatusText>Arrangement</StatusText>

                            <StatusGroup>
                                <StatusLabel>Position:</StatusLabel>
                                <StatusValue>{position}</StatusValue>
                            </StatusGroup>

                            <StatusGroup>
                                <StatusLabel>End:</StatusLabel>
                                <StatusValue>{projectEnd}</StatusValue>
                            </StatusGroup>

                            <StatusGroup>
                                <StatusLabel>Length:</StatusLabel>
                                <StatusValue>{duration}</StatusValue>
                            </StatusGroup>
                            {latestHistory && (
                                <div ref={historyRef} style={{ position: 'relative' }}>
                                    <StatusGroup>
                                        <StatusLabel>Event:</StatusLabel>
                                        <button
                                            onClick={() => setHistoryOpen((v) => !v)}
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
                            )}
                        </>
                    )}
                </div>

                {/* ── Inline Error/Notice (replaces center info when active) ── */}
                {statusMessage && (
                    <div style={{
                        display: 'flex',
                        alignItems: 'center',
                        gap: 8,
                        flex: 1,
                        minWidth: 0,
                        justifyContent: 'center',
                    }}>
                        <span style={{
                            color: statusSeverity === 'error'
                                ? 'var(--color-status-error)'
                                : 'var(--color-accent-primary)',
                            fontWeight: 600,
                            whiteSpace: 'nowrap',
                            overflow: 'hidden',
                            textOverflow: 'ellipsis',
                        }}>
                            {statusSeverity === 'error' ? '⚠ ' : 'ℹ '}{statusMessage}
                        </span>
                        <button
                            onClick={() => statusClear()}
                            style={{
                                background: 'none',
                                border: 'none',
                                color: statusSeverity === 'error'
                                    ? 'var(--color-status-error)'
                                    : 'var(--color-accent-primary)',
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
                )}

                {/* Right section */}
                <div style={{
                    display: 'flex',
                    alignItems: 'center',
                    gap: 12,
                    flexShrink: 0,
                }}>
                    <span
                        title={connected ? 'Engine connected' : 'Engine disconnected'}
                        style={{
                            width: 6, height: 6,
                            borderRadius: '50%',
                            background: connected ? 'var(--color-status-success)' : 'var(--color-status-error)',
                            flexShrink: 0,
                        }}
                    />
                    <span style={{
                        color: isPlaying ? 'var(--color-accent-primary)' : 'var(--color-text-tertiary)',
                        fontSize: 'var(--font-size-xs)',
                    }}>
                        {isPlaying ? '▶' : '■'}
                    </span>

                    <StatusText>{trackCount} tracks</StatusText>
                    <StatusText>{bpm.toFixed(1)} BPM</StatusText>
                    <StatusText>{(sampleRate / 1000).toFixed(1)} kHz</StatusText>
                    {pluginSandbox && (
                        <StatusText
                            title={`Plugin Sandbox: ${pluginSandbox.enabled ? 'enabled' : 'disabled'}; instances=${pluginSandbox.instances.length}`}
                        >
                            {pluginSandbox.enabled ? `Sandbox ${pluginSandbox.instances.length}` : 'Sandbox Off'}
                        </StatusText>
                    )}

                    <div style={{
                        display: 'flex',
                        alignItems: 'center',
                        gap: 3,
                    }}>
                        <span style={{
                            width: 5, height: 5,
                            borderRadius: '50%',
                            background: 'var(--color-text-tertiary)',
                        }} />
                        <StatusText>Main</StatusText>
                    </div>
                    <div ref={gridRef} style={{ position: 'relative' }}>
                        <button
                            onClick={() => setGridOpen((v) => !v)}
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
                </div>
            </div>
        </div>
    );
};

// ── Helpers ──────────────────────────────────────────────

const StatusLabel = ({ children }: { children: React.ReactNode }) => (
    <span style={{
        color: 'var(--color-text-tertiary)',
        fontWeight: 400,
    }}>
        {children}
    </span>
);

const StatusValue = ({ children }: { children: React.ReactNode }) => (
    <span style={{
        color: 'var(--color-text-secondary)',
        fontFamily: 'var(--font-mono)',
        fontWeight: 500,
    }}>
        {children}
    </span>
);

const StatusText = ({
    children,
    title,
}: {
    children: React.ReactNode;
    title?: string;
}) => (
    <span style={{
        color: 'var(--color-text-secondary)',
        fontWeight: 500,
    }} title={title}>
        {children}
    </span>
);

const StatusGroup = ({ children }: { children: React.ReactNode }) => (
    <span style={{
        display: 'inline-flex',
        alignItems: 'center',
        gap: 3,
    }}>
        {children}
    </span>
);

const panelModeBtnStyle = (active: boolean): React.CSSProperties => ({
    border: active ? '1px solid color-mix(in srgb, var(--color-accent-primary) 52%, transparent)' : '1px solid transparent',
    borderRadius: 'var(--radius-md)',
    background: active ? 'var(--color-accent-primary-dim)' : 'transparent',
    color: active ? 'var(--color-text-primary)' : 'var(--color-text-tertiary)',
    fontSize: 'var(--font-size-xs)',
    fontWeight: 700,
    letterSpacing: '0.02em',
    padding: '3px 8px',
    cursor: 'pointer',
});
