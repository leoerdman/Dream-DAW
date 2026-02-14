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

import { useEngineStore } from '@/shared/stores/useEngineStore';
import { useStatusStore } from '@/shared/stores/useStatusStore';

interface StatusBarProps {
    projectEnd?: string;
    duration?: string;
    trackCount?: number;
}

export const StatusBar = ({
    projectEnd = '48.1.00',
    duration = '2:28.430',
}: StatusBarProps) => {
    // Live engine data
    const isPlaying = useEngineStore((s) => s.transport.is_playing);
    const positionSeconds = useEngineStore((s) => s.transport.position_seconds);
    const bpm = useEngineStore((s) => s.transport.bpm);
    const connected = useEngineStore((s) => s.connected);
    const projectSampleRate = useEngineStore((s) => s.projectSampleRate);
    const projectTracks = useEngineStore((s) => s.projectTracks);

    // Status bar messages
    const statusMessage = useStatusStore((s) => s.message);
    const statusSeverity = useStatusStore((s) => s.severity);
    const statusClear = useStatusStore((s) => s.clear);

    // Live values from engine store
    const sampleRate = projectSampleRate || 44100;
    const trackCount = projectTracks.length;

    // Compute bar.beat.sub from live playhead
    const bar = Math.floor((positionSeconds / 60) * bpm / 4) + 1;
    const beat = Math.floor(((positionSeconds / 60) * bpm) % 4) + 1;
    const sub = Math.floor((((positionSeconds / 60) * bpm) % 1) * 96);
    const position = `${bar}.${beat}.${sub.toString().padStart(2, '0')}`;

    return (
        <div style={{ flexShrink: 0 }}>
            {/* ── Main Status Row ── */}
            <div style={{
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'space-between',
                height: 24,
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
                }}>
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
                </div>

                {/* Right section */}
                <div style={{
                    display: 'flex',
                    alignItems: 'center',
                    gap: 12,
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
                        fontSize: 10,
                    }}>
                        {isPlaying ? '▶' : '■'}
                    </span>

                    <StatusText>{trackCount} tracks</StatusText>
                    <StatusText>{sampleRate} Hz</StatusText>

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
                </div>
            </div>

            {/* ── Error/Notice Row (appears below status when active) ── */}
            {statusMessage && (
                <div
                    style={{
                        display: 'flex',
                        alignItems: 'center',
                        justifyContent: 'space-between',
                        height: 22,
                        padding: '0 10px',
                        fontSize: 'var(--font-size-2xs)',
                        fontWeight: 500,
                        background: statusSeverity === 'error'
                            ? 'rgba(217, 64, 64, 0.14)'
                            : 'rgba(74, 158, 255, 0.10)',
                        color: statusSeverity === 'error'
                            ? 'var(--color-status-error)'
                            : 'var(--color-accent-primary)',
                        borderTop: `1px solid ${statusSeverity === 'error'
                            ? 'rgba(217, 64, 64, 0.3)'
                            : 'rgba(74, 158, 255, 0.2)'}`,
                    }}
                >
                    <span>{statusSeverity === 'error' ? '⚠ ' : 'ℹ '}{statusMessage}</span>
                    <button
                        onClick={() => statusClear()}
                        style={{
                            background: 'none',
                            border: 'none',
                            color: 'inherit',
                            cursor: 'pointer',
                            fontSize: 12,
                            opacity: 0.6,
                            padding: '0 4px',
                        }}
                        title="Dismiss"
                    >
                        ✕
                    </button>
                </div>
            )}
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

const StatusText = ({ children }: { children: React.ReactNode }) => (
    <span style={{
        color: 'var(--color-text-secondary)',
        fontWeight: 500,
    }}>
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
