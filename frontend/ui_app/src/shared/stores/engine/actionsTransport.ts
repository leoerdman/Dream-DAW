import type { StoreApi } from 'zustand';
import * as engine from '@/shared/api/engine';
import type { EngineStore } from '@/shared/stores/useEngineStore';

export function createTransportActions(
    set: StoreApi<EngineStore>['setState'],
    get: StoreApi<EngineStore>['getState'],
    markBpmPending: (ms: number) => void,
): Pick<
    EngineStore,
    'togglePlay' | 'play' | 'stop' | 'setBpm' | 'setTimeSignature' | 'seekSeconds' | 'seekToBeat' | 'setLoop' | 'setFrequency'
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

        setTimeSignature: async (numerator: number, denominator: number) => {
            // BUG-059 FIX: Validate inputs — reject NaN/Infinity, enforce integer range,
            // and snap denominator to nearest valid power-of-2 (1,2,4,8,16,32).
            if (!Number.isFinite(numerator) || !Number.isFinite(denominator)) return;
            const clampedNumerator = Math.max(1, Math.min(32, Math.round(numerator)));
            const rawDenom = Math.max(1, Math.min(32, Math.round(denominator)));
            // Snap to nearest power of 2 (standard: 1, 2, 4, 8, 16, 32)
            const clampedDenominator = Math.pow(2, Math.round(Math.log2(rawDenom)));
            set((s) => ({
                timeSigNumerator: clampedNumerator,
                timeSigDenominator: clampedDenominator,
                transport: {
                    ...s.transport,
                    time_sig_numerator: clampedNumerator,
                    time_sig_denominator: clampedDenominator,
                },
            }));
            try {
                const response = await engine.setTimeSignatureWithDeltas(clampedNumerator, clampedDenominator);
                await get().applyProjectDeltas(response.deltas, 'setTimeSignature');
                set({ lastError: null });
            } catch (e) {
                set({ lastError: String(e) });
            }
        },

        seekSeconds: async (seconds: number) => {
            // BUG-006: Validate input — reject NaN, Infinity, and negative values.
            const safe = Number.isFinite(seconds) ? Math.max(0, seconds) : 0;
            try {
                await engine.seekSeconds(safe);
                set({ lastError: null });
            } catch (e) {
                set({ lastError: String(e) });
            }
        },

        seekToBeat: async (beat: number) => {
            // BUG-006: Validate input — reject NaN, Infinity, and negative values.
            const safe = Number.isFinite(beat) ? Math.max(0, beat) : 0;
            try {
                await engine.seekToBeat(safe);
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
    };
}
