import type { ProjectDelta } from '@/shared/api/engine';
import type { ProjectTrack } from '@/shared/lib/trackAdapter';
import { useAutomationStore } from '@/shared/stores/useAutomationStore';
import type { DeltaEnv, DeltaWorkingState } from './types';
import { clamp01 } from '@/shared/lib/audioMath';
import { DEFAULT_TRACK_HEIGHT_PX } from '@/shared/lib/TimelineEngine.types';
import { colorForTrackIndex, normalizeTrackType } from './trackDeltaUtils';
import {
    findTrackIndexById,
    getTrackByIndex,
    getTrackCount,
    getTrackIdByIndex,
    insertTrackAt,
    moveTrackById,
    patchTrackById,
    rebuildChildTrackIds,
    removeTrackById,
} from './trackStateOps';

function patchTrack(state: DeltaWorkingState, id: string, patch: Partial<ProjectTrack>): void {
    patchTrackById(state, id, patch);
}

function patchSampleRackPad(
    state: DeltaWorkingState,
    trackId: string,
    padIndex: number,
    patch: Partial<NonNullable<ProjectTrack['sample_rack']>['pads'][number]>,
): boolean {
    const track = state.tracks.byId[trackId];
    if (!track || !track.sample_rack || !Array.isArray(track.sample_rack.pads)) return false;
    if (padIndex < 0 || padIndex >= track.sample_rack.pads.length) return false;
    const nextPads = track.sample_rack.pads.slice();
    nextPads[padIndex] = { ...nextPads[padIndex], ...patch };
    patchTrack(state, trackId, {
        sample_rack: {
            ...track.sample_rack,
            pads: nextPads,
        },
    });
    return true;
}

