import { resolveSampleRate } from '@/shared/lib/audioMath';
import type { ProjectDelta } from '@/shared/api/engine';
import { applyClipDelta } from './delta/clipDeltaHandlers';
import { applyPluginDelta } from './delta/pluginDeltaHandlers';
import { applyTrackDelta } from './delta/trackDeltaHandlers';
import type { DeltaApplyResult, DeltaApplyState, DeltaWorkingState, EntityState } from './delta/types';

export type { DeltaApplyResult, DeltaApplyState } from './delta/types';

function toEntityState<T extends { id: string }>(items: T[]): EntityState<T> {
    return {
        byId: Object.fromEntries(items.map((item) => [item.id, item])),
        allIds: items.map((item) => item.id),
    };
}

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
    };

    for (const delta of deltas) {
        const handledByClip = applyClipDelta(working, delta, { bpm, sampleRate, reason });
        if (handledByClip) {
            continue;
        }

        const handledByTrack = applyTrackDelta(working, delta, { bpm, sampleRate, reason });
        if (handledByTrack) {
            continue;
        }

        const handledByPlugin = applyPluginDelta(working, delta, { bpm, sampleRate, reason });
        if (handledByPlugin) {
            continue;
        }
        // Delta kind intentionally ignored by local reducer. Keep state stable
        // and avoid forcing heavyweight full-project refreshes.
        // eslint-disable-next-line no-console
        console.warn(`[Delta] Unhandled delta ignored (${reason}): ${delta.kind}`);
    }

    if (!working.changed) {
        return { nextState: null };
    }

    return {
        nextState: {
            timelineClips: working.timelineClips,
            clipsById: working.clipsById,
            clips: toEntityState(working.timelineClips),
            projectTracks: working.projectTracks,
            tracksById: working.tracksById,
            tracks: toEntityState(working.projectTracks),
        },
    };
}
