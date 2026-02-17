import { memo, useState, useCallback, type CSSProperties } from 'react';

/* ═══════════════════════════════════════════════════════════════
   CloseButton — Enterprise shared close "✕" button.
   Replaces 5+ different close button implementations.
   ═══════════════════════════════════════════════════════════════ */

interface CloseButtonProps {
    onClick: () => void;
    /** Size variant — 'sm' (20px), 'md' (24px) */
    size?: 'sm' | 'md';
    /** Optional tooltip */
    title?: string;
}

const SIZES = {
    sm: 20,
    md: 24,
} as const;

export const CloseButton = memo(function CloseButton({
    onClick,
    size = 'md',
    title = 'Close',
}: CloseButtonProps) {
    const [hovered, setHovered] = useState(false);
    const onEnter = useCallback(() => setHovered(true), []);
    const onLeave = useCallback(() => setHovered(false), []);

    const dim = SIZES[size];

    const style: CSSProperties = {
        width: dim,
        height: dim,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        borderRadius: 'var(--radius-full)',
        background: hovered ? 'var(--color-bg-hover)' : 'var(--color-bg-elevated)',
        color: 'var(--color-text-secondary)',
        fontSize: size === 'sm' ? 'var(--font-size-xs)' : 'var(--font-size-sm)',
        cursor: 'pointer',
        transition: `background var(--transition-fast), color var(--transition-fast)`,
        border: 'none',
        padding: 0,
        lineHeight: 1,
        flexShrink: 0,
    };

    return (
        <button
            type="button"
            style={style}
            onClick={onClick}
            onMouseEnter={onEnter}
            onMouseLeave={onLeave}
            title={title}
            aria-label={title}
        >
            ✕
        </button>
    );
});
