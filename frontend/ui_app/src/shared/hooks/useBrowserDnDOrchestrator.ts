import { useCallback } from 'react';
import * as engineApi from '@/shared/api/engine';
import type { BrowserDragItem } from '@/shared/types/Arrangement';
import type { ProjectTrack } from '@/shared/stores/useEngineStore';

interface UseBrowserDnDOrchestratorArgs {
    projectTracks: ProjectTrack[];
    projectBpm: number;
    transportBpm: number;
    projectSampleRate: number;
    importFile: (path: string, trackIndex?: number, positionFrames?: number) => Promise<void>;
    fetchProject: () => Promise<void>;
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
    projectTracks,
    projectBpm,
    transportBpm,
    projectSampleRate,
    importFile,
    fetchProject,
}: UseBrowserDnDOrchestratorArgs) => {
    const dropPluginOnTrack = useCallback(async (item: BrowserDragItem, trackId: string) => {
        const track = projectTracks.find((t) => t.id === trackId);
        if (!track || !item.path) return;
        const slot = resolvePluginSlot(track, item.slotHint);
        await engineApi.addPluginToTrack(track.id, item.path, item.name, slot);
        await fetchProject();
    }, [projectTracks, fetchProject]);

    const addDefaultDeviceToTrack = useCallback(async (trackId: string) => {
        const track = projectTracks.find((t) => t.id === trackId);
        if (!track) return;
        const addInstrument = track.track_type === 'Midi' && !track.instrument;
        const pluginId = addInstrument ? 'internal://instrument/sampler' : 'internal://effect/utility';
        const pluginName = addInstrument ? 'Sampler' : 'Utility';
        const slot: 'instrument' | 'effect' = addInstrument ? 'instrument' : 'effect';
        await engineApi.addPluginToTrack(track.id, pluginId, pluginName, slot);
        await fetchProject();
    }, [projectTracks, fetchProject]);

    const dropBrowserItemOnTimeline = useCallback(async (item: BrowserDragItem, trackIndex: number, beat: number) => {
        const track = projectTracks[Math.max(0, Math.min(projectTracks.length - 1, trackIndex))];
        if (!track) return;

        if (item.type === 'plugin') {
            await dropPluginOnTrack(item, track.id);
            return;
        }
        if (item.type !== 'audio' && item.type !== 'midi') return;
        if (!item.path) return;

        const bpm = projectBpm || transportBpm || 120;
        const sr = projectSampleRate || 44100;
        const posSeconds = beat / (bpm / 60);
        const positionFrames = Math.round(posSeconds * sr);
        await importFile(item.path, trackIndex, positionFrames);
    }, [projectTracks, dropPluginOnTrack, importFile, projectBpm, transportBpm, projectSampleRate]);

    return {
        dropPluginOnTrack,
        dropBrowserItemOnTimeline,
        addDefaultDeviceToTrack,
    };
};
