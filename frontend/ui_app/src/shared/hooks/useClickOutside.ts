import { useEffect, type RefObject } from 'react';

/**
 * Enterprise shared click-outside hook.
 *
 * Attaches a `mousedown` listener that fires `onClose` when a click
 * occurs outside the referenced element. Replaces 4+ duplicated
 * inline implementations across TransportBar, StatusBar, etc.
 *
 * @param ref — React ref to the container element
 * @param onClose — callback to fire when clicking outside
 * @param active — whether the listener is active (default: true)
 */
export function useClickOutside(
    ref: RefObject<HTMLElement | null>,
    onClose: () => void,
    active = true,
): void {
    useEffect(() => {
        if (!active) return;
        const onDown = (e: PointerEvent) => {
            if (ref.current && !ref.current.contains(e.target as Node)) {
                onClose();
            }
        };
        // BUG-025 FIX: passive:true avoids blocking scroll during click-outside detection.
        document.addEventListener('pointerdown', onDown, { passive: true });
        return () => document.removeEventListener('pointerdown', onDown);
    }, [ref, onClose, active]);
}
