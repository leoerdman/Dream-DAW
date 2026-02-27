import * as engine from '@/shared/api/engine';
import { beatToFrame, frameToBeat, resolveBpm, resolveSampleRate } from '@/shared/lib/audioMath';
import { useEngineStore } from '@/shared/stores/useEngineStore';
import { useGridStore } from '@/shared/stores/useGridStore';
import { useStatusStore } from '@/shared/stores/useStatusStore';
import { resolveSplitFrame } from './utils';
import type { KeyboardShortcutHandlerEnv } from './types';

function resolveNudgeStepLabel(coarse: boolean): string {
    const grid = useGridStore.getState();
    if (grid.division === 'OFF') return coarse ? 'free x4' : 'free';
    if (grid.division === 'ADAPTIVE') return coarse ? 'adaptive x4' : 'adaptive';
    const tripletSuffix = grid.triplet ? 'T' : '';
    return coarse ? `${grid.division}${tripletSuffix} x4` : `${grid.division}${tripletSuffix}`;
}

export async function splitSelectedClipsAtCursor(ctx: KeyboardShortcutHandlerEnv['ctx']): Promise<string[] | null> {
    const {
        selectedClipId,
        selectedClipIds,
        editCursorBeat = -1,
        timelineClips,
        marqueeSelection,
        playheadFrames,
        selectedTrackIndex,
    } = ctx;
    const splitFrame = resolveSplitFrame(playheadFrames, editCursorBeat);
    const store = useEngineStore.getState();
    const bpm = resolveBpm(store.transport.bpm);
    const sampleRate = resolveSampleRate(store.projectSampleRate, store.transport.sample_rate);
    const splitBeat = Number.isFinite(editCursorBeat) && editCursorBeat >= 0 ? editCursorBeat : frameToBeat(playheadFrames, bpm, sampleRate);
    const hasThinMultiCursor = Boolean(
        marqueeSelection
        && Math.abs(marqueeSelection.endBeat - marqueeSelection.startBeat) <= 1e-6
        && marqueeSelection.startTrack !== marqueeSelection.endTrack,
    );
    const targets = selectedClipIds.length > 0 ? selectedClipIds : (selectedClipId ? [selectedClipId] : []);
    const EPS = 1e-6;
    const containsSplit = (clip: (typeof timelineClips)[number]) => splitBeat > clip.startBeat + EPS && splitBeat < clip.startBeat + clip.durationBeats - EPS;
    let clipsAtPlayhead = (targets.length > 0 ? timelineClips.filter((clip) => targets.includes(clip.id)) : timelineClips.filter((clip) => clip.trackIndex === selectedTrackIndex)).filter(containsSplit);
    if (hasThinMultiCursor && marqueeSelection) {
        const minTrack = Math.min(marqueeSelection.startTrack, marqueeSelection.endTrack);
        const maxTrack = Math.max(marqueeSelection.startTrack, marqueeSelection.endTrack);
        clipsAtPlayhead = timelineClips.filter((clip) => clip.trackIndex >= minTrack && clip.trackIndex <= maxTrack).filter(containsSplit);
    }
    if (clipsAtPlayhead.length === 0) return null;
    const batchedDeltas: engine.ProjectDelta[] = [];
    for (const clip of clipsAtPlayhead) {
        const response = await engine.splitClipWithDeltas(clip.id, splitFrame);
        batchedDeltas.push(...response.deltas);
    }
    await useEngineStore.getState().applyProjectDeltas(batchedDeltas, 'keyboard:split-clips');
    return clipsAtPlayhead.map((clip) => clip.id);
}

// BUG-B08 FIX: In-flight guard prevents rapid Ctrl+D from creating overlapping duplicates.
let _duplicateInFlight = false;

export async function duplicateSelectedClips(ctx: KeyboardShortcutHandlerEnv['ctx']): Promise<string[] | null> {
    if (_duplicateInFlight) return null;
    _duplicateInFlight = true;
    try {
        const {
            selectedClipId,
            selectedClipIds,
            timelineClips,
            onClipSelectionChanged,
        } = ctx;
        const targets = selectedClipIds.length > 0 ? selectedClipIds : (selectedClipId ? [selectedClipId] : []);
        if (targets.length === 0) return null;
        const selected = timelineClips.filter((c) => targets.includes(c.id)).sort((a, b) => a.startBeat - b.startBeat);
        if (selected.length === 0) return null;
        const store = useEngineStore.getState();
        const bpm = resolveBpm(store.transport.bpm);
        let minStart = Infinity;
        let maxEnd = -Infinity;
        for (const c of selected) {
            if (c.startBeat < minStart) minStart = c.startBeat;
            const end = c.startBeat + c.durationBeats;
            if (end > maxEnd) maxEnd = end;
        }
        const spanBeats = Math.max(0.0001, maxEnd - minStart);
        const sampleRate = resolveSampleRate(store.projectSampleRate);
        const results = await Promise.all(selected.map((clip) => engine.duplicateClipWithDeltas(clip.id, Math.max(0, beatToFrame(clip.startBeat + spanBeats, bpm, sampleRate)))));
        await useEngineStore.getState().applyProjectDeltas(results.flatMap((r) => r.deltas), 'keyboard:duplicate-clips');
        const nextSelection = results.map((r) => r.new_id);
        onClipSelectionChanged(nextSelection);
        useStatusStore.getState().setInfo(`Duplicate: ${nextSelection.length} clip(s)`);
        return nextSelection;
    } finally {
        _duplicateInFlight = false;
    }
}

