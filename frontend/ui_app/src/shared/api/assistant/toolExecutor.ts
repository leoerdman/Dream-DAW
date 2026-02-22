import { useEngineStore } from '@/shared/stores/useEngineStore';
import { useAgentActionStore, getToolLabel } from '@/shared/stores/useAgentActionStore';
import * as engineApi from '@/shared/api/engine';
import { resolveSampleRate } from '@/shared/lib/audioMath';
import {
    type MidiNoteLike,
    getOptionalStringField,
} from '@/shared/api/assistant/types';
import { shouldFetchProjectAfterTool } from '@/shared/api/assistant/toolPolicies';

type GlobalWithPreviewTimer = typeof globalThis & {
    __dreamPreviewTimer?: ReturnType<typeof setTimeout> | null;
};

function resolveTrackIndex(track: string): number {
    const idx = parseInt(track, 10);
    if (!isNaN(idx)) return idx;
    const tracks = useEngineStore.getState().projectTracks;
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
    // Show visual feedback for every action
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
    if (shouldFetchProjectAfterTool(name)) {
        try {
            await useEngineStore.getState().fetchProject(`agent-tool:${name}`);
        } catch (e) {
            console.warn('[Agent] fetchProject after tool failed:', e);
        }
    }

    return result;
}

async function executeToolInner(
    name: string,
    args: Record<string, unknown>,
    onSelectClips?: (ids: string[]) => void,
): Promise<string> {
    const state = useEngineStore.getState();
    const tracks = state.projectTracks;
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
                bpm: state.projectBpm || state.transport.bpm || 120,
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
                    muted: t.is_mute,
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
                bpm: state.projectBpm || t.bpm,
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
            // BUG-13 FIX: Clamp volume to valid range
            const vol = Math.max(0, Math.min(1, args.volume as number));
            const response = await engineApi.setTrackVolumeWithDeltas(args.trackIndex as number, vol);
            await useEngineStore.getState().applyProjectDeltas(response.deltas, 'agent-set-track-volume');
            return JSON.stringify({ trackIndex: args.trackIndex, volume: vol });
        }

        case 'set_track_pan': {
            // BUG-13 FIX: Clamp pan to valid range
            const pan = Math.max(-1, Math.min(1, args.pan as number));
            const response = await engineApi.setTrackPanWithDeltas(args.trackIndex as number, pan);
            await useEngineStore.getState().applyProjectDeltas(response.deltas, 'agent-set-track-pan');
            return JSON.stringify({ trackIndex: args.trackIndex, pan: pan });
        }

        case 'set_track_mute': {
            const response = await engineApi.setTrackMuteWithDeltas(args.trackIndex as number, args.muted as boolean);
            await useEngineStore.getState().applyProjectDeltas(response.deltas, 'agent-set-track-mute');
            return JSON.stringify({ trackIndex: args.trackIndex, muted: args.muted });
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
                } catch {
                    // Index may become invalid as tracks shift or if already removed; skip.
                }
            }
            return JSON.stringify({ success: true, requested: normalized.length, deleted });
        }

        case 'delete_clip': {
            const response = await engineApi.deleteClipWithDeltas(args.clipId as string);
            await useEngineStore.getState().applyProjectDeltas(response.deltas, 'agent-delete-clip');
            return JSON.stringify({ deleted: args.clipId });
        }

        // ── Batch Operations (10x faster) ──
        case 'add_audio_clips_batch': {
            const clipDefs = args.clips as { trackIndex: number; samplePath: string; startBeat: number }[];
            if (!Array.isArray(clipDefs) || clipDefs.length === 0) return JSON.stringify({ error: 'clips array is required' });
            const stBatch = useEngineStore.getState();
            const bpmBatch = stBatch.projectBpm || stBatch.transport.bpm || 120;
            const srBatch = resolveSampleRate(stBatch.projectSampleRate);
            const fpbBatch = (60.0 / bpmBatch) * srBatch;

            // BUG-7 FIX: Pre-delete overlapping clips for the entire batch
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
            await engineApi.undo();
            return JSON.stringify({ undone: true });

        case 'redo':
            await engineApi.redo();
            return JSON.stringify({ redone: true });

        case 'set_master_volume':
            await engineApi.setMasterVolume(args.volume as number);
            return JSON.stringify({ masterVolume: args.volume });

        // ── MIDI Composition Tools ──
        case 'add_midi_track': {
            const trackName = (args.name as string) || undefined;
            const addTrackResponse = await engineApi.addTrackWithDeltasAdvanced('midi', null, trackName);
            await useEngineStore.getState().applyProjectDeltas(addTrackResponse.deltas, 'agent-add-midi-track');
            const addedTrackId = addTrackResponse.deltas.find((delta) => delta.kind === 'TrackAdded')?.data.track_id;
            const updatedState = useEngineStore.getState();
            const newIdx = addedTrackId
                ? updatedState.projectTracks.findIndex((track) => track.id === addedTrackId)
                : updatedState.projectTracks.length - 1;
            const newTrackId = newIdx >= 0 ? updatedState.projectTracks[newIdx]?.id : undefined;

            // Auto-assign instrument if requested
            const instrumentArg = (args.instrument as string | undefined)?.toLowerCase();
            let instrumentAssigned: string | null = null;
            if (instrumentArg && newTrackId) {
                const INSTRUMENT_MAP: Record<string, { pluginId: string; displayName: string }> = {
                    essence: { pluginId: 'internal://instrument/wave-synth', displayName: 'Essence' },
                    sampler: { pluginId: 'internal://instrument/sampler', displayName: 'Sampler' },
                };
                const entry = INSTRUMENT_MAP[instrumentArg];
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
            const SI_MAP: Record<string, { pluginId: string; displayName: string }> = {
                essence: { pluginId: 'internal://instrument/wave-synth', displayName: 'Essence' },
                sampler: { pluginId: 'internal://instrument/sampler', displayName: 'Sampler' },
            };
            const siEntry = SI_MAP[siInstrument];
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
            // Find the instrument slot ID on the track
            const spTrack = tracks[spTrackIdx];
            const instrumentSlotId = spTrack.instrument?.id;
            if (!instrumentSlotId) return JSON.stringify({ error: `Track ${spTrackIdx} has no instrument assigned. Use set_track_instrument first.` });
            await engineApi.setInternalPluginParam(spTrackId, instrumentSlotId, spParamId, spValue);
            return JSON.stringify({ success: true, trackIndex: spTrackIdx, paramId: spParamId, value: spValue });
        }

        case 'create_midi_clip': {
            const tIdx = args.trackIndex as number;
            const startBeat = args.startBeat as number;
            const durBeats = args.durationBeats as number;
            const clipName = (args.name as string) || undefined;

            // OVERLAP GUARD: Auto-delete clips that collide with the new clip's range.
            // This prevents the agent from stacking clips on top of each other.
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

            // Convert beats to frames: frames = beats * 60 / BPM * sampleRate
            const st = useEngineStore.getState();
            const bpmVal = st.projectBpm || st.transport.bpm || 120;
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
            const bpm2 = st2.projectBpm || st2.transport.bpm || 120;
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

        // ── AI Producer Tools ──
        case 'search_browser': {
            const query = (args.query as string).toLowerCase();
            const files = await engineApi.scanAllAudioSources();
            // Fuzzy match logic:
            const matches = files.filter(f => f.name.toLowerCase().includes(query));
            // Return top 10 matches to avoid blowing up context window
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
            await engineApi.setSampleRackPadSample(trackId, padIndex, samplePath);
            return JSON.stringify({ success: true, trackIndex, padIndex, sampleLoaded: samplePath });
        }

        case 'add_audio_clip': {
            const trackIndex = args.trackIndex as number;
            const samplePath = args.samplePath as string;
            const startBeat = args.startBeat as number;

            // OVERLAP GUARD (BUG-4): auto-delete clips at the same position
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
            const bpm3 = st3.projectBpm || st3.transport.bpm || 120;
            const sr3 = resolveSampleRate(st3.projectSampleRate);
            const fpb3 = (60.0 / bpm3) * sr3;
            const startFrames = Math.round(startBeat * fpb3);

            const result = await engineApi.importAudioFileWithDeltas(samplePath, trackIndex, startFrames);
            await useEngineStore.getState().applyProjectDeltas(result.deltas, 'agent-add-audio-clip');
            return JSON.stringify({ success: true, clipId: result.clip_id, clipName: result.clip_name, startBeat, overlapsRemoved: overlapping.length });
        }

        // ── Phase 1: Core Operations ──
        case 'move_clip': {
            const clipId = args.clipId as string;
            const newTrackIndex = args.newTrackIndex as number;
            const newPositionBeats = args.newPositionBeats as number;

            const stMove = useEngineStore.getState();
            const fpbMove = (60.0 / (stMove.projectBpm || stMove.transport.bpm || 120)) * (resolveSampleRate(stMove.projectSampleRate));
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
                const fpbDup = (60.0 / (stDup.projectBpm || stDup.transport.bpm || 120)) * (resolveSampleRate(stDup.projectSampleRate));
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
            const fpbSplit = (60.0 / (stSplit.projectBpm || stSplit.transport.bpm || 120)) * (resolveSampleRate(stSplit.projectSampleRate));
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
            const fpbFade = (60.0 / (stFade.projectBpm || stFade.transport.bpm || 120)) * (resolveSampleRate(stFade.projectSampleRate));
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

        case 'add_effect': {
            const trackIndex = args.trackIndex as number;
            const slotIndex = args.slotIndex as number;
            const effectType = args.effectType as engineApi.BuiltinEffectType;
            await engineApi.addDevice(trackIndex, slotIndex, effectType);
            return JSON.stringify({ success: true, trackIndex, effectType });
        }

        case 'remove_effect': {
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
            await engineApi.setInternalPluginParam(trackId, slotId, paramId, val);
            return JSON.stringify({ success: true, paramChanged: paramId, value: val });
        }

        case 'create_track_group': {
            const tIndices = args.trackIndices as number[];
            const name = args.groupName as string;
            const tIds = tIndices.map(i => tracks[i]?.id).filter(id => id) as string[];
            await engineApi.createGroup(tIds, name);
            return JSON.stringify({ success: true, groupName: name, tracksGrouped: tIds.length });
        }

        case 'set_loop_region': {
            const enabled = args.enabled as boolean;
            const stL = useEngineStore.getState();
            const fpbL = (60.0 / (stL.projectBpm || stL.transport.bpm || 120)) * (resolveSampleRate(stL.projectSampleRate));
            const startF = Math.round((args.startBeat as number) * fpbL);
            const endF = Math.round((args.endBeat as number) * fpbL);
            const response = await engineApi.setLoopWithDeltas(enabled, startF, endF);
            await useEngineStore.getState().applyProjectDeltas(response.deltas, 'agent-set-loop-region');
            return JSON.stringify({ success: true, loopEnabled: enabled, startBeat: args.startBeat, endBeat: args.endBeat });
        }

        // ── Phase 2: Music Theory & MIDI Algorithms ──
        case 'quantize_notes': {
            const clipId = args.clipId as string;
            const grid = args.gridBeats as number;
            const strength = (args.strength as number ?? 100) / 100;
            const clip = clips.find(c => c.id === clipId);
            if (!clip) return JSON.stringify({ error: 'Clip not found' });
            // Get existing notes, quantize them, write back
            const stQ = useEngineStore.getState();
            const bpmQ = stQ.projectBpm || stQ.transport.bpm || 120;
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
            const fpbH = (60.0 / (stH.projectBpm || stH.transport.bpm || 120)) * (resolveSampleRate(stH.projectSampleRate));
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
            const INTERVALS: Record<string, number[]> = {
                major: [0, 4, 7], minor: [0, 3, 7], dim: [0, 3, 6], aug: [0, 4, 8],
                dom7: [0, 4, 7, 10], maj7: [0, 4, 7, 11], min7: [0, 3, 7, 10],
                sus2: [0, 2, 7], sus4: [0, 5, 7], add9: [0, 4, 7, 14],
                min9: [0, 3, 7, 10, 14], maj9: [0, 4, 7, 11, 14],
                dim7: [0, 3, 6, 9], aug7: [0, 4, 8, 10],
                m7b5: [0, 3, 6, 10], '6': [0, 4, 7, 9], m6: [0, 3, 7, 9],
            };
            const intervals = INTERVALS[quality] || INTERVALS.major;
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
            const fpbArp = (60.0 / (stArp.projectBpm || stArp.transport.bpm || 120)) * (resolveSampleRate(stArp.projectSampleRate));
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
            const SCALES: Record<string, number[]> = {
                major: [0, 2, 4, 5, 7, 9, 11], minor: [0, 2, 3, 5, 7, 8, 10],
                dorian: [0, 2, 3, 5, 7, 9, 10], phrygian: [0, 1, 3, 5, 7, 8, 10],
                lydian: [0, 2, 4, 6, 7, 9, 11], mixolydian: [0, 2, 4, 5, 7, 9, 10],
                aeolian: [0, 2, 3, 5, 7, 8, 10], locrian: [0, 1, 3, 5, 6, 8, 10],
                pentatonic_major: [0, 2, 4, 7, 9], pentatonic_minor: [0, 3, 5, 7, 10],
                blues: [0, 3, 5, 6, 7, 10], harmonic_minor: [0, 2, 3, 5, 7, 8, 11],
                melodic_minor: [0, 2, 3, 5, 7, 9, 11], whole_tone: [0, 2, 4, 6, 8, 10],
                chromatic: [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11],
            };
            // BUG-8 FIX: Return error instead of silently falling back to major
            const intervals = SCALES[scaleType];
            if (!intervals) return JSON.stringify({ error: `Unknown scale type: "${scaleType}". Valid types: ${Object.keys(SCALES).join(', ')}` });
            const pitches: number[] = [];
            for (let n = lo; n <= hi; n++) {
                if (intervals.includes((n - (root % 12) + 12) % 12)) pitches.push(n);
            }
            return JSON.stringify({ root, scaleType, pitches, count: pitches.length });
        }

        // ── Phase 2: Sample Rack Pad Controls ──
        case 'set_pad_volume': {
            const trackId = tracks[args.trackIndex as number]?.id;
            if (!trackId) return JSON.stringify({ error: 'Track not found' });
            await engineApi.setSampleRackPadVolumeCmd(trackId, args.padIndex as number, args.volume as number);
            return JSON.stringify({ success: true });
        }

        case 'set_pad_mute': {
            const trackId = tracks[args.trackIndex as number]?.id;
            if (!trackId) return JSON.stringify({ error: 'Track not found' });
            await engineApi.setSampleRackPadMuteCmd(trackId, args.padIndex as number, args.muted as boolean);
            return JSON.stringify({ success: true });
        }

        case 'set_pad_adsr': {
            const trackId = tracks[args.trackIndex as number]?.id;
            if (!trackId) return JSON.stringify({ error: 'Track not found' });
            await engineApi.setSampleRackPadAdsrCmd(
                trackId, args.padIndex as number,
                args.attack as number, args.decay as number,
                args.sustain as number, args.release as number
            );
            return JSON.stringify({ success: true });
        }

        case 'set_pad_filter_cutoff': {
            const trackId = tracks[args.trackIndex as number]?.id;
            if (!trackId) return JSON.stringify({ error: 'Track not found' });
            await engineApi.setSampleRackPadFilterCutoffCmd(trackId, args.padIndex as number, args.cutoff as number);
            return JSON.stringify({ success: true });
        }

        // ── Phase 2/3: Track Styling, Bypass, Preview ──
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
            // BUG-6 FIX: Cancel previous preview timer to prevent leaked note-offs
            const globals = globalThis as GlobalWithPreviewTimer;
            if (globals.__dreamPreviewTimer) clearTimeout(globals.__dreamPreviewTimer);
            globals.__dreamPreviewTimer = setTimeout(() => {
                engineApi.previewSamplerNoteOff(tIdx, pitch).catch(() => { });
                globals.__dreamPreviewTimer = null;
            }, 500);
            return JSON.stringify({ success: true, pitch, velocity: vel });
        }

        // ── Phase 3: Intelligent Mixing ──
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
            for (let i = 0; i < tracks.length; i++) {
                if (excludes.has(i)) continue;
                const t = tracks[i];
                const name = t.name.toLowerCase();
                // Auto high-pass tracks that don't need low-end
                if (name.includes('hat') || name.includes('hi-hat') || name.includes('hihat') ||
                    name.includes('vocal') || name.includes('vox') || name.includes('shaker') ||
                    name.includes('perc') || name.includes('clap') || name.includes('crash') ||
                    name.includes('ride') || name.includes('cymbal') || name.includes('fx') ||
                    name.includes('pad') || name.includes('syn') || name.includes('lead')) {
                    try {
                        // BUG-5 FIX: Use named constant instead of magic number
                        await engineApi.addDevice(i, 0, engineApi.BuiltinEffectType.AutoFilter);
                        cleaned++;
                    } catch { /* slot may be occupied */ }
                }
            }
            return JSON.stringify({ success: true, tracksCleaned: cleaned });
        }

        // ── Phase 4: Creative Arrangement ──
        case 'suggest_arrangement': {
            const genre = (args.genre as string).toLowerCase();
            const durBars = (args.durationBars as number) || 64;
            const beatsPerBar = 4;
            // Genre-aware arrangement templates
            const templates: Record<string, { name: string; startBar: number; endBar: number }[]> = {
                house: [
                    { name: 'Intro (Kick Only)', startBar: 0, endBar: 8 },
                    { name: 'Build-up (Add Hats + Clap)', startBar: 8, endBar: 16 },
                    { name: 'Breakdown (Remove Kick, Add Pads)', startBar: 16, endBar: 24 },
                    { name: 'Build-up (Riser + Filter Sweep)', startBar: 24, endBar: 28 },
                    { name: 'DROP (Full Energy)', startBar: 28, endBar: 44 },
                    { name: 'Breakdown 2 (Strip Back)', startBar: 44, endBar: 52 },
                    { name: 'DROP 2 (Full + Variation)', startBar: 52, endBar: 60 },
                    { name: 'Outro (Fade Elements)', startBar: 60, endBar: 64 },
                ],
                techno: [
                    { name: 'Intro (Ambient Textures)', startBar: 0, endBar: 8 },
                    { name: 'Build (Add Kick)', startBar: 8, endBar: 16 },
                    { name: 'Main Loop A', startBar: 16, endBar: 32 },
                    { name: 'Breakdown (Filter Down)', startBar: 32, endBar: 40 },
                    { name: 'Main Loop B (Variation)', startBar: 40, endBar: 56 },
                    { name: 'Outro (Dissolve)', startBar: 56, endBar: 64 },
                ],
                dnb: [
                    { name: 'Intro', startBar: 0, endBar: 8 },
                    { name: 'Build-up', startBar: 8, endBar: 16 },
                    { name: 'Drop 1', startBar: 16, endBar: 32 },
                    { name: 'Breakdown', startBar: 32, endBar: 40 },
                    { name: 'Drop 2', startBar: 40, endBar: 56 },
                    { name: 'Outro', startBar: 56, endBar: 64 },
                ],
                hiphop: [
                    { name: 'Intro', startBar: 0, endBar: 4 },
                    { name: 'Verse 1', startBar: 4, endBar: 20 },
                    { name: 'Hook/Chorus', startBar: 20, endBar: 28 },
                    { name: 'Verse 2', startBar: 28, endBar: 44 },
                    { name: 'Hook/Chorus', startBar: 44, endBar: 52 },
                    { name: 'Bridge', startBar: 52, endBar: 56 },
                    { name: 'Outro', startBar: 56, endBar: 64 },
                ],
                pop: [
                    { name: 'Intro', startBar: 0, endBar: 4 },
                    { name: 'Verse 1', startBar: 4, endBar: 12 },
                    { name: 'Pre-Chorus', startBar: 12, endBar: 16 },
                    { name: 'Chorus', startBar: 16, endBar: 24 },
                    { name: 'Verse 2', startBar: 24, endBar: 32 },
                    { name: 'Pre-Chorus 2', startBar: 32, endBar: 36 },
                    { name: 'Chorus 2', startBar: 36, endBar: 44 },
                    { name: 'Bridge', startBar: 44, endBar: 52 },
                    { name: 'Final Chorus', startBar: 52, endBar: 60 },
                    { name: 'Outro', startBar: 60, endBar: 64 },
                ],
            };
            const template = templates[genre] || templates.house;
            // Scale to target duration
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
                const meters = await engineApi.getMeters();
                const trackMeters = meters.tracks.map((t: [import('@/shared/api/engine').MeterReading, import('@/shared/api/engine').MeterReading], i: number) => ({
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

        // ── Beat Pattern Generator ──
        case 'generate_beat_pattern': {
            const genre = ((args.genre as string) || 'house').toLowerCase();
            const bars = Math.max(1, Math.min(64, (args.bars as number) || 4));
            const swing = Math.max(0, Math.min(0.5, (args.swing as number) || 0));

            // Define one-bar patterns per genre: {pitch, beatOffset, velocity}
            // Kick=36, Snare/Clap=37/38, ClosedHat=42, OpenHat=46, Ride=51
            type NoteHit = { pitch: number; beat: number; velocity: number; dur: number };
            const patterns: Record<string, NoteHit[]> = {
                house: [
                    // 4/4 kick
                    { pitch: 36, beat: 0, velocity: 120, dur: 0.25 },
                    { pitch: 36, beat: 1, velocity: 120, dur: 0.25 },
                    { pitch: 36, beat: 2, velocity: 120, dur: 0.25 },
                    { pitch: 36, beat: 3, velocity: 120, dur: 0.25 },
                    // Clap on 1, 3
                    { pitch: 37, beat: 1, velocity: 100, dur: 0.25 },
                    { pitch: 37, beat: 3, velocity: 100, dur: 0.25 },
                    // Closed hat offbeats
                    { pitch: 42, beat: 0.5, velocity: 80, dur: 0.125 },
                    { pitch: 42, beat: 1.5, velocity: 80, dur: 0.125 },
                    { pitch: 42, beat: 2.5, velocity: 80, dur: 0.125 },
                    { pitch: 42, beat: 3.5, velocity: 80, dur: 0.125 },
                ],
                techno: [
                    // Hard 4/4 kick
                    { pitch: 36, beat: 0, velocity: 127, dur: 0.25 },
                    { pitch: 36, beat: 1, velocity: 127, dur: 0.25 },
                    { pitch: 36, beat: 2, velocity: 127, dur: 0.25 },
                    { pitch: 36, beat: 3, velocity: 127, dur: 0.25 },
                    // Clap on 1, 3
                    { pitch: 37, beat: 1, velocity: 90, dur: 0.25 },
                    { pitch: 37, beat: 3, velocity: 90, dur: 0.25 },
                    // 16th hats
                    ...Array.from({ length: 16 }, (_, i) => ({
                        pitch: 42, beat: i * 0.25, velocity: i % 4 === 0 ? 100 : i % 2 === 0 ? 70 : 55, dur: 0.125,
                    })),
                ],
                dnb: [
                    // DnB kick (1, 2.75)
                    { pitch: 36, beat: 0, velocity: 120, dur: 0.25 },
                    { pitch: 36, beat: 2.75, velocity: 110, dur: 0.25 },
                    // Snare on 1, 3
                    { pitch: 38, beat: 1, velocity: 110, dur: 0.25 },
                    { pitch: 38, beat: 3, velocity: 110, dur: 0.25 },
                    // Fast hats (8th notes)
                    ...Array.from({ length: 8 }, (_, i) => ({
                        pitch: 42, beat: i * 0.5, velocity: i % 2 === 0 ? 90 : 65, dur: 0.125,
                    })),
                ],
                hiphop: [
                    // Boom bap kick
                    { pitch: 36, beat: 0, velocity: 110, dur: 0.5 },
                    { pitch: 36, beat: 2.5, velocity: 100, dur: 0.5 },
                    // Snare on 1, 3
                    { pitch: 38, beat: 1, velocity: 105, dur: 0.25 },
                    { pitch: 38, beat: 3, velocity: 105, dur: 0.25 },
                    // Hats with groove
                    { pitch: 42, beat: 0, velocity: 75, dur: 0.125 },
                    { pitch: 42, beat: 0.5, velocity: 60, dur: 0.125 },
                    { pitch: 42, beat: 1, velocity: 75, dur: 0.125 },
                    { pitch: 42, beat: 1.5, velocity: 60, dur: 0.125 },
                    { pitch: 42, beat: 2, velocity: 75, dur: 0.125 },
                    { pitch: 42, beat: 2.5, velocity: 60, dur: 0.125 },
                    { pitch: 42, beat: 3, velocity: 75, dur: 0.125 },
                    { pitch: 42, beat: 3.5, velocity: 60, dur: 0.125 },
                ],
                trap: [
                    // 808 kick
                    { pitch: 36, beat: 0, velocity: 127, dur: 0.5 },
                    { pitch: 36, beat: 1.75, velocity: 110, dur: 0.5 },
                    { pitch: 36, beat: 2.5, velocity: 115, dur: 0.5 },
                    // Snare on 1, 3
                    { pitch: 38, beat: 1, velocity: 120, dur: 0.25 },
                    { pitch: 38, beat: 3, velocity: 120, dur: 0.25 },
                    // Trap hi-hat rolls (32nd notes on offbeats)
                    { pitch: 42, beat: 0.5, velocity: 85, dur: 0.0625 },
                    { pitch: 42, beat: 0.5625, velocity: 70, dur: 0.0625 },
                    { pitch: 42, beat: 0.625, velocity: 60, dur: 0.0625 },
                    { pitch: 42, beat: 1.5, velocity: 85, dur: 0.0625 },
                    { pitch: 42, beat: 1.5625, velocity: 70, dur: 0.0625 },
                    { pitch: 42, beat: 1.625, velocity: 60, dur: 0.0625 },
                    { pitch: 42, beat: 2.5, velocity: 85, dur: 0.0625 },
                    { pitch: 42, beat: 2.5625, velocity: 70, dur: 0.0625 },
                    { pitch: 42, beat: 2.625, velocity: 60, dur: 0.0625 },
                    { pitch: 42, beat: 3.5, velocity: 85, dur: 0.0625 },
                    { pitch: 42, beat: 3.5625, velocity: 70, dur: 0.0625 },
                    { pitch: 42, beat: 3.625, velocity: 60, dur: 0.0625 },
                ],
                lofi: [
                    // Lazy boom bap
                    { pitch: 36, beat: 0, velocity: 95, dur: 0.5 },
                    { pitch: 36, beat: 2.33, velocity: 85, dur: 0.5 },
                    // Snare on 1, 3 (softer)
                    { pitch: 38, beat: 1, velocity: 80, dur: 0.25 },
                    { pitch: 38, beat: 3, velocity: 80, dur: 0.25 },
                    // Lazy hats
                    { pitch: 42, beat: 0.5, velocity: 55, dur: 0.125 },
                    { pitch: 42, beat: 1.5, velocity: 50, dur: 0.125 },
                    { pitch: 42, beat: 2.5, velocity: 55, dur: 0.125 },
                    { pitch: 42, beat: 3.5, velocity: 50, dur: 0.125 },
                ],
            };

            const oneBar = patterns[genre] || patterns['house'];

            // Expand to N bars + apply swing
            const notes: { pitch: number; startBeat: number; velocity: number; durationBeats: number }[] = [];
            for (let bar = 0; bar < bars; bar++) {
                for (const hit of oneBar) {
                    let beat = bar * 4 + hit.beat;
                    // Apply swing to offbeat notes
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

        // ═══════════════════════════════════════════════════════════════════
        // Phase 5: Deep Music Production Tools (20 implementations)
        // ═══════════════════════════════════════════════════════════════════

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
            const bpmVal = st.projectBpm || st.transport.bpm || 120;
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
            const bpmVal = st.projectBpm || st.transport.bpm || 120;
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
            const bpmVal = st.projectBpm || st.transport.bpm || 120;
            const beatsPerSecond = bpmVal / 60.0;
            return JSON.stringify({
                path: args.path,
                durationSeconds: duration,
                durationBeats: parseFloat((duration * beatsPerSecond).toFixed(2)),
                durationBars: parseFloat((duration * beatsPerSecond / 4).toFixed(2)),
            });
        }

        case 'set_arrangement_grid': {
            await engineApi.setArrangementGrid(
                args.numerator as number,
                args.denominator as number,
                1, // ntoles (default no tuplets)
                (args.snapToGrid as boolean) ?? true,
                false, // not fixed
            );
            return JSON.stringify({ success: true, grid: `${args.numerator}/${args.denominator}`, snapToGrid: args.snapToGrid ?? true });
        }

        case 'set_key_signature': {
            // Normalize tonic/mode to title-case for consistency with KEY_MODES/KEY_TONICS
            const rawTonic = (args.tonic as string).trim();
            const rawMode = (args.mode as string).trim();
            const tonic = rawTonic.charAt(0).toUpperCase() + rawTonic.slice(1).toLowerCase();
            const mode = rawMode.charAt(0).toUpperCase() + rawMode.slice(1).toLowerCase();
            await engineApi.setKeySignature(
                (args.enabled as boolean) ?? true,
                tonic,
                mode,
            );
            return JSON.stringify({ success: true, key: `${tonic} ${mode}` });
        }

        case 'duplicate_tracks': {
            const indices = args.trackIndices as number[];
            const trackIds = indices.map(i => tracks[i]?.id).filter(Boolean);
            if (trackIds.length === 0) return JSON.stringify({ error: 'No valid tracks to duplicate' });
            await engineApi.duplicateTracks(trackIds);
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
            await engineApi.setSampleRackPadSoloCmd(trackId, args.padIndex as number, args.soloed as boolean);
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
            await engineApi.bounceTrack(trackId);
            return JSON.stringify({ success: true, bounced: args.trackIndex });
        }

        case 'export_mix': {
            const settings: engineApi.ExportSettings = {
                outputPath: args.outputPath as string,
                format: ((args.format as string) || 'wav') as 'wav' | 'mp3',
                sampleRate: resolveSampleRate((args.sampleRate as number)) as 44100 | 48000 | 96000,
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
            const bpmVal = st.projectBpm || st.transport.bpm || 120;
            const totalBeats = clips.reduce((max, c) => Math.max(max, c.startBeat + c.durationBeats), 0);
            const totalBars = Math.ceil(totalBeats / 4);
            const tracksOverview = tracks.map((t, i) => {
                const trackClips = clips.filter(c => c.trackIndex === i);
                return {
                    index: i,
                    name: t.name,
                    type: t.track_type,
                    color: t.color,
                    muted: t.is_mute,
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

// ─── System prompt builder ──────────────────────────────────────────────────

export function buildSystemPrompt(): string {
    const s = useEngineStore.getState();
    const tracks = s.projectTracks;
    const clips = s.timelineClips;
    const bpm = s.projectBpm || s.transport.bpm || 120;
    const sr = resolveSampleRate(s.projectSampleRate);
    const transport = s.transport;

    // Build rich track list with full context
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
                t.is_mute ? '🔇MUTED' : '',
                t.is_solo ? '🔆SOLO' : '',
                t.is_armed ? '🔴ARMED' : '',
            ].filter(Boolean).join(' ');

            return `  [${i}] "${t.name}" (${t.track_type})${inst} vol=${(t.volume * 100).toFixed(0)}% pan=${t.pan === 0 ? 'C' : t.pan > 0 ? `R${(t.pan * 100).toFixed(0)}` : `L${(-t.pan * 100).toFixed(0)}`}${flags ? ' ' + flags : ''} clips=${trackClips.length}${fx ? ` fx=[${fx}]` : ''}${routing}`;
        })
        .join('\n');

    const transportStatus = transport.is_playing ? '▶ Playing' : '⏹ Stopped';
    const totalClips = clips.length;

    return `You are **Dream AI** — the intelligent Producer-Composer built into Dream DAW. You are not just a chatbot; you are an autonomous musical co-author capable of building professional tracks from scratch.

## Your Identity & AI Producer Manifesto
1. **Absolute Order (Enterprise Hygiene)**: Consistently and logically name all tracks and clips (e.g. \`DRM_Kick_Main\`, \`SYN_Bass_Sub\`).
2. **Explainability**: NEVER act blindly. Explain *why* you chose a sample, *why* a note is placed on a specific beat, and how it fits the genre.
3. **Musical Theory & Rhythmology**: You understand beats, bars, syncopation. You know genre rules (e.g. House: 4/4 Kick on 0, 1, 2, 3; Clap on 1 and 3; Hat on offbeats 0.5, 1.5).
4. **Macro-Structure (Arrangement)**: You think in Intro -> Breakdown -> Build-up -> Drop/Chorus -> Outro.
5. **Step-by-Step Logic**: Seek sounds -> Draft Rhythm -> Draft Harmony -> Arrange -> Mix.

## Current Project State
- **Transport**: ${transportStatus} at beat ${transport.position_beats?.toFixed(1) ?? 0}
- **BPM**: ${bpm} | **Sample Rate**: ${sr} Hz
- **Tracks**: ${tracks.length} | **Total Clips**: ${totalClips}

### Track List
${trackList || '  (no tracks)'}



## Behavior Rules & Execution Patterns

### Chain-of-Thought
Before executing any action, briefly explain what you're about to do and why based on your music theory knowledge.
- "For a Tech House drop, we need a punchy 4/4 kick. I'll search for 'kick', load it into a drum rack on Track 0, and program notes on beats 0, 1, 2, and 3."

### Drum Programming (CRITICAL)
1. **Sample Racks (Drum Racks)**: Use a \\\`midi\\\` track for drums. Search for samples using \\\`search_browser\\\`. Load them into Drum Rack pads using \\\`add_sample_to_rack\\\`.
   - **Pad 0 (Pitch 36 / C1)**: Kick
   - **Pad 1 (Pitch 37 / C#1) or Pad 2**: Snare/Clap
   - **Pad 6 (Pitch 42 / F#1)**: Closed Hi-Hat
2. **Beat Patterns**: Use \\\`generate_beat_pattern\\\` for instant genre-correct rhythm patterns (house, techno, dnb, hiphop, trap, lofi). Feed the returned notes into \\\`set_clip_notes\\\`.
3. **MIDI Notes**: Use \\\`create_midi_clip\\\` followed by \\\`set_clip_notes\\\`. Note pitches must match the pads where you loaded the samples (e.g. Kick = 36, Clap = 37 or 38, Hat = 42).
4. **NEVER overlap clips** on the same track at the same time. The system will auto-delete overlapped clips, but you MUST still use the correct track index. **Check existing tracks and their clips before creating new ones.** Each musical element (kick, bass, melody, chords) should be on its OWN separate track.
5. **Pad Sound Design**: Sculpt each pad using \\\`set_pad_adsr\\\` (shape transients), \\\`set_pad_volume\\\` (level), and \\\`set_pad_filter_cutoff\\\` (brightness). Use \\\`preview_note\\\` to audition before programming.

### Instrument Assignment (CRITICAL)
1. **For melodic tracks** (bass, lead, pad, chord, melody, arp): ALWAYS use \\\`add_midi_track({ instrument: 'essence' })\\\` or call \\\`set_track_instrument({ trackIndex, instrument: 'essence' })\\\` to assign the Essence synth.
2. **Sound Design**: After assigning Essence, use \\\`set_synth_param\\\` to shape the sound. Key params: \\\`synth.osc1.wave\\\` (0-7), \\\`synth.filter.cutoff\\\` (0-1), \\\`synth.attack\\\`/\\\`synth.decay\\\`/\\\`synth.sustain\\\`/\\\`synth.release\\\`, \\\`synth.lfo.rate\\\`/\\\`synth.lfo.depth\\\`.
3. **For drum tracks**: Use \\\`add_midi_track\\\` WITHOUT instrument, then load samples into drum rack pads.
4. **NEVER write melodic notes to a drum rack track.** Always create a DEDICATED track with Essence synth for melodies.
5. **Track isolation**: Each musical role (kick, snare/clap, hats, bass, melody, chords, pads) should be on its OWN separate track with the right instrument.

### Music Theory Engine
1. **Chords**: Use \\\`generate_chord\\\` to compute exact MIDI pitches. Example: \\\`generate_chord(48, "min7")\\\` returns [48, 51, 55, 58].
2. **Scales**: Use \\\`generate_scale\\\` to constrain melodies/basslines to correct pitches. Always stay in key.
3. **Arpeggios**: Use \\\`generate_arpeggio\\\` for pulsing patterns — combine with generate_chord for instant harmonic movement.
4. **Quantize**: After recording or AI-generated patterns, use \\\`quantize_notes\\\` to tighten timing. Use \\\`humanize_velocity\\\` to add human feel (±10-20 range).

### Intelligent Mixing
1. First \\\`auto_gain_stage\\\` to normalize all tracks to -3dB (0.7).
2. Then \\\`auto_cleanup_mix\\\` to add high-pass filters to non-bass tracks.
3. Use \\\`get_metering\\\` to check levels and prevent clipping.
4. Color-code tracks (\\\`set_track_color\\\`) for visual organization.

### Response Quality
1. **Be concise but informative**. Every sentence should add value.
2. **Use pro audio terminology** — "gain staging", "signal flow", "groove", "syncopation".
3. **If a tool fails**, explain the error in plain language and suggest an alternative (e.g. if the sample isn't found, try a broader search).

### ⚡ CRITICAL: Batch Operations
**ALWAYS use batch tools instead of individual calls for repetitive operations:**
- To place a kick on every beat: use \\\`add_audio_clips_batch\\\` with a single array of all placements (NOT 16 individual \\\`add_audio_clip\\\` calls).
- To delete all clips on a track: use \\\`delete_all_clips_on_track\\\` (NOT individual \\\`delete_clip\\\` calls).
- To delete specific clips: use \\\`delete_clips_batch\\\` with an array of IDs (NOT individual \\\`delete_clip\\\` calls).
Batch tools are 10x faster and prevent crashes from too many rapid IPC calls.`;
}
