interface TrackInspectorHeaderProps {
    rulerHeight: number;
    mixerFocusMode: boolean;
}

export function TrackInspectorHeader({ rulerHeight, mixerFocusMode }: TrackInspectorHeaderProps) {
    return (
        <div
            style={{
                height: rulerHeight,
                flexShrink: 0,
                background: 'var(--color-bg-header)',
                borderBottom: 'var(--space-px) solid var(--color-divider)',
                display: 'flex',
                alignItems: 'center',
                paddingLeft: 8,
            }}
        >
            <span
                style={{
                    fontSize: 'var(--font-size-2xs)',
                    fontWeight: 'var(--font-weight-semibold)' as unknown as number,
                    color: 'var(--color-text-secondary)',
                    letterSpacing: 'var(--letter-spacing-wide)',
                    textTransform: 'uppercase',
                }}
            >
                {mixerFocusMode ? 'Mixer' : 'Tracks'}
            </span>
            {mixerFocusMode && (
                <span
                    style={{
                        marginLeft: 6,
                        fontSize: 'var(--font-size-micro)',
                        fontWeight: 'var(--font-weight-bold)' as unknown as number,
                        fontFamily: 'var(--font-role-data)',
                        color: 'var(--color-accent-primary)',
                        background: 'color-mix(in srgb, var(--color-accent-primary) 14%, transparent)',
                        border: 'var(--space-px) solid color-mix(in srgb, var(--color-accent-primary) 36%, transparent)',
                        borderRadius: 'var(--radius-sm)',
                        padding: 'var(--space-px) var(--space-1)',
                    }}
                >
                    TAB
                </span>
            )}
        </div>
    );
}