export async function nudgeSelectedClips(
    ctx: KeyboardShortcutHandlerEnv['ctx'],
    direction: -1 | 1,
    coarse: boolean,
): Promise<string[] | null> {
    const { selectedClipId, selectedClipIds, timelineClips } = ctx;
    const targets = selectedClipIds.length > 0 ? selectedClipIds : (selectedClipId ? [selectedClipId] : []);
    if (targets.length === 0) return null;
    const selected = timelineClips.filter((clip) => targets.includes(clip.id));
    if (selected.length === 0) return null;

    const gridState = useGridStore.getState();
    const baseStep = Math.max(0.0001, gridState.gridInterval(4) || 0.25);
    const stepBeats = baseStep * (coarse ? 4 : 1);
    let deltaBeats = stepBeats * direction;
    if (deltaBeats < 0) {
        let minStart = Infinity;
        for (const clip of selected) minStart = Math.min(minStart, clip.startBeat);
        deltaBeats = Math.max(-minStart, deltaBeats);
        if (Math.abs(deltaBeats) <= 1e-9) return selected.map((clip) => clip.id);
    }

    const store = useEngineStore.getState();
    const bpm = resolveBpm(store.transport.bpm);
    const sampleRate = resolveSampleRate(store.projectSampleRate, store.transport.sample_rate);
    const responses = await Promise.all(selected.map((clip) => {
        const nextBeat = Math.max(0, clip.startBeat + deltaBeats);
        return engine.moveClipWithDeltas(clip.id, clip.trackIndex, Math.max(0, beatToFrame(nextBeat, bpm, sampleRate)));
    }));
    await useEngineStore.getState().applyProjectDeltas(responses.flatMap((response) => response.deltas), 'keyboard:nudge-time');
    const stepLabel = resolveNudgeStepLabel(coarse);
    useStatusStore.getState().setInfo(`Nudge ${direction < 0 ? 'left' : 'right'} ${stepLabel} (${selected.length} clip(s))`);
    return selected.map((clip) => clip.id);
}

export async function nudgeSelectedClipsTrack(
    ctx: KeyboardShortcutHandlerEnv['ctx'],
    direction: -1 | 1,
    coarse: boolean,
): Promise<string[] | null> {
    const { selectedClipId, selectedClipIds, timelineClips, trackIds } = ctx;
    const targets = selectedClipIds.length > 0 ? selectedClipIds : (selectedClipId ? [selectedClipId] : []);
    if (targets.length === 0) return null;
    const selected = timelineClips.filter((clip) => targets.includes(clip.id));
    if (selected.length === 0) return null;

    const maxTrackIndex = Math.max(0, trackIds.length - 1);
    let minTrack = Infinity;
    let maxTrack = -Infinity;
    for (const clip of selected) {
        minTrack = Math.min(minTrack, clip.trackIndex);
        maxTrack = Math.max(maxTrack, clip.trackIndex);
    }
    const desiredDelta = (coarse ? 4 : 1) * direction;
    const minDelta = -minTrack;
    const maxDelta = maxTrackIndex - maxTrack;
    const deltaTrack = Math.max(minDelta, Math.min(maxDelta, desiredDelta));
    if (deltaTrack === 0) return selected.map((clip) => clip.id);

    const store = useEngineStore.getState();
    const bpm = resolveBpm(store.transport.bpm);
    const sampleRate = resolveSampleRate(store.projectSampleRate, store.transport.sample_rate);
    const responses = await Promise.all(selected.map((clip) => {
        const nextTrack = Math.max(0, Math.min(maxTrackIndex, clip.trackIndex + deltaTrack));
        return engine.moveClipWithDeltas(clip.id, nextTrack, Math.max(0, beatToFrame(clip.startBeat, bpm, sampleRate)));
    }));
    await useEngineStore.getState().applyProjectDeltas(responses.flatMap((response) => response.deltas), 'keyboard:nudge-track');
    const stepLabel = resolveNudgeStepLabel(coarse);
    useStatusStore.getState().setInfo(`Nudge ${direction < 0 ? 'up' : 'down'} ${Math.abs(deltaTrack)} track(s) • ${stepLabel} (${selected.length} clip(s))`);
    return selected.map((clip) => clip.id);
}
