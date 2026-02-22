import { useCallback } from 'react';
import * as engineApi from '@/shared/api/engine';
import { beatDurationToFrames, beatToFrame } from '@/shared/lib/audioMath';
import { useStatusStore } from '@/shared/stores/useStatusStore';
import { useEngineStore } from '@/shared/stores/useEngineStore';
import type { TimelineClip } from '@/shared/lib/arrangementTypes';
import type { ProjectDelta } from '@/shared/api/engine';

type BottomPanelMode = 'rack' | 'clip';

type Args = {
    projectBpm: number;
    transportBpm: number;
    projectSampleRate: number;
    timelineClipsForView: TimelineClip[];
    selectedClipIds: string[];
    trackCountRaw: number;
    createMidiClip: (trackIndex: number, positionFrames: number, durationFrames: number) => Promise<void>;
    applyProjectDeltas: (deltas: ProjectDelta[], reason?: string) => Promise<void>;
    setSelectedClipIds: React.Dispatch<React.SetStateAction<string[]>>;
    setBottomPanelModeForActiveTrack: (mode: BottomPanelMode) => void;
};

type Result = {
    handleDoubleClickTrack: (trackIndex: number, beat: number) => void;
    handleClipMove: (clipId: string, newStartBeat: number, newTrackIndex: number) => void;
    handleClipResize: (clipId: string, newStartBeat: number, newDurationBeats: number) => void;
    handleClipFades: (clipId: string, fadeInFrames: number, fadeOutFrames: number) => void;
    handleOpenMidiClip: (clipId: string) => void;
};

export function useTimelineClipHandlers({
    projectBpm,
    transportBpm,
    projectSampleRate,
    timelineClipsForView,
    selectedClipIds,
    trackCountRaw,
    createMidiClip,
    applyProjectDeltas,
    setSelectedClipIds,
    setBottomPanelModeForActiveTrack,
}: Args): Result {
    const handleDoubleClickTrack = useCallback((trackIndex: number, beat: number) => {
        const bpm = projectBpm || transportBpm || 120;
        const sampleRate = projectSampleRate;
        const storeState = useEngineStore.getState();
        const beatsPerBar = (storeState as typeof storeState & { projectBeatsPerBar?: number }).projectBeatsPerBar ?? 4;
        const positionFrames = beatToFrame(beat, bpm, sampleRate);
        const durationFrames = beatDurationToFrames(beatsPerBar, bpm, sampleRate);
        void createMidiClip(trackIndex, positionFrames, durationFrames);
    }, [createMidiClip, projectBpm, projectSampleRate, transportBpm]);

    const handleClipMove = useCallback((clipId: string, newStartBeat: number, newTrackIndex: number) => {
        const bpm = projectBpm || transportBpm || 120;
        const sampleRate = projectSampleRate;

        const dragged = timelineClipsForView.find((clip) => clip.id === clipId);
        if (!dragged) return;

        const selectedSet = new Set(selectedClipIds);
        const moveAsGroup = selectedSet.size > 1 && selectedSet.has(clipId);

        const moveOne = async (id: string, targetBeat: number, targetTrack: number) => {
            const positionFrames = beatToFrame(Math.max(0, targetBeat), bpm, sampleRate);
            const response = await engineApi.moveClipWithDeltas(id, targetTrack, positionFrames);
            await applyProjectDeltas(response.deltas, 'clip-move');
        };

        const run = async () => {
            if (!moveAsGroup) {
                await moveOne(clipId, newStartBeat, newTrackIndex);
                return;
            }

            const deltaBeat = newStartBeat - dragged.startBeat;
            const deltaTrack = newTrackIndex - dragged.trackIndex;
            const selectedClips = timelineClipsForView.filter((clip) => selectedSet.has(clip.id));
            for (const clip of selectedClips) {
                const targetBeat = Math.max(0, clip.startBeat + deltaBeat);
                const targetTrack = Math.max(0, Math.min(trackCountRaw - 1, clip.trackIndex + deltaTrack));
                await moveOne(clip.id, targetBeat, targetTrack);
            }
        };

        void run()
            .then(() => {
                console.log('[DawShell] Clip move applied', {
                    clipId,
                    newTrackIndex,
                    newStartBeat,
                    mode: moveAsGroup ? 'group' : 'single',
                });
            })
            .catch((err) => {
                console.error('[DawShell] moveClip failed:', err);
                useStatusStore.getState().setError(`Clip move failed: ${err instanceof Error ? err.message : String(err)}`);
            });
    }, [applyProjectDeltas, projectBpm, projectSampleRate, selectedClipIds, timelineClipsForView, trackCountRaw, transportBpm]);

    const handleClipResize = useCallback((clipId: string, newStartBeat: number, newDurationBeats: number) => {
        const bpm = projectBpm || transportBpm || 120;
        const sampleRate = projectSampleRate;
        const newPositionFrames = beatToFrame(newStartBeat, bpm, sampleRate);
        const newDurationFrames = Math.max(128, beatDurationToFrames(newDurationBeats, bpm, sampleRate));

        void engineApi.resizeClipWithDeltas(clipId, newPositionFrames, newDurationFrames)
            .then(async (response) => {
                await applyProjectDeltas(response.deltas, 'clip-resize');
                console.log('[DawShell] Clip resized', { clipId, newStartBeat, newDurationBeats });
            })
            .catch((err) => {
                console.error('[DawShell] resizeClip failed:', err);
                useStatusStore.getState().setError(`Clip resize failed: ${err instanceof Error ? err.message : String(err)}`);
            });
    }, [applyProjectDeltas, projectBpm, projectSampleRate, transportBpm]);

    const handleClipFades = useCallback((clipId: string, fadeInFrames: number, fadeOutFrames: number) => {
        void engineApi
            .setClipFadesWithDeltas(clipId, Math.max(0, Math.round(fadeInFrames)), Math.max(0, Math.round(fadeOutFrames)))
            .then(async (response) => {
                await applyProjectDeltas(response.deltas, 'clip-fades');
            })
            .catch((err) => console.error('[DawShell] setClipFades failed:', err));
    }, [applyProjectDeltas]);

    const handleOpenMidiClip = useCallback((clipId: string) => {
        setSelectedClipIds([clipId]);
        setBottomPanelModeForActiveTrack('clip');
    }, [setBottomPanelModeForActiveTrack, setSelectedClipIds]);

    return {
        handleDoubleClickTrack,
        handleClipMove,
        handleClipResize,
        handleClipFades,
        handleOpenMidiClip,
    };
}
