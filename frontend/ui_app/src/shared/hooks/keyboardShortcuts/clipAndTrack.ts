import * as engine from '@/shared/api/engine';
import { beatToFrame, frameToBeat, resolveSampleRate } from '@/shared/lib/audioMath';
import { normalizeTimelineClips } from '@/shared/lib/clipNormalization';
import { useEngineStore } from '@/shared/stores/useEngineStore';
import type { TimelineClip } from '@/shared/lib/arrangementTypes';
import type { KeyboardShortcutHandlerEnv } from './types';
import { getScopedEditorElement, isModKey, matchesShortcutAction } from './utils';

/**
 * Optimistically removes clips from the engine store state so the canvas
 * redraws immediately, without waiting for the async IPC round-trip.
 * Returns a rollback function that restores the previous state on failure.
 */
function optimisticRemoveClips(clipIds: string[]): () => void {
    const idSet = new Set(clipIds);
    const state = useEngineStore.getState();
    const snapshot = {
        timelineClips: state.timelineClips,
        clipsById: state.clipsById,
        clips: state.clips,
    };

    const nextTimelineClips = normalizeTimelineClips(
        state.timelineClips.filter((c: TimelineClip) => !idSet.has(c.id)),
    );
    const nextClipsById = Object.fromEntries(
        nextTimelineClips.map((clip: TimelineClip) => [clip.id, clip]),
    );
    useEngineStore.setState({
        timelineClips: nextTimelineClips,
        clipsById: nextClipsById,
        clips: {
            byId: nextClipsById,
            allIds: nextTimelineClips.map((clip: TimelineClip) => clip.id),
        },
    });

    return () => useEngineStore.setState(snapshot);
}

