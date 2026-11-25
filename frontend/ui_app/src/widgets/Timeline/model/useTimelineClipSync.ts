import { useEffect, useMemo } from 'react';
import type { TimelineClip } from '@/shared/lib/arrangementTypes';
import { clamp01 } from '@/shared/lib/audioMath';
import type { TimelineClipData } from '@/shared/lib/CanvasClipRenderer';
import type { TimelineEngine } from '@/shared/lib/TimelineEngine';
import { useEngineStore } from '@/shared/stores/useEngineStore';
import { isTrackActive } from '@/shared/utils/routing';

interface UseTimelineClipSyncArgs {
    engineRef: React.RefObject<TimelineEngine | null>;
    clips: TimelineClip[];
    selectedClipIds: string[];
    selectedClipIdsRef: React.MutableRefObject<string[]>;
}

export function useTimelineClipSync({
    engineRef,
    clips,
    selectedClipIds,
    selectedClipIdsRef,
}: UseTimelineClipSyncArgs) {
    // BUG-N06 FIX: Select allIds + byId separately with shallow equality
    // to avoid recomputing trackActiveStates on unrelated store updates.
    const tracksAllIds = useEngineStore((s) => s.tracks.allIds);
    const tracksByIdRef = useEngineStore((s) => s.tracks.byId);
    const trackActiveStates = useMemo(() => {
        const orderedTracks = tracksAllIds
            .map((id) => tracksByIdRef[id])
            .filter((track): track is NonNullable<typeof track> => Boolean(track));
        return orderedTracks.map((_t, i, arr) => isTrackActive(i, arr));
    }, [tracksAllIds, tracksByIdRef]);

    useEffect(() => {
        const engine = engineRef.current;
        if (!engine) return;
        const clipData: TimelineClipData[] = clips.map((c) => {
            let fadeIn = (c.durationSamples && c.durationSamples > 0)
                ? clamp01((c.fadeIn ?? 0) / c.durationSamples)
                : 0;
            let fadeOut = (c.durationSamples && c.durationSamples > 0)
                ? clamp01((c.fadeOut ?? 0) / c.durationSamples)
                : 0;
            // ENTERPRISE: Cross-clamp to prevent fadeIn+fadeOut > 1.0
            if (fadeIn + fadeOut > 1.0 && (fadeIn + fadeOut) > 0) {
                const total = fadeIn + fadeOut;
                fadeIn = fadeIn / total;
                fadeOut = fadeOut / total;
            }
            return ({
                fadeIn,
                fadeOut,
                id: c.id,
                name: c.name,
                trackIndex: c.trackIndex,
                startBeat: c.startBeat,
                durationBeats: c.durationBeats,
                type: c.type,
                color: c.color,
                // SSOT: Engine's setClips() carries over selection from internal state.
                // We pass selected: false here — the engine overwrites it with oldClip.selected.
                selected: false,
                filePath: c.filePath,
                durationSamples: c.durationSamples,
                sourceOffset: c.sourceOffset,
                fadeInCurve: c.fadeInCurve,
                fadeOutCurve: c.fadeOutCurve,
                isOffline: c.isOffline,
                muted: c.muted,
                trackDisabled: !trackActiveStates[c.trackIndex],
                isWarped: c.isWarped,
                warpSourceDurationFrames: c.warpSourceDurationFrames,
                sourceFileTotalFrames: c.sourceFileTotalFrames,
                numFrames: c.numFrames,
                sampleRate: c.sampleRate,
                channels: c.channels,
                pitchShiftSemitones: c.pitchShiftSemitones,
                midiNotes: c.midiNotes,
            });
        });
        engine.setClips(clipData);
        // SSOT: setClipSelection ensures the engine's selection state matches React's
        // selectedClipIds. This is needed because setClips carries over OLD selection
        // from the engine, but React may have changed selectedClipIds independently.
        engine.setClipSelection(selectedClipIdsRef.current);
    }, [clips, engineRef, trackActiveStates, selectedClipIdsRef]);

    // SSOT FIX: Sync clip selection independently of the full clips array.
    // This allows shift-click (which updates selectedClipIds in React but doesn't
    // change the clips array) to immediately reflect in the engine.
    useEffect(() => {
        const engine = engineRef.current;
        if (!engine) return;
        engine.setClipSelection(selectedClipIds);
    }, [engineRef, selectedClipIds]);

    // ── Group track miniature metadata ────────────────────────────────
    useEffect(() => {
        const engine = engineRef.current;
        if (!engine) return;

        const groupTracks = new Map<number, number[]>();
        const trackColors = new Map<number, string>();
        const orderedTracks = tracksAllIds
            .map((id) => tracksByIdRef[id])
            .filter((track): track is NonNullable<typeof track> => Boolean(track));

        // Build ID → index lookup for O(1) resolution
        const idToIndex = new Map<string, number>();
        for (let i = 0; i < tracksAllIds.length; i++) {
            idToIndex.set(tracksAllIds[i], i);
        }

        // Recursive helper: collect all descendant track indices (flattens subgroups)
        const collectChildIndices = (childIds: string[], visited: Set<number>): number[] => {
            const result: number[] = [];
            for (const childId of childIds) {
                const childIdx = idToIndex.get(childId);
                if (childIdx === undefined || childIdx < 0) continue;
                if (visited.has(childIdx)) continue; // cycle protection
                visited.add(childIdx);

                const childTrack = orderedTracks[childIdx];
                if (childTrack?.track_type === 'Group' && childTrack.child_track_ids?.length) {
                    // Subgroup: recursively include its children (not the group track itself)
                    const subChildren = collectChildIndices(childTrack.child_track_ids, visited);
                    result.push(...subChildren);
                } else {
                    // Leaf track: include directly
                    result.push(childIdx);
                }
            }
            return result;
        };

        for (let i = 0; i < orderedTracks.length; i++) {
            const track = orderedTracks[i];
            if (track.color) {
                trackColors.set(i, track.color);
            }
            if (track.track_type === 'Group' && track.child_track_ids && track.child_track_ids.length > 0) {
                const visited = new Set<number>([i]); // prevent self-reference
                const childIndices = collectChildIndices(track.child_track_ids, visited);
                if (childIndices.length > 0) {
                    groupTracks.set(i, childIndices);
                }
            }
        }

        engine.setTrackMeta(groupTracks, trackColors);
    }, [tracksAllIds, tracksByIdRef, engineRef]);
}
