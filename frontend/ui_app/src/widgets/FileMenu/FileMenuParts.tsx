export const MenuItem = ({
    label,
    shortcut,
    subLabel,
    onClick,
}: {
    label: string;
    shortcut?: string;
    subLabel?: string;
    onClick: () => void;
}) => (
    <button
        onClick={onClick}
        style={{
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            width: '100%',
            padding: 'var(--space-1-5) var(--space-3)',
            background: 'transparent',
            border: 'none',
            color: 'var(--color-text-primary)',
            fontSize: 'var(--font-size-xs)',
            fontWeight: 'var(--font-weight-regular)' as unknown as number,
            cursor: 'pointer',
            textAlign: 'left',
            transition: 'background var(--transition-fast)',
            gap: 16,
        }}
        onMouseEnter={(e) => { e.currentTarget.style.background = 'var(--color-accent-primary-dim)'; }}
        onMouseLeave={(e) => { e.currentTarget.style.background = 'transparent'; }}
    >
        <span
            style={{
                flex: 1,
                overflow: 'hidden',
                textOverflow: 'ellipsis',
                whiteSpace: 'nowrap',
            }}
            title={subLabel}
        >
            {label}
        </span>
        {shortcut && (
            <span
                style={{
                    fontSize: 'var(--font-size-2xs)',
                    color: 'var(--color-text-tertiary)',
                    fontFamily: 'var(--font-role-data)',
                    whiteSpace: 'nowrap',
                }}
            >
                {shortcut}
            </span>
        )}
    </button>
);

export const MenuSeparator = () => (
    <div
        style={{
            height: 1,
            background: 'var(--color-border-subtle)',
            margin: 'var(--space-1) var(--space-2)',
        }}
    />
);
