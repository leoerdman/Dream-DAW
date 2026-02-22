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
                borderBottom: '1px solid var(--color-divider)',
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
                    letterSpacing: '0.5px',
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
                        fontFamily: 'var(--font-mono)',
                        color: 'var(--color-accent-primary)',
                        background: 'color-mix(in srgb, var(--color-accent-primary) 14%, transparent)',
                        border: '1px solid color-mix(in srgb, var(--color-accent-primary) 36%, transparent)',
                        borderRadius: 'var(--radius-sm)',
                        padding: '1px 4px',
                    }}
                >
                    TAB
                </span>
            )}
        </div>
    );
}
