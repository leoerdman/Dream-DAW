import { useEngineStore } from '@/shared/stores/useEngineStore';
import { useAgentActionStore, getToolLabel } from '@/shared/stores/useAgentActionStore';
import { useGridStore } from '@/shared/stores/useGridStore';
import * as engineApi from '@/shared/api/engine';
import { resolveBpm, resolveSampleRate } from '@/shared/lib/audioMath';
import { decodeMetersBinaryPacket } from '@/shared/lib/binaryMeters';
import { AUTO_CLEANUP_TRACK_NAME_HINTS, ARRANGEMENT_TEMPLATES } from '@/shared/api/assistant/toolExecutor.constants.arrangement';
import { BEAT_PATTERNS, CHORD_INTERVALS, SCALE_INTERVALS } from '@/shared/api/assistant/toolExecutor.constants.music';
import { INSTRUMENT_PRESETS, resolveEffectEntry } from '@/shared/api/assistant/toolExecutor.constants.plugins';
import { buildSystemPromptTemplate } from '@/shared/api/assistant/toolExecutor.prompt';
import {
    type MidiNoteLike,
    getOptionalStringField,
} from '@/shared/api/assistant/types';
type GlobalWithPreviewTimer = typeof globalThis & {
    __dreamPreviewTimer?: ReturnType<typeof setTimeout> | null;
};

function getOrderedTracks(state: ReturnType<typeof useEngineStore.getState>) {
    return state.tracks.allIds
        .map((id) => state.tracks.byId[id])
        .filter((track): track is NonNullable<typeof track> => Boolean(track));
}

