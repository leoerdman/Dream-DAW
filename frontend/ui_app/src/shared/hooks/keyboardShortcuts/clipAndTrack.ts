import * as engine from '@/shared/api/engine';
import { beatToFrame, frameToBeat, resolveSampleRate } from '@/shared/lib/audioMath';
import { useEngineStore } from '@/shared/stores/useEngineStore';
import type { KeyboardShortcutHandlerEnv } from './types';
import { getScopedEditorElement, isModKey } from './utils';

export async function handleClipAndTrackShortcuts(env: KeyboardShortcutHandlerEnv): Promise<boolean> {
    const { e, ctx, clipboardRef } = env;
    const { selectedClipId, selectedClipIds, selectedTrackId, projectTracks, timelineClips, marqueeSelection, onClipSelectionChanged, inPianoRoll, inDeviceRack, selectedDeviceId, selectedTrackIndex, playheadFrames } = ctx;

    if (isModKey(e) && e.code === 'KeyJ') {
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
        const selectedTrackIdx = projectTracks.findIndex((t) => t.id === selectedTrackId);
        const trackDelta = selectedTrackIdx >= 0 ? selectedTrackIdx - anchorTrackIndex : 0;
        try {
            if (trackDelta === 0) {
                const results = await Promise.all(clipboardRef.current.map((clip) => engine.duplicateClipWithDeltas(clip.id, Math.max(0, beatToFrame(cursorBeat + (clip.startBeat - firstBeat) + groupOffset, bpm, sampleRate)))));
                await useEngineStore.getState().applyProjectDeltas(results.flatMap((r) => r.deltas), 'shortcut-paste-same-track');
                onClipSelectionChanged(results.map((r) => r.new_id));
            } else {
                const results = await Promise.all(clipboardRef.current.map((clip) => engine.duplicateClipWithDeltas(clip.id)));
                for (let i = 0; i < results.length; i += 1) {
                    const clip = clipboardRef.current[i];
                    const destBeat = Math.max(0, cursorBeat + (clip.startBeat - firstBeat) + groupOffset);
                    const targetTrack = Math.max(0, Math.min(projectTracks.length - 1, clip.trackIndex + trackDelta));
                    const response = await engine.moveClipWithDeltas(results[i].new_id, targetTrack, Math.max(0, beatToFrame(destBeat, bpm, sampleRate)));
                    await useEngineStore.getState().applyProjectDeltas(response.deltas, 'shortcut-paste-move');
                }
                await useEngineStore.getState().applyProjectDeltas(results.flatMap((r) => r.deltas), 'shortcut-paste-cross-track');
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
        try {
            const responses = await Promise.all(selected.map((c) => engine.deleteClipWithDeltas(c.id)));
            await useEngineStore.getState().applyProjectDeltas(responses.flatMap((r) => r.deltas), 'shortcut-cut');
            onClipSelectionChanged([]);
        } catch (err) {
            console.error('[Shortcuts] Cut clip failed:', err);
        }
        return true;
    }

    if ((e.key === 'Backspace' || e.key === 'Delete') && !e.repeat) {
        if ((inDeviceRack && selectedDeviceId.length > 0) || inPianoRoll || getScopedEditorElement(e, 'track-inspector')) return true;
        e.preventDefault();
        e.stopPropagation();
        const targets = selectedClipIds.length > 0 ? selectedClipIds : (selectedClipId ? [selectedClipId] : []);
        if (targets.length === 0) return true;
        try {
            const responses = await Promise.all(targets.map((id) => engine.deleteClipWithDeltas(id)));
            await useEngineStore.getState().applyProjectDeltas(responses.flatMap((r) => r.deltas), 'shortcut-delete');
            onClipSelectionChanged([]);
        } catch (err) {
            console.error('[Shortcuts] Delete clip failed:', err);
        }
        return true;
    }

    if ((e.key === '0' || e.code === 'Numpad0') && !isModKey(e) && !e.shiftKey) {
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
            const response = await engine.setTrackSoloWithDeltas(selectedTrackIndex, !projectTracks[selectedTrackIndex]?.is_solo);
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
            const response = await engine.setTrackMuteWithDeltas(selectedTrackIndex, !projectTracks[selectedTrackIndex]?.is_mute);
            await useEngineStore.getState().applyProjectDeltas(response.deltas, 'keyboard:toggle-track-mute');
        } catch (err) {
            console.error('[Shortcuts] setTrackMute failed:', err);
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

