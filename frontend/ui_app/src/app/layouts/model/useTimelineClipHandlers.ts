import { useCallback } from 'react';
import * as engineApi from '@/shared/api/engine';
import { beatDurationToFrames, beatToFrame } from '@/shared/lib/audioMath';
import { normalizeTimelineClips } from '@/shared/lib/clipNormalization';
import { useStatusStore } from '@/shared/stores/useStatusStore';
import { useEngineStore } from '@/shared/stores/useEngineStore';
import { toEntityState } from '@/shared/stores/engine/storeHelpers';
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
    handleClipResize: (clipId: string, newStartBeat: number, newDurationBeats: number, allowStretch: boolean) => void;
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
    const isClipNotFoundError = (err: unknown): boolean => {
        const message = err instanceof Error ? err.message : String(err);
        return /clip/i.test(message) && /not\s+found/i.test(message);
    };

    const pruneGhostClip = useCallback((clipId: string) => {
        if (!clipId) return;
        useEngineStore.setState((s) => {
            const existsInList = s.timelineClips.some((clip) => clip.id === clipId);
            const existsInMap = Boolean(s.clipsById[clipId]);
            if (!existsInList && !existsInMap) return s;

            const nextTimelineClips = normalizeTimelineClips(
                s.timelineClips.filter((clip) => clip.id !== clipId),
            );
            const nextClipsById = Object.fromEntries(
                nextTimelineClips.map((clip) => [clip.id, clip]),
            );

            return {
                timelineClips: nextTimelineClips,
                clipsById: nextClipsById,
                clips: toEntityState(nextTimelineClips),
            };
        });
        setSelectedClipIds((prev) => prev.filter((id) => id !== clipId));
    }, [setSelectedClipIds]);

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
            try {
                return await engineApi.moveClipWithDeltas(id, targetTrack, positionFrames);
            } catch (err) {
                if (isClipNotFoundError(err)) {
                    pruneGhostClip(id);
                }
                throw err;
            }
        };

        const run = async () => {
            const collectedDeltas: ProjectDelta[] = [];
            if (!moveAsGroup) {
                const response = await moveOne(clipId, newStartBeat, newTrackIndex);
                collectedDeltas.push(...response.deltas);
                await applyProjectDeltas(collectedDeltas, 'clip-move');
                return;
            }

            const deltaBeat = newStartBeat - dragged.startBeat;
            const deltaTrack = newTrackIndex - dragged.trackIndex;
            const seen = new Set<string>();
            const selectedClips = timelineClipsForView.filter((clip) => {
                if (!selectedSet.has(clip.id)) return false;
                if (seen.has(clip.id)) return false;
                seen.add(clip.id);
                return true;
            });
            for (const clip of selectedClips) {
                const targetBeat = Math.max(0, clip.startBeat + deltaBeat);
                const targetTrack = Math.max(0, Math.min(trackCountRaw - 1, clip.trackIndex + deltaTrack));
                const response = await moveOne(clip.id, targetBeat, targetTrack);
                collectedDeltas.push(...response.deltas);
            }
            if (collectedDeltas.length > 0) {
                await applyProjectDeltas(collectedDeltas, 'clip-move-group');
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
    }, [applyProjectDeltas, projectBpm, projectSampleRate, pruneGhostClip, selectedClipIds, timelineClipsForView, trackCountRaw, transportBpm]);

    const handleClipResize = useCallback((clipId: string, newStartBeat: number, newDurationBeats: number, allowStretch: boolean) => {
        const bpm = projectBpm || transportBpm || 120;
        const sampleRate = projectSampleRate;
        const newPositionFrames = beatToFrame(newStartBeat, bpm, sampleRate);
        const newDurationFrames = Math.max(128, beatDurationToFrames(newDurationBeats, bpm, sampleRate));

        void engineApi.resizeClipWithDeltas(clipId, newPositionFrames, newDurationFrames, allowStretch)
            .then(async (response) => {
                await applyProjectDeltas(response.deltas, 'clip-resize');
                console.log('[DawShell] Clip resized', { clipId, newStartBeat, newDurationBeats, allowStretch });
            })
            .catch((err) => {
                if (isClipNotFoundError(err)) {
                    pruneGhostClip(clipId);
                }
                console.error('[DawShell] resizeClip failed:', err);
                useStatusStore.getState().setError(`Clip resize failed: ${err instanceof Error ? err.message : String(err)}`);
            });
    }, [applyProjectDeltas, projectBpm, projectSampleRate, pruneGhostClip, transportBpm]);

    const handleClipFades = useCallback((clipId: string, fadeInFrames: number, fadeOutFrames: number) => {
        void engineApi
            .setClipFadesWithDeltas(clipId, Math.max(0, Math.round(fadeInFrames)), Math.max(0, Math.round(fadeOutFrames)))
            .then(async (response) => {
                await applyProjectDeltas(response.deltas, 'clip-fades');
            })
            .catch((err) => {
                if (isClipNotFoundError(err)) {
                    pruneGhostClip(clipId);
                }
                console.error('[DawShell] setClipFades failed:', err);
            });
    }, [applyProjectDeltas, pruneGhostClip]);

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
