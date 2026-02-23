interface AddDeviceButtonProps {
    onClick: () => void;
}

export function AddDeviceButton({ onClick }: AddDeviceButtonProps) {
    return (
        <button
            onClick={() => {
                window.dispatchEvent(new CustomEvent('dream:browser-set-search', { detail: { categoryId: 'plugins', query: '' } }));
                onClick();
            }}
            style={{
                width: 64,
                minWidth: 64,
                height: '100%',
                minHeight: 100,
                display: 'flex',
                flexDirection: 'column',
                alignItems: 'center',
                justifyContent: 'center',
                gap: 'var(--space-1-5)',
                background: 'transparent',
                border: 'var(--space-px) dashed var(--color-border-subtle)',
                borderRadius: 'var(--radius-sm)',
                cursor: 'pointer',
                color: 'var(--color-text-tertiary)',
                fontSize: 'var(--font-size-2xs)',
                fontWeight: 500,
                flexShrink: 0,
                transition: 'all var(--transition-fast)',
            }}
            onMouseEnter={(e) => {
                e.currentTarget.style.borderColor = 'var(--color-accent-primary)';
                e.currentTarget.style.color = 'var(--color-accent-primary)';
            }}
            onMouseLeave={(e) => {
                e.currentTarget.style.borderColor = 'var(--color-border-subtle)';
                e.currentTarget.style.color = 'var(--color-text-tertiary)';
            }}
        >
            <span style={{ fontSize: 'var(--font-size-2xl)', lineHeight: 1 }}>+</span>
            Add Device
        </button>
    );
}

