import throttle from 'lodash.throttle';
import type { StoreApi } from 'zustand';
import * as engine from '@/shared/api/engine';
import { clamp01 } from '@/shared/lib/audioMath';
import type { EngineStore } from '@/shared/stores/useEngineStore';
import type { ProjectTrack } from '@/shared/stores/useEngineStore';
import { buildTrackStatePatch } from '@/shared/stores/engine/storeHelpers';
import type { TrackStatePatch } from '@/shared/stores/engine/storeHelpers';
import { useStatusStore } from '@/shared/stores/useStatusStore';
import {
    clearTrackControlCaches as clearTrackControlCachesLocal,
    getPendingMasterVolume,
    pendingPanValues,
    pendingSendLevelValues,
    pendingVolumeValues,
    setPendingMasterVolume,
    throttledMasterVolumeSend,
    throttledPanSends,
    throttledSendLevelSends,
    throttledVolumeSends,
    type ThrottledFn,
} from '@/shared/stores/engine/actionsTrackProjectThrottle';
export { clearTrackControlCachesLocal as clearTrackControlCaches };
function patchTrackByIndex(
    state: EngineStore,
    trackIndex: number,
    patch: Partial<ProjectTrack>,
): TrackStatePatch<ProjectTrack> {
    const trackId = state.tracks.allIds[trackIndex];
    // BUG-026 FIX: Return empty object for not-found tracks to preserve
    // Zustand reference equality. Previously returned a full track state
    // patch (structurally different from `state`) which triggered needless
    // re-renders even though nothing changed.
    if (!trackId) return {} as TrackStatePatch<ProjectTrack>;

    const sourceTrack = state.tracks.byId[trackId];
    if (!sourceTrack) return {} as TrackStatePatch<ProjectTrack>;

    const updatedTrack = { ...sourceTrack, ...patch };
    const nextTracksById = { ...state.tracks.byId, [trackId]: updatedTrack };
    return buildTrackStatePatch(state.tracks.allIds, nextTracksById);
}

export function createTrackProjectActions(
    set: StoreApi<EngineStore>['setState'],
    get: StoreApi<EngineStore>['getState'],
): Pick<
    EngineStore,
    | 'setTrackVolume'
    | 'setTrackPan'
    | 'setTrackSendLevel'
    | 'setMasterVolume'
    | 'flushTrackControlFinals'
    | 'setTrackDisabled'
    | 'setTrackSolo'
    | 'addTrack'
    | 'deleteTrack'
    | 'renameTrack'
    | 'importFile'
    | 'createMidiClip'
