/**
 * StatusBar — Bottom status bar (Ableton Live style).
 *
 * Ported from StatusBarView.swift (142 lines).
 * NOW WIRED to Zustand engine store for live playhead data.
 *
 * Layout:
 *   [Arrangement] [Position: 1.1.24] [End: 48.1.00] [Length: 2:28.430]
 *   ...spacer...
 *   [▶/■] [9 tracks] [44100 Hz] [Main ▾]
 */

import { useEngineStore } from '@/shared/stores/useEngineStore';

interface StatusBarProps {
    projectEnd?: string;
    duration?: string;
    trackCount?: number;
}

export const StatusBar = ({
    projectEnd = '48.1.00',
    duration = '2:28.430',
    trackCount = 9,
}: StatusBarProps) => {
    // Live engine data
    const isPlaying = useEngineStore((s) => s.transport.is_playing);
    const positionSeconds = useEngineStore((s) => s.transport.position_seconds);
    const bpm = useEngineStore((s) => s.transport.bpm);
    const connected = useEngineStore((s) => s.connected);

    // Compute bar.beat.sub from live playhead
    const bar = Math.floor((positionSeconds / 60) * bpm / 4) + 1;
    const beat = Math.floor(((positionSeconds / 60) * bpm) % 4) + 1;
    const sub = Math.floor((((positionSeconds / 60) * bpm) % 1) * 96);
    const position = `${bar}.${beat}.${sub.toString().padStart(2, '0')}`;

    const sampleRate = 44100; // TODO: read from engine state when available

    return (
        <div style={{
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            height: 'var(--daw-status-bar-height)',
            background: 'var(--color-bg-header)',
            borderTop: '1px solid var(--color-divider)',
            padding: '0 8px',
            fontSize: 'var(--font-size-2xs)',
            flexShrink: 0,
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