export function applyTrackDelta(state: DeltaWorkingState, delta: ProjectDelta, env: DeltaEnv): boolean {
    void env;
    if (delta.kind === 'TrackVolumeChanged') {
        patchTrack(state, delta.data.track_id, { volume: delta.data.volume });
        return true;
    }
    if (delta.kind === 'TrackPanChanged') {
        patchTrack(state, delta.data.track_id, { pan: delta.data.pan });
        return true;
    }
    if (delta.kind === 'TrackDisabledChanged') {
        // ENTERPRISE TYPE SAFETY: Both `disabled` and `muted` (legacy) are now
        // declared in the ProjectDelta type — no `as Record<string, unknown>` needed.
        // Backend schema migrated from `muted` → `disabled`. Support both
        // with explicit fallback and deprecation warning for old field.
        if (typeof delta.data.disabled !== 'boolean') {
            console.warn('[TrackDelta] TrackDisabledChanged: missing `disabled` field — skipping.');
            return true;
        }
        const nextDisabled = delta.data.disabled;
        patchTrack(state, delta.data.track_id, { is_disabled: nextDisabled });
        return true;
    }
    if (delta.kind === 'TrackSoloChanged') {
        patchTrack(state, delta.data.track_id, { is_solo: delta.data.soloed });
        return true;
    }
    if (delta.kind === 'TrackArmChanged') {
        const track = getTrackByIndex(state, delta.data.track_index);
        if (!track) return true;
        patchTrack(state, track.id, { is_armed: delta.data.armed });
        return true;
    }
    if (delta.kind === 'TrackRoutingChanged') {
        patchTrack(state, delta.data.track_id, { output: delta.data.output_destination_id ?? 'master' });
        return true;
    }
    if (delta.kind === 'TrackInputChanged') {
        patchTrack(state, delta.data.track_id, { input: delta.data.input_source_id ?? 'none' });
        return true;
    }
    if (delta.kind === 'TrackSamplerSampleChanged') {
        const track = state.tracks.byId[delta.data.track_id];
        if (!track) return true;
        patchTrack(state, delta.data.track_id, {
            sampler: {
                sample_path: delta.data.sample_path,
                root_note: track.sampler?.root_note ?? 60,
                volume: track.sampler?.volume ?? 1,
                attack: track.sampler?.attack ?? 0.01,
                decay: track.sampler?.decay ?? 0.2,
                sustain: track.sampler?.sustain ?? 0.8,
                release: track.sampler?.release ?? 0.3,
                osc2_waveform: track.sampler?.osc2_waveform,
                osc_mix: track.sampler?.osc_mix,
                detune_cents: track.sampler?.detune_cents,
                sub_level: track.sampler?.sub_level,
            },
        });
        return true;
    }
    if (delta.kind === 'SampleRackPadSampleChanged') {
        patchSampleRackPad(state, delta.data.track_id, delta.data.pad_index, {
            sample_path: delta.data.sample_path,
        });
        return true;
    }
    if (delta.kind === 'SampleRackPadVolumeChanged') {
        patchSampleRackPad(state, delta.data.track_id, delta.data.pad_index, {
            volume: delta.data.volume,
        });
        return true;
    }
    if (delta.kind === 'SampleRackPadMuteChanged') {
        patchSampleRackPad(state, delta.data.track_id, delta.data.pad_index, {
            is_disabled: delta.data.muted,
        });
        return true;
    }
    if (delta.kind === 'SampleRackPadSoloChanged') {
        patchSampleRackPad(state, delta.data.track_id, delta.data.pad_index, {
            is_soloed: delta.data.soloed,
        });
        return true;
    }
    if (delta.kind === 'SampleRackPadAdsrChanged') {
        patchSampleRackPad(state, delta.data.track_id, delta.data.pad_index, {
            attack: delta.data.attack,
            decay: delta.data.decay,
            sustain: delta.data.sustain,
            release: delta.data.release,
        });
        return true;
    }
    if (delta.kind === 'SampleRackPadFilterCutoffChanged') {
        patchSampleRackPad(state, delta.data.track_id, delta.data.pad_index, {
            filter_cutoff: delta.data.cutoff,
        });
        return true;
    }
    if (delta.kind === 'TrackRenamed') {
        patchTrack(state, delta.data.track_id, { name: delta.data.new_name });
        return true;
    }
    if (delta.kind === 'TrackColorChanged') {
        patchTrack(state, delta.data.track_id, { color: delta.data.color });
        return true;
    }
    if (delta.kind === 'TrackHeightChanged') {
        patchTrack(state, delta.data.track_id, { height: delta.data.height });
        return true;
    }
    if (delta.kind === 'TrackGroupExpandedChanged') {
        patchTrack(state, delta.data.track_id, { is_expanded: delta.data.expanded });
        return true;
    }
    if (delta.kind === 'TrackFlowSynthConfigChanged') {
        patchTrack(state, delta.data.track_id, { flow_synth: delta.data.config });
        return true;
    }
    if (delta.kind === 'AutomationPointsChanged') {
        const track = state.tracks.byId[delta.data.track_id];
        if (!track) return true;
        const lanePoints = delta.data.points.map((point) => ({
            beat: point.beat,
            value: point.value,
            curve_type: point.curve_type,
            tension: point.tension ?? undefined,
        }));
        // BUG-040 FIX: Keep lanes with 0 points instead of removing them.
        // Previously, `.filter(lane => lane.points.length > 0)` removed the lane
        // entirely when all points were deleted, losing the param_id association.
        // When the user adds a new point after clearing, the lane was re-created
        // without any previous parameter metadata. Now we keep the lane structure
        // intact with empty points array — the param_id is preserved for undo.
        const nextLanes = track.automation_lanes.some((lane) => lane.param_id === delta.data.param_id)
            ? track.automation_lanes
                .map((lane) => lane.param_id === delta.data.param_id
                    ? { ...lane, points: lanePoints }
                    : lane)
            : (lanePoints.length > 0
                ? [...track.automation_lanes, { param_id: delta.data.param_id, points: lanePoints }]
                : track.automation_lanes);
        const nextPatch: Partial<ProjectTrack> = { automation_lanes: nextLanes };
        // BUG-041 FIX: Derive send_a/send_b from the point with the highest
        // beat value (last in time), not from array position .at(-1).
        // After undo, the backend may send unsorted points — .at(-1) gives
        // the wrong value because it's just the last array element, not the
        // temporally last point.
        const param = (delta.data.param_id ?? '').toLowerCase();
        if (param === 'send.a' || param === 'send.b') {
            const points = delta.data.points;
            let lastValue = 0;
            if (points.length > 0) {
                let maxBeat = -Infinity;
                for (const p of points) {
                    if (p.beat >= maxBeat) {
                        maxBeat = p.beat;
                        lastValue = p.value;
                    }
                }
            }
            if (param === 'send.a') {
                nextPatch.send_a = clamp01(lastValue);
            } else {
                nextPatch.send_b = clamp01(lastValue);
            }
        }
        patchTrack(state, delta.data.track_id, nextPatch);
        return true;
    }

    if (delta.kind === 'TrackAdded') {
        const insertIndex = Math.max(0, Math.min(delta.data.track_index, getTrackCount(state)));
        const nextTrack: ProjectTrack = {
            id: delta.data.track_id,
            name: delta.data.name,
            track_type: normalizeTrackType(delta.data.track_type),
            color: colorForTrackIndex(insertIndex),
            volume: 1,
            pan: 0,
            send_a: 0,
            send_b: 0,
            is_disabled: false,
            is_solo: false,
            is_armed: false,
            height: DEFAULT_TRACK_HEIGHT_PX,
            output: 'master',
            input: 'none',
            parent_track_id: null,
            child_track_ids: [],
            is_expanded: true,
            effects: [],
            instrument: null,
            sampler: null,
            sample_rack: null,
            automation_lanes: [],
        };
        insertTrackAt(state, insertIndex, nextTrack);

        for (const id of state.clips.allIds) {
            const clip = state.clips.byId[id];
            if (clip && clip.trackIndex >= insertIndex) {
                state.clips.byId[id] = { ...clip, trackIndex: clip.trackIndex + 1 };
            }
        }

        // ENTERPRISE FIX (Phase 32): Track structural mutations MUST unconditionally
        // dirty the project. Previously, adding a track to an empty project (no clips
        // at insertIndex) would skip state.changed, causing auto-save to miss the change.
        state.changed = true;
        return true;
    }

    if (delta.kind === 'TrackRemoved') {
        const hintedIndex = delta.data.track_index;
        const hintedTrackId = getTrackIdByIndex(state, hintedIndex);
        const expectedIndex = hintedTrackId === delta.data.track_id
            ? hintedIndex
            : findTrackIndexById(state, delta.data.track_id);
        if (expectedIndex < 0) return true;
        const removeIndex = removeTrackById(state, delta.data.track_id);
        if (removeIndex < 0) return true;

        const nextAllIds: string[] = [];
        const nextById: Record<string, import('@/shared/lib/arrangementTypes').TimelineClip> = {};

        for (const id of state.clips.allIds) {
            const clip = state.clips.byId[id];
            if (!clip) continue;
            if (clip.trackIndex === removeIndex) continue;

            if (clip.trackIndex > removeIndex) {
                nextById[id] = { ...clip, trackIndex: clip.trackIndex - 1 };
            } else {
                nextById[id] = clip;
            }
            nextAllIds.push(id);
        }

        state.clips = { byId: nextById, allIds: nextAllIds };
        // ENTERPRISE FIX (Phase 32): Track removal is a structural mutation that
        // MUST unconditionally dirty the project — not gated behind changedClips.
        // Removing an empty track previously wouldn't trigger auto-save.
        state.changed = true;

        const trackIdToClean = delta.data.track_id;
        queueMicrotask(() => {
            try {
                useAutomationStore.getState().cleanupTrackLanes(trackIdToClean);
            } catch (cleanupErr) {
                console.warn('[TrackDelta] AutomationStore cleanup failed:', cleanupErr);
            }
        });

        return true;
    }

    if (delta.kind === 'TrackMoved') {
        const moveResult = moveTrackById(state, delta.data.track_id, delta.data.new_index);
        if (!moveResult) return true;
        const oldIndex = moveResult.oldIndex;
        const newIndex = moveResult.newIndex;
        if (oldIndex === newIndex) return true;


        for (const id of state.clips.allIds) {
            const clip = state.clips.byId[id];
            if (!clip) continue;

            if (clip.trackIndex === oldIndex) {
                state.clips.byId[id] = { ...clip, trackIndex: newIndex };
            } else if (oldIndex < newIndex && clip.trackIndex > oldIndex && clip.trackIndex <= newIndex) {
                state.clips.byId[id] = { ...clip, trackIndex: clip.trackIndex - 1 };
            } else if (oldIndex > newIndex && clip.trackIndex >= newIndex && clip.trackIndex < oldIndex) {
                state.clips.byId[id] = { ...clip, trackIndex: clip.trackIndex + 1 };
            }
        }

        // ENTERPRISE FIX (Phase 32): Track move is a structural mutation — MUST
        // unconditionally dirty the project, not gated behind changedClips.
        // Same pattern as TrackAdded (line 236) and TrackRemoved (line 270).
        state.changed = true;
        return true;
    }

    if (delta.kind === 'TrackParentChanged') {
        const track = state.tracks.byId[delta.data.track_id];
        if (!track) return true;
        patchTrack(state, delta.data.track_id, {
            parent_track_id: delta.data.parent_track_id,
            output: delta.data.parent_track_id ?? 'master',
        });
        rebuildChildTrackIds(state);
        return true;
    }

    return false;
}
