import type { ProjectDelta } from '@/shared/api/engine';
import type { FlatPluginSlot, ProjectTrack } from '@/shared/lib/trackAdapter';
import type { DeltaEnv, DeltaWorkingState } from './types';

function patchTrack(state: DeltaWorkingState, id: string, patch: Partial<ProjectTrack>): void {
    const track = state.tracksById[id];
    if (!track) return;
    const next = { ...track, ...patch };
    state.projectTracks = state.projectTracks.map((t) => (t.id === id ? next : t));
    state.tracksById = { ...state.tracksById, [id]: next };
    state.changed = true;
}

export function applyPluginDelta(state: DeltaWorkingState, delta: ProjectDelta, env: DeltaEnv): boolean {
    if (delta.kind === 'PluginBypassChanged') {
        const track = state.tracksById[delta.data.track_id];
        if (!track) return true;

        if (track.instrument?.id === delta.data.slot_id) {
            patchTrack(state, track.id, {
                instrument: { ...track.instrument, is_bypassed: delta.data.bypassed },
            });
            return true;
        }

        const effects = track.effects.map((fx) => (
            fx.id === delta.data.slot_id ? { ...fx, is_bypassed: delta.data.bypassed } : fx
        ));
        patchTrack(state, track.id, { effects });
        return true;
    }

    if (delta.kind === 'PluginSidechainChanged') {
        const track = state.tracksById[delta.data.track_id];
        if (!track) return true;
        if (track.instrument?.id === delta.data.slot_id) {
            patchTrack(state, track.id, {
                instrument: {
                    ...track.instrument,
                    sidechain_source_track_id: delta.data.source_track_id,
                },
            });
            return true;
        }
        const effects = track.effects.map((fx) => (
            fx.id === delta.data.slot_id
                ? { ...fx, sidechain_source_track_id: delta.data.source_track_id }
                : fx
        ));
        patchTrack(state, track.id, { effects });
        return true;
    }

    if (delta.kind === 'PluginMoved') {
        const track = state.tracksById[delta.data.track_id];
        if (!track) return true;

        const effects = track.effects.slice();
        if (effects.length === 0) return true;
        const hintedOld = delta.data.old_slot_index;
        const oldIndex = (hintedOld >= 0
            && hintedOld < effects.length
            && effects[hintedOld]?.id === delta.data.slot_id)
            ? hintedOld
            : effects.findIndex((fx) => fx.id === delta.data.slot_id);
        if (oldIndex < 0) return true;
        const newIndex = Math.max(0, Math.min(delta.data.new_slot_index, effects.length - 1));

        const [moved] = effects.splice(oldIndex, 1);
        effects.splice(newIndex, 0, moved);
        patchTrack(state, track.id, { effects });
        return true;
    }

    if (delta.kind === 'PluginRemoved') {
        const track = state.tracksById[delta.data.track_id];
        if (!track) return true;
        if (track.instrument?.id === delta.data.slot_id) {
            patchTrack(state, track.id, { instrument: null });
            return true;
        }
        patchTrack(state, track.id, { effects: track.effects.filter((fx) => fx.id !== delta.data.slot_id) });
        return true;
    }

    if (delta.kind === 'PluginAdded') {
        const track = state.tracksById[delta.data.track_id];
        if (!track) return true;

        if (track.instrument?.id === delta.data.slot_id || track.effects.some((fx) => fx.id === delta.data.slot_id)) {
            return true;
        }

        const added: FlatPluginSlot = {
            id: delta.data.slot_id,
            name: delta.data.plugin_name,
            plugin_id: delta.data.plugin_uid,
            is_bypassed: false,
        };
        if (delta.data.is_instrument) {
            patchTrack(state, track.id, { instrument: added });
            return true;
        }
        const effects = track.effects.slice();
        const insert = Math.max(0, Math.min(delta.data.slot_index, effects.length));
        effects.splice(insert, 0, added);
        patchTrack(state, track.id, { effects });
        return true;
    }

    return false;
}
