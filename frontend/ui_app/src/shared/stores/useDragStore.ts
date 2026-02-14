/**
 * useDragStore — Shared drag state for in-app drag-and-drop.
 *
 * HTML5 DnD is unreliable inside Tauri WebView (native drag handler intercepts
 * events). This store implements a lightweight alternative:
 *
 * 1. AssetBrowser sets `draggingItem` on mousedown + threshold
 * 2. Global mousemove updates `cursorPos` for real-time ghost preview
 * 3. Timeline reads cursor position to render a ghost clip at exact drop location
 * 4. Timeline handles global mouseup drop resolution → creates clip
 * 5. Timeline/store calls `endDrag()` to clean up
 *
 * Mouseup cleanup is orchestrated by the Timeline shell, not by this store.
 */

import { create } from 'zustand';

export interface DragBrowserItem {
    id: string;
    name: string;
    type: 'audio' | 'midi' | 'preset' | 'plugin';
    path: string;
    slotHint?: 'instrument' | 'effect' | 'auto';
    /** Real audio duration (seconds) when available. */
    durationSeconds?: number;
}

interface DragState {
    /** The item currently being dragged from the AssetBrowser (null when idle). */
    draggingItem: DragBrowserItem | null;

    /** Current cursor position (updated on every mousemove during drag). */
    cursorX: number;
    cursorY: number;

    /** Start dragging an item. Begins tracking cursor position. */
    startDrag: (item: DragBrowserItem, cursorX?: number, cursorY?: number) => void;

    /** Cancel / end the drag. Stops cursor tracking. */
    endDrag: () => void;
    /** Patch metadata for active drag item (e.g. resolved duration). */
    updateDraggingItem: (patch: Partial<DragBrowserItem>) => void;
}

/** Internal cleanup handle for the global mousemove listener. */
let _cleanupMouseMove: (() => void) | null = null;

export const useDragStore = create<DragState>((set) => ({
    draggingItem: null,
    cursorX: 0,
    cursorY: 0,

    startDrag: (item, cursorX, cursorY) => {
        console.log('[DragStore] startDrag', item.name);
        set({
            draggingItem: item,
            cursorX: cursorX ?? 0,
            cursorY: cursorY ?? 0,
        });
        window.__dreamInAppDrag = true;

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
        window.__dreamInAppDrag = false;
    },

    updateDraggingItem: (patch) => {
        set((state) => {
            if (!state.draggingItem) return state;
            return {
                draggingItem: {
                    ...state.draggingItem,
                    ...patch,
                },
            };
        });
    },
}));
