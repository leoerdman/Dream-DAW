import { useEffect, useRef } from 'react';
import { createPortal } from 'react-dom';

export interface ClipContextMenuPopupProps {
    x: number;
    y: number;
    clipId: string;
    onDuplicate: () => void;
    onDelete: () => void;
    onResetFades: () => void;
    onDismiss: () => void;
}

export const ClipContextMenuPopup = ({
    x,
    y,
    onDuplicate,
    onDelete,
    onResetFades,
    onDismiss,
}: ClipContextMenuPopupProps) => {
    const ref = useRef<HTMLDivElement>(null);

    useEffect(() => {
        const handleClick = (e: MouseEvent) => {
            if (ref.current && !ref.current.contains(e.target as Node)) onDismiss();
        };
        const handleKey = (e: KeyboardEvent) => {
            if (e.key === 'Escape') onDismiss();
        };
        document.addEventListener('pointerdown', handleClick);
        document.addEventListener('keydown', handleKey);
        return () => {
            document.removeEventListener('pointerdown', handleClick);
            document.removeEventListener('keydown', handleKey);
        };
    }, [onDismiss]);

    const clampedX = Math.min(x, window.innerWidth - 196);
    const clampedY = Math.min(y, window.innerHeight - 200);

    const itemStyle: React.CSSProperties = {
        width: '100%',
        padding: 'var(--space-1-5) var(--space-3)',
        background: 'none',
        border: 'none',
        color: 'var(--color-text-primary)',
        fontSize: 'var(--font-size-sm)',
        fontWeight: 'var(--font-weight-regular)',
        textAlign: 'left',
        cursor: 'pointer',
        borderRadius: 'var(--radius-md)',
        display: 'flex',
        alignItems: 'center',
        gap: 8,
    };

    const hoverIn = (e: React.MouseEvent) => {
        (e.currentTarget as HTMLElement).style.background = 'color-mix(in srgb, var(--text-primary) 8%, transparent)';
    };
    const hoverOut = (e: React.MouseEvent) => {
        (e.currentTarget as HTMLElement).style.background = 'none';
    };

    const node = (
        <div
            ref={ref}
            style={{
                position: 'fixed',
                left: clampedX,
                top: clampedY,
                width: 188,
                background: 'var(--surface-2)',
                border: 'var(--space-px) solid var(--color-border-subtle)',
                borderRadius: 'var(--radius-xl)',
                padding: 4,
                zIndex: 'var(--z-menu)',
                boxShadow: 'var(--shadow-panel)',
            }}
        >
            <button style={itemStyle} onClick={onDuplicate} onMouseEnter={hoverIn} onMouseLeave={hoverOut}>
                <span style={{ width: 14, fontSize: 'var(--font-size-base)' }}>📋</span> Duplicate Clip
            </button>
            <button style={itemStyle} onClick={onResetFades} onMouseEnter={hoverIn} onMouseLeave={hoverOut}>
                <span style={{ width: 14, fontSize: 'var(--font-size-base)' }}>↩</span> Reset Fades
            </button>
            <div style={{ height: 1, background: 'var(--color-divider)', margin: 'var(--space-0-5) var(--space-2)' }} />
            <button
                style={{ ...itemStyle, color: 'var(--color-status-error)' }}
                onClick={onDelete}
                onMouseEnter={(e) => {
                    (e.currentTarget as HTMLElement).style.background = 'color-mix(in srgb, var(--color-status-error) 18%, transparent)';
                }}
                onMouseLeave={hoverOut}
            >
                <span style={{ width: 14, fontSize: 'var(--font-size-base)' }}>🗑</span> Delete Clip
            </button>
        </div>
    );

    if (typeof document !== 'undefined' && document.body) {
        return createPortal(node, document.body);
    }
    return node;
};
