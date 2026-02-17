import { memo, useState, useCallback, type CSSProperties, type ReactNode } from 'react';

/* ═══════════════════════════════════════════════════════════════
   ActionButton — Enterprise shared action button.
   Standardizes button sizing across all modals and panels.
   Variants: primary (accent), secondary (ghost), danger (error).
   ═══════════════════════════════════════════════════════════════ */

interface ActionButtonProps {
    children: ReactNode;
    onClick?: () => void;
    variant?: 'primary' | 'secondary' | 'danger' | 'ghost';
    /** Size: 'sm' for compact, 'md' for standard */
    size?: 'sm' | 'md';
    disabled?: boolean;
    type?: 'button' | 'submit';
    title?: string;
    style?: CSSProperties;
}

const PADDING = {
    sm: 'var(--space-1) var(--space-2-5)',
    md: 'var(--space-2) var(--space-4)',
} as const;

const FONT_SIZE = {
    sm: 'var(--font-size-xs)',
    md: 'var(--font-size-sm)',
} as const;

const getVariantColors = (variant: string, hovered: boolean) => {
    switch (variant) {
        case 'primary':
            return {
                background: hovered ? 'var(--color-accent-primary-hover)' : 'var(--color-accent-primary)',
                color: 'var(--color-text-on-accent)',
                border: 'none',
            };
        case 'danger':
            return {
                background: hovered ? 'color-mix(in srgb, var(--color-status-error) 85%, white)' : 'var(--color-status-error)',
                color: 'var(--color-text-on-accent)',
                border: 'none',
            };
        case 'ghost':
            return {
                background: hovered ? 'var(--color-bg-hover)' : 'transparent',
                color: 'var(--color-text-secondary)',
                border: 'none',
            };
        case 'secondary':
        default:
            return {
                background: hovered ? 'var(--color-bg-hover)' : 'var(--color-bg-elevated)',
                color: 'var(--color-text-primary)',
                border: 'var(--border-width-1) solid var(--color-control-border)',
            };
    }
};

export const ActionButton = memo(function ActionButton({
    children,
    onClick,
    variant = 'secondary',
    size = 'md',
    disabled = false,
    type = 'button',
    title,
    style: extStyle,
}: ActionButtonProps) {
    const [hovered, setHovered] = useState(false);
    const onEnter = useCallback(() => setHovered(true), []);
    const onLeave = useCallback(() => setHovered(false), []);

    const colors = getVariantColors(variant, hovered && !disabled);

    const style: CSSProperties = {
        ...colors,
        padding: PADDING[size],
        fontSize: FONT_SIZE[size],
        fontWeight: 'var(--font-weight-semibold)' as unknown as number,
        borderRadius: 'var(--radius-lg)',
        cursor: disabled ? 'not-allowed' : 'pointer',
        opacity: disabled ? 'var(--opacity-disabled)' as unknown as number : 1,
        transition: `background var(--transition-fast), color var(--transition-fast), opacity var(--transition-fast)`,
        lineHeight: 'var(--line-height-tight)',
        whiteSpace: 'nowrap',
        display: 'inline-flex',
        alignItems: 'center',
        justifyContent: 'center',
        gap: 'var(--space-1)',
        ...extStyle,
    };

    return (
        <button
            type={type}
            style={style}
            onClick={disabled ? undefined : onClick}
            onMouseEnter={onEnter}
            onMouseLeave={onLeave}
            disabled={disabled}
            title={title}
        >
            {children}
        </button>
    );
});
