import type { StoreApi } from 'zustand';
import * as engine from '@/shared/api/engine';
import type { EngineStore } from '@/shared/stores/useEngineStore';

export function createPluginEditorActions(
    set: StoreApi<EngineStore>['setState'],
    get: StoreApi<EngineStore>['getState'],
): Pick<EngineStore, 'togglePluginEditor' | 'closeAllPluginEditors' | 'hideEditorsForTrack' | 'restoreEditorsForTrack'> {
    return {
        togglePluginEditor: async (trackId: string, slotId: string) => {
            const { openEditorsByTrack } = get();
            const trackSet = openEditorsByTrack[trackId] || new Set<string>();
            const isOpen = trackSet.has(slotId);
            try {
                if (isOpen) {
                    await engine.closePluginWindowForSlot(trackId, slotId);
                    const nextSet = new Set(trackSet);
                    nextSet.delete(slotId);
                    set((state) => ({ openEditorsByTrack: { ...state.openEditorsByTrack, [trackId]: nextSet } }));
                } else {
                    await engine.openPluginWindowForSlot(trackId, slotId);
                    const nextSet = new Set(trackSet);
                    nextSet.add(slotId);
                    set((state) => ({ openEditorsByTrack: { ...state.openEditorsByTrack, [trackId]: nextSet } }));
                }
                set({ lastError: null });
            } catch (error) {
                set({ lastError: String(error) });
            }
        },

        closeAllPluginEditors: async () => {
            const { openEditorsByTrack } = get();
            for (const [trackId, slots] of Object.entries(openEditorsByTrack)) {
                for (const slotId of slots) {
                    try {
                        await engine.closePluginWindowForSlot(trackId, slotId);
                    } catch (err) {
                        console.warn('[PluginEditors] closePluginWindowForSlot failed:', err);
                    }
                }
            }
            set({ openEditorsByTrack: {} });
        },

        /**
         * ENTERPRISE: Hide native plugin windows for a track.
         * Closes the native OS windows but PRESERVES the openEditorsByTrack Set.
         * When user returns to this track, restoreEditorsForTrack will reopen them.
         */
        hideEditorsForTrack: async (trackId: string) => {
            const { openEditorsByTrack } = get();
            const slots = openEditorsByTrack[trackId];
            if (!slots || slots.size === 0) return;

            // Close native windows silently — do NOT modify the Set
            await Promise.all(
                Array.from(slots).map((slotId) =>
                    engine.closePluginWindowForSlot(trackId, slotId).catch((err) =>
                        console.warn('[PluginEditors] hideEditorsForTrack: close failed:', err),
                    ),
                ),
            );
        },

        /**
         * ENTERPRISE: Restore native plugin windows for a track.
         * Reads the preserved openEditorsByTrack Set and reopens native windows.
         */
        restoreEditorsForTrack: async (trackId: string) => {
            const { openEditorsByTrack } = get();
            const slots = openEditorsByTrack[trackId];
            if (!slots || slots.size === 0) return;

            // Reopen native windows from the preserved Set
            await Promise.all(
                Array.from(slots).map((slotId) =>
                    engine.openPluginWindowForSlot(trackId, slotId).catch((err) =>
                        console.warn('[PluginEditors] restoreEditorsForTrack: open failed:', err),
                    ),
                ),
            );
        },
    };
}
