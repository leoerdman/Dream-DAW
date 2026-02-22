import * as engine from '@/shared/api/engine';
import { beatDurationToFrames, beatToFrame, frameToBeat, resolveSampleRate } from '@/shared/lib/audioMath';
import { useEngineStore } from '@/shared/stores/useEngineStore';
import type { KeyboardShortcutHandlerEnv } from './types';
import { isModKey, resolveSplitFrame } from './utils';

export async function handleTransportAndEditingShortcuts(env: KeyboardShortcutHandlerEnv): Promise<boolean> {
    const { e, ctx } = env;
    const {
        selectedClipId,
        selectedClipIds,
        selectedTrackId,
        projectTracks,
        editCursorBeat = -1,
        timelineClips,
        marqueeSelection,
        onTogglePlayback,
        onClipSelectionChanged,
        playheadFrames,
        inPianoRoll,
        inDeviceRack,
        selectedTrackIndex,
        insertAfterIndex,
    } = ctx;

    if (e.code === 'Space' && !e.repeat) {
        e.preventDefault();
        e.stopPropagation();
        const transportState = useEngineStore.getState().transport;
        if (!transportState.is_playing) {
            void engine.stopPreview().catch((err) => {
                console.warn('[Keyboard] stopPreview before playback failed:', err);
            });
        }
        onTogglePlayback();
        return true;
    }

    if (isModKey(e) && !e.shiftKey && e.code === 'KeyZ' && !e.repeat) {
        e.preventDefault();
        e.stopPropagation();
        try {
            const response = await engine.undoWithDeltas();
            await useEngineStore.getState().applyProjectDeltas(response.deltas, 'keyboard-undo');
        } catch (err) {
            console.warn('[Keyboard] Undo failed:', err);
        }
        return true;
    }

    const isRedo = (isModKey(e) && e.shiftKey && e.code === 'KeyZ') || (e.ctrlKey && !e.shiftKey && !e.metaKey && e.code === 'KeyY');
    if (isRedo && !e.repeat) {
        e.preventDefault();
        e.stopPropagation();
        try {
            const response = await engine.redoWithDeltas();
            await useEngineStore.getState().applyProjectDeltas(response.deltas, 'keyboard-redo');
        } catch (err) {
            console.warn('[Keyboard] Redo failed:', err);
        }
        return true;
    }

    if (isModKey(e) && !e.shiftKey && e.code === 'KeyT') {
        e.preventDefault();
        e.stopPropagation();
        try {
            const response = await engine.addTrackWithDeltasAdvanced('audio', insertAfterIndex, undefined, selectedTrackId && selectedTrackId !== 'master' ? selectedTrackId : null);
            await useEngineStore.getState().applyProjectDeltas(response.deltas, 'keyboard:add-track-audio');
        } catch (err) {
            console.error('[Shortcuts] New audio track failed:', err);
        }
        return true;
    }

    if (isModKey(e) && e.shiftKey && e.code === 'KeyT') {
        e.preventDefault();
        e.stopPropagation();
        try {
            const response = await engine.addTrackWithDeltasAdvanced('midi', insertAfterIndex, undefined, selectedTrackId && selectedTrackId !== 'master' ? selectedTrackId : null);
            await useEngineStore.getState().applyProjectDeltas(response.deltas, 'keyboard:add-track-midi');
        } catch (err) {
            console.error('[Shortcuts] New MIDI track failed:', err);
        }
        return true;
    }

    if (isModKey(e) && e.shiftKey && e.code === 'KeyM') {
        if (inPianoRoll || inDeviceRack || !marqueeSelection) return true;
        e.preventDefault();
        e.stopPropagation();
        const minTrack = Math.min(marqueeSelection.startTrack, marqueeSelection.endTrack);
        const maxTrack = Math.max(marqueeSelection.startTrack, marqueeSelection.endTrack);
        const store = useEngineStore.getState();
        const bpm = Math.max(1, store.projectBpm || store.transport.bpm || 120);
        const sampleRate = resolveSampleRate(store.projectSampleRate, store.transport.sample_rate);
        const startBeat = Math.min(marqueeSelection.startBeat, marqueeSelection.endBeat);
        const endBeat = Math.max(marqueeSelection.startBeat, marqueeSelection.endBeat);
        const durationBeats = Math.max(0.25, endBeat - startBeat);
        const positionFrames = Math.max(0, beatToFrame(startBeat, bpm, sampleRate));
        const durationFrames = Math.max(1, beatDurationToFrames(durationBeats, bpm, sampleRate));
        const midiTrackIndices: number[] = [];
        for (let i = minTrack; i <= maxTrack; i += 1) {
            const track = projectTracks[i];
            if (!track) continue;
            const trackType = (track.track_type ?? '').toLowerCase();
            if (!trackType.includes('midi')) continue;
            if (trackType.includes('group') || trackType.includes('master') || trackType.includes('bus') || trackType.includes('return')) continue;
            midiTrackIndices.push(i);
        }
        if (midiTrackIndices.length === 0) return true;
        try {
            await Promise.all(midiTrackIndices.map((trackIndex) => engine.createMidiClipWithDeltas(trackIndex, positionFrames, durationFrames).then((r) => useEngineStore.getState().applyProjectDeltas(r.deltas, 'keyboard:create-midi-clip-range'))));
        } catch (err) {
            console.error('[Shortcuts] Create MIDI clips from box failed:', err);
        }
        return true;
    }

    if (isModKey(e) && e.code === 'KeyE' && !e.repeat) {
        if (inPianoRoll || inDeviceRack) return true;
        e.preventDefault();
        e.stopPropagation();
        try {
            const splitFrame = resolveSplitFrame(playheadFrames, editCursorBeat);
            const store = useEngineStore.getState();
            const bpm = Math.max(1, store.projectBpm || store.transport.bpm || 120);
            const sampleRate = resolveSampleRate(store.projectSampleRate, store.transport.sample_rate);
            const splitBeat = Number.isFinite(editCursorBeat) && editCursorBeat >= 0 ? editCursorBeat : frameToBeat(playheadFrames, bpm, sampleRate);
            const hasThinMultiCursor = Boolean(marqueeSelection) && Math.abs((marqueeSelection?.endBeat ?? 0) - (marqueeSelection?.startBeat ?? 0)) <= 1e-6 && marqueeSelection.startTrack !== marqueeSelection.endTrack;
            const targets = selectedClipIds.length > 0 ? selectedClipIds : (selectedClipId ? [selectedClipId] : []);
            const EPS = 1e-6;
            const containsSplit = (clip: (typeof timelineClips)[number]) => splitBeat > clip.startBeat + EPS && splitBeat < clip.startBeat + clip.durationBeats - EPS;
            let clipsAtPlayhead = (targets.length > 0 ? timelineClips.filter((clip) => targets.includes(clip.id)) : timelineClips.filter((clip) => clip.trackIndex === selectedTrackIndex)).filter(containsSplit);
            if (hasThinMultiCursor && marqueeSelection) {
                const minTrack = Math.min(marqueeSelection.startTrack, marqueeSelection.endTrack);
                const maxTrack = Math.max(marqueeSelection.startTrack, marqueeSelection.endTrack);
                clipsAtPlayhead = timelineClips.filter((clip) => clip.trackIndex >= minTrack && clip.trackIndex <= maxTrack).filter(containsSplit);
            }
            if (clipsAtPlayhead.length === 0) return true;
            const batchedDeltas: engine.ProjectDelta[] = [];
            for (const clip of clipsAtPlayhead) {
                const response = await engine.splitClipWithDeltas(clip.id, splitFrame);
                batchedDeltas.push(...response.deltas);
            }
            await useEngineStore.getState().applyProjectDeltas(batchedDeltas, 'shortcut-split');
        } catch (err) {
            console.error('[Shortcuts] Split clip failed:', err);
        }
        return true;
    }

    if (isModKey(e) && e.code === 'KeyD') {
        if (inPianoRoll || inDeviceRack) return true;
        e.preventDefault();
        e.stopPropagation();
        const targets = selectedClipIds.length > 0 ? selectedClipIds : (selectedClipId ? [selectedClipId] : []);
        if (targets.length === 0) return true;
        const selected = timelineClips.filter((c) => targets.includes(c.id)).sort((a, b) => a.startBeat - b.startBeat);
        if (selected.length === 0) return true;
        const store = useEngineStore.getState();
        const bpm = Math.max(1, store.projectBpm || store.transport.bpm || 120);
        let minStart = Infinity;
        let maxEnd = -Infinity;
        for (const c of selected) {
            if (c.startBeat < minStart) minStart = c.startBeat;
            const end = c.startBeat + c.durationBeats;
            if (end > maxEnd) maxEnd = end;
        }
        const spanBeats = Math.max(0.0001, maxEnd - minStart);
        const sampleRate = resolveSampleRate(store.projectSampleRate);
        try {
            const results = await Promise.all(selected.map((clip) => engine.duplicateClipWithDeltas(clip.id, Math.max(0, beatToFrame(clip.startBeat + spanBeats, bpm, sampleRate)))));
            await useEngineStore.getState().applyProjectDeltas(results.flatMap((r) => r.deltas), 'shortcut-duplicate');
            onClipSelectionChanged(results.map((r) => r.new_id));
        } catch (err) {
            console.error('[Shortcuts] Duplicate clip failed:', err);
        }
        return true;
    }

    return false;
}

