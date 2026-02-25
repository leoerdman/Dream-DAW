import type { StoreApi } from 'zustand';
import * as engine from '@/shared/api/engine';
import type { EngineStore } from '@/shared/stores/useEngineStore';

export function createTransportActions(
    set: StoreApi<EngineStore>['setState'],
    get: StoreApi<EngineStore>['getState'],
    markBpmPending: (ms: number) => void,
): Pick<
    EngineStore,
    'togglePlay' | 'play' | 'stop' | 'setBpm' | 'seekSeconds' | 'seekToBeat' | 'setLoop' | 'setFrequency' | 'expandWindow'
> {
    return {
        togglePlay: async () => {
            try {
                const isPlaying = await engine.togglePlayback();
                set((s) => ({
                    transport: { ...s.transport, is_playing: isPlaying },
                    lastError: null,
                }));
            } catch (e) {
                set({ lastError: String(e) });
            }
        },

        play: async () => {
            try {
                await engine.play();
                set((s) => ({
                    transport: { ...s.transport, is_playing: true },
                    lastError: null,
                }));
            } catch (e) {
                set({ lastError: String(e) });
            }
        },

        stop: async () => {
            try {
                await engine.stop();
                set((s) => ({
                    transport: { ...s.transport, is_playing: false },
                    lastError: null,
                }));
            } catch (e) {
                set({ lastError: String(e) });
            }
        },

        setBpm: async (bpm: number) => {
            // BUG-036 FIX: Clamp BPM to valid range — was unbounded,
            // allowing 0, negative, or 9999 values through.
            const clamped = Math.max(20, Math.min(999, bpm));
            set((s) => ({ transport: { ...s.transport, bpm: clamped }, projectBpm: clamped }));
            markBpmPending(500);
            try {
                const response = await engine.setBpmWithDeltas(clamped);
                await get().applyProjectDeltas(response.deltas, 'setBpm');
                set({ lastError: null });
            } catch (e) {
                set({ lastError: String(e) });
            }
        },

        seekSeconds: async (seconds: number) => {
            try {
                await engine.seekSeconds(seconds);
                set({ lastError: null });
            } catch (e) {
                set({ lastError: String(e) });
            }
        },

        seekToBeat: async (beat: number) => {
            try {
                await engine.seekToBeat(beat);
                set({ lastError: null });
            } catch (e) {
                set({ lastError: String(e) });
            }
        },

        setLoop: async (enabled: boolean, startFrames: number, endFrames: number) => {
            set((s) => ({
                transport: { ...s.transport, loop_enabled: enabled, loop_start: startFrames, loop_end: endFrames },
            }));
            try {
                const response = await engine.setLoopWithDeltas(enabled, startFrames, endFrames);
                await get().applyProjectDeltas(response.deltas, 'setLoop');
                set({ lastError: null });
            } catch (e) {
                set({ lastError: String(e) });
            }
        },

        setFrequency: async (freq: number) => {
            try {
                await engine.setFrequency(freq);
                set({ lastError: null });
            } catch (e) {
                set({ lastError: String(e) });
            }
        },

        expandWindow: async () => {
            try {
                await engine.expandWindow();
            } catch (e) {
                set({ lastError: String(e) });
            }
        },
    };
}