function resolveTrackIndex(track: string): number {
    const idx = parseInt(track, 10);
    if (!isNaN(idx)) return idx;
    const tracks = getOrderedTracks(useEngineStore.getState());
    const found = tracks.findIndex(
        (t) => t.name.toLowerCase() === track.toLowerCase(),
    );
    return found >= 0 ? found : -1;
}
export async function executeTool(
    name: string,
    args: Record<string, unknown>,
    onSelectClips?: (ids: string[]) => void,
): Promise<string> {
    useAgentActionStore.getState().showAction(getToolLabel(name));
    let result: string;
    try {
        result = await executeToolInner(name, args, onSelectClips);
    } catch (err: unknown) {
        const errorMsg = err instanceof Error ? err.message : String(err);
        console.warn(`[Assistant Tool Error] ${name}:`, errorMsg);
        return JSON.stringify({
            error: true,
            message: `Tool ${name} failed to execute: ${errorMsg}. Please revise your tool arguments or try an alternative approach.`
        });
    }
    return result;
}
async function executeToolInner(
    name: string,
    args: Record<string, unknown>,
    onSelectClips?: (ids: string[]) => void,
): Promise<string> {
    const state = useEngineStore.getState();
    const tracks = getOrderedTracks(state);
    const clips = state.timelineClips;
    switch (name) {
        case 'get_project_overview': {
            let projectName = 'Untitled';
            try {
                const status = await engineApi.getProjectStatus();
                if (status.filePath) {
                    const parts = status.filePath.replace(/\\/g, '/').split('/');
                    projectName = parts[parts.length - 1]?.replace(/\.dream$/, '') || 'Untitled';
                }
            } catch { /* fallback */ }
            return JSON.stringify({
                projectName,
                bpm: resolveBpm(state.projectBpm, state.transport.bpm),
                sampleRate: resolveSampleRate(state.projectSampleRate),
                isPlaying: state.transport.is_playing,
                positionBeats: state.transport.position_beats ?? 0,
                trackCount: tracks.length,
                totalClips: clips.length,
                tracks: tracks.map((t, i) => ({
                    index: i,
                    id: t.id,
                    name: t.name,
                    type: t.track_type,
                    volume: t.volume,
                    pan: t.pan,
                    disabled: t.is_disabled,
                    soloed: t.is_solo,
                    armed: t.is_armed,
                    color: t.color,
                    instrument: t.instrument?.name ?? null,
                    effects: (t.effects ?? []).map(e => e.name),
                    clipCount: clips.filter((c) => c.trackIndex === i).length,
                })),
            });
        }
        case 'get_track_clips': {
            const idx = resolveTrackIndex(args.track as string);
            const trackClips = clips.filter((c) => c.trackIndex === idx);
            return JSON.stringify(trackClips.map((c) => ({
                id: c.id,
                name: c.name,
                startBeat: c.startBeat,
                durationBeats: c.durationBeats,
                type: c.type,
                muted: c.muted,
            })));
        }
        case 'get_clip_details': {
            const clip = clips.find((c) => c.id === args.clipId);
            return clip ? JSON.stringify(clip) : JSON.stringify({ error: 'Clip not found' });
        }
        case 'get_transport_state': {
            const t = state.transport;
            return JSON.stringify({
                isPlaying: t.is_playing,
                positionFrames: t.position_frames,
                bpm: resolveBpm(state.projectBpm, t.bpm),
                loopEnabled: t.loop_enabled,
                loopStartFrames: t.loop_start,
                loopEndFrames: t.loop_end,
            });
        }
        case 'select_clips': {
            const ids = args.clipIds as string[];
            onSelectClips?.(ids);
            return JSON.stringify({ selected: ids.length });
        }
        case 'select_all_clips_on_track': {
            const idx = resolveTrackIndex(args.track as string);
            const ids = clips.filter((c) => c.trackIndex === idx).map((c) => c.id);
            onSelectClips?.(ids);
            return JSON.stringify({ selected: ids.length, trackIndex: idx });
        }
        case 'transport_play':
            await engineApi.play();
            return JSON.stringify({ status: 'playing' });
        case 'transport_stop':
            await engineApi.stop();
            return JSON.stringify({ status: 'stopped' });
        case 'set_bpm':
            {
                const bpm = args.bpm as number;
                const response = await engineApi.setBpmWithDeltas(bpm);
                await useEngineStore.getState().applyProjectDeltas(response.deltas, 'agent-set-bpm');
                return JSON.stringify({ bpm: args.bpm });
            }
        case 'seek_to_beat':
            await engineApi.seekToBeat(args.beat as number);
            return JSON.stringify({ seekedTo: args.beat });
        case 'set_track_volume': {
            const vol = Math.max(0, Math.min(1, args.volume as number));
            const response = await engineApi.setTrackVolumeWithDeltas(args.trackIndex as number, vol);
            await useEngineStore.getState().applyProjectDeltas(response.deltas, 'agent-set-track-volume');
            return JSON.stringify({ trackIndex: args.trackIndex, volume: vol });
        }
        case 'set_track_pan': {
            const pan = Math.max(-1, Math.min(1, args.pan as number));
            const response = await engineApi.setTrackPanWithDeltas(args.trackIndex as number, pan);
            await useEngineStore.getState().applyProjectDeltas(response.deltas, 'agent-set-track-pan');
            return JSON.stringify({ trackIndex: args.trackIndex, pan: pan });
        }
        case 'set_track_disabled': {
            const response = await engineApi.setTrackDisabledWithDeltas(args.trackIndex as number, args.disabled as boolean);
            await useEngineStore.getState().applyProjectDeltas(response.deltas, 'agent-set-track-disabled');
            return JSON.stringify({ trackIndex: args.trackIndex, disabled: args.disabled });
        }
        case 'set_track_solo': {
            const response = await engineApi.setTrackSoloWithDeltas(args.trackIndex as number, args.soloed as boolean);
            await useEngineStore.getState().applyProjectDeltas(response.deltas, 'agent-set-track-solo');
            return JSON.stringify({ trackIndex: args.trackIndex, soloed: args.soloed });
        }
        case 'add_track': {
            const response = await engineApi.addTrackWithDeltas(args.name as string | undefined);
            await useEngineStore.getState().applyProjectDeltas(response.deltas, 'agent-add-track');
            const result = { deltas: response.deltas.length };
            return JSON.stringify({ added: true, result });
        }
        case 'rename_track': {
            const response = await engineApi.renameTrackWithDeltas(args.trackIndex as number, args.name as string);
            await useEngineStore.getState().applyProjectDeltas(response.deltas, 'agent-rename-track');
            return JSON.stringify({ trackIndex: args.trackIndex, name: args.name });
        }
        case 'delete_track': {
            const response = await engineApi.deleteTrackWithDeltas(args.trackIndex as number);
            await useEngineStore.getState().applyProjectDeltas(response.deltas, 'agent-delete-track');
            return JSON.stringify({ deleted: args.trackIndex });
        }
        case 'delete_tracks_batch': {
            const indices = args.trackIndices as number[];
            if (!Array.isArray(indices) || indices.length === 0) return JSON.stringify({ error: 'trackIndices array is required' });
            const normalized = Array.from(
                new Set(
                    indices
                        .map((idx) => Number(idx))
                        .filter((idx) => Number.isInteger(idx) && idx >= 0),
                ),
            ).sort((a, b) => b - a);
            let deleted = 0;
            for (const idx of normalized) {
                try {
                    const response = await engineApi.deleteTrackWithDeltas(idx);
                    await useEngineStore.getState().applyProjectDeltas(response.deltas, 'agent-delete-tracks-batch');
                    deleted += 1;
                } catch (err) {
                    console.warn('[toolExecutor] delete_tracks_batch: skip index', idx, err);
                }
            }
            return JSON.stringify({ success: true, requested: normalized.length, deleted });
        }
        case 'delete_clip': {
            const response = await engineApi.deleteClipWithDeltas(args.clipId as string);
            await useEngineStore.getState().applyProjectDeltas(response.deltas, 'agent-delete-clip');
            return JSON.stringify({ deleted: args.clipId });
        }
        case 'add_audio_clips_batch': {
            const clipDefs = args.clips as { trackIndex: number; samplePath: string; startBeat: number }[];
            if (!Array.isArray(clipDefs) || clipDefs.length === 0) return JSON.stringify({ error: 'clips array is required' });
            const stBatch = useEngineStore.getState();
            const bpmBatch = resolveBpm(stBatch.projectBpm, stBatch.transport.bpm);
            const srBatch = resolveSampleRate(stBatch.projectSampleRate);
            const fpbBatch = (60.0 / bpmBatch) * srBatch;
            let batchOverlapsRemoved = 0;
            for (const def of clipDefs) {
                const existing = clips.filter(c =>
                    c.trackIndex === def.trackIndex &&
                    c.startBeat <= def.startBeat &&
                    (c.startBeat + c.durationBeats) > def.startBeat
                );
                for (const oc of existing) {
                    try {
                        const response = await engineApi.deleteClipWithDeltas(oc.id);
                        await useEngineStore.getState().applyProjectDeltas(response.deltas, 'agent-batch-overlap-delete');
                        batchOverlapsRemoved++;
                    } catch { /* skip */ }
                }
            }
            const results: { clipId: string; clipName: string; startBeat: number }[] = [];
            for (const def of clipDefs) {
                const startFrames = Math.round(def.startBeat * fpbBatch);
                const r = await engineApi.importAudioFileWithDeltas(def.samplePath, def.trackIndex, startFrames);
                await useEngineStore.getState().applyProjectDeltas(r.deltas, 'agent-batch-import-audio');
                results.push({ clipId: r.clip_id, clipName: r.clip_name, startBeat: def.startBeat });
            }
            return JSON.stringify({ success: true, clipsCreated: results.length, clips: results, overlapsRemoved: batchOverlapsRemoved });
        }
        case 'delete_clips_batch': {
            const idsToDelete = args.clipIds as string[];
            if (!Array.isArray(idsToDelete) || idsToDelete.length === 0) return JSON.stringify({ error: 'clipIds array is required' });
            let deleted = 0;
            for (const id of idsToDelete) {
                try {
                    const response = await engineApi.deleteClipWithDeltas(id);
                    await useEngineStore.getState().applyProjectDeltas(response.deltas, 'agent-delete-clips-batch');
                    deleted++;
                } catch { /* skip missing */ }
            }
            return JSON.stringify({ success: true, deleted, total: idsToDelete.length });
        }
        case 'delete_all_clips_on_track': {
            const trackStr = args.track as string;
            const tIdx = resolveTrackIndex(trackStr);
            const toDelete = clips.filter(c => c.trackIndex === tIdx);
            for (const c of toDelete) {
                try {
                    const response = await engineApi.deleteClipWithDeltas(c.id);
                    await useEngineStore.getState().applyProjectDeltas(response.deltas, 'agent-delete-all-track');
                } catch { /* skip */ }
            }
            return JSON.stringify({ success: true, deleted: toDelete.length, trackIndex: tIdx });
        }
        case 'set_clip_muted': {
            const response = await engineApi.setClipMutedWithDeltas(args.clipId as string, args.muted as boolean);
            await useEngineStore.getState().applyProjectDeltas(response.deltas, 'agent-set-clip-muted');
            return JSON.stringify({ clipId: args.clipId, muted: args.muted });
        }
        case 'undo':
            {
                const response = await engineApi.undoWithDeltas();
                await useEngineStore.getState().applyProjectDeltas(response.deltas, 'agent-undo');
                return JSON.stringify({ undone: true });
            }
        case 'redo':
            {
                const response = await engineApi.redoWithDeltas();
                await useEngineStore.getState().applyProjectDeltas(response.deltas, 'agent-redo');
                return JSON.stringify({ redone: true });
            }
        case 'set_master_volume':
            await engineApi.setMasterVolume(args.volume as number);
            return JSON.stringify({ masterVolume: args.volume });
        case 'add_midi_track': {
            const trackName = (args.name as string) || undefined;
            const addTrackResponse = await engineApi.addTrackWithDeltasAdvanced('midi', null, trackName);
            await useEngineStore.getState().applyProjectDeltas(addTrackResponse.deltas, 'agent-add-midi-track');
            const addedTrackId = addTrackResponse.deltas.find((delta) => delta.kind === 'TrackAdded')?.data.track_id;
            const updatedState = useEngineStore.getState();
            const updatedTracks = getOrderedTracks(updatedState);
            const newIdx = addedTrackId
                ? updatedTracks.findIndex((track) => track.id === addedTrackId)
                : updatedTracks.length - 1;
            const newTrackId = newIdx >= 0 ? updatedTracks[newIdx]?.id : undefined;
            const instrumentArg = (args.instrument as string | undefined)?.toLowerCase();
            let instrumentAssigned: string | null = null;
            if (instrumentArg && newTrackId) {
                const entry = INSTRUMENT_PRESETS[instrumentArg];
                if (entry) {
                    const response = await engineApi.addPluginToTrackWithDeltas(
                        newTrackId,
                        entry.pluginId,
                        entry.displayName,
                        'instrument',
                    );
                    await useEngineStore.getState().applyProjectDeltas(response.deltas, 'agent-create-instrument-track');
                    instrumentAssigned = entry.displayName;
                }
            }
            return JSON.stringify({ added: true, trackIndex: newIdx, name: trackName || `Track ${newIdx + 1}`, instrument: instrumentAssigned });
        }
        case 'set_track_instrument': {
            const siTrackIdx = args.trackIndex as number;
            const siTrackId = tracks[siTrackIdx]?.id;
            if (!siTrackId) return JSON.stringify({ error: `Track ${siTrackIdx} not found` });
            const siInstrument = ((args.instrument as string) || 'essence').toLowerCase();
            const siEntry = INSTRUMENT_PRESETS[siInstrument];
            if (!siEntry) return JSON.stringify({ error: `Unknown instrument: ${siInstrument}. Use "essence" or "sampler".` });
            {
                const response = await engineApi.addPluginToTrackWithDeltas(
                    siTrackId,
                    siEntry.pluginId,
                    siEntry.displayName,
                    'instrument',
                );
                await useEngineStore.getState().applyProjectDeltas(response.deltas, 'agent-set-instrument');
            }
            return JSON.stringify({ success: true, trackIndex: siTrackIdx, instrument: siEntry.displayName });
        }
        case 'set_synth_param': {
            const spTrackIdx = args.trackIndex as number;
            const spTrackId = tracks[spTrackIdx]?.id;
            if (!spTrackId) return JSON.stringify({ error: `Track ${spTrackIdx} not found` });
            const spParamId = args.paramId as string;
            const spValue = args.value as number;
            const spTrack = tracks[spTrackIdx];
            const instrumentSlotId = spTrack.instrument?.id;
            if (!instrumentSlotId) return JSON.stringify({ error: `Track ${spTrackIdx} has no instrument assigned. Use set_track_instrument first.` });
            const response = await engineApi.setInternalPluginParamWithDeltas(
                spTrackId,
                instrumentSlotId,
                spParamId,
                spValue,
            );
            await useEngineStore.getState().applyProjectDeltas(response.deltas, 'agent-set-synth-param');
            return JSON.stringify({ success: true, trackIndex: spTrackIdx, paramId: spParamId, value: spValue });
        }
        case 'create_midi_clip': {
            const tIdx = args.trackIndex as number;
            const startBeat = args.startBeat as number;
            const durBeats = args.durationBeats as number;
            const clipName = (args.name as string) || undefined;
            const endBeat = startBeat + durBeats;
            const overlapping = clips.filter(c =>
                c.trackIndex === tIdx &&
                c.startBeat < endBeat &&
                (c.startBeat + c.durationBeats) > startBeat
            );
            for (const oc of overlapping) {
                try {
                    const response = await engineApi.deleteClipWithDeltas(oc.id);
                    await useEngineStore.getState().applyProjectDeltas(response.deltas, 'agent-create-midi-overlap-delete');
                } catch { /* skip missing */ }
            }
            const st = useEngineStore.getState();
            const bpmVal = resolveBpm(st.projectBpm, st.transport.bpm);
            const srVal = resolveSampleRate(st.projectSampleRate);
            const framesPerBeat = (60.0 / bpmVal) * srVal;
            const posFrames = Math.round(startBeat * framesPerBeat);
            const durFrames = Math.round(durBeats * framesPerBeat);
            const result = await engineApi.createMidiClipWithDeltas(tIdx, posFrames, durFrames, clipName);
            await useEngineStore.getState().applyProjectDeltas(result.deltas, 'agent-create-midi-clip');
            return JSON.stringify({
                clipId: result.clip_id,
                clipName: result.clip_name,
                startBeat,
                durationBeats: durBeats,
                overlapsRemoved: overlapping.length,
            });
        }
        case 'set_clip_notes': {
            const clipId = args.clipId as string;
            const noteArgs = args.notes as Array<{ pitch: number; velocity: number; startBeat: number; durationBeats: number }>;
            const st2 = useEngineStore.getState();
            const bpm2 = resolveBpm(st2.projectBpm, st2.transport.bpm);
            const sr2 = resolveSampleRate(st2.projectSampleRate);
            const fpb2 = (60.0 / bpm2) * sr2;
            const engineNotes = noteArgs.map(n => ({
                pitch: n.pitch,
                velocity: n.velocity,
                startFrames: Math.round(n.startBeat * fpb2),
                durationFrames: Math.round(n.durationBeats * fpb2),
            }));
            const response = await engineApi.updateMidiClipWithDeltas(clipId, engineNotes);
            await useEngineStore.getState().applyProjectDeltas(response.deltas, 'agent-set-clip-notes');
            return JSON.stringify({ clipId, notesWritten: engineNotes.length });
        }
        case 'search_browser': {
            const query = (args.query as string).toLowerCase();
            const files = await engineApi.scanAllAudioSources();
            const matches = files.filter(f => f.name.toLowerCase().includes(query));
            const limited = matches.slice(0, 10).map(f => ({
                name: f.name,
                path: f.path,
                durationSeconds: f.duration_seconds
            }));
            return JSON.stringify({ matchesFound: matches.length, results: limited });
        }
        case 'add_sample_to_rack': {
            const trackIndex = args.trackIndex as number;
            const padIndex = args.padIndex as number;
            const samplePath = args.samplePath as string;
            const trackId = tracks[trackIndex]?.id;
            if (!trackId) return JSON.stringify({ error: `Track ${trackIndex} not found` });
            if (tracks[trackIndex].track_type.toLowerCase() !== 'midi') {
                return JSON.stringify({ error: `Track ${trackIndex} is not a MIDI track (type: ${tracks[trackIndex].track_type})` });
            }
            const response = await engineApi.setSampleRackPadSampleWithDeltas(trackId, padIndex, samplePath);
            await useEngineStore.getState().applyProjectDeltas(response.deltas, 'agent-add-sample-to-rack');
            return JSON.stringify({ success: true, trackIndex, padIndex, sampleLoaded: samplePath });
        }
        case 'add_audio_clip': {
            const trackIndex = args.trackIndex as number;
            const samplePath = args.samplePath as string;
            const startBeat = args.startBeat as number;
            const overlapping = clips.filter(c =>
                c.trackIndex === trackIndex &&
                c.startBeat <= startBeat &&
                (c.startBeat + c.durationBeats) > startBeat
            );
            for (const oc of overlapping) {
                try {
                    const response = await engineApi.deleteClipWithDeltas(oc.id);
                    await useEngineStore.getState().applyProjectDeltas(response.deltas, 'agent-add-audio-overlap-delete');
                } catch { /* skip missing */ }
            }
            const st3 = useEngineStore.getState();
            const bpm3 = resolveBpm(st3.projectBpm, st3.transport.bpm);
            const sr3 = resolveSampleRate(st3.projectSampleRate);
            const fpb3 = (60.0 / bpm3) * sr3;
            const startFrames = Math.round(startBeat * fpb3);
            const result = await engineApi.importAudioFileWithDeltas(samplePath, trackIndex, startFrames);
            await useEngineStore.getState().applyProjectDeltas(result.deltas, 'agent-add-audio-clip');
            return JSON.stringify({ success: true, clipId: result.clip_id, clipName: result.clip_name, startBeat, overlapsRemoved: overlapping.length });
        }
        case 'move_clip': {
            const clipId = args.clipId as string;
            const newTrackIndex = args.newTrackIndex as number;
            const newPositionBeats = args.newPositionBeats as number;
            const stMove = useEngineStore.getState();
            const fpbMove = (60.0 / resolveBpm(stMove.projectBpm, stMove.transport.bpm)) * (resolveSampleRate(stMove.projectSampleRate));
            const posFrames = Math.round(newPositionBeats * fpbMove);
            const response = await engineApi.moveClipWithDeltas(clipId, newTrackIndex, posFrames);
            await useEngineStore.getState().applyProjectDeltas(response.deltas, 'agent-move-clip');
            return JSON.stringify({ success: true, clipId, newTrackIndex, newPositionBeats });
        }
        case 'duplicate_clip': {
            const clipId = args.clipId as string;
            let posFrames: number | undefined;
            if (args.newPositionBeats !== undefined) {
                const stDup = useEngineStore.getState();
                const fpbDup = (60.0 / resolveBpm(stDup.projectBpm, stDup.transport.bpm)) * (resolveSampleRate(stDup.projectSampleRate));
                posFrames = Math.round((args.newPositionBeats as number) * fpbDup);
            }
            const result = await engineApi.duplicateClipWithDeltas(clipId, posFrames);
            await useEngineStore.getState().applyProjectDeltas(result.deltas, 'agent-duplicate-clip');
            return JSON.stringify({ success: true, duplicatedClipId: result.new_id });
        }
        case 'split_clip': {
            const clipId = args.clipId as string;
            const splitBeat = args.splitBeat as number;
            const stSplit = useEngineStore.getState();
            const fpbSplit = (60.0 / resolveBpm(stSplit.projectBpm, stSplit.transport.bpm)) * (resolveSampleRate(stSplit.projectSampleRate));
            const splitFrames = Math.round(splitBeat * fpbSplit);
            const result = await engineApi.splitClipWithDeltas(clipId, splitFrames);
            await useEngineStore.getState().applyProjectDeltas(result.deltas, 'agent-split-clip');
            return JSON.stringify({ success: true, originalClipId: clipId, leftId: result.left_id, rightId: result.right_id });
        }
        case 'set_clip_fade': {
            const clipId = args.clipId as string;
            const fIn = args.fadeInBeats as number;
            const fOut = args.fadeOutBeats as number;
            const stFade = useEngineStore.getState();
            const fpbFade = (60.0 / resolveBpm(stFade.projectBpm, stFade.transport.bpm)) * (resolveSampleRate(stFade.projectSampleRate));
            const response = await engineApi.setClipFadesWithDeltas(
                clipId,
                Math.round(fIn * fpbFade),
                Math.round(fOut * fpbFade),
            );
            await useEngineStore.getState().applyProjectDeltas(response.deltas, 'agent-set-clip-fade');
            return JSON.stringify({ success: true, clipId });
        }
        case 'merge_clips': {
            const clipIds = args.clipIds as string[];
            const result = await engineApi.mergeClipsWithDeltas(clipIds);
            await useEngineStore.getState().applyProjectDeltas(result.deltas, 'agent-merge-clips');
            return JSON.stringify({ success: true, newClipId: result.new_id });
        }
        case 'add_device': {
            const trackIndex = args.trackIndex as number;
            const trackId = tracks[trackIndex]?.id;
            if (!trackId) return JSON.stringify({ error: `Track ${trackIndex} not found` });
            const effectArg = args.effectType as number | string;
            const effect = resolveEffectEntry(effectArg);
            if (!effect) return JSON.stringify({ error: `Unknown effectType: ${String(effectArg)}` });
            const response = await engineApi.addPluginToTrackWithDeltas(
                trackId,
                effect.pluginId,
                effect.displayName,
                'effect',
            );
            await useEngineStore.getState().applyProjectDeltas(response.deltas, 'agent-add-effect');
            return JSON.stringify({ success: true, trackIndex, effectType: effectArg, effect: effect.displayName });
        }
        case 'remove_device': {
            const trackIndex = args.trackIndex as number;
            const slotId = args.slotId as string;
            const trackId = tracks[trackIndex]?.id;
            if (!trackId) return JSON.stringify({ error: `Track not found` });
            const response = await engineApi.removePluginFromTrackWithDeltas(trackId, slotId);
            await useEngineStore.getState().applyProjectDeltas(response.deltas, 'agent-remove-effect');
            return JSON.stringify({ success: true, trackIndex, slotRemoved: slotId });
        }
        case 'set_effect_parameter': {
            const trackIndex = args.trackIndex as number;
            const slotId = args.slotId as string;
            const paramId = args.paramId as string;
            const val = args.value as number;
            const trackId = tracks[trackIndex]?.id;
            if (!trackId) return JSON.stringify({ error: `Track not found` });
            const response = await engineApi.setInternalPluginParamWithDeltas(trackId, slotId, paramId, val);
            await useEngineStore.getState().applyProjectDeltas(response.deltas, 'agent-set-effect-parameter');
            return JSON.stringify({ success: true, paramChanged: paramId, value: val });
        }
        case 'create_track_group': {
            const tIndices = args.trackIndices as number[];
            const name = args.groupName as string;
            const tIds = tIndices.map(i => tracks[i]?.id).filter(id => id) as string[];
            const response = await engineApi.createGroupWithDeltas(tIds, name);
            await useEngineStore.getState().applyProjectDeltas(response.deltas, 'agent-create-track-group');
            return JSON.stringify({ success: true, groupId: response.group_id, groupName: name, tracksGrouped: tIds.length });
        }
        case 'set_loop_region': {
            const enabled = args.enabled as boolean;
            const stL = useEngineStore.getState();
            const fpbL = (60.0 / resolveBpm(stL.projectBpm, stL.transport.bpm)) * (resolveSampleRate(stL.projectSampleRate));
            const startF = Math.round((args.startBeat as number) * fpbL);
            const endF = Math.round((args.endBeat as number) * fpbL);
            const response = await engineApi.setLoopWithDeltas(enabled, startF, endF);
            await useEngineStore.getState().applyProjectDeltas(response.deltas, 'agent-set-loop-region');
            return JSON.stringify({ success: true, loopEnabled: enabled, startBeat: args.startBeat, endBeat: args.endBeat });
        }
        case 'quantize_notes': {
            const clipId = args.clipId as string;
            const grid = args.gridBeats as number;
            const strength = (args.strength as number ?? 100) / 100;
            const clip = clips.find(c => c.id === clipId);
            if (!clip) return JSON.stringify({ error: 'Clip not found' });
            const stQ = useEngineStore.getState();
            const bpmQ = resolveBpm(stQ.projectBpm, stQ.transport.bpm);
            const srQ = resolveSampleRate(stQ.projectSampleRate);
            const fpbQ = (60.0 / bpmQ) * srQ;
            const gridFrames = Math.round(grid * fpbQ);
            if (clip.midiNotes && clip.midiNotes.length > 0) {
                const quantized = clip.midiNotes.map(n => {
                    const startFrames = Math.round(n.startBeat * fpbQ);
                    const nearestGrid = Math.round(startFrames / gridFrames) * gridFrames;
                    const newStartFrames = Math.round(startFrames + (nearestGrid - startFrames) * strength);
                    return { pitch: n.pitch, velocity: n.velocity, startFrames: Math.max(0, newStartFrames), durationFrames: Math.round(n.durationBeats * fpbQ) };
                });
                const response = await engineApi.updateMidiClipWithDeltas(clipId, quantized);
                await useEngineStore.getState().applyProjectDeltas(response.deltas, 'agent-quantize-notes');
                return JSON.stringify({ success: true, notesQuantized: quantized.length, gridBeats: grid });
            }
            return JSON.stringify({ error: 'No MIDI notes found in clip' });
        }
        case 'humanize_velocity': {
            const clipId = args.clipId as string;
            const range = args.range as number;
            const clip = clips.find(c => c.id === clipId);
            if (!clip || !clip.midiNotes) return JSON.stringify({ error: 'Clip or notes not found' });
            const stH = useEngineStore.getState();
            const fpbH = (60.0 / resolveBpm(stH.projectBpm, stH.transport.bpm)) * (resolveSampleRate(stH.projectSampleRate));
            const humanized = clip.midiNotes.map(n => {
                const delta = Math.round((Math.random() * 2 - 1) * range);
                return { pitch: n.pitch, velocity: Math.max(1, Math.min(127, n.velocity + delta)), startFrames: Math.round(n.startBeat * fpbH), durationFrames: Math.round(n.durationBeats * fpbH) };
            });
            const response = await engineApi.updateMidiClipWithDeltas(clipId, humanized);
            await useEngineStore.getState().applyProjectDeltas(response.deltas, 'agent-humanize-velocity');
            return JSON.stringify({ success: true, notesHumanized: humanized.length });
        }
        case 'generate_chord': {
            const root = args.root as number;
            const quality = (args.quality as string).toLowerCase();
            const spread = (args.octaveSpread as number) || 1;
            const intervals = CHORD_INTERVALS[quality] || CHORD_INTERVALS.major;
            let pitches: number[] = [];
            for (let oct = 0; oct < spread; oct++) {
                pitches = pitches.concat(intervals.map(i => root + i + oct * 12));
            }
            pitches = pitches.filter(p => p >= 0 && p <= 127);
            return JSON.stringify({ root, quality, pitches });
        }
        case 'generate_arpeggio': {
            const clipId = args.clipId as string;
            const pitches = args.pitches as number[];
            const direction = (args.direction as string) || 'up';
            const rate = args.rateBeats as number;
            const dur = args.durationBeats as number;
            const vel = (args.velocity as number) || 100;
            const gate = ((args.gatePercent as number) || 80) / 100;
            let sequence: number[] = [];
            if (direction === 'up') sequence = [...pitches];
            else if (direction === 'down') sequence = [...pitches].reverse();
            else if (direction === 'updown') sequence = [...pitches, ...[...pitches].reverse().slice(1, -1)];
            else { // random
                sequence = [...pitches];
                for (let i = sequence.length - 1; i > 0; i--) {
                    const j = Math.floor(Math.random() * (i + 1));
                    [sequence[i], sequence[j]] = [sequence[j], sequence[i]];
                }
            }
            const totalSteps = Math.floor(dur / rate);
            const stArp = useEngineStore.getState();
            const fpbArp = (60.0 / resolveBpm(stArp.projectBpm, stArp.transport.bpm)) * (resolveSampleRate(stArp.projectSampleRate));
            const notes = [];
            for (let step = 0; step < totalSteps; step++) {
                const pitch = sequence[step % sequence.length];
                notes.push({ pitch, velocity: vel, startFrames: Math.round(step * rate * fpbArp), durationFrames: Math.round(rate * gate * fpbArp) });
            }
            const response = await engineApi.updateMidiClipWithDeltas(clipId, notes);
            await useEngineStore.getState().applyProjectDeltas(response.deltas, 'agent-generate-arpeggio');
            return JSON.stringify({ success: true, notesGenerated: notes.length, direction, rateBeats: rate });
        }
        case 'generate_scale': {
            const root = args.root as number;
            const scaleType = (args.scaleType as string).toLowerCase();
            const lo = (args.lowNote as number) || 24;
            const hi = (args.highNote as number) || 108;
            const intervals = SCALE_INTERVALS[scaleType];
            if (!intervals) {
                return JSON.stringify({
                    error: `Unknown scale type: "${scaleType}". Valid types: ${Object.keys(SCALE_INTERVALS).join(', ')}`,
                });
            }
            const pitches: number[] = [];
            for (let n = lo; n <= hi; n++) {
                if (intervals.includes((n - (root % 12) + 12) % 12)) pitches.push(n);
            }
            return JSON.stringify({ root, scaleType, pitches, count: pitches.length });
        }
        case 'set_pad_volume': {
            const trackId = tracks[args.trackIndex as number]?.id;
            if (!trackId) return JSON.stringify({ error: 'Track not found' });
            const response = await engineApi.setSampleRackPadVolumeWithDeltasCmd(
                trackId,
                args.padIndex as number,
                args.volume as number,
            );
            await useEngineStore.getState().applyProjectDeltas(response.deltas, 'agent-set-pad-volume');
            return JSON.stringify({ success: true });
        }
        case 'set_pad_mute': {
            const trackId = tracks[args.trackIndex as number]?.id;
            if (!trackId) return JSON.stringify({ error: 'Track not found' });
            const response = await engineApi.setSampleRackPadMuteWithDeltasCmd(
                trackId,
                args.padIndex as number,
                args.muted as boolean,
            );
            await useEngineStore.getState().applyProjectDeltas(response.deltas, 'agent-set-pad-mute');
            return JSON.stringify({ success: true });
        }
        case 'set_pad_adsr': {
            const trackId = tracks[args.trackIndex as number]?.id;
            if (!trackId) return JSON.stringify({ error: 'Track not found' });
            const response = await engineApi.setSampleRackPadAdsrWithDeltasCmd(
                trackId, args.padIndex as number,
                args.attack as number, args.decay as number,
                args.sustain as number, args.release as number
            );
            await useEngineStore.getState().applyProjectDeltas(response.deltas, 'agent-set-pad-adsr');
            return JSON.stringify({ success: true });
        }
        case 'set_pad_filter_cutoff': {
            const trackId = tracks[args.trackIndex as number]?.id;
            if (!trackId) return JSON.stringify({ error: 'Track not found' });
            const response = await engineApi.setSampleRackPadFilterCutoffWithDeltasCmd(
                trackId,
                args.padIndex as number,
                args.cutoff as number,
            );
            await useEngineStore.getState().applyProjectDeltas(response.deltas, 'agent-set-pad-filter-cutoff');
            return JSON.stringify({ success: true });
        }
        case 'set_track_color': {
            const trackId = tracks[args.trackIndex as number]?.id;
            if (!trackId) return JSON.stringify({ error: 'Track not found' });
            const response = await engineApi.setTrackColorWithDeltas(trackId, args.colorHex as string);
            await useEngineStore.getState().applyProjectDeltas(response.deltas, 'agent-set-track-color');
            return JSON.stringify({ success: true, color: args.colorHex });
        }
        case 'bypass_effect': {
            const trackIndex = args.trackIndex as number;
            const slotIndex = args.slotIndex as number;
            const bypassed = args.bypassed as boolean;
            const track = tracks[trackIndex];
            if (!track) return JSON.stringify({ error: `Track ${trackIndex} not found` });
            const slot = track.effects?.[slotIndex];
            if (!slot) return JSON.stringify({ error: `Effect slot ${slotIndex} not found on track ${trackIndex}` });
            const response = await engineApi.setSlotBypassWithDeltas(track.id, slot.id, bypassed);
            await useEngineStore.getState().applyProjectDeltas(response.deltas, 'agent-bypass-effect');
            return JSON.stringify({ success: true, trackIndex, slotIndex, bypassed });
        }
        case 'preview_note': {
            const pitch = args.pitch as number;
            const vel = (args.velocity as number) || 100;
            const tIdx = args.trackIndex as number;
            await engineApi.previewSamplerNoteOn(tIdx, pitch, vel);
            const globals = globalThis as GlobalWithPreviewTimer;
            if (globals.__dreamPreviewTimer) clearTimeout(globals.__dreamPreviewTimer);
            globals.__dreamPreviewTimer = setTimeout(() => {
                engineApi.previewSamplerNoteOff(tIdx, pitch).catch(() => { });
                globals.__dreamPreviewTimer = null;
            }, 500);
            return JSON.stringify({ success: true, pitch, velocity: vel });
        }
        case 'auto_gain_stage': {
            const target = (args.targetVolume as number) ?? 0.7;
            for (let i = 0; i < tracks.length; i++) {
                const response = await engineApi.setTrackVolumeWithDeltas(i, target);
                await useEngineStore.getState().applyProjectDeltas(response.deltas, 'agent-auto-gain-stage');
            }
            return JSON.stringify({ success: true, tracksNormalized: tracks.length, targetVolume: target });
        }
        case 'auto_cleanup_mix': {
            const excludes = new Set((args.excludeTrackIndices as number[]) ?? []);
            let cleaned = 0;
            const autoFilterPlugin = {
                pluginId: 'internal://effect/auto-filter',
                displayName: 'Auto Filter',
            };
            for (let i = 0; i < tracks.length; i++) {
                if (excludes.has(i)) continue;
                const t = tracks[i];
                if (!t?.id) continue;
                const name = t.name.toLowerCase();
                if (AUTO_CLEANUP_TRACK_NAME_HINTS.some((hint) => name.includes(hint))) {
                    try {
                        const response = await engineApi.addPluginToTrackWithDeltas(
                            t.id,
                            autoFilterPlugin.pluginId,
                            autoFilterPlugin.displayName,
                            'effect',
                        );
                        await useEngineStore.getState().applyProjectDeltas(response.deltas, 'agent-auto-cleanup-mix');
                        cleaned++;
                    } catch { /* slot may be occupied */ }
                }
            }
            return JSON.stringify({ success: true, tracksCleaned: cleaned });
        }
        case 'suggest_arrangement': {
            const genre = (args.genre as string).toLowerCase();
            const durBars = (args.durationBars as number) || 64;
            const beatsPerBar = 4;
            const template = ARRANGEMENT_TEMPLATES[genre] || ARRANGEMENT_TEMPLATES.house;
            const scaleFactor = durBars / (template[template.length - 1]?.endBar || 64);
            const sections = template.map(s => ({
                ...s,
                startBar: Math.round(s.startBar * scaleFactor),
                endBar: Math.round(s.endBar * scaleFactor),
                startBeat: Math.round(s.startBar * scaleFactor * beatsPerBar),
                endBeat: Math.round(s.endBar * scaleFactor * beatsPerBar),
            }));
            return JSON.stringify({ genre, totalBars: durBars, sections });
        }
        case 'get_metering': {
            try {
                const metersPacket = await engineApi.getMetersBinary();
                const meters = decodeMetersBinaryPacket(metersPacket);
                const trackMeters = meters.tracks.map((t, i: number) => ({
                    index: i,
                    name: tracks[i]?.name ?? `Track ${i}`,
                    leftRMS: t[0].rms.toFixed(3),
                    leftPeak: t[0].peak.toFixed(3),
                    rightRMS: t[1].rms.toFixed(3),
                    rightPeak: t[1].peak.toFixed(3),
                    clipping: t[0].clipping || t[1].clipping,
                }));
                return JSON.stringify({
                    master: {
                        leftRMS: meters.master_left.rms.toFixed(3),
                        leftPeak: meters.master_left.peak.toFixed(3),
                        rightRMS: meters.master_right.rms.toFixed(3),
                        rightPeak: meters.master_right.peak.toFixed(3),
                    },
                    tracks: trackMeters,
                });
            } catch {
                return JSON.stringify({ error: 'Metering not available' });
            }
        }
        case 'generate_beat_pattern': {
            const genre = ((args.genre as string) || 'house').toLowerCase();
            const bars = Math.max(1, Math.min(64, (args.bars as number) || 4));
            const swing = Math.max(0, Math.min(0.5, (args.swing as number) || 0));
            const oneBar = BEAT_PATTERNS[genre] || BEAT_PATTERNS.house;
            const notes: { pitch: number; startBeat: number; velocity: number; durationBeats: number }[] = [];
            for (let bar = 0; bar < bars; bar++) {
                for (const hit of oneBar) {
                    let beat = bar * 4 + hit.beat;
                    if (swing > 0 && hit.beat % 1 !== 0) {
                        const isOffbeat16th = (hit.beat * 4) % 2 !== 0;
                        if (isOffbeat16th) beat += swing;
                    }
                    notes.push({
                        pitch: hit.pitch,
                        startBeat: parseFloat(beat.toFixed(4)),
                        velocity: hit.velocity,
                        durationBeats: hit.dur,
                    });
                }
            }
            return JSON.stringify({
                genre,
                bars,
                swing,
                totalNotes: notes.length,
                notes,
                pitchMap: { kick: 36, snare: 38, clap: 37, closedHat: 42, openHat: 46 },
                usage: 'Use set_clip_notes with these notes after creating a MIDI clip on a drum rack track.',
            });
        }
        case 'get_midi_clip_notes': {
            const clipId = args.clipId as string;
            const clip = useEngineStore.getState().timelineClips.find(c => c.id === clipId);
            if (!clip) return JSON.stringify({ error: `Clip ${clipId} not found` });
            if (clip.type !== 'midi') return JSON.stringify({ error: `Clip ${clipId} is not a MIDI clip (type: ${clip.type})` });
            const notes = (clip as { midiNotes?: MidiNoteLike[] }).midiNotes ?? [];
            return JSON.stringify({
                clipId,
                clipName: clip.name,
                noteCount: notes.length,
                notes: notes.map((n) => ({
                    pitch: n.pitch,
                    noteName: ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'][n.pitch % 12] + (Math.floor(n.pitch / 12) - 1),
                    startBeat: n.startBeat,
                    durationBeats: n.durationBeats,
                    velocity: n.velocity,
                })),
            });
        }
        case 'resize_clip': {
            const st = useEngineStore.getState();
            const bpmVal = resolveBpm(st.projectBpm, st.transport.bpm);
            const srVal = resolveSampleRate(st.projectSampleRate);
            const fpb = (60.0 / bpmVal) * srVal;
            const newPosFrames = Math.round((args.newStartBeat as number) * fpb);
            const newDurFrames = Math.round((args.newDurationBeats as number) * fpb);
            const response = await engineApi.resizeClipWithDeltas(args.clipId as string, newPosFrames, newDurFrames);
            await useEngineStore.getState().applyProjectDeltas(response.deltas, 'agent-resize-clip');
            return JSON.stringify({ success: true, clipId: args.clipId, newStartBeat: args.newStartBeat, newDurationBeats: args.newDurationBeats });
        }
        case 'set_clip_warp': {
            const response = await engineApi.setClipWarpWithDeltas({
                clipId: args.clipId as string,
                isWarped: args.isWarped as boolean,
                warpBaseBpm: (args.warpBaseBpm as number) ?? null,
            });
            await useEngineStore.getState().applyProjectDeltas(response.deltas, 'agent-set-clip-warp');
            return JSON.stringify({ success: true, clipId: args.clipId, isWarped: args.isWarped, warpBaseBpm: args.warpBaseBpm ?? null });
        }
        case 'set_clip_source_offset': {
            const st = useEngineStore.getState();
            const bpmVal = resolveBpm(st.projectBpm, st.transport.bpm);
            const srVal = resolveSampleRate(st.projectSampleRate);
            const fpb = (60.0 / bpmVal) * srVal;
            const offsetFrames = Math.round((args.offsetBeats as number) * fpb);
            const response = await engineApi.setClipSourceOffsetWithDeltas(args.clipId as string, offsetFrames);
            await useEngineStore.getState().applyProjectDeltas(response.deltas, 'agent-set-clip-source-offset');
            return JSON.stringify({ success: true, clipId: args.clipId, offsetBeats: args.offsetBeats });
        }
        case 'preview_audio_file': {
            await engineApi.previewAudioFile(args.path as string);
            return JSON.stringify({ success: true, previewing: args.path });
        }
        case 'stop_preview': {
            await engineApi.stopPreview();
            return JSON.stringify({ success: true, stopped: true });
        }
        case 'get_audio_file_duration': {
            const duration = await engineApi.getAudioFileDuration(args.path as string);
            const st = useEngineStore.getState();
            const bpmVal = resolveBpm(st.projectBpm, st.transport.bpm);
            const beatsPerSecond = bpmVal / 60.0;
            return JSON.stringify({
                path: args.path,
                durationSeconds: duration,
                durationBeats: parseFloat((duration * beatsPerSecond).toFixed(2)),
                durationBars: parseFloat((duration * beatsPerSecond / 4).toFixed(2)),
            });
        }
        case 'set_arrangement_grid': {
            const numerator = args.numerator as number;
            const denominator = args.denominator as number;
            const ntoles = 1;
            const snapToGrid = (args.snapToGrid as boolean) ?? true;
            const fixed = false;
            const response = await engineApi.setArrangementGridWithDeltas(
                numerator,
                denominator,
                ntoles,
                snapToGrid,
                fixed,
            );
            await useEngineStore.getState().applyProjectDeltas(response.deltas, 'agent-set-arrangement-grid');
            useGridStore.getState().applyProjectGrid({
                numerator,
                denominator,
                ntoles,
                snapToGrid,
                fixed,
            });
            return JSON.stringify({ success: true, grid: `${args.numerator}/${args.denominator}`, snapToGrid: args.snapToGrid ?? true });
        }
        case 'set_key_signature': {
            const rawTonic = (args.tonic as string).trim();
            const rawMode = (args.mode as string).trim();
            const tonic = rawTonic.charAt(0).toUpperCase() + rawTonic.slice(1).toLowerCase();
            const mode = rawMode.charAt(0).toUpperCase() + rawMode.slice(1).toLowerCase();
            const response = await engineApi.setKeySignatureWithDeltas(
                (args.enabled as boolean) ?? true,
                tonic,
                mode,
            );
            await useEngineStore.getState().applyProjectDeltas(response.deltas, 'agent-set-key-signature');
            return JSON.stringify({ success: true, key: `${tonic} ${mode}` });
        }
        case 'duplicate_tracks': {
            const indices = args.trackIndices as number[];
            const trackIds = indices.map(i => tracks[i]?.id).filter(Boolean);
            if (trackIds.length === 0) return JSON.stringify({ error: 'No valid tracks to duplicate' });
            const response = await engineApi.duplicateTracksWithDeltas(trackIds);
            await useEngineStore.getState().applyProjectDeltas(response.deltas, 'agent-duplicate-tracks');
            return JSON.stringify({ success: true, duplicated: indices.length });
        }
        case 'move_track': {
            const trackId = tracks[args.trackIndex as number]?.id;
            if (!trackId) return JSON.stringify({ error: `Track ${args.trackIndex} not found` });
            const response = await engineApi.moveTrackToIndexWithDeltas(trackId, args.targetIndex as number);
            await useEngineStore.getState().applyProjectDeltas(response.deltas, 'agent-move-track');
            return JSON.stringify({ success: true, from: args.trackIndex, to: args.targetIndex });
        }
        case 'set_track_routing': {
            const trackId = tracks[args.trackIndex as number]?.id;
            if (!trackId) return JSON.stringify({ error: `Track ${args.trackIndex} not found` });
            const target = args.target as string;
            let targetId = 'master';
            if (target !== 'master') {
                const tIdx = resolveTrackIndex(target);
                if (tIdx >= 0 && tracks[tIdx]) targetId = tracks[tIdx].id;
            }
            const response = await engineApi.setTrackRoutingWithDeltas(trackId, targetId);
            await useEngineStore.getState().applyProjectDeltas(response.deltas, 'agent-set-track-routing');
            return JSON.stringify({ success: true, trackIndex: args.trackIndex, routedTo: target });
        }
        case 'arm_track': {
            const response = await engineApi.armTrackWithDeltas(args.trackIndex as number, args.armed as boolean);
            await useEngineStore.getState().applyProjectDeltas(response.deltas, 'agent-arm-track');
            return JSON.stringify({ success: true, trackIndex: args.trackIndex, armed: args.armed });
        }
        case 'set_pad_solo': {
            const trackId = tracks[args.trackIndex as number]?.id;
            if (!trackId) return JSON.stringify({ error: `Track ${args.trackIndex} not found` });
            const response = await engineApi.setSampleRackPadSoloWithDeltasCmd(
                trackId,
                args.padIndex as number,
                args.soloed as boolean,
            );
            await useEngineStore.getState().applyProjectDeltas(response.deltas, 'agent-set-pad-solo');
            return JSON.stringify({ success: true, padIndex: args.padIndex, soloed: args.soloed });
        }
        case 'set_clips_muted_batch': {
            const clipIds = args.clipIds as string[];
            const muted = args.muted as boolean;
            const result = await engineApi.setClipsMutedWithDeltas(clipIds, muted);
            await useEngineStore.getState().applyProjectDeltas(result.deltas, 'agent-set-clips-muted-batch');
            return JSON.stringify({ success: true, muted, applied: result.deltas.length });
        }
        case 'bounce_track': {
            const trackId = tracks[args.trackIndex as number]?.id;
            if (!trackId) return JSON.stringify({ error: `Track ${args.trackIndex} not found` });
            const response = await engineApi.bounceTrackWithDeltas(trackId);
            await useEngineStore.getState().applyProjectDeltas(response.deltas, 'agent-bounce-track');
            return JSON.stringify({ success: true, bounced: args.trackIndex });
        }
        case 'export_mix': {
            const settings: engineApi.ExportSettings = {
                outputPath: args.outputPath as string,
                format: ((args.format as string) || 'wav') as 'wav' | 'mp3',
                sampleRate: resolveSampleRate((args.sampleRate as number)),
                bitDepth: ((args.bitDepth as number) || 24) as 16 | 24 | 32,
                range: ((args.range as string) || 'full') as 'full' | 'loop' | 'selected',
                normalize: (args.normalize as boolean) ?? false,
                tailMs: 500,
            };
            await engineApi.exportMix(settings);
            return JSON.stringify({ success: true, outputPath: settings.outputPath, format: settings.format });
        }
        case 'set_automation_points': {
            const trackId = tracks[args.trackIndex as number]?.id;
            if (!trackId) return JSON.stringify({ error: `Track ${args.trackIndex} not found` });
            const rawPoints = args.points as Array<{ beat: number; value: number; curveType?: string }>;
            const points = rawPoints.map(p => ({
                beat: p.beat,
                value: p.value,
                curveType: (p.curveType || 'linear') as 'linear' | 'bezier' | 'step',
            }));
            const response = await engineApi.setAutomationPointsWithDeltas(trackId, args.paramId as string, points);
            await useEngineStore.getState().applyProjectDeltas(response.deltas, 'agent-set-automation-points');
            return JSON.stringify({ success: true, trackIndex: args.trackIndex, paramId: args.paramId, pointsWritten: points.length });
        }
        case 'get_arrangement_overview': {
            const st = useEngineStore.getState();
            const bpmVal = resolveBpm(st.projectBpm, st.transport.bpm);
            const totalBeats = clips.reduce((max, c) => Math.max(max, c.startBeat + c.durationBeats), 0);
            const totalBars = Math.ceil(totalBeats / 4);
            const tracksOverview = tracks.map((t, i) => {
                const trackClips = clips.filter(c => c.trackIndex === i);
                return {
                    index: i,
                    name: t.name,
                    type: t.track_type,
                    color: t.color,
                    muted: t.is_disabled,
                    soloed: t.is_solo,
                    volume: Math.round(t.volume * 100),
                    clipCount: trackClips.length,
                    fx: (t.effects ?? []).map(e => e.name),
                    instrument: t.instrument?.name ?? null,
                };
            });
            return JSON.stringify({
                bpm: bpmVal,
                totalBars,
                totalBeats: parseFloat(totalBeats.toFixed(1)),
                totalTracks: tracks.length,
                totalClips: clips.length,
                tracks: tracksOverview,
            });
        }
        default:
            return JSON.stringify({ error: `Unknown tool: ${name}` });
    }
}
export function buildSystemPrompt(): string {
    const s = useEngineStore.getState();
    const tracks = getOrderedTracks(s);
    const clips = s.timelineClips;
    const bpm = resolveBpm(s.projectBpm, s.transport.bpm);
    const sr = resolveSampleRate(s.projectSampleRate);
    const transport = s.transport;
    const trackList = tracks
        .map((t, i) => {
            const trackClips = clips.filter(c => c.trackIndex === i);
            const fx = (t.effects ?? []).map(e => e.name).join(', ');
            const inst = t.instrument ? ` instrument="${t.instrument.name}"` : '';
            const output = getOptionalStringField(t, 'output');
            const outputDestinationId = getOptionalStringField(t, 'output_destination_id');
            const routing = output && output !== 'master'
                ? ` → ${output}`
                : outputDestinationId && outputDestinationId !== 'master'
                    ? ` → ${outputDestinationId}`
                    : '';
            const flags = [
                t.is_disabled ? '🔇MUTED' : '',
                t.is_solo ? '🔆SOLO' : '',
                t.is_armed ? '🔴ARMED' : '',
            ].filter(Boolean).join(' ');
            return `  [${i}] "${t.name}" (${t.track_type})${inst} vol=${(t.volume * 100).toFixed(0)}% pan=${t.pan === 0 ? 'C' : t.pan > 0 ? `R${(t.pan * 100).toFixed(0)}` : `L${(-t.pan * 100).toFixed(0)}`}${flags ? ' ' + flags : ''} clips=${trackClips.length}${fx ? ` fx=[${fx}]` : ''}${routing}`;
        })
        .join('\n');
    const totalClips = clips.length;
    return buildSystemPromptTemplate({
        transport,
        bpm,
        sampleRate: sr,
        trackCount: tracks.length,
        totalClips,
        trackList,
    });
}
