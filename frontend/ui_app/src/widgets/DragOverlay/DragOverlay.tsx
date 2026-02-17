/**
 * DragOverlay — Floating label that follows the cursor during store-based drag.
 *
 * Renders only when `useDragStore.draggingItem` is set.
 * Follows the mouse cursor with a slight offset (+12px, +12px).
 */

import { useEffect, useState } from 'react';
import { useDragStore } from '@/shared/stores/useDragStore';

export const DragOverlay = () => {
    const draggingItem = useDragStore(s => s.draggingItem);
    const [pos, setPos] = useState({ x: 0, y: 0 });

    useEffect(() => {
        if (!draggingItem) return;

        const onMove = (e: MouseEvent) => {
            setPos({ x: e.clientX, y: e.clientY });
        };
        window.addEventListener('mousemove', onMove);
        return () => window.removeEventListener('mousemove', onMove);
    }, [draggingItem]);

    if (!draggingItem) return null;

    const icon = draggingItem.type === 'plugin' ? '🧩' : '🎵';

    return (
        <div
            style={{
                position: 'fixed',
                left: pos.x + 12,
                top: pos.y + 12,
                padding: '4px 10px',
                borderRadius: 'var(--radius-md)',
                background: 'var(--color-accent-primary)',
                color: 'var(--color-text-on-accent)',
                fontSize: 'var(--font-size-sm)',
                fontWeight: 'var(--font-weight-semibold)' as unknown as number,
                fontFamily: 'var(--font-mono)',
                whiteSpace: 'nowrap',
                pointerEvents: 'none',
                boxShadow: '0 4px 12px var(--color-overlay-dark)',
                zIndex: 'var(--z-drag-overlay)' as unknown as number,
                userSelect: 'none',
            }}
        >
            {icon} {draggingItem.name}
        </div>
    );
};
