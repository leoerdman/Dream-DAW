import { useEffect, useRef } from 'react';
import { createPortal } from 'react-dom';
import { TRACK_PALETTE, PALETTE_COLUMNS } from '@/widgets/TrackInspector/model/trackPalette';

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

    const swatchSize = 16;
    const gap = 2;
    const paddingX = 10;
    const paddingY = 8;
    const popupWidth = PALETTE_COLUMNS * (swatchSize + gap) - gap + paddingX * 2;
    const popupHeight = Math.ceil(TRACK_PALETTE.length / PALETTE_COLUMNS) * (swatchSize + gap) - gap + paddingY * 2 + 24;
    const clampedX = Math.min(x, window.innerWidth - popupWidth - 8);
    const clampedY = Math.min(y, window.innerHeight - popupHeight - 8);

    const node = (
        <div ref={ref} data-color-picker style={{
            position: 'fixed', left: clampedX, top: clampedY, width: popupWidth,
            background: 'var(--color-bg-elevated)', border: 'var(--space-px) solid var(--color-border-subtle)',
            borderRadius: 'var(--radius-xl)', padding: `${paddingY}px ${paddingX}px`, zIndex: 'var(--z-menu)',
            boxShadow: '0 var(--space-2) var(--space-8) var(--color-overlay-dark)',
        }}>
            <div style={{
                fontSize: 'var(--font-size-2xs)', fontWeight: 'var(--font-weight-semibold)',
                color: 'var(--color-text-secondary)',
                textTransform: 'uppercase', letterSpacing: '0.05em',
                marginBottom: 6, textAlign: 'center',
            }}>Track Color</div>

            <div style={{
                display: 'grid',
                gridTemplateColumns: `repeat(${PALETTE_COLUMNS}, ${swatchSize}px)`,
                gap: gap,
            }}>
                {TRACK_PALETTE.map((c) => {
                    const isActive = currentColor.toLowerCase() === c.hex.toLowerCase();
                    return (
                        <button
                            key={c.hex}
                            title={c.name}
                            onClick={() => onSelect(c.hex)}
                            style={{
                                width: swatchSize, height: swatchSize,
                                borderRadius: 'var(--radius-sm)',
                                background: c.hex,
                                border: isActive ? '2px solid var(--color-text-bright)' : '1px solid rgba(0,0,0,0.15)',
                                cursor: 'pointer',
                                transition: 'transform var(--transition-micro), border-color var(--transition-fast)',
                                boxShadow: isActive ? `0 0 var(--space-1-5) ${c.hex}80` : 'none',
                                padding: 0,
                            }}
                            onMouseEnter={e => { e.currentTarget.style.transform = 'scale(1.25)'; e.currentTarget.style.zIndex = '1'; }}
                            onMouseLeave={e => { e.currentTarget.style.transform = 'scale(1)'; e.currentTarget.style.zIndex = '0'; }}
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
