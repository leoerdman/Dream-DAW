import throttle from 'lodash.throttle';
import type { StoreApi } from 'zustand';
import * as engine from '@/shared/api/engine';
import type { EngineStore } from '@/shared/stores/useEngineStore';
import type { ProjectTrack } from '@/shared/stores/useEngineStore';
import { buildTrackStatePatch } from '@/shared/stores/engine/storeHelpers';
import type { TrackStatePatch } from '@/shared/stores/engine/storeHelpers';

// BUG-007 FIX: Proper type for lodash‑throttled functions (includes cancel/flush).
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type ThrottledFn<T extends (...args: any[]) => any> = T & { cancel(): void; flush(): void };
const throttledVolumeSends = new Map<number, ThrottledFn<(volume: number) => void>>();
const throttledPanSends = new Map<number, ThrottledFn<(pan: number) => void>>();
const pendingVolumeValues = new Map<number, number>();
const pendingPanValues = new Map<number, number>();
// BUG-008 FIX: Throttled send level functions to prevent IPC flooding during fader drag.
const throttledSendLevelSends = new Map<string, ThrottledFn<(value: number) => void>>();
let pendingMasterVolume: number | null = null;

const throttledMasterVolumeSend = throttle((volume: number) => {
    void engine.setMasterVolume(volume);
}, 16);

// BUG-013 FIX: Cancel internal throttle timers before clearing maps.
// Without this, stale timeouts fire after the map is cleared, sending
// IPC calls for tracks that may no longer exist.
// BUG-010 FIX: Exported so project snapshot handler can call it on project reload.
export function clearTrackControlCaches(): void {
    for (const fn of throttledVolumeSends.values()) fn.cancel();
    for (const fn of throttledPanSends.values()) fn.cancel();
    for (const fn of throttledSendLevelSends.values()) fn.cancel();
    throttledVolumeSends.clear();
    throttledPanSends.clear();
    throttledSendLevelSends.clear();
    pendingVolumeValues.clear();
    pendingPanValues.clear();
    pendingMasterVolume = null;
}

