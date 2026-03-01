import type { StoreApi } from 'zustand';
import * as engine from '@/shared/api/engine';
import { MIN_BPM, MAX_BPM, clampTimeSigNumerator, clampTimeSigDenominator } from '@/shared/lib/audioMath';
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
                const isPlaying = await engine.withTimeout(engine.togglePlayback(), 500);
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
                await engine.withTimeout(engine.play(), 500);
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
                await engine.withTimeout(engine.stop(), 500);
                set((s) => ({
                    transport: { ...s.transport, is_playing: false },
                    lastError: null,
                }));
            } catch (e) {
                set({ lastError: String(e) });
            }
        },

        setBpm: async (bpm: number) => {
            // BUG-036 FIX: Clamp BPM to valid range — uses SSOT constants from audioMath.
            const clamped = Math.max(MIN_BPM, Math.min(MAX_BPM, bpm));
            set((s) => ({ transport: { ...s.transport, bpm: clamped }, projectBpm: clamped }));
            markBpmPending(500);
            try {
                const response = await engine.withTimeout(engine.setBpmWithDeltas(clamped), 500);
                await get().applyProjectDeltas(response.deltas, 'setBpm');
                set({ lastError: null });
            } catch (e) {
                set({ lastError: String(e) });
            }
        },

        setTimeSignature: async (numerator: number, denominator: number) => {
            // BUG-059 FIX: Validate inputs — reject NaN/Infinity, enforce integer range,
            // SSOT: Uses shared clamp functions from audioMath.ts (max num 99, max denom 64).
            if (!Number.isFinite(numerator) || !Number.isFinite(denominator)) return;
            const clampedNumerator = clampTimeSigNumerator(numerator);
            const clampedDenominator = clampTimeSigDenominator(denominator);
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
                await engine.withTimeout(engine.seekSeconds(safe), 500);
                set({ lastError: null });
            } catch (e) {
                set({ lastError: String(e) });
            }
        },

        seekToBeat: async (beat: number) => {
            // BUG-006: Validate input — reject NaN, Infinity, and negative values.
            const safe = Number.isFinite(beat) ? Math.max(0, beat) : 0;
            try {
                await engine.withTimeout(engine.seekToBeat(safe), 500);
                set({ lastError: null });
            } catch (e) {
                set({ lastError: String(e) });
            }
        },

        setLoop: async (enabled: boolean, startFrames: number, endFrames: number) => {
            // BUG-014 FIX: Validate inputs — reject NaN/Infinity/negative, matching other transport actions.
            if (!Number.isFinite(startFrames) || !Number.isFinite(endFrames)) return;

            // BUG-016 FIX: Round FIRST, then clamp/enforce ordering.
            // Previously: clamped, then rounded. If start and end were floats between N and N+0.4,
            // both could round down to N, creating a 0-length loop which the backend might reject or crash on.
            const roundedStart = Math.max(0, Math.round(startFrames));
            const roundedEnd = Math.max(0, Math.round(endFrames));

            const safeStart = Math.min(roundedStart, roundedEnd);
            // BUG-015 FIX: Enforce minimum 1-frame loop duration to prevent zero/negative-length loops.
            const safeEnd = Math.max(safeStart + 1, roundedEnd);
            set((s) => ({
                transport: { ...s.transport, loop_enabled: enabled, loop_start: safeStart, loop_end: safeEnd },
            }));
            try {
                const response = await engine.setLoopWithDeltas(enabled, safeStart, safeEnd);
                await get().applyProjectDeltas(response.deltas, 'setLoop');
                set({ lastError: null });
            } catch (e) {
                set({ lastError: String(e) });
            }
        },

        setFrequency: async (freq: number) => {
            // BUG-F008 FIX: Validate input — reject NaN, Infinity, clamp to audible range.
            const safe = Number.isFinite(freq) ? Math.max(20, Math.min(20000, freq)) : 440;
            try {
                await engine.setFrequency(safe);
                set({ lastError: null });
            } catch (e) {
                set({ lastError: String(e) });
            }
        },
    };
}
