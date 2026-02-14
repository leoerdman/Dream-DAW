/**
 * useDragStore — Shared drag state for in-app drag-and-drop.
 *
 * HTML5 DnD is unreliable inside Tauri WebView (native drag handler intercepts
 * events). This store implements a lightweight alternative:
 *
 * 1. AssetBrowser sets `draggingItem` on mousedown + threshold
 * 2. Global mousemove updates `cursorPos` for real-time ghost preview
 * 3. Timeline reads cursor position to render a ghost clip at exact drop location
 * 4. DawShell's global mouseup handler detects cursor over Timeline → creates clip
 * 5. DawShell calls `endDrag()` to clean up
 *
 * IMPORTANT: The mouseup cleanup is handled SOLELY by DawShell, NOT by this store.
 * This avoids listener ordering race conditions during HMR and strict mode.
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

    /** Cancel / end the drag. Stops cursor tracking. */
    endDrag: () => void;
}

/** Internal cleanup handle for the global mousemove listener. */
let _cleanupMouseMove: (() => void) | null = null;

export const useDragStore = create<DragState>((set) => ({
    draggingItem: null,
    cursorX: 0,
    cursorY: 0,

    startDrag: (item) => {
        console.log('[DragStore] startDrag', item.name);
        set({ draggingItem: item });

        // Attach global mousemove to track cursor for ghost preview rendering
        _cleanupMouseMove?.();
        const onMove = (e: MouseEvent) => {
            set({ cursorX: e.clientX, cursorY: e.clientY });
        };
        window.addEventListener('mousemove', onMove);
        _cleanupMouseMove = () => {
            window.removeEventListener('mousemove', onMove);
        };
    },

    endDrag: () => {
        set((state) => {
            if (state.draggingItem) {
                console.log('[DragStore] endDrag');
            }
            return { draggingItem: null };
        });
        _cleanupMouseMove?.();
        _cleanupMouseMove = null;
    },
}));
