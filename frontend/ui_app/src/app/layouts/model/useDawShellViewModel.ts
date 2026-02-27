import { useMemo, useRef } from 'react';
import { resolveBpm } from '@/shared/lib/audioMath';
import { frameToBeat } from '@/shared/lib/audioMath';
import type { TimelineClip } from '@/shared/lib/arrangementTypes';
import type { MidiNote } from '@/widgets/PianoRoll/model/pianoRollConfig';
import type { EntityState } from '@/shared/stores/engine/storeHelpers';
import type { ProjectTrack } from '@/shared/stores/useEngineStore';

interface UseDawShellViewModelArgs {
    projectBpm: number;
    transportBpm: number;
    projectSampleRate: number;
    transportLoopStart: number;
    transportLoopEnd: number;
    timelineClips: TimelineClip[];
    selectedClipIds: string[];
    clipFadeCurves: Record<string, { fadeInCurve: number; fadeOutCurve: number }>;
    midiNotesByClip: Record<string, MidiNote[]>;
    tracksEntity: EntityState<ProjectTrack>;
}

export function useDawShellViewModel(args: UseDawShellViewModelArgs) {
    const {
        transportBpm,
        projectSampleRate,
        transportLoopStart,
        transportLoopEnd,
        timelineClips,
        selectedClipIds,
        clipFadeCurves,
        midiNotesByClip,
        tracksEntity,
    } = args;

    const clipCache = useRef(new Map<string, { lastClip: TimelineClip, lastCurve: any, lastNotes: any, viewClip: TimelineClip }>());

    const timelineClipsForView = useMemo(() => {
        const cache = clipCache.current;
        const newCache = new Map();

        const result = timelineClips.map((clip) => {
            const curve = clipFadeCurves[clip.id];
            const localNotes = clip.type === 'midi' ? midiNotesByClip[clip.id] : undefined;

            const cached = cache.get(clip.id);
            if (cached && cached.lastClip === clip && cached.lastCurve === curve && cached.lastNotes === localNotes) {
                newCache.set(clip.id, cached);
                return cached.viewClip;
            }

            const withCurve = curve
                ? {
                    ...clip,
                    fadeInCurve: curve.fadeInCurve,
                    fadeOutCurve: curve.fadeOutCurve,
                }
                : clip;

            let viewClip = withCurve;
            if (localNotes) {
                viewClip = {
                    ...withCurve,
                    midiNotes: localNotes,
                };
            }

            newCache.set(clip.id, { lastClip: clip, lastCurve: curve, lastNotes: localNotes, viewClip });
            return viewClip;
        });

        clipCache.current = newCache;
        return result;
    }, [timelineClips, midiNotesByClip, clipFadeCurves]);

    const prevSelectedClipIdsRef = useRef<string[]>([]);
    const selectedClipIdsForView = useMemo(() => {
        const validIds = selectedClipIds.filter((id) => clipCache.current.has(id));
        if (
            validIds.length === prevSelectedClipIdsRef.current.length &&
            validIds.every((v, i) => v === prevSelectedClipIdsRef.current[i])
        ) {
            return prevSelectedClipIdsRef.current;
        }
        prevSelectedClipIdsRef.current = validIds;
        return validIds;
    }, [selectedClipIds, timelineClipsForView]);

    const selectedClipIdForView = useMemo(
        () => (selectedClipIdsForView.length > 0 ? selectedClipIdsForView[selectedClipIdsForView.length - 1] : null),
        [selectedClipIdsForView]
    );

    const _loopBpm = useMemo(() => resolveBpm(transportBpm), [transportBpm]);
    const loopStartBeat = useMemo(
        () => frameToBeat(transportLoopStart, _loopBpm, projectSampleRate),
        [transportLoopStart, _loopBpm, projectSampleRate]
    );
    const loopEndBeat = useMemo(
        () => frameToBeat(transportLoopEnd, _loopBpm, projectSampleRate),
        [transportLoopEnd, _loopBpm, projectSampleRate]
    );

    const offlineClipCount = useMemo(() => {
        return timelineClips.filter((c) => c.type === 'audio' && c.isOffline).length;
    }, [timelineClips]);

    const missingPluginCount = useMemo(() => {
        let count = 0;
        for (const trackId of tracksEntity.allIds) {
            const track = tracksEntity.byId[trackId];
            if (!track) continue;
            if (track.instrument?.plugin_id?.startsWith('missing://')) count += 1;
            count += (track.effects ?? []).filter((fx: any) => fx.plugin_id?.startsWith('missing://')).length;
        }
        return count;
    }, [tracksEntity]);

    const missingMediaSummary = useMemo(() => ({
        offlineClipCount,
        missingPluginCount,
        total: offlineClipCount + missingPluginCount,
    }), [offlineClipCount, missingPluginCount]);

    const result = useMemo(() => ({
        timelineClipsForView,
        selectedClipIdsForView,
        selectedClipIdForView,
        loopStartBeat,
        loopEndBeat,
        missingMediaSummary,
    }), [
        timelineClipsForView,
        selectedClipIdsForView,
        selectedClipIdForView,
        loopStartBeat,
        loopEndBeat,
        missingMediaSummary,
    ]);

    const ref = useRef(result);
    // Simple deep equal for the result object
    const isEqual = (a: any, b: any) => {
        if (a === b) return true;
        if (!a || !b || typeof a !== 'object' || typeof b !== 'object') return false;
        const keysA = Object.keys(a);
        const keysB = Object.keys(b);
        if (keysA.length !== keysB.length) return false;
        for (const key of keysA) {
            if (a[key] !== b[key]) return false;
        }
        return true;
    };

    if (!isEqual(ref.current, result)) {
        ref.current = result;
    }
    return ref.current;
}
