/**
 * useDragStore — Shared drag state for in-app drag-and-drop.
 *
 * HTML5 DnD is unreliable inside Tauri WebView (native drag handler intercepts
 * events). This store implements a lightweight alternative:
 *
 * 1. AssetBrowser sets `draggingItem` on mousedown + threshold
 * 2. Global mousemove updates `cursorPos` for real-time ghost preview
 * 3. Timeline reads cursor position to render a ghost clip at exact drop location
 * 4. Global mouseup in DawShell detects if cursor is over Timeline → creates clip
 *
 * This approach is 100% reliable across all platforms.
 */

import { create } from 'zustand';

export interface DragBrowserItem {
    id: string;
    name: string;
    type: 'audio' | 'midi' | 'preset' | 'plugin';
    path: string;
    slotHint?: 'instrument' | 'effect' | 'auto';
}

interface DragState {
    /** The item currently being dragged from the AssetBrowser (null when idle). */
    draggingItem: DragBrowserItem | null;

    /** Current cursor position (updated on every mousemove during drag). */
    cursorX: number;
    cursorY: number;

    /** Start dragging an item. Begins tracking cursor position. */
    startDrag: (item: DragBrowserItem) => void;

    /** Cancel / end the drag. */
    endDrag: () => void;

    /** Update cursor position (called from global mousemove during drag). */
    updateCursor: (x: number, y: number) => void;
}

/** Internal cleanup handle for the global mousemove + mouseup listeners. */
let _cleanupGlobalListeners: (() => void) | null = null;

export const useDragStore = create<DragState>((set, get) => ({
    draggingItem: null,
    cursorX: 0,
    cursorY: 0,

    startDrag: (item) => {
        console.log('[DragStore] startDrag', item.name);
        set({ draggingItem: item });

        // Attach global mousemove to track cursor for ghost preview rendering
        _cleanupGlobalListeners?.();
        const onMove = (e: MouseEvent) => {
            get().updateCursor(e.clientX, e.clientY);
        };
        const onUp = () => {
            // endDrag is called from DawShell's mouseup handler (which checks
            // whether cursor is over Timeline). This is just a safety fallback.
            // Small delay to let DawShell handler fire first.
            requestAnimationFrame(() => {
                if (get().draggingItem) {
                    get().endDrag();
                }
            });
        };
        window.addEventListener('mousemove', onMove);
        window.addEventListener('mouseup', onUp);
        _cleanupGlobalListeners = () => {
            window.removeEventListener('mousemove', onMove);
            window.removeEventListener('mouseup', onUp);
        };
    },

    endDrag: () => {
        set((state) => {
            if (state.draggingItem) {
                console.log('[DragStore] endDrag');
            }
            return { draggingItem: null };
        });
        _cleanupGlobalListeners?.();
        _cleanupGlobalListeners = null;
    },

    updateCursor: (x, y) => {
        set({ cursorX: x, cursorY: y });
    },
}));
