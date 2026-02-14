/**
 * useDragStore — Shared drag state for in-app drag-and-drop.
 *
 * HTML5 DnD is unreliable inside Tauri WebView (native drag handler intercepts
 * events). This store implements a lightweight alternative:
 *
 * 1. AssetBrowser sets `draggingItem` on mousedown
 * 2. Timeline detects mouseup while `draggingItem` is set → creates clip
 * 3. Global mouseup clears `draggingItem`
 *
 * This approach is 100% reliable across all platforms.
 */

import { create } from 'zustand';

export interface DragBrowserItem {
    id: string;
    name: string;
    type: 'audio' | 'midi' | 'preset';
    path: string;
}

interface DragState {
    /** The item currently being dragged from the AssetBrowser (null when idle). */
    draggingItem: DragBrowserItem | null;

    /** Start dragging an item. */
    startDrag: (item: DragBrowserItem) => void;

    /** Cancel / end the drag. */
    endDrag: () => void;
}

export const useDragStore = create<DragState>((set) => ({
    draggingItem: null,

    startDrag: (item) => {
        console.log('[DragStore] startDrag', item.name);
        set({ draggingItem: item });
    },

    endDrag: () => {
        set((state) => {
            if (state.draggingItem) {
                console.log('[DragStore] endDrag');
            }
            return { draggingItem: null };
        });
    },
}));
