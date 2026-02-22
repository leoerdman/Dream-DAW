import type { ProjectDelta } from '@/shared/api/engine';
import type { ProjectTrack } from '@/shared/lib/trackAdapter';
import type { DeltaEnv, DeltaWorkingState } from './types';

const TRACK_PALETTE = [
    '#F05C4D', '#FF8A1A', '#FFBF33', '#FFE14D',
    '#A3D94D', '#4DC775', '#4DC7B0', '#4DC7CC',
    '#4DA6E3', '#4D7AE3', '#6B5CE3', '#9B59D9',
    '#D94DA6', '#E36B96', '#E66673', '#8C949E',
] as const;

function colorForTrackIndex(index: number): string {
    const safe = Number.isFinite(index) ? Math.max(0, Math.floor(index)) : 0;
    return TRACK_PALETTE[safe % TRACK_PALETTE.length] ?? '#667788';
}

function normalizeTrackType(trackType: string): string {
    const normalized = (trackType || 'audio').trim().toLowerCase();
    if (normalized === 'midi') return 'Midi';
    if (normalized === 'group') return 'Group';
    if (normalized === 'master') return 'Master';
    return 'Audio';
}

function fallback(state: DeltaWorkingState, env: DeltaEnv, suffix: string): void {
    state.fallbackReason = `${env.reason}-${suffix}`;
}

function patchTrack(state: DeltaWorkingState, id: string, patch: Partial<ProjectTrack>): void {
    const track = state.tracksById[id];
    if (!track) return;
    const next = { ...track, ...patch };
    state.projectTracks = state.projectTracks.map((t) => (t.id === id ? next : t));
    state.tracksById = { ...state.tracksById, [id]: next };
    state.changed = true;
}

export function applyTrackDelta(state: DeltaWorkingState, delta: ProjectDelta, env: DeltaEnv): boolean {
    if (delta.kind === 'TrackVolumeChanged') {
        patchTrack(state, delta.data.track_id, { volume: delta.data.volume });
        return true;
    }
    if (delta.kind === 'TrackPanChanged') {
        patchTrack(state, delta.data.track_id, { pan: delta.data.pan });
        return true;
    }
    if (delta.kind === 'TrackMuteChanged') {
        patchTrack(state, delta.data.track_id, { is_mute: delta.data.muted });
        return true;
    }
    if (delta.kind === 'TrackSoloChanged') {
        patchTrack(state, delta.data.track_id, { is_solo: delta.data.soloed });
        return true;
    }
    if (delta.kind === 'TrackRenamed') {
        patchTrack(state, delta.data.track_id, { name: delta.data.new_name });
        return true;
    }

    if (delta.kind === 'TrackAdded') {
        const insertIndex = Math.max(0, Math.min(delta.data.track_index, state.projectTracks.length));
        const nextTrack: ProjectTrack = {
            id: delta.data.track_id,
            name: delta.data.name,
            track_type: normalizeTrackType(delta.data.track_type),
            color: colorForTrackIndex(insertIndex),
            volume: 1,
            pan: 0,
            is_mute: false,
            is_solo: false,
            is_armed: false,
            height: 80,
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
        const tracks = state.projectTracks.slice();
        tracks.splice(insertIndex, 0, nextTrack);
        state.projectTracks = tracks;
        state.tracksById = { ...state.tracksById, [nextTrack.id]: nextTrack };

        state.timelineClips = state.timelineClips.map((clip) => (
            clip.trackIndex >= insertIndex ? { ...clip, trackIndex: clip.trackIndex + 1 } : clip
        ));
        const nextClips: typeof state.clipsById = {};
        for (const clip of state.timelineClips) nextClips[clip.id] = clip;
        state.clipsById = nextClips;
        state.changed = true;
        return true;
    }

    if (delta.kind === 'TrackRemoved') {
        const removeIndex = delta.data.track_index;
        if (removeIndex < 0 || removeIndex >= state.projectTracks.length) {
            fallback(state, env, 'remove-track-index-out-of-range');
            return true;
        }
        state.projectTracks = state.projectTracks.filter((_, i) => i !== removeIndex);
        const nextTracks = { ...state.tracksById };
        delete nextTracks[delta.data.track_id];
        state.tracksById = nextTracks;

        const nextTimeline = state.timelineClips
            .filter((clip) => clip.trackIndex !== removeIndex)
            .map((clip) => (clip.trackIndex > removeIndex ? { ...clip, trackIndex: clip.trackIndex - 1 } : clip));
        const nextClips: typeof state.clipsById = {};
        for (const clip of nextTimeline) nextClips[clip.id] = clip;
        state.timelineClips = nextTimeline;
        state.clipsById = nextClips;
        state.changed = true;
        return true;
    }

    if (delta.kind === 'TrackMoved') {
        const oldIndex = delta.data.old_index;
        const newIndex = delta.data.new_index;
        if (oldIndex < 0 || newIndex < 0 || oldIndex >= state.projectTracks.length || newIndex >= state.projectTracks.length) {
            fallback(state, env, 'move-track-index-out-of-range');
            return true;
        }
        if (oldIndex === newIndex) return true;

        const tracks = state.projectTracks.slice();
        const [moved] = tracks.splice(oldIndex, 1);
        tracks.splice(newIndex, 0, moved);
        state.projectTracks = tracks;

        state.timelineClips = state.timelineClips.map((clip) => {
            if (clip.trackIndex === oldIndex) return { ...clip, trackIndex: newIndex };
            if (oldIndex < newIndex && clip.trackIndex > oldIndex && clip.trackIndex <= newIndex) {
                return { ...clip, trackIndex: clip.trackIndex - 1 };
            }
            if (oldIndex > newIndex && clip.trackIndex >= newIndex && clip.trackIndex < oldIndex) {
                return { ...clip, trackIndex: clip.trackIndex + 1 };
            }
            return clip;
        });
        const nextClips: typeof state.clipsById = {};
        for (const clip of state.timelineClips) nextClips[clip.id] = clip;
        state.clipsById = nextClips;
        state.changed = true;
        return true;
    }

    return false;
}
