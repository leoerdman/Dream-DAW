/**
 * StatusBar — Bottom status bar (Ableton Live style).
 *
 * Ported from StatusBarView.swift (142 lines).
 *
 * Layout:
 *   [Arrangement] [Position: 1.1.24] [End: 48.1.00] [Length: 2:28.430]
 *   ...spacer...
 *   [▶/■] [9 tracks] [44100 Hz] [Main ▾]
 */

interface StatusBarProps {
    position?: string;
    projectEnd?: string;
    duration?: string;
    trackCount?: number;
    sampleRate?: number;
    isPlaying?: boolean;
}

export const StatusBar = ({
    position = '1.1.24',
    projectEnd = '48.1.00',
    duration = '2:28.430',
    trackCount = 9,
    sampleRate = 44100,
    isPlaying = false,
}: StatusBarProps) => {
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
