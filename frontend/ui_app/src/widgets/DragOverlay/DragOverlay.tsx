/**
 * DragOverlay — Floating label that follows the cursor during store-based drag.
 *
 * Renders only when `useDragStore.draggingItem` is set.
 * BUG-089 FIX: Uses ref-based DOM manipulation instead of React state
 * to eliminate 60fps re-renders during drag.
 */

import { useEffect, useRef } from 'react';
import { useDragStore } from '@/shared/stores/useDragStore';

/** Pixel offset from cursor to the overlay label (prevents the label from blocking clicks). */
const CURSOR_OFFSET_PX = 12;
/** Border radius uses UDS token for consistent rounding. */
const DRAG_LABEL_RADIUS = 'var(--radius-md)';
/** Font size uses UDS token for consistent typography. */
const DRAG_LABEL_FONT_SIZE = 'var(--font-size-xs)';

export const DragOverlay = () => {
    const draggingItem = useDragStore(s => s.draggingItem);
    const overlayRef = useRef<HTMLDivElement>(null);

    useEffect(() => {
        if (!draggingItem) return;

        // ENTERPRISE FIX (Phase 33): Pointer events for consistency.
        const handleMouseMove = (e: PointerEvent) => {
            if (overlayRef.current) {
                overlayRef.current.style.transform = `translate(${e.clientX + CURSOR_OFFSET_PX}px, ${e.clientY + CURSOR_OFFSET_PX}px)`;
            }
        };

        window.addEventListener('pointermove', handleMouseMove);
        return () => window.removeEventListener('pointermove', handleMouseMove);
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
                transform: 'translate(var(--space-0), var(--space-0))',
                pointerEvents: 'none',
                zIndex: 'var(--z-drag-overlay, 99999)',
                background: 'var(--token-color-rgba-30-30-40-0d85)',
                backdropFilter: 'blur(var(--space-2))',
                color: 'var(--token-color-hex-ffffff)',
                padding: 'var(--token-size-px-5) var(--space-2-5)',
                borderRadius: DRAG_LABEL_RADIUS,
                fontSize: DRAG_LABEL_FONT_SIZE,
                whiteSpace: 'nowrap',
                boxShadow: '0 var(--space-1) var(--space-3) var(--token-color-rgba-0-0-0-0d4)',
                willChange: 'transform',
            }}
        >
            {label}
        </div>
    );
};
