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
    selectedClipIdsRef: React.MutableRefObject<string[]>;
}

export function useTimelineClipSync({
    engineRef,
    clips,
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
        const clipData: TimelineClipData[] = clips.map((c) => ({
            fadeIn: (c.durationSamples && c.durationSamples > 0)
                ? clamp01((c.fadeIn ?? 0) / c.durationSamples)
                : 0,
            fadeOut: (c.durationSamples && c.durationSamples > 0)
                ? clamp01((c.fadeOut ?? 0) / c.durationSamples)
                : 0,
            id: c.id,
            name: c.name,
            trackIndex: c.trackIndex,
            startBeat: c.startBeat,
            durationBeats: c.durationBeats,
            type: c.type,
            color: c.color,
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
            pitchShiftSemitones: c.pitchShiftSemitones,
            midiNotes: c.midiNotes,
        }));
        // BUG-C02 FIX: Apply selection directly to clipData before setClips
        // to prevent 1-frame deselection flicker between setClips/setClipSelection.
        const selectedSet = new Set(selectedClipIdsRef.current);
        for (const cd of clipData) {
            cd.selected = selectedSet.has(cd.id);
        }
        engine.setClips(clipData);
        engine.setClipSelection(selectedClipIdsRef.current);
    }, [clips, engineRef, trackActiveStates, selectedClipIdsRef]);
}
