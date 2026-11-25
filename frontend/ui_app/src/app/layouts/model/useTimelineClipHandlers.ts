import { useCallback } from 'react';
import * as engineApi from '@/shared/api/engine';
import { beatDurationToFrames, beatToFrame, DEFAULT_TIME_SIG_NUMERATOR, resolveBpm } from '@/shared/lib/audioMath';
import { useStatusStore } from '@/shared/stores/useStatusStore';
import { useEngineStore, type EngineStore } from '@/shared/stores/useEngineStore';
import { extractNewClipIdsFromDeltas } from '@/shared/lib/clipDeltaUtils';
import type { TimelineClip } from '@/shared/lib/arrangementTypes';
import type { ProjectDelta } from '@/shared/api/engine';

/**
 * SSOT: Canonical clip lookup via normalized clips.byId map.
 */
function resolveClipById(state: EngineStore, clipId: string): TimelineClip | undefined {
    return state.clips.byId[clipId];
}

type BottomPanelMode = 'rack' | 'clip';

type Args = {
    projectBpm: number;
    transportBpm: number;
    projectSampleRate: number;
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
    handleClipDuplicate: (clipId: string, newStartBeat: number, newTrackIndex: number) => void;
    handleClipResize: (clipId: string, newStartBeat: number, newDurationBeats: number, allowStretch: boolean, sourceOffset?: number, warpSourceDurationFrames?: number, durationSamples?: number) => void;
    handleClipFades: (clipId: string, fadeInFrames: number, fadeOutFrames: number) => void;
    handleOpenMidiClip: (clipId: string) => void;
};