> {
    return {
        setTrackVolume: async (trackIndex: number, volume: number) => {
            // BUG-032 FIX: Guard against NaN/Infinity from slider math.
            // A NaN volume would poison the audio thread's gain calculation.
            if (!Number.isFinite(volume)) return;
            // BUG-009: Guard track index bounds to prevent stale index access.
            if (trackIndex < 0 || trackIndex >= get().tracks.allIds.length) return;
            try {
                set((s) => {
                    const tid = s.tracks.allIds[trackIndex];
                    const track = tid ? s.tracks.byId[tid] : null;
                    if (!track || track.volume === volume) return s;
                    return patchTrackByIndex(s, trackIndex, { volume });
                });
                pendingVolumeValues.set(trackIndex, volume);
                if (!throttledVolumeSends.has(trackIndex)) {
                    throttledVolumeSends.set(
                        trackIndex,
                        throttle((nextVolume: number) => {
                            // BUG-C02 FIX: Capture oldVolume at IPC-send time via get(),
                            // NOT in the outer closure. The outer closure's oldVolume
                            // becomes stale on the 2nd+ call when the throttle function
                            // is reused from the Map.
                            const trackId = get().tracks.allIds[trackIndex];
                            const currentVolume = trackId
                                ? get().tracks.byId[trackId]?.volume
                                : undefined;
                            void engine
                                .setTrackVolumeWithDeltas(trackIndex, nextVolume)
                                .then((response) => get().applyProjectDeltas(response.deltas, 'setTrackVolume'))
                                .catch((e) => {
                                    // BUG-011 FIX: Revert optimistic update on failure.
                                    // BUG-C02 FIX: rollback uses fresh `currentVolume` not stale closure.
                                    if (currentVolume !== undefined) {
                                        set((s) => patchTrackByIndex(s, trackIndex, { volume: currentVolume }));
                                    }
                                    set({ lastError: String(e) });
                                });
                        }, 16),
                    );
                }
                throttledVolumeSends.get(trackIndex)?.(volume);
            } catch (e) {
                set({ lastError: String(e) });
            }
        },

        setTrackPan: async (trackIndex: number, pan: number) => {
            // BUG-032 FIX: Guard against NaN/Infinity from slider math.
            if (!Number.isFinite(pan)) return;
            // BUG-009: Guard track index bounds to prevent stale index access.
            if (trackIndex < 0 || trackIndex >= get().tracks.allIds.length) return;
            try {
                set((s) => {
                    const tid = s.tracks.allIds[trackIndex];
                    const track = tid ? s.tracks.byId[tid] : null;
                    if (!track || track.pan === pan) return s;
                    return patchTrackByIndex(s, trackIndex, { pan });
                });
                pendingPanValues.set(trackIndex, pan);
                if (!throttledPanSends.has(trackIndex)) {
                    throttledPanSends.set(
                        trackIndex,
                        throttle((nextPan: number) => {
                            // BUG-C03 FIX: Capture oldPan at IPC-send time via get(),
                            // NOT in the outer closure. Same stale closure bug as BUG-C02.
                            const trackId = get().tracks.allIds[trackIndex];
                            const currentPan = trackId
                                ? get().tracks.byId[trackId]?.pan
                                : undefined;
                            void engine
                                .setTrackPanWithDeltas(trackIndex, nextPan)
                                .then((response) => get().applyProjectDeltas(response.deltas, 'setTrackPan'))
                                .catch((e) => {
                                    // BUG-011 FIX: Revert optimistic update on failure.
                                    // BUG-C03 FIX: rollback uses fresh `currentPan` not stale closure.
                                    if (currentPan !== undefined) {
                                        set((s) => patchTrackByIndex(s, trackIndex, { pan: currentPan }));
                                    }
                                    set({ lastError: String(e) });
                                });
                        }, 16),
                    );
                }
                throttledPanSends.get(trackIndex)?.(pan);
            } catch (e) {
                set({ lastError: String(e) });
            }
        },

        // BUG-008 FIX: Throttle send level IPC calls (same 16ms as volume/pan).
        // Previously made a raw `await` on every invocation, flooding the backend
        // with 60+ IPC calls/second during fader drag.
        setTrackSendLevel: async (trackIndex: number, send: 'A' | 'B', value: number) => {
            try {
                const clamped = clamp01(value);
                set((s) => {
                    const trackId = s.tracks.allIds[trackIndex];
                    const track = trackId ? s.tracks.byId[trackId] : null;
                    if (!track) return s;
                    if (send === 'A' && track.send_a === clamped) return s;
                    if (send === 'B' && track.send_b === clamped) return s;
                    return patchTrackByIndex(s, trackIndex, send === 'A' ? { send_a: clamped } : { send_b: clamped });
                });
                const throttleKey = `${trackIndex}-${send}`;
                // BUG-040 FIX: Track pending send level values for proper flush.
                pendingSendLevelValues.set(throttleKey, { trackIndex, send, value: clamped });
                let fn = throttledSendLevelSends.get(throttleKey);
                if (!fn) {
                    fn = throttle(async (v: number) => {
                        try {
                            const response = await engine.setTrackSendLevelWithDeltas(trackIndex, send, v);
                            await get().applyProjectDeltas(response.deltas, `setTrackSendLevel-${send}`);
                        } catch (e) {
                            set({ lastError: String(e) });
                        }
                    }, 16) as ThrottledFn<(value: number) => void>;
                    throttledSendLevelSends.set(throttleKey, fn);
                }
                fn(clamped);
            } catch (e) {
                set({ lastError: String(e) });
            }
        },

        setMasterVolume: async (volume: number) => {
            // BUG-036 FIX: Guard against NaN/Infinity — would corrupt master gain.
            if (!Number.isFinite(volume)) return;
            try {
                // ENTERPRISE FIX: Clamp to 2.0 (linear gain = +6dB).
                // Must match engine API (engine.ts:139) and Rust backend
                // (audio_thread_commands.rs:255) which both enforce 0..2.
                // Previous value of 12 caused silent clipping: UI displayed
                // up to +21.6dB but Rust capped output at +6dB.
                const clamped = Math.max(0, Math.min(2, volume));
                setPendingMasterVolume(clamped);
                set({ masterVolume: clamped });
                throttledMasterVolumeSend(clamped);
            } catch (e) {
                set({ lastError: String(e) });
            }
        },

        flushTrackControlFinals: async () => {
            try {
                // BUG-007 FIX: Cancel all pending throttled calls BEFORE sending final values.
                // Without this, a trailing throttled call can fire after flush and overwrite
                // the flushed value with a stale one.
                for (const fn of throttledVolumeSends.values()) fn.cancel?.();
                for (const fn of throttledPanSends.values()) fn.cancel?.();
                throttledMasterVolumeSend.cancel?.();

                // BUG-H07 FIX: Snapshot AND clear BEFORE async calls.
                // Previously, clearing happened AFTER await — any new values added
                // during the await (from concurrent UI interactions) would be lost.
                const volumeEntries = Array.from(pendingVolumeValues.entries());
                const panEntries = Array.from(pendingPanValues.entries());
                const pendingMasterVolume = getPendingMasterVolume();
                pendingVolumeValues.clear();
                pendingPanValues.clear();
                // BUG-040 FIX: Snapshot and clear pending send levels.
                const sendEntries = Array.from(pendingSendLevelValues.values());
                pendingSendLevelValues.clear();
                setPendingMasterVolume(null);

                // BUG-012 FIX: Collect ALL deltas first, then apply in a single batch.
                // Previously each Promise.all branch called applyProjectDeltas independently,
                // causing racing state reads where later calls saw stale state.
                const ipcResults = await Promise.all([
                    ...volumeEntries.map(async ([trackIndex, volume]) =>
                        engine.setTrackVolumeWithDeltas(trackIndex, volume),
                    ),
                    ...panEntries.map(async ([trackIndex, pan]) =>
                        engine.setTrackPanWithDeltas(trackIndex, pan),
                    ),
                    // BUG-040 FIX: Include send levels in the flush batch.
                    ...sendEntries.map(async ({ trackIndex, send, value }) =>
                        engine.setTrackSendLevelWithDeltas(trackIndex, send, value),
                    ),
                ]);
                const allDeltas = ipcResults.flatMap((r) => r.deltas);
                if (allDeltas.length > 0) {
                    await get().applyProjectDeltas(allDeltas, 'flushTrackControlFinals');
                }
                if (pendingMasterVolume != null) {
                    await engine.setMasterVolume(pendingMasterVolume);
                }
                set({ lastError: null });
            } catch (e) {
                set({ lastError: String(e) });
            }
        },

        setTrackDisabled: async (trackIndex: number, disabled: boolean) => {
            // BUG-028 FIX: Capture actual pre-call state for rollback instead of assuming !disabled.
            const preCallTrackId = get().tracks.allIds[trackIndex];
            const preCallDisabled = preCallTrackId ? get().tracks.byId[preCallTrackId]?.is_disabled : undefined;
            set((s) => {
                const trackId = s.tracks.allIds[trackIndex];
                const track = trackId ? s.tracks.byId[trackId] : null;
                if (!track || track.is_disabled === disabled) return s;
                return patchTrackByIndex(s, trackIndex, { is_disabled: disabled });
            });
            try {
                const response = await engine.setTrackDisabledWithDeltas(trackIndex, disabled);
                await get().applyProjectDeltas(response.deltas, 'setTrackDisabled');
                set({ lastError: null });
            } catch (e) {
                // BUG-028 FIX: Rollback to captured pre-call state, not assumed inverse.
                if (preCallDisabled !== undefined) {
                    set((s) => ({
                        ...patchTrackByIndex(s, trackIndex, { is_disabled: preCallDisabled }),
                        lastError: String(e),
                    }));
                } else {
                    set({ lastError: String(e) });
                }
            }
        },

        setTrackSolo: async (trackIndex: number, soloed: boolean) => {
            // BUG-010 FIX: Capture original state BEFORE optimistic update.
            const trackId = get().tracks.allIds[trackIndex];
            const originalSoloed = trackId ? get().tracks.byId[trackId]?.is_solo : undefined;
            set((s) => {
                const tid = s.tracks.allIds[trackIndex];
                const track = tid ? s.tracks.byId[tid] : null;
                if (!track || track.is_solo === soloed) return s;
                return patchTrackByIndex(s, trackIndex, { is_solo: soloed });
            });
            try {
                const response = await engine.setTrackSoloWithDeltas(trackIndex, soloed);
                await get().applyProjectDeltas(response.deltas, 'setTrackSolo');
                set({ lastError: null });
            } catch (e) {
                // BUG-010 FIX: Rollback to captured original state, not negation.
                if (originalSoloed !== undefined) {
                    set((s) => ({
                        ...patchTrackByIndex(s, trackIndex, { is_solo: originalSoloed }),
                        lastError: String(e),
                    }));
                } else {
                    set({ lastError: String(e) });
                }
            }
        },

        addTrack: async (name?: string) => {
            try {
                const response = await engine.addTrackWithDeltas(name);
                clearTrackControlCachesLocal();
                await get().applyProjectDeltas(response.deltas, 'addTrack');
                set({ lastError: null });
            } catch (e) {
                set({ lastError: String(e) });
            }
        },

        deleteTrack: async (index: number) => {
            // BUG-029 FIX: Validate index bounds before IPC.
            if (index < 0 || index >= get().tracks.allIds.length) return;

            // BUG-004 FIX: Auto-close FlowEditor + clean up automation lanes for the deleted track.
            const trackId = get().tracks.allIds[index];
            if (trackId) {
                try {
                    const { useFlowSynthStore } = await import('@/widgets/FlowSynth/model/useFlowSynthStore');
                    const flowState = useFlowSynthStore.getState();
                    if (flowState.activeTrackId === trackId) {
                        flowState.closeFlowEditor();
                    }
                    // BUG-034 FIX: Clean up all device caches for this track.
                    // Each track can have one Flow device — its deviceId IS the trackId in our model.
                    flowState.cleanupDeviceCache(trackId);
                } catch (flowErr: unknown) {
                    // BUG-019 FIX: Only swallow module-not-found errors.
                    // Previously caught ALL errors, including runtime crashes from
                    // closeFlowEditor() (e.g., closing while a node is being evaluated).
                    // Non-import errors must propagate to avoid silent state corruption.
                    const isModuleNotFound = flowErr instanceof Error &&
                        (flowErr.message.includes('Failed to fetch dynamically imported module') ||
                         flowErr.message.includes('Loading chunk') ||
                         flowErr.message.includes('Cannot find module'));
                    if (!isModuleNotFound) {
                        console.error('[Dream] FlowSynth cleanup failed during track delete:', flowErr);
                    }
                }

                try {
                    const { useAutomationStore } = await import('@/shared/stores/useAutomationStore');
                    useAutomationStore.getState().cleanupTrackLanes(trackId);
                } catch { /* Automation module not loaded — safe to skip */ }
            }

            try {
                const response = await engine.deleteTrackWithDeltas(index);
                clearTrackControlCachesLocal();
                await get().applyProjectDeltas(response.deltas, 'deleteTrack');
                set({ lastError: null });
            } catch (e) {
                set({ lastError: String(e) });
            }
        },

        renameTrack: async (index: number, name: string) => {
            // BUG-030 FIX: Validate empty/whitespace name.
            const trimmed = name.trim();
            if (!trimmed) return;
            try {
                const response = await engine.renameTrackWithDeltas(index, trimmed);
                await get().applyProjectDeltas(response.deltas, 'renameTrack');
                set({ lastError: null });
            } catch (e) {
                set({ lastError: String(e) });
            }
        },

        importFile: async (path: string, trackIndex: number, positionFrames?: number) => {
            // BUG-039 FIX: Validate path — empty or null-byte paths cause Rust std::fs to panic.
            if (!path || path.includes('\0')) {
                set({ lastError: 'Import failed: invalid file path' });
                return null;
            }
            try {
                const response = await engine.importAudioFileWithDeltas(path, trackIndex, positionFrames);
                await get().applyProjectDeltas(response.deltas, 'importFile');
                return response;
            } catch (err) {
                const msg = `Import failed: ${err instanceof Error ? err.message : String(err)}`;
                console.error(`[Dream] ${msg}`);
                set({ lastError: msg });
                useStatusStore.getState().setError(msg);
                return null;
            }
        },

        createMidiClip: async (trackIndex: number, positionFrames: number, durationFrames: number) => {
            // BUG-020 FIX: Validate trackIndex bounds before IPC.
            // Unlike setTrackVolume (line 67) and deleteTrack (line 321),
            // createMidiClip previously skipped bounds validation. Negative or
            // out-of-range indices cause a Rust panic in the backend.
            if (trackIndex < 0 || trackIndex >= get().tracks.allIds.length) {
                console.error(`[Dream] createMidiClip: trackIndex ${trackIndex} out of bounds (${get().tracks.allIds.length} tracks)`);
                return;
            }
            // BUG-036: Validate inputs — reject NaN, negative, zero-duration.
            const safePosition = Number.isFinite(positionFrames) ? Math.max(0, Math.round(positionFrames)) : 0;
            const safeDuration = Number.isFinite(durationFrames) ? Math.max(1, Math.round(durationFrames)) : 1;
            try {
                const response = await engine.createMidiClipWithDeltas(trackIndex, safePosition, safeDuration);
                await get().applyProjectDeltas(response.deltas, 'createMidiClip');
            } catch (err) {
                const msg = `Create MIDI clip failed: ${err instanceof Error ? err.message : String(err)}`;
                console.error(`[Dream] ${msg}`);
                set({ lastError: msg });
                useStatusStore.getState().setError(msg);
            }
        },
    };
}
