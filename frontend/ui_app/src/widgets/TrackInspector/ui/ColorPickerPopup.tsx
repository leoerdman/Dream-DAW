import { useEffect, useRef } from 'react';
import { createPortal } from 'react-dom';
import { TRACK_PALETTE } from '@/widgets/TrackInspector/model/trackPalette';

export type ColorPickerPopupProps = {
    x: number;
    y: number;
    currentColor: string;
    onSelect: (color: string) => void;
    onDismiss: () => void;
};

export const ColorPickerPopup = ({
    x,
    y,
    currentColor,
    onSelect,
    onDismiss,
}: ColorPickerPopupProps) => {
    const ref = useRef<HTMLDivElement>(null);

    useEffect(() => {
        const handleClick = (e: MouseEvent) => {
            if (ref.current && !ref.current.contains(e.target as Node)) onDismiss();
        };
        const handleKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onDismiss(); };
        document.addEventListener('mousedown', handleClick);
        document.addEventListener('keydown', handleKey);
        return () => {
            document.removeEventListener('mousedown', handleClick);
            document.removeEventListener('keydown', handleKey);
        };
    }, [onDismiss]);

    const popupWidth = 222;
    const popupHeight = 160;
    const clampedX = Math.min(x, window.innerWidth - popupWidth - 8);
    const clampedY = Math.min(y, window.innerHeight - popupHeight - 8);

    const node = (
        <div ref={ref} data-color-picker style={{
            position: 'fixed', left: clampedX, top: clampedY, width: popupWidth,
            background: 'var(--color-bg-elevated)', border: 'var(--space-px) solid var(--color-border-subtle)',
            borderRadius: 'var(--radius-xl)', padding: 8, zIndex: 'var(--z-menu)',
            boxShadow: '0 var(--space-2) var(--space-8) var(--color-overlay-dark)',
        }}>
            <div style={{
                fontSize: 'var(--font-size-2xs)', fontWeight: 'var(--font-weight-semibold)',
                color: 'var(--color-text-secondary)',
                textTransform: 'uppercase', letterSpacing: '0.05em',
                marginBottom: 6, textAlign: 'center',
            }}>Track Color</div>

            <div style={{
                display: 'grid', gridTemplateColumns: 'repeat(8, 1fr)', gap: 3,
            }}>
                {TRACK_PALETTE.map((c) => {
                    const isActive = currentColor.toLowerCase() === c.hex.toLowerCase();
                    return (
                        <button
                            key={c.hex}
                            title={c.name}
                            onClick={() => onSelect(c.hex)}
                            style={{
                                width: 23, height: 23, borderRadius: 'var(--radius-md)',
                                background: c.hex,
                                border: isActive ? 'var(--space-0-5) solid var(--color-text-bright)' : 'var(--space-0-5) solid transparent',
                                cursor: 'pointer',
                                transition: `transform var(--transition-micro), border-color var(--transition-fast)`,
                                boxShadow: isActive ? `0 0 var(--space-1-5) ${c.hex}80` : 'none',
                            }}
                            onMouseEnter={e => { e.currentTarget.style.transform = 'scale(1.15)'; }}
                            onMouseLeave={e => { e.currentTarget.style.transform = 'scale(1)'; }}
                        />
                    );
                })}
            </div>
        </div>
    );

    if (typeof document !== 'undefined' && document.body) {
        return createPortal(node, document.body);
    }
    return node;
};