export function useTimelineClipHandlers({
    projectBpm,
    projectSampleRate,
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
        // ENTERPRISE FIX: Only match genuine clip-not-found errors, not serde
        // deserialization failures like "missing field `new_track_index`".
        // Require "clip" word AND a not-found indicator, but exclude "missing field".
        if (/missing\s+field/i.test(message)) return false;
        return /clip/i.test(message) && /(not\s+found|unknown|does\s+not\s+exist|missing)/i.test(message);
    };

    // AUDIT FIX: Extracted from duplicate inline definitions in handleClipMove and handleClipDuplicate.
    // Single Source of Truth for snap-to-visible-track logic.
    const snapToVisibleTrack = useCallback((targetTrack: number, preferredDirection: -1 | 0 | 1 = 0): number => {
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
    }, [hiddenTrackIndices, trackCountRaw]);

    // SSOT FIX: Use timelineClips as the single source of truth.
    // Previously guessed which byId map was canonical — now always derives from the array.
    // SSOT FIX: pruneGhostClip derives all state from single filtered array.
    const pruneGhostClip = useCallback((clipId: string) => {
        if (!clipId) return;
        useEngineStore.getState().deleteClip(clipId);
        setSelectedClipIds((prev) => prev.filter((id) => id !== clipId));
    }, [setSelectedClipIds]);

    const handleDoubleClickTrack = useCallback((trackIndex: number, beat: number) => {
        // BUG-026: Use projectBpm as single source of truth — transportBpm can diverge during pending changes.
        const bpm = resolveBpm(projectBpm);
        const sampleRate = projectSampleRate;
        const storeState = useEngineStore.getState();
        // BUG-005: Derive beatsPerBar from timeSigNumerator instead of unsafe `as` cast.
        const beatsPerBar = storeState.timeSigNumerator ?? DEFAULT_TIME_SIG_NUMERATOR;
        const positionFrames = Math.round(beatToFrame(beat, bpm, sampleRate));
        const durationFrames = Math.round(beatDurationToFrames(beatsPerBar, bpm, sampleRate));
        void createMidiClip(trackIndex, positionFrames, durationFrames);
    }, [createMidiClip, projectBpm, projectSampleRate]);

    const handleClipMove = useCallback((clipId: string, newStartBeat: number, newTrackIndex: number) => {
        // BUG-026: Use projectBpm as single source of truth.
        const bpm = resolveBpm(projectBpm);
        const sampleRate = projectSampleRate;
        const liveState = useEngineStore.getState();
        // SSOT: Use clips.byId as the single canonical lookup map.
        const liveClip = resolveClipById(liveState, clipId);
        const liveExists = Boolean(liveClip);
        if (!liveExists) {
            pruneGhostClip(clipId);
            return;
        }

        // AUDIT FIX: Use resolveClipById as the SSOT — removed fallback to timelineClipsForView.
        const dragged = liveClip;
        if (!dragged) {
            pruneGhostClip(clipId);
            return;
        }

        const selectedSet = new Set(selectedClipIds);
        const moveAsGroup = selectedSet.size > 1 && selectedSet.has(clipId);

        const run = async () => {
            let clipsToMove: TimelineClip[];
            if (moveAsGroup) {
                const seen = new Set<string>();
                clipsToMove = selectedClipIds
                    .map((id) => resolveClipById(liveState, id))
                    .filter((clip): clip is TimelineClip => Boolean(clip))
                    .filter((clip) => {
                        if (!selectedSet.has(clip.id)) return false;
                        if (seen.has(clip.id)) return false;
                        seen.add(clip.id);
                        return true;
                    });
            } else {
                clipsToMove = [dragged];
            }

            const deltaBeat = newStartBeat - dragged.startBeat;
            const deltaTrack = newTrackIndex - dragged.trackIndex;
            const preferredDirection: -1 | 0 | 1 = deltaTrack > 0 ? 1 : (deltaTrack < 0 ? -1 : 0);

            const requests = clipsToMove.map((clip) => {
                const targetBeat = moveAsGroup ? Math.max(0, clip.startBeat + deltaBeat) : newStartBeat;
                const targetTrack = snapToVisibleTrack(Math.max(0, Math.min(trackCountRaw - 1, moveAsGroup ? clip.trackIndex + deltaTrack : newTrackIndex)), preferredDirection);
                const positionFrames = Math.round(beatToFrame(Math.max(0, targetBeat), bpm, sampleRate));
                return { id: clip.id, newTrackIndex: targetTrack, newPositionFrames: positionFrames };
            });

            try {
                const response = await engineApi.moveMultipleClipsWithDeltas(requests);
                await applyProjectDeltas(response.deltas, moveAsGroup ? 'clip-move-group' : 'clip-move');
            } catch (err) {
                console.error('[CLIP-MOVE-DIAG] Move FAILED:', err);
                if (isClipNotFoundError(err)) {
                    // Not ideal grouping behavior if one deletes mid-drag, but avoids total failure.
                    for (const req of requests) pruneGhostClip(req.id);
                    return;
                }
                throw err;
            }
        };

        void run()
            .then(() => {
                // Hot-path interaction: avoid console I/O on every drag commit.
            })
            .catch((err) => {
                console.error('[Dream] moveClip failed:', err);
                if (isClipNotFoundError(err)) return;
                useStatusStore.getState().setError(`Clip move failed: ${err instanceof Error ? err.message : String(err)}`);
            });
    }, [
        applyProjectDeltas,
        projectBpm,
        projectSampleRate,
        pruneGhostClip,
        selectedClipIds,
        snapToVisibleTrack,
        trackCountRaw,
    ]);

    const handleClipResize = useCallback((clipId: string, newStartBeat: number, newDurationBeats: number, allowStretch: boolean, optSourceOffset?: number, optWarpSourceDurationFrames?: number, optDurationSamples?: number) => {
        // BUG-008: Validate inputs before IPC — reject negative, NaN, zero-duration.
        if (!Number.isFinite(newStartBeat) || newStartBeat < 0) return;
        if (!Number.isFinite(newDurationBeats) || newDurationBeats <= 0) return;
        const liveState = useEngineStore.getState();
        const liveExists = Boolean(resolveClipById(liveState, clipId));
        if (!liveExists) {
            pruneGhostClip(clipId);
            return;
        }
        const liveClip = resolveClipById(liveState, clipId);
        if (!liveClip) {
            pruneGhostClip(clipId);
            return;
        }
        // BUG-026: Use projectBpm as single source of truth.
        const bpm = resolveBpm(projectBpm);
        const sampleRate = projectSampleRate;
        const newPositionFrames = Math.round(beatToFrame(newStartBeat, bpm, sampleRate));
        // ENTERPRISE FIX (WAVEFORM-DESYNC): Prefer the precisely-clamped durationSamples
        // from the composed preview when available. The preview computes durationSamples
        // with source-boundary clamping; recomputing from beats introduces floating-point
        // drift that causes the waveform to snap during the IPC gap.
        // CRITICAL: Both paths must enforce MIN_CLIP_FRAMES (128) to match the Rust
        // backend's minimum (mutators.rs L78). Without this, the backend rejects the
        // resize with ClipTooShort, causing the clip to snap to a 1px strip.
        const MIN_CLIP_FRAMES = 128;
        const newDurationFrames = typeof optDurationSamples === 'number' && optDurationSamples > 0
            ? Math.max(MIN_CLIP_FRAMES, optDurationSamples)
            : Math.round(Math.max(MIN_CLIP_FRAMES, beatDurationToFrames(newDurationBeats, bpm, sampleRate)));

        // ENTERPRISE FIX: Apply optimistic Zustand update BEFORE async IPC logic.
        // This bridges the 100-200ms IPC gap, preventing the TimelineEngine from
        // collapsing to stale store values (causing waveform snap-back) on mouseUp.
        //
        // CRITICAL: Update the SSOT clips store with ALL preview-computed fields.
        useEngineStore.getState().patchClip(clipId, {
            startBeat: newStartBeat,
            durationBeats: newDurationBeats,
            durationSamples: newDurationFrames,
            sourceFileTotalFrames: liveClip.sourceFileTotalFrames ?? liveClip.numFrames,
            numFrames: liveClip.numFrames ?? liveClip.sourceFileTotalFrames,
            ...(typeof optSourceOffset === 'number'
                ? { sourceOffset: Math.round(optSourceOffset) }
                : {}),
            // ENTERPRISE FIX (ROOT CAUSE): Propagate warpSourceDurationFrames from
            // the composed preview. Without this, the store keeps the stale pre-resize
            // value → the waveform renderer reads the wrong source window → visible
            // stretching/squishing during the 100-200ms IPC gap.
            ...(typeof optWarpSourceDurationFrames === 'number'
                ? { warpSourceDurationFrames: optWarpSourceDurationFrames }
                : {}),
        });

        void engineApi.resizeClipWithDeltas(clipId, newPositionFrames, newDurationFrames, allowStretch)
            .then(async (response) => {
                await applyProjectDeltas(response.deltas, 'clip-resize');
            })
            .catch((err) => {
                if (isClipNotFoundError(err)) {
                    pruneGhostClip(clipId);
                    return;
                }
                console.error('[Dream] resizeClip failed:', err);
                useStatusStore.getState().setError(`Clip resize failed: ${err instanceof Error ? err.message : String(err)}`);
            });
    }, [applyProjectDeltas, projectBpm, projectSampleRate, pruneGhostClip]);

    const handleClipFades = useCallback((clipId: string, fadeInFrames: number, fadeOutFrames: number) => {
        const liveState = useEngineStore.getState();
        const liveExists = Boolean(resolveClipById(liveState, clipId));
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
                console.error('[Dream] setClipFades failed:', err);
                // BUG-062: Surface error to user via status store.
                useStatusStore.getState().setError(`Clip fades failed: ${err instanceof Error ? err.message : String(err)}`);
            });
    }, [applyProjectDeltas, pruneGhostClip]);

    // ────────────────────────────────────────────────────────────────────────
    // ENTERPRISE: Cmd+Drag duplicate — duplicates clips to target position/track.
    // Supports multi-clip selection: all selected clips are duplicated with
    // the same relative offset that the primary clip was dragged by.
    // ────────────────────────────────────────────────────────────────────────
    const handleClipDuplicate = useCallback((clipId: string, newStartBeat: number, newTrackIndex: number) => {
        const bpm = resolveBpm(projectBpm);
        const sampleRate = projectSampleRate;
        const liveState = useEngineStore.getState();
        const liveClip = resolveClipById(liveState, clipId);
        if (!liveClip) {
            pruneGhostClip(clipId);
            return;
        }

        const dragged = liveClip;

        const selectedSet = new Set(selectedClipIds);
        const duplicateAsGroup = selectedSet.size > 1 && selectedSet.has(clipId);

        const snapToVisibleTrackLocal = (targetTrack: number): number => snapToVisibleTrack(targetTrack, 0);

        const run = async () => {
            let clipsToDuplicate: TimelineClip[];
            if (duplicateAsGroup) {
                const seen = new Set<string>();
                clipsToDuplicate = selectedClipIds
                    .map((id) => resolveClipById(liveState, id))
                    .filter((clip): clip is TimelineClip => Boolean(clip))
                    .filter((clip) => {
                        if (!selectedSet.has(clip.id)) return false;
                        if (seen.has(clip.id)) return false;
                        seen.add(clip.id);
                        return true;
                    });
            } else {
                clipsToDuplicate = [dragged];
            }

            const deltaBeat = newStartBeat - dragged.startBeat;
            const deltaTrack = newTrackIndex - dragged.trackIndex;

            const requests = clipsToDuplicate.map((clip) => {
                const targetBeat = duplicateAsGroup ? Math.max(0, clip.startBeat + deltaBeat) : newStartBeat;
                const targetTrack = snapToVisibleTrackLocal(Math.max(0, Math.min(trackCountRaw - 1, duplicateAsGroup ? clip.trackIndex + deltaTrack : newTrackIndex)));
                const positionFrames = Math.round(beatToFrame(Math.max(0, targetBeat), bpm, sampleRate));
                return { id: clip.id, newPositionFrames: positionFrames, targetTrackIndex: targetTrack };
            });

            try {
                const response = await engineApi.duplicateMultipleClipsWithDeltas(requests);
                await applyProjectDeltas(response.deltas, 'clip-duplicate-drag');
                // SSOT FIX: Use typed helper for delta extraction.
                const newIds = extractNewClipIdsFromDeltas(response.deltas, response.new_id);

                if (newIds.length > 0) {
                    setSelectedClipIds(newIds);
                }
            } catch (err) {
                console.error('[Dream] Cmd+Drag duplicate failed:', err);
                useStatusStore.getState().setError(`Clip duplicate failed: ${err instanceof Error ? err.message : String(err)}`);
            }
        };

        void run().catch((err) => {
            console.error('[Dream] Cmd+Drag duplicate failed:', err);
            useStatusStore.getState().setError(`Clip duplicate failed: ${err instanceof Error ? err.message : String(err)}`);
        });
    }, [
        applyProjectDeltas,
        projectBpm,
        projectSampleRate,
        pruneGhostClip,
        selectedClipIds,
        setSelectedClipIds,
        snapToVisibleTrack,
        trackCountRaw,
    ]);

    const handleOpenMidiClip = useCallback((clipId: string) => {
        setSelectedClipIds([clipId]);
        setBottomPanelModeForActiveTrack('clip');
    }, [setBottomPanelModeForActiveTrack, setSelectedClipIds]);

    return {
        handleDoubleClickTrack,
        handleClipMove,
        handleClipDuplicate,
        handleClipResize,
        handleClipFades,
        handleOpenMidiClip,
    };
}
