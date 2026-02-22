import throttle from 'lodash.throttle';
import type { StoreApi } from 'zustand';
import * as engine from '@/shared/api/engine';
import type { EngineStore } from '@/shared/stores/useEngineStore';

const throttledVolumeSends = new Map<number, (volume: number) => void>();
const throttledPanSends = new Map<number, (pan: number) => void>();
const pendingVolumeValues = new Map<number, number>();
const pendingPanValues = new Map<number, number>();
let pendingMasterVolume: number | null = null;

const throttledMasterVolumeSend = throttle((volume: number) => {
    void engine.setMasterVolume(volume);
}, 16);

function clearTrackControlCaches(): void {
    throttledVolumeSends.clear();
    throttledPanSends.clear();
    pendingVolumeValues.clear();
    pendingPanValues.clear();
}

export function createTrackProjectActions(
    set: StoreApi<EngineStore>['setState'],
    get: StoreApi<EngineStore>['getState'],
): Pick<
    EngineStore,
    | 'setTrackVolume'
    | 'setTrackPan'
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
                pendingVolumeValues.set(trackIndex, volume);
                if (!throttledVolumeSends.has(trackIndex)) {
                    throttledVolumeSends.set(
                        trackIndex,
                        throttle((nextVolume: number) => {
                            void engine
                                .setTrackVolumeWithDeltas(trackIndex, nextVolume)
                                .then((response) => get().applyProjectDeltas(response.deltas, 'setTrackVolume'))
                                .catch((e) => set({ lastError: String(e) }));
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
                pendingPanValues.set(trackIndex, pan);
                if (!throttledPanSends.has(trackIndex)) {
                    throttledPanSends.set(
                        trackIndex,
                        throttle((nextPan: number) => {
                            void engine
                                .setTrackPanWithDeltas(trackIndex, nextPan)
                                .then((response) => get().applyProjectDeltas(response.deltas, 'setTrackPan'))
                                .catch((e) => set({ lastError: String(e) }));
                        }, 16),
                    );
                }
                throttledPanSends.get(trackIndex)?.(pan);
            } catch (e) {
                set({ lastError: String(e) });
            }
        },

        setMasterVolume: async (volume: number) => {
            try {
                const clamped = Math.max(0, Math.min(2, volume));
                pendingMasterVolume = clamped;
                set({ masterVolume: clamped });
                throttledMasterVolumeSend(clamped);
            } catch (e) {
                set({ lastError: String(e) });
            }
        },

        flushTrackControlFinals: async () => {
            try {
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
                const track = s.projectTracks[trackIndex];
                if (!track || track.is_mute === muted) return s;
                const updated = { ...track, is_mute: muted };
                const nextTracks = [...s.projectTracks];
                nextTracks[trackIndex] = updated;
                return {
                    projectTracks: nextTracks,
                    tracksById: { ...s.tracksById, [track.id]: updated },
                    tracks: { byId: { ...s.tracks.byId, [track.id]: updated }, allIds: s.tracks.allIds },
                };
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
                const track = s.projectTracks[trackIndex];
                if (!track || track.is_solo === soloed) return s;
                const updated = { ...track, is_solo: soloed };
                const nextTracks = [...s.projectTracks];
                nextTracks[trackIndex] = updated;
                return {
                    projectTracks: nextTracks,
                    tracksById: { ...s.tracksById, [track.id]: updated },
                    tracks: { byId: { ...s.tracks.byId, [track.id]: updated }, allIds: s.tracks.allIds },
                };
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
