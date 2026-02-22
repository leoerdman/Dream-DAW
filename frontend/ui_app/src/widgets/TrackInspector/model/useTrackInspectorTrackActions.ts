import { useCallback } from 'react';
import * as engineApi from '@/shared/api/engine';
import { useEngineStore } from '@/shared/stores/useEngineStore';
import type { TrackData } from '@/widgets/TrackInspector/model/trackModels';

interface UseTrackInspectorTrackActionsArgs {
    tracks: TrackData[];
    selectedTrackIdSet: Set<string>;
    getTrackIndex: (id: string) => number;
    engineSetTrackMute: (trackIndex: number, muted: boolean) => Promise<void>;
    engineSetTrackSolo: (trackIndex: number, soloed: boolean) => Promise<void>;
    setLocalOverrides: React.Dispatch<React.SetStateAction<Record<string, Partial<TrackData>>>>;
}

export function useTrackInspectorTrackActions({
    tracks,
    selectedTrackIdSet,
    getTrackIndex,
    engineSetTrackMute,
    engineSetTrackSolo,
    setLocalOverrides,
}: UseTrackInspectorTrackActionsArgs) {
    const toggleMute = useCallback((id: string) => {
        const track = tracks.find((t) => t.id === id);
        if (!track) return;
        const idx = getTrackIndex(id);
        const newMuted = !track.isMuted;
        if (idx >= 0) void engineSetTrackMute(idx, newMuted);
        setLocalOverrides((prev) => ({ ...prev, [id]: { ...prev[id], isMuted: newMuted } }));
    }, [tracks, getTrackIndex, engineSetTrackMute, setLocalOverrides]);

    const toggleSolo = useCallback((id: string) => {
        const selected = selectedTrackIdSet.has(id)
            ? Array.from(selectedTrackIdSet)
            : [id];
        const targetIds = selected.length > 0 ? selected : [id];
        const targetSet = new Set(targetIds);
        const targetTracks = tracks.filter((t) => targetSet.has(t.id));
        if (targetTracks.length === 0) return;

        const allTargetsAlreadySolo = targetTracks.every((t) => t.isSoloed);
        const shouldSoloTargets = !allTargetsAlreadySolo;

        const nextSoloById = new Map<string, boolean>();
        for (const track of targetTracks) {
            if (track.type === 'master') continue;
            if (track.isSoloed !== shouldSoloTargets) {
                nextSoloById.set(track.id, shouldSoloTargets);
            }
        }
        if (nextSoloById.size === 0) return;

        for (const [trackId, soloed] of nextSoloById) {
            const idx = getTrackIndex(trackId);
            if (idx >= 0) void engineSetTrackSolo(idx, soloed);
        }

        setLocalOverrides((prev) => {
            const next = { ...prev };
            for (const [trackId, soloed] of nextSoloById) {
                next[trackId] = { ...next[trackId], isSoloed: soloed };
            }
            return next;
        });
    }, [tracks, selectedTrackIdSet, getTrackIndex, engineSetTrackSolo, setLocalOverrides]);

    const toggleArm = useCallback((id: string) => {
        const track = tracks.find((t) => t.id === id);
        if (!track) return;
        const idx = getTrackIndex(id);
        const newArmed = !track.isArmed;
        if (idx >= 0) {
            void engineApi
                .armTrackWithDeltas(idx, newArmed)
                .then((response) => useEngineStore.getState().applyProjectDeltas(response.deltas, 'track-inspector:arm'))
                .catch((err) => {
                    console.error('[TrackInspector] armTrack failed:', err);
                });
        }
        setLocalOverrides((prev) => ({ ...prev, [id]: { ...prev[id], isArmed: newArmed } }));
    }, [tracks, getTrackIndex, setLocalOverrides]);

    const setTrackOutput = useCallback(async (trackId: string, targetId: string) => {
        try {
            const response = await engineApi.setTrackRoutingWithDeltas(trackId, targetId);
            await useEngineStore.getState().applyProjectDeltas(response.deltas, 'track-inspector:routing');
            setLocalOverrides((prev) => ({ ...prev, [trackId]: { ...prev[trackId], output: targetId } }));
        } catch (err) {
            console.error('[TrackInspector] setTrackRouting failed:', err);
        }
    }, [setLocalOverrides]);

    const setTrackInput = useCallback(async (trackId: string, inputId: string) => {
        try {
            const response = await engineApi.setTrackInputWithSnapshotDelta(trackId, inputId);
            await useEngineStore.getState().applyProjectDeltas(response.deltas, 'track-inspector:set-input');
            setLocalOverrides((prev) => ({ ...prev, [trackId]: { ...prev[trackId], input: inputId } }));
        } catch (err) {
            console.error('[TrackInspector] setTrackInput failed:', err);
        }
    }, [setLocalOverrides]);

    return {
        toggleMute,
        toggleSolo,
        toggleArm,
        setTrackOutput,
        setTrackInput,
    };
}