function patchTrackByIndex(
    state: EngineStore,
    trackIndex: number,
    patch: Partial<ProjectTrack>,
): TrackStatePatch<ProjectTrack> | EngineStore {
    const trackId = state.tracks.allIds[trackIndex];
    if (!trackId) return state;

    const sourceTrack = state.tracks.byId[trackId];
    if (!sourceTrack) return state;

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
    | 'setTrackMute'
    | 'setTrackSolo'
    | 'addTrack'
    | 'deleteTrack'
    | 'renameTrack'
    | 'importFile'
    | 'createMidiClip'
> {
    return {
        setTrackVolume: async (trackIndex: number, volume: number) => {
            try {
                // BUG-011 FIX: Capture old value for rollback on IPC failure.
                const trackId = get().tracks.allIds[trackIndex];
                const oldVolume = trackId
                    ? get().tracks.byId[trackId]?.volume
                    : undefined;

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
                            void engine
                                .setTrackVolumeWithDeltas(trackIndex, nextVolume)
                                .then((response) => get().applyProjectDeltas(response.deltas, 'setTrackVolume'))
                                .catch((e) => {
                                    // BUG-011 FIX: Revert optimistic update on failure.
                                    if (oldVolume !== undefined) {
                                        set((s) => patchTrackByIndex(s, trackIndex, { volume: oldVolume }));
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
            try {
                // BUG-011 FIX: Capture old value for rollback on IPC failure.
                const trackId = get().tracks.allIds[trackIndex];
                const oldPan = trackId
                    ? get().tracks.byId[trackId]?.pan
                    : undefined;

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
                            void engine
                                .setTrackPanWithDeltas(trackIndex, nextPan)
                                .then((response) => get().applyProjectDeltas(response.deltas, 'setTrackPan'))
                                .catch((e) => {
                                    // BUG-011 FIX: Revert optimistic update on failure.
                                    if (oldPan !== undefined) {
                                        set((s) => patchTrackByIndex(s, trackIndex, { pan: oldPan }));
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
                const clamped = Math.max(0, Math.min(1, value));
                set((s) => {
                    const trackId = s.tracks.allIds[trackIndex];
                    const track = trackId ? s.tracks.byId[trackId] : null;
                    if (!track) return s;
                    if (send === 'A' && track.send_a === clamped) return s;
                    if (send === 'B' && track.send_b === clamped) return s;
                    return patchTrackByIndex(s, trackIndex, send === 'A' ? { send_a: clamped } : { send_b: clamped });
                });
                const throttleKey = `${trackIndex}-${send}`;
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
            try {
                // BUG-014 FIX: Clamp to 12.0 (SSOT with ChannelStrip max),
                // was 2.0 which silently clipped master boost above +6dB.
                const clamped = Math.max(0, Math.min(12, volume));
                pendingMasterVolume = clamped;
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

                const volumeEntries = Array.from(pendingVolumeValues.entries());
                const panEntries = Array.from(pendingPanValues.entries());
                await Promise.all([
                    ...volumeEntries.map(async ([trackIndex, volume]) => {
                        const response = await engine.setTrackVolumeWithDeltas(trackIndex, volume);
                        await get().applyProjectDeltas(response.deltas, 'flushTrackControlFinals-volume');
                    }),
                    ...panEntries.map(async ([trackIndex, pan]) => {
                        const response = await engine.setTrackPanWithDeltas(trackIndex, pan);
                        await get().applyProjectDeltas(response.deltas, 'flushTrackControlFinals-pan');
                    }),
                ]);
                if (pendingMasterVolume != null) {
                    await engine.setMasterVolume(pendingMasterVolume);
                }
                pendingVolumeValues.clear();
                pendingPanValues.clear();
                pendingMasterVolume = null;
                set({ lastError: null });
            } catch (e) {
                set({ lastError: String(e) });
            }
        },

        setTrackMute: async (trackIndex: number, muted: boolean) => {
            set((s) => {
                const trackId = s.tracks.allIds[trackIndex];
                const track = trackId ? s.tracks.byId[trackId] : null;
                if (!track || track.is_mute === muted) return s;
                return patchTrackByIndex(s, trackIndex, { is_mute: muted });
            });
            try {
                const response = await engine.setTrackMuteWithDeltas(trackIndex, muted);
                await get().applyProjectDeltas(response.deltas, 'setTrackMute');
                set({ lastError: null });
            } catch (e) {
                set({ lastError: String(e) });
            }
        },

        setTrackSolo: async (trackIndex: number, soloed: boolean) => {
            set((s) => {
                const trackId = s.tracks.allIds[trackIndex];
                const track = trackId ? s.tracks.byId[trackId] : null;
                if (!track || track.is_solo === soloed) return s;
                return patchTrackByIndex(s, trackIndex, { is_solo: soloed });
            });
            try {
                const response = await engine.setTrackSoloWithDeltas(trackIndex, soloed);
                await get().applyProjectDeltas(response.deltas, 'setTrackSolo');
                set({ lastError: null });
            } catch (e) {
                set({ lastError: String(e) });
            }
        },

        addTrack: async (name?: string) => {
            try {
                const response = await engine.addTrackWithDeltas(name);
                clearTrackControlCaches();
                await get().applyProjectDeltas(response.deltas, 'addTrack');
                set({ lastError: null });
            } catch (e) {
                set({ lastError: String(e) });
            }
        },

        deleteTrack: async (index: number) => {
            try {
                const response = await engine.deleteTrackWithDeltas(index);
                clearTrackControlCaches();
                await get().applyProjectDeltas(response.deltas, 'deleteTrack');
                set({ lastError: null });
            } catch (e) {
                set({ lastError: String(e) });
            }
        },

        renameTrack: async (index: number, name: string) => {
            try {
                const response = await engine.renameTrackWithDeltas(index, name);
                await get().applyProjectDeltas(response.deltas, 'renameTrack');
                set({ lastError: null });
            } catch (e) {
                set({ lastError: String(e) });
            }
        },

        importFile: async (path: string, trackIndex: number, positionFrames?: number) => {
            try {
                const response = await engine.importAudioFileWithDeltas(path, trackIndex, positionFrames);
                await get().applyProjectDeltas(response.deltas, 'importFile');
                return response;
            } catch (err) {
                const msg = `Import failed: ${err}`;
                console.error(`[Engine] ${msg}`);
                set({ lastError: msg });
                return null;
            }
        },

        createMidiClip: async (trackIndex: number, positionFrames: number, durationFrames: number) => {
            try {
                const response = await engine.createMidiClipWithDeltas(trackIndex, positionFrames, durationFrames);
                await get().applyProjectDeltas(response.deltas, 'createMidiClip');
            } catch (err) {
                const msg = `Create MIDI clip failed: ${err}`;
                console.error(`[Engine] ${msg}`);
                set({ lastError: msg });
            }
        },
    };
}
