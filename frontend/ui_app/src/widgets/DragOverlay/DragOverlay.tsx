/**
 * DragOverlay — Floating label that follows the cursor during store-based drag.
 *
 * Renders only when `useDragStore.draggingItem` is set.
 * BUG-089 FIX: Uses ref-based DOM manipulation instead of React state
 * to eliminate 60fps re-renders during drag.
 */

import { useEffect, useRef } from 'react';
import { useDragStore } from '@/shared/stores/useDragStore';

export const DragOverlay = () => {
    const draggingItem = useDragStore(s => s.draggingItem);
    const overlayRef = useRef<HTMLDivElement>(null);

    useEffect(() => {
        if (!draggingItem) return;

        const handleMouseMove = (e: MouseEvent) => {
            if (overlayRef.current) {
                overlayRef.current.style.transform = `translate(${e.clientX + 12}px, ${e.clientY + 12}px)`;
            }
        };

        window.addEventListener('mousemove', handleMouseMove);
        return () => window.removeEventListener('mousemove', handleMouseMove);
    }, [draggingItem]);

    if (!draggingItem) return null;

    const label = draggingItem.type === 'plugin'
        ? `🧩 ${draggingItem.name}`
        : `🎵 ${draggingItem.name}`;

    return (
        <div
            ref={overlayRef}
            style={{
                position: 'fixed',
                left: 0,
                top: 0,
                transform: 'translate(0px, 0px)',
                pointerEvents: 'none',
                zIndex: 99999,
                background: 'var(--token-color-rgba-30-30-40-0d85)',
                backdropFilter: 'blur(8px)',
                color: 'var(--token-color-hex-ffffff)',
                padding: '5px 10px',
                borderRadius: 6,
                fontSize: 12,
                whiteSpace: 'nowrap',
                boxShadow: '0 4px 12px var(--token-color-rgba-0-0-0-0d4)',
                willChange: 'transform',
            }}
        >
            {label}
        </div>
    );
};
