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
                borderRadius: '4px',
                background: 'var(--color-accent-primary, #4a90d9)',
                color: '#fff',
                fontSize: '11px',
                fontWeight: 600,
                fontFamily: 'var(--font-mono, monospace)',
                whiteSpace: 'nowrap',
                pointerEvents: 'none',
                boxShadow: '0 4px 12px rgba(0,0,0,0.4)',
                zIndex: 99999,
                userSelect: 'none',
            }}
        >
            {icon} {draggingItem.name}
        </div>
    );
};
