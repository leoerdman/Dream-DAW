import { useEffect, useRef } from 'react';
import { createPortal } from 'react-dom';

export interface DeviceContextMenuPopupProps {
    x: number;
    y: number;
    deviceId: string;
    deviceName: string;
    isEnabled: boolean;
    onGroup: () => void;
    onBypass: () => void;
    onDelete: () => void;
    onDismiss: () => void;
}

export const DeviceContextMenuPopup = ({
    x,
    y,
    deviceId: _deviceId,
    deviceName,
    isEnabled,
    onGroup,
    onBypass,
    onDelete,
    onDismiss,
}: DeviceContextMenuPopupProps) => {
    const ref = useRef<HTMLDivElement>(null);

    useEffect(() => {
        const handleClick = (e: MouseEvent) => {
            if (ref.current && !ref.current.contains(e.target as Node)) onDismiss();
        };
        const handleKey = (e: KeyboardEvent) => {
            if (e.key === 'Escape') onDismiss();
        };
        document.addEventListener('mousedown', handleClick);
        document.addEventListener('keydown', handleKey);
        return () => {
            document.removeEventListener('mousedown', handleClick);
            document.removeEventListener('keydown', handleKey);
        };
    }, [onDismiss]);

    const clampedX = Math.min(x, window.innerWidth - 196);
    const clampedY = Math.min(y, window.innerHeight - 220);

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
                width: 200,
                background: 'var(--surface-2)',
                border: 'var(--space-px) solid var(--color-border-subtle)',
                borderRadius: 'var(--radius-xl)',
                padding: 4,
                zIndex: 'var(--z-menu)',
                boxShadow: 'var(--shadow-panel)',
            }}
        >
            <div
                style={{
                    padding: 'var(--space-1) var(--space-3)',
                    fontSize: 'var(--font-size-xs)',
                    color: 'var(--color-text-tertiary)',
                    fontWeight: 'var(--font-weight-bold)',
                    textTransform: 'uppercase',
                    letterSpacing: '0.04em',
                    whiteSpace: 'nowrap',
                    overflow: 'hidden',
                    textOverflow: 'ellipsis',
                }}
            >
                {deviceName}
            </div>
            <div style={{ height: 1, background: 'var(--color-divider)', margin: 'var(--space-0-5) var(--space-2)' }} />
            <button style={itemStyle} onClick={onGroup} onMouseEnter={hoverIn} onMouseLeave={hoverOut}>
                <span style={{ width: 14, fontSize: 'var(--font-size-base)' }}>🧩</span> Group Into Rack
            </button>
            <button style={itemStyle} onClick={onBypass} onMouseEnter={hoverIn} onMouseLeave={hoverOut}>
                <span style={{ width: 14, fontSize: 'var(--font-size-base)' }}>{isEnabled ? '🔇' : '🔊'}</span>
                {isEnabled ? 'Bypass Device' : 'Enable Device'}
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
                <span style={{ width: 14, fontSize: 'var(--font-size-base)' }}>🗑</span> Delete Device
            </button>
        </div>
    );

    if (typeof document !== 'undefined' && document.body) {
        return createPortal(node, document.body);
    }
    return node;
};
