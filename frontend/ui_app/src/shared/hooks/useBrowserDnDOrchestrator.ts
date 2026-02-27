import { useCallback } from 'react';
import * as engineApi from '@/shared/api/engine';
import type { BrowserDragItem } from '@/shared/lib/arrangementTypes';
import type { ProjectTrack } from '@/shared/stores/useEngineStore';
import type { EntityState } from '@/shared/stores/engine/storeHelpers';
import { defaultInternalPluginForTrack } from '@/shared/lib/internalPlugins';
import { beatToFrame, resolveBpm, resolveSampleRate } from '@/shared/lib/audioMath';

interface UseBrowserDnDOrchestratorArgs {
    tracks: EntityState<ProjectTrack>;

    projectBpm: number;
    transportBpm: number;
    projectSampleRate: number;
    importFile: (path: string, trackIndex: number, positionFrames?: number) => Promise<unknown>;
    applyProjectDeltas: (deltas: engineApi.ProjectDelta[], reason?: string) => Promise<void>;
}

const resolvePluginSlot = (
    track: ProjectTrack,
    hint: 'instrument' | 'effect' | 'auto' | undefined,
): 'instrument' | 'effect' => {
    if (hint === 'instrument') return 'instrument';
    if (hint === 'effect') return 'effect';
    if (track.track_type === 'Midi' && !track.instrument) return 'instrument';
    return 'effect';
};



export const useBrowserDnDOrchestrator = ({
    tracks,

    projectBpm,
    transportBpm,
    projectSampleRate,
    importFile,
    applyProjectDeltas,
}: UseBrowserDnDOrchestratorArgs) => {
    const getTrackById = useCallback((trackId: string): ProjectTrack | null => {
        return tracks.byId[trackId] ?? null;
    }, [tracks.byId]);

    const getTrackAtIndex = useCallback((trackIndex: number): ProjectTrack | null => {
        if (tracks.allIds.length === 0) return null;
        const boundedIndex = Math.max(0, Math.min(tracks.allIds.length - 1, trackIndex));
        const trackId = tracks.allIds[boundedIndex];
        return trackId ? (tracks.byId[trackId] ?? null) : null;
    }, [tracks.allIds, tracks.byId]);

    const getTrackIndexById = useCallback((trackId: string): number => {
        return tracks.allIds.indexOf(trackId);
    }, [tracks.allIds]);

    const buildPluginSlotAttempts = (
        primary: 'instrument' | 'effect',
    ): Array<'instrument' | 'effect' | 'auto'> => {
        const fallback: 'instrument' | 'effect' = primary === 'instrument' ? 'effect' : 'instrument';
        const attempts: Array<'instrument' | 'effect' | 'auto'> = [primary, 'auto', fallback];
        return attempts.filter((slot, index) => attempts.indexOf(slot) === index);
    };

    const dropPluginOnTrack = useCallback(async (item: BrowserDragItem, trackId: string) => {
        const track = getTrackById(trackId);
        if (!track || !item.path) return;
        const slot = resolvePluginSlot(track, item.slotHint);
        // Timeline/browser DnD always appends to end.
        // Position-aware drops (before/after specific slot) are handled by
        // useDeviceRackDnD which resolves position from the mouse coordinates.
        const insertIndex = undefined;
        let lastErr: unknown = null;
        const attempts = buildPluginSlotAttempts(slot);
        for (const attempt of attempts) {
            try {
                const response = await engineApi.addPluginToTrackWithDeltas(
                    track.id,
                    item.path,
                    item.name,
                    attempt,
                    insertIndex,
                );
                await applyProjectDeltas(response.deltas, 'browser-dnd:add-plugin');
                lastErr = null;
                break;
            } catch (err) {
                lastErr = err;
            }
        }
        if (lastErr) throw lastErr;
    }, [getTrackById, applyProjectDeltas]);

    const addDefaultDeviceToTrack = useCallback(async (trackId: string) => {
        const track = getTrackById(trackId);
        if (!track) return;
        const def = defaultInternalPluginForTrack(track.track_type, Boolean(track.instrument));
        const pluginId = def.pluginId;
        const pluginName = def.pluginName;
        const slot = def.slot;
        const response = await engineApi.addPluginToTrackWithDeltas(track.id, pluginId, pluginName, slot);
        await applyProjectDeltas(response.deltas, 'browser-dnd:add-default-device');
    }, [getTrackById, applyProjectDeltas]);

    const dropBrowserItemOnTimeline = useCallback(async (item: BrowserDragItem, trackIndex: number, beat: number) => {
        const track = getTrackAtIndex(trackIndex);
        if (!track) return;

        if (item.type === 'plugin') {
            await dropPluginOnTrack(item, track.id);
            return;
        }
        if (item.type !== 'audio' && item.type !== 'midi') return;
        if (!item.path) return;

        const bpm = resolveBpm(transportBpm);
        const sr = resolveSampleRate(projectSampleRate);
        const positionFrames = beatToFrame(beat, bpm, sr);
        const resolvedTrackIndex = getTrackIndexById(track.id);
        if (resolvedTrackIndex < 0) return;
        await importFile(item.path, resolvedTrackIndex, positionFrames);
    }, [getTrackAtIndex, getTrackIndexById, dropPluginOnTrack, importFile, projectBpm, transportBpm, projectSampleRate]);

    return {
        dropPluginOnTrack,
        dropBrowserItemOnTimeline,
        addDefaultDeviceToTrack,
    };
};