export async function handleClipAndTrackShortcuts(env: KeyboardShortcutHandlerEnv): Promise<boolean> {
    const { e, ctx, clipboardRef } = env;
    const { selectedClipId, selectedClipIds, selectedTrackId, trackIds, tracksById, timelineClips, marqueeSelection, onClipSelectionChanged, inPianoRoll, inDeviceRack, selectedDeviceId, selectedTrackIndex, playheadFrames } = ctx;

    if (matchesShortcutAction(e, 'glue_clips')) {
        if (inPianoRoll || inDeviceRack) return true;
        e.preventDefault();
        e.stopPropagation();
        const targets = selectedClipIds.length > 0 ? selectedClipIds : (selectedClipId ? [selectedClipId] : []);
        if (targets.length < 2) return true;
        const selected = timelineClips.filter((c) => targets.includes(c.id));
        if (selected.length < 2 || !selected.every((c) => c.trackIndex === selected[0].trackIndex)) return true;
        try {
            const response = await engine.mergeClipsWithDeltas(selected.map((c) => c.id));
            await useEngineStore.getState().applyProjectDeltas(response.deltas, 'shortcut-merge');
        } catch (err) {
            console.error('[Shortcuts] Merge clips failed:', err);
        }
        return true;
    }

    if (isModKey(e) && e.code === 'KeyC') {
        if (inPianoRoll || inDeviceRack) return true;
        e.preventDefault();
        e.stopPropagation();
        const targets = selectedClipIds.length > 0 ? selectedClipIds : (selectedClipId ? [selectedClipId] : []);
        const selected = timelineClips.filter((c) => targets.includes(c.id)).sort((a, b) => a.startBeat - b.startBeat);
        if (selected.length > 0) clipboardRef.current = selected.map((c) => ({ ...c }));
        return true;
    }

    if (isModKey(e) && e.code === 'KeyV') {
        if (inPianoRoll || inDeviceRack || clipboardRef.current.length === 0) return true;
        e.preventDefault();
        e.stopPropagation();
        const store = useEngineStore.getState();
        const bpm = Math.max(1, store.projectBpm || store.transport.bpm || 120);
        const sampleRate = resolveSampleRate(store.projectSampleRate);
        const cursorBeat = (ctx.editCursorBeat ?? -1) >= 0 ? (ctx.editCursorBeat as number) : frameToBeat(playheadFrames, bpm, sampleRate);
        const firstBeat = clipboardRef.current[0].startBeat;
        let minRelative = Infinity;
        for (const c of clipboardRef.current) minRelative = Math.min(minRelative, c.startBeat - firstBeat);
        const groupOffset = Math.max(0, cursorBeat + minRelative) - (cursorBeat + minRelative);
        const anchorTrackIndex = clipboardRef.current[0].trackIndex;
        const selectedTrackIdx = selectedTrackIndex;
        const trackDelta = selectedTrackIdx >= 0 ? selectedTrackIdx - anchorTrackIndex : 0;
        try {
            if (trackDelta === 0) {
                const results = await Promise.all(clipboardRef.current.map((clip) => engine.duplicateClipWithDeltas(clip.id, Math.max(0, beatToFrame(cursorBeat + (clip.startBeat - firstBeat) + groupOffset, bpm, sampleRate)))));
                await useEngineStore.getState().applyProjectDeltas(results.flatMap((r) => r.deltas), 'shortcut-paste-same-track');
                onClipSelectionChanged(results.map((r) => r.new_id));
            } else {
                const allDeltas: Array<{ deltas: unknown[] }> = [];
                const results = await Promise.all(clipboardRef.current.map((clip) => engine.duplicateClipWithDeltas(clip.id)));
                allDeltas.push(...results);
                for (let i = 0; i < results.length; i += 1) {
                    const clip = clipboardRef.current[i];
                    const destBeat = Math.max(0, cursorBeat + (clip.startBeat - firstBeat) + groupOffset);
                    const targetTrack = Math.max(0, Math.min(trackIds.length - 1, clip.trackIndex + trackDelta));
                    const response = await engine.moveClipWithDeltas(results[i].new_id, targetTrack, Math.max(0, beatToFrame(destBeat, bpm, sampleRate)));
                    allDeltas.push(response);
                }
                await useEngineStore.getState().applyProjectDeltas(allDeltas.flatMap((r) => r.deltas as never[]), 'shortcut-paste-cross-track');
                onClipSelectionChanged(results.map((r) => r.new_id));
            }
        } catch (err) {
            console.error('[Shortcuts] Paste clip failed:', err);
        }
        return true;
    }

    if (isModKey(e) && e.code === 'KeyX') {
        if (inPianoRoll || inDeviceRack) return true;
        e.preventDefault();
        e.stopPropagation();
        const targets = selectedClipIds.length > 0 ? selectedClipIds : (selectedClipId ? [selectedClipId] : []);
        const selected = timelineClips.filter((c) => targets.includes(c.id)).sort((a, b) => a.startBeat - b.startBeat);
        if (selected.length === 0) return true;
        clipboardRef.current = selected.map((c) => ({ ...c }));
        // Optimistic removal: instantly remove from canvas before async IPC
        const rollback = optimisticRemoveClips(selected.map((c) => c.id));
        onClipSelectionChanged([]);
        try {
            const responses = await Promise.all(selected.map((c) => engine.deleteClipWithDeltas(c.id)));
            await useEngineStore.getState().applyProjectDeltas(responses.flatMap((r) => r.deltas), 'shortcut-cut');
        } catch (err) {
            console.error('[Shortcuts] Cut clip failed:', err);
            rollback();
        }
        return true;
    }

    if ((e.key === 'Backspace' || e.key === 'Delete') && !e.repeat) {
        // Device rack, track inspector, and piano roll handle their own delete
        // independently. Piano roll uses capture + stopImmediatePropagation when
        // MIDI notes are selected, but if the event reaches us first (e.g. the
        // piano roll listener hasn't attached yet), we must bail here.
        if (inPianoRoll || (inDeviceRack && selectedDeviceId.length > 0) || getScopedEditorElement(e, 'track-inspector')) return true;
        const targets = selectedClipIds.length > 0 ? selectedClipIds : (selectedClipId ? [selectedClipId] : []);
        if (targets.length === 0) return false;
        e.preventDefault();
        e.stopPropagation();
        // Optimistic removal: instantly remove from canvas before async IPC
        const rollback = optimisticRemoveClips(targets);
        onClipSelectionChanged([]);
        try {
            const responses = await Promise.all(targets.map((id) => engine.deleteClipWithDeltas(id)));
            await useEngineStore.getState().applyProjectDeltas(responses.flatMap((r) => r.deltas), 'shortcut-delete');
        } catch (err) {
            console.error('[Shortcuts] Delete clip failed:', err);
            rollback();
        }
        return true;
    }

    if ((e.code === 'Digit0' || e.code === 'Numpad0') && !isModKey(e) && !e.shiftKey) {
        if (inPianoRoll || inDeviceRack) return true;
        e.preventDefault();
        e.stopPropagation();
        const targets = selectedClipIds.length > 0 ? selectedClipIds : (selectedClipId ? [selectedClipId] : []);
        if (targets.length === 0) return true;
        const selected = timelineClips.filter((c) => targets.includes(c.id));
        const newMutedState = selected.some((c) => !c.muted);
        try {
            const response = targets.length === 1 ? await engine.setClipMutedWithDeltas(targets[0], newMutedState) : await engine.setClipsMutedWithDeltas(targets, newMutedState);
            await useEngineStore.getState().applyProjectDeltas(response.deltas, targets.length === 1 ? 'shortcut-mute-single' : 'shortcut-mute-batch');
        } catch (err) {
            console.error('[Shortcuts] Toggle clip mute failed:', err);
        }
        return true;
    }

    if (e.code === 'KeyS' && !isModKey(e) && !e.shiftKey && !e.altKey) {
        if (inPianoRoll || inDeviceRack || !selectedTrackId || selectedTrackId === 'master' || selectedTrackIndex < 0) return true;
        e.preventDefault();
        e.stopPropagation();
        try {
            const selectedTrackIdAtIndex = trackIds[selectedTrackIndex];
            const selectedTrack = selectedTrackIdAtIndex ? tracksById[selectedTrackIdAtIndex] : undefined;
            const response = await engine.setTrackSoloWithDeltas(selectedTrackIndex, !selectedTrack?.is_solo);
            await useEngineStore.getState().applyProjectDeltas(response.deltas, 'keyboard:toggle-track-solo');
        } catch (err) {
            console.error('[Shortcuts] setTrackSolo failed:', err);
        }
        return true;
    }

    if (e.code === 'KeyM' && !isModKey(e) && !e.shiftKey && !e.altKey) {
        if (inPianoRoll || inDeviceRack || !selectedTrackId || selectedTrackId === 'master' || selectedTrackIndex < 0) return true;
        e.preventDefault();
        e.stopPropagation();
        try {
            const selectedTrackIdAtIndex = trackIds[selectedTrackIndex];
            const selectedTrack = selectedTrackIdAtIndex ? tracksById[selectedTrackIdAtIndex] : undefined;
            const response = await engine.setTrackDisabledWithDeltas(selectedTrackIndex, !selectedTrack?.is_disabled);
            await useEngineStore.getState().applyProjectDeltas(response.deltas, 'keyboard:toggle-track-disabled');
        } catch (err) {
            console.error('[Shortcuts] setTrackDisabled failed:', err);
        }
        return true;
    }

    if (e.code === 'KeyB' && !isModKey(e) && !e.shiftKey && !e.altKey) {
        if (inPianoRoll || inDeviceRack) return true;
        e.preventDefault();
        e.stopPropagation();
        const targets = selectedClipIds.length > 0 ? selectedClipIds : (selectedClipId ? [selectedClipId] : []);
        try {
            if (targets.length > 0) {
                const response = await engine.bounceSelectionToTrackWithDeltas({ clipIds: targets });
                await useEngineStore.getState().applyProjectDeltas(response.deltas, 'keyboard:bounce-selection');
            } else if (marqueeSelection) {
                const store = useEngineStore.getState();
                const bpm = store.projectBpm || store.transport.bpm || 120;
                const sr = resolveSampleRate(store.projectSampleRate, store.transport.sample_rate);
                const startBeat = Math.min(marqueeSelection.startBeat, marqueeSelection.endBeat);
                const endBeat = Math.max(marqueeSelection.startBeat, marqueeSelection.endBeat);
                if (endBeat - startBeat > 1e-6) {
                    const response = await engine.bounceSelectionToTrackWithDeltas({ rangeStartFrames: Math.max(0, beatToFrame(startBeat, bpm, sr)), rangeEndFrames: Math.max(1, beatToFrame(endBeat, bpm, sr)), startTrackIndex: Math.min(marqueeSelection.startTrack, marqueeSelection.endTrack), endTrackIndex: Math.max(marqueeSelection.startTrack, marqueeSelection.endTrack) });
                    await useEngineStore.getState().applyProjectDeltas(response.deltas, 'keyboard:bounce-time-range');
                }
            }
        } catch (err) {
            console.error('[Shortcuts] Bounce selection failed:', err);
        }
        return true;
    }

    if (isModKey(e) && e.code === 'KeyL') {
        if (inPianoRoll || inDeviceRack) return true;
        e.preventDefault();
        e.stopPropagation();
        const store = useEngineStore.getState();
        const transport = store.transport;
        const bpm = store.projectBpm || transport.bpm || 120;
        const sr = resolveSampleRate(store.projectSampleRate, transport.sample_rate);
        const marqueeStartBeat = marqueeSelection ? Math.min(marqueeSelection.startBeat, marqueeSelection.endBeat) : 0;
        const marqueeEndBeat = marqueeSelection ? Math.max(marqueeSelection.startBeat, marqueeSelection.endBeat) : 0;
        const hasMarqueeRange = Boolean(marqueeSelection) && marqueeEndBeat - marqueeStartBeat > 1e-6;
        if (hasMarqueeRange) {
            store.setLoop(true, beatToFrame(Math.max(0, marqueeStartBeat), bpm, sr), beatToFrame(Math.max(marqueeStartBeat + 0.25, marqueeEndBeat), bpm, sr));
            return true;
        }
        if (transport.loop_enabled) {
            store.setLoop(false, transport.loop_start, transport.loop_end);
            return true;
        }
        const targets = selectedClipIds.length > 0 ? selectedClipIds : (selectedClipId ? [selectedClipId] : []);
        if (targets.length === 0) {
            store.setLoop(!transport.loop_enabled, transport.loop_start, transport.loop_end);
            return true;
        }
        const selected = timelineClips.filter((c) => targets.includes(c.id));
        if (selected.length === 0) {
            store.setLoop(!transport.loop_enabled, transport.loop_start, transport.loop_end);
            return true;
        }
        let startBeat = Infinity;
        let endBeat = -Infinity;
        for (const clip of selected) {
            startBeat = Math.min(startBeat, clip.startBeat);
            endBeat = Math.max(endBeat, clip.startBeat + clip.durationBeats);
        }
        const beatsPerBar = (store as typeof store & { projectBeatsPerBar?: number }).projectBeatsPerBar ?? 4;
        if (endBeat - startBeat < beatsPerBar) endBeat = startBeat + beatsPerBar;
        store.setLoop(true, beatToFrame(startBeat, bpm, sr), beatToFrame(endBeat, bpm, sr));
        return true;
    }

    return false;
}
