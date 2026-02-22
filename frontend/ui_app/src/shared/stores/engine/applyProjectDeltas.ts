import { resolveSampleRate } from '@/shared/lib/audioMath';
import type { ProjectDelta } from '@/shared/api/engine';
import { applyClipDelta } from './delta/clipDeltaHandlers';
import { applyPluginDelta } from './delta/pluginDeltaHandlers';
import { applyTrackDelta } from './delta/trackDeltaHandlers';
import type { DeltaApplyResult, DeltaApplyState, DeltaWorkingState } from './delta/types';

export type { DeltaApplyResult, DeltaApplyState } from './delta/types';

export function applyProjectDeltasToState(
    state: DeltaApplyState,
    deltas: ProjectDelta[],
    reason: string,
): DeltaApplyResult {
    const bpm = state.projectBpm || state.transport.bpm || 120;
    const sampleRate = resolveSampleRate(state.projectSampleRate, state.transport.sample_rate);

    const working: DeltaWorkingState = {
        timelineClips: state.timelineClips,
        clipsById: state.clipsById,
        projectTracks: state.projectTracks,
        tracksById: state.tracksById,
        changed: false,
        fallbackReason: null,
    };

    for (const delta of deltas) {
        const handledByClip = applyClipDelta(working, delta, { bpm, sampleRate, reason });
        if (handledByClip) {
            if (working.fallbackReason) break;
            continue;
        }

        const handledByTrack = applyTrackDelta(working, delta, { bpm, sampleRate, reason });
        if (handledByTrack) {
            if (working.fallbackReason) break;
            continue;
        }

        const handledByPlugin = applyPluginDelta(working, delta, { bpm, sampleRate, reason });
        if (handledByPlugin) {
            if (working.fallbackReason) break;
            continue;
        }

        working.fallbackReason = `${reason}-unhandled-${delta.kind}`;
        break;
    }

    if (!working.changed) {
        return { nextState: null, fallbackReason: working.fallbackReason };
    }

    return {
        nextState: {
            timelineClips: working.timelineClips,
            clipsById: working.clipsById,
            projectTracks: working.projectTracks,
            tracksById: working.tracksById,
        },
        fallbackReason: working.fallbackReason,
    };
}
