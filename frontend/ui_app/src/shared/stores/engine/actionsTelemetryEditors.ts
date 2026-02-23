import type { StoreApi } from 'zustand';
import * as engine from '@/shared/api/engine';
import type { EngineStore } from '@/shared/stores/useEngineStore';

export function createPluginEditorActions(
    set: StoreApi<EngineStore>['setState'],
    get: StoreApi<EngineStore>['getState'],
): Pick<EngineStore, 'togglePluginEditor' | 'closeAllPluginEditors'> {
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
                    } catch {
                        // no-op
                    }
                }
            }
            set({ openEditorsByTrack: {} });
        },
    };
}
