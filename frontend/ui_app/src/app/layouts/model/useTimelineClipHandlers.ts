import { useCallback } from 'react';
import * as engineApi from '@/shared/api/engine';
import { beatDurationToFrames, beatToFrame } from '@/shared/lib/audioMath';
import { normalizeTimelineClips } from '@/shared/lib/clipNormalization';
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
    hiddenTrackIndices: Set<number>;
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
    hiddenTrackIndices,
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
            const canonicalById = Object.keys(s.clips.byId).length > 0 ? s.clips.byId : s.clipsById;
            if (!canonicalById[clipId]) return s;

            const nextClipIds = s.clips.allIds.filter((id) => id !== clipId);
            const nextClipsEntityById = { ...canonicalById };
            delete nextClipsEntityById[clipId];
            const nextTimelineClips = normalizeTimelineClips(
                nextClipIds
                    .map((id) => nextClipsEntityById[id])
                    .filter((clip): clip is TimelineClip => Boolean(clip)),
            );
            const nextClipsById = Object.fromEntries(nextTimelineClips.map((clip) => [clip.id, clip]));

            return {
                timelineClips: nextTimelineClips,
                clipsById: nextClipsById,
                clips: {
                    byId: nextClipsById,
                    allIds: nextTimelineClips.map((clip) => clip.id),
                },
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
        const liveState = useEngineStore.getState();
        const liveClip = liveState.clips.byId[clipId] ?? liveState.clipsById[clipId];
        const liveExists = Boolean(liveClip);
        if (!liveExists) {
            pruneGhostClip(clipId);
            return;
        }

        const dragged = liveClip ?? timelineClipsForView.find((clip) => clip.id === clipId);
        if (!dragged) {
            pruneGhostClip(clipId);
            return;
        }

        const selectedSet = new Set(selectedClipIds);
        const moveAsGroup = selectedSet.size > 1 && selectedSet.has(clipId);

        const snapToVisibleTrack = (targetTrack: number, preferredDirection: -1 | 0 | 1): number => {
            const clamped = Math.max(0, Math.min(trackCountRaw - 1, targetTrack));
            if (!hiddenTrackIndices.has(clamped)) return clamped;

            if (preferredDirection >= 0) {
                for (let i = clamped + 1; i < trackCountRaw; i += 1) {
                    if (!hiddenTrackIndices.has(i)) return i;
                }
            }
            if (preferredDirection <= 0) {
                for (let i = clamped - 1; i >= 0; i -= 1) {
                    if (!hiddenTrackIndices.has(i)) return i;
                }
            }

            for (let radius = 1; radius < trackCountRaw; radius += 1) {
                const up = clamped - radius;
                const down = clamped + radius;
                if (up >= 0 && !hiddenTrackIndices.has(up)) return up;
                if (down < trackCountRaw && !hiddenTrackIndices.has(down)) return down;
            }
            return clamped;
        };

        const moveOne = async (id: string, targetBeat: number, targetTrack: number) => {
            const positionFrames = beatToFrame(Math.max(0, targetBeat), bpm, sampleRate);
            const safeTrack = snapToVisibleTrack(targetTrack, 0);
            try {
                return await engineApi.moveClipWithDeltas(id, safeTrack, positionFrames);
            } catch (err) {
                if (isClipNotFoundError(err)) {
                    pruneGhostClip(id);
                    return null;
                }
                throw err;
            }
        };

        const run = async () => {
            if (!moveAsGroup) {
                const response = await moveOne(clipId, newStartBeat, newTrackIndex);
                if (!response) return;
                await applyProjectDeltas(response.deltas, 'clip-move');
                return;
            }

            const deltaBeat = newStartBeat - dragged.startBeat;
            const deltaTrack = newTrackIndex - dragged.trackIndex;
            const seen = new Set<string>();
            const selectedClips = selectedClipIds
                .map((id) => liveState.clips.byId[id] ?? liveState.clipsById[id])
                .filter((clip): clip is TimelineClip => Boolean(clip))
                .filter((clip) => {
                if (!selectedSet.has(clip.id)) return false;
                if (seen.has(clip.id)) return false;
                seen.add(clip.id);
                return true;
            });
            const moveErrors: string[] = [];
            for (const clip of selectedClips) {
                const targetBeat = Math.max(0, clip.startBeat + deltaBeat);
                const targetTrack = snapToVisibleTrack(
                    Math.max(0, Math.min(trackCountRaw - 1, clip.trackIndex + deltaTrack)),
                    deltaTrack > 0 ? 1 : (deltaTrack < 0 ? -1 : 0),
                );
                try {
                    const response = await moveOne(clip.id, targetBeat, targetTrack);
                    if (!response) continue;
                    // Apply per-clip deltas immediately to keep UI consistent even if
                    // later clips in the same group fail validation/not-found checks.
                    await applyProjectDeltas(response.deltas, 'clip-move-group');
                } catch (err) {
                    moveErrors.push(err instanceof Error ? err.message : String(err));
                }
            }
            if (moveErrors.length > 0) {
                throw new Error(`Group move completed with ${moveErrors.length} error(s): ${moveErrors.join('; ')}`);
            }
        };

        void run()
            .then(() => {
                // Hot-path interaction: avoid console I/O on every drag commit.
            })
            .catch((err) => {
                console.error('[DawShell] moveClip failed:', err);
                if (isClipNotFoundError(err)) return;
                useStatusStore.getState().setError(`Clip move failed: ${err instanceof Error ? err.message : String(err)}`);
            });
    }, [
        applyProjectDeltas,
        hiddenTrackIndices,
        projectBpm,
        projectSampleRate,
        pruneGhostClip,
        selectedClipIds,
        timelineClipsForView,
        trackCountRaw,
        transportBpm,
    ]);

    const handleClipResize = useCallback((clipId: string, newStartBeat: number, newDurationBeats: number, allowStretch: boolean) => {
        const liveState = useEngineStore.getState();
        const liveExists = Boolean(liveState.clips.byId[clipId] ?? liveState.clipsById[clipId]);
        if (!liveExists) {
            pruneGhostClip(clipId);
            return;
        }
        const bpm = projectBpm || transportBpm || 120;
        const sampleRate = projectSampleRate;
        const newPositionFrames = beatToFrame(newStartBeat, bpm, sampleRate);
        const newDurationFrames = Math.max(128, beatDurationToFrames(newDurationBeats, bpm, sampleRate));

        void engineApi.resizeClipWithDeltas(clipId, newPositionFrames, newDurationFrames, allowStretch)
            .then(async (response) => {
                await applyProjectDeltas(response.deltas, 'clip-resize');
            })
            .catch((err) => {
                if (isClipNotFoundError(err)) {
                    pruneGhostClip(clipId);
                    return;
                }
                console.error('[DawShell] resizeClip failed:', err);
                useStatusStore.getState().setError(`Clip resize failed: ${err instanceof Error ? err.message : String(err)}`);
            });
    }, [applyProjectDeltas, projectBpm, projectSampleRate, pruneGhostClip, transportBpm]);

    const handleClipFades = useCallback((clipId: string, fadeInFrames: number, fadeOutFrames: number) => {
        const liveState = useEngineStore.getState();
        const liveExists = Boolean(liveState.clips.byId[clipId] ?? liveState.clipsById[clipId]);
        if (!liveExists) {
            pruneGhostClip(clipId);
            return;
        }
        void engineApi
            .setClipFadesWithDeltas(clipId, Math.max(0, Math.round(fadeInFrames)), Math.max(0, Math.round(fadeOutFrames)))
            .then(async (response) => {
                await applyProjectDeltas(response.deltas, 'clip-fades');
            })
            .catch((err) => {
                if (isClipNotFoundError(err)) {
                    pruneGhostClip(clipId);
                    return;
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
