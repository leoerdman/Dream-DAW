import * as engine from '@/shared/api/engine';
import { beatToFrame, frameToBeat, resolveSampleRate } from '@/shared/lib/audioMath';
import { useAutomationStore } from '@/shared/stores/useAutomationStore';
import { useEngineStore } from '@/shared/stores/useEngineStore';
import { useLastTouchedParamStore } from '@/shared/stores/useLastTouchedParamStore';
import { useRegionEditStore } from '@/shared/stores/useRegionEditStore';
import { useStatusStore } from '@/shared/stores/useStatusStore';
import type { KeyboardShortcutHandlerEnv } from './types';
import { matchesShortcutAction } from './utils';
import { duplicateRegion, moveRegion, normalizeRegion, swapRegions } from './transportAndEditingRegions';

type ShortcutCtx = KeyboardShortcutHandlerEnv['ctx'];

async function flushLaneToEngine(laneId: string, tag: string): Promise<void> {
    const lane = useAutomationStore.getState().lanes[laneId];
    if (!lane) return;
    const store = useEngineStore.getState();
    const currentBpm = Math.max(1, store.projectBpm || store.transport.bpm || 120);
    const currentSampleRate = resolveSampleRate(store.projectSampleRate, store.transport.sample_rate);
    const points = lane.breakpoints.map((bp) => ({
        beat: Math.max(0, frameToBeat(beatToFrame(bp.beat, currentBpm, currentSampleRate), currentBpm, currentSampleRate)),
        value: Math.max(0, Math.min(1, bp.value)),
        curveType: bp.curve === 'bezier' ? 'bezier' as const : bp.curve === 'step' ? 'step' as const : 'linear' as const,
    }));
    const response = await engine.setAutomationPointsWithDeltas(lane.trackId, lane.paramKey, points);
    await useEngineStore.getState().applyProjectDeltas(response.deltas, tag);
}

export async function handleRegionShortcuts(
    e: KeyboardEvent,
    ctx: ShortcutCtx,
): Promise<boolean> {
    const { marqueeSelection, onClipSelectionChanged, inPianoRoll, inDeviceRack } = ctx;

    if (matchesShortcutAction(e, 'region_capture_a') && !e.repeat) {
        if (inPianoRoll || inDeviceRack) return true;
        e.preventDefault();
        e.stopPropagation();
        const range = normalizeRegion(marqueeSelection);
        if (!range) {
            useStatusStore.getState().setError('Region A: marquee selection required');
            return true;
        }
        useRegionEditStore.getState().setRegionA(range);
        useStatusStore.getState().setInfo('Region A captured');
        return true;
    }

    if (matchesShortcutAction(e, 'region_capture_b') && !e.repeat) {
        if (inPianoRoll || inDeviceRack) return true;
        e.preventDefault();
        e.stopPropagation();
        const range = normalizeRegion(marqueeSelection);
        if (!range) {
            useStatusStore.getState().setError('Region B: marquee selection required');
            return true;
        }
        useRegionEditStore.getState().setRegionB(range);
        useStatusStore.getState().setInfo('Region B captured');
        return true;
    }

    if (matchesShortcutAction(e, 'region_swap_a_b') && !e.repeat) {
        if (inPianoRoll || inDeviceRack) return true;
        e.preventDefault();
        e.stopPropagation();
        const { regionA, regionB } = useRegionEditStore.getState();
        if (!regionA || !regionB) {
            useStatusStore.getState().setError('Region Swap: capture A and B first');
            return true;
        }
        try {
            const moved = await swapRegions(regionA, regionB);
            useStatusStore.getState().setInfo(`Region Swap: moved ${moved} clip(s)`);
        } catch (err) {
            useStatusStore.getState().setError(`Region Swap failed: ${String(err)}`);
        }
        return true;
    }

    if (matchesShortcutAction(e, 'region_duplicate') && !e.repeat) {
        if (inPianoRoll || inDeviceRack) return true;
        e.preventDefault();
        e.stopPropagation();
        const range = normalizeRegion(marqueeSelection);
        if (!range) {
            useStatusStore.getState().setError('Region Duplicate: marquee selection required');
            return true;
        }
        try {
            const newIds = await duplicateRegion(range);
            if (newIds.length > 0) onClipSelectionChanged(newIds);
            useStatusStore.getState().setInfo(`Region Duplicate: ${newIds.length} clip(s)`);
        } catch (err) {
            useStatusStore.getState().setError(`Region Duplicate failed: ${String(err)}`);
        }
        return true;
    }

    if (matchesShortcutAction(e, 'region_move_left') && !e.repeat) {
        if (inPianoRoll || inDeviceRack) return true;
        e.preventDefault();
        e.stopPropagation();
        const range = normalizeRegion(marqueeSelection);
        if (!range) {
            useStatusStore.getState().setError('Region Move: marquee selection required');
            return true;
        }
        try {
            const moved = await moveRegion(range, -1);
            useStatusStore.getState().setInfo(`Region Move Left: ${moved} clip(s)`);
        } catch (err) {
            useStatusStore.getState().setError(`Region Move Left failed: ${String(err)}`);
        }
        return true;
    }

    if (matchesShortcutAction(e, 'region_move_right') && !e.repeat) {
        if (inPianoRoll || inDeviceRack) return true;
        e.preventDefault();
        e.stopPropagation();
        const range = normalizeRegion(marqueeSelection);
        if (!range) {
            useStatusStore.getState().setError('Region Move: marquee selection required');
            return true;
        }
        try {
            const moved = await moveRegion(range, 1);
            useStatusStore.getState().setInfo(`Region Move Right: ${moved} clip(s)`);
        } catch (err) {
            useStatusStore.getState().setError(`Region Move Right failed: ${String(err)}`);
        }
        return true;
    }

    return false;
}

export async function handleAutomationShortcuts(
    e: KeyboardEvent,
    ctx: ShortcutCtx,
): Promise<boolean> {
    const { selectedTrackId, inPianoRoll, inDeviceRack, editCursorBeat = -1, playheadFrames } = ctx;

    if (matchesShortcutAction(e, 'toggle_track_automation_visibility') && !e.repeat) {
        if (inPianoRoll || inDeviceRack || !selectedTrackId || selectedTrackId === 'master') return true;
        e.preventDefault();
        e.stopPropagation();
        useAutomationStore.getState().toggleTrackAutomation(selectedTrackId);
        return true;
    }

    if (matchesShortcutAction(e, 'create_envelope_last_touched') && !e.repeat) {
        if (inPianoRoll || inDeviceRack || !selectedTrackId || selectedTrackId === 'master') return true;
        e.preventDefault();
        e.stopPropagation();
        const autoStore = useAutomationStore.getState();
        const touched = useLastTouchedParamStore.getState().lastTouched;
        const trackId = selectedTrackId;
        const paramName = touched?.paramName?.trim() || 'Macro 1';
        const paramKey = touched?.trackId === trackId && touched?.paramKey
            ? touched.paramKey
            : `manual:${paramName.toLowerCase().replace(/\s+/g, '_')}`;
        const lane = Object.values(autoStore.lanes).find((l) => l.trackId === trackId && l.paramKey === paramKey);
        if (!lane) autoStore.addLane(trackId, paramName, paramKey);
        autoStore.setTrackAutomationVisible(trackId, true);
        if (!autoStore.globalVisible) autoStore.toggleGlobalVisible();
        return true;
    }

    if (matchesShortcutAction(e, 'create_automation_item') && !e.repeat) {
        if (inPianoRoll || inDeviceRack || !selectedTrackId || selectedTrackId === 'master') return true;
        e.preventDefault();
        e.stopPropagation();
        const autoStore = useAutomationStore.getState();
        const touched = useLastTouchedParamStore.getState().lastTouched;
        const trackId = selectedTrackId;
        const paramName = touched?.paramName?.trim() || 'Macro 1';
        const paramKey = touched?.trackId === trackId && touched?.paramKey
            ? touched.paramKey
            : `manual:${paramName.toLowerCase().replace(/\s+/g, '_')}`;
        let lane = Object.values(autoStore.lanes).find((l) => l.trackId === trackId && l.paramKey === paramKey);
        if (!lane) {
            const laneId = autoStore.addLane(trackId, paramName, paramKey);
            lane = useAutomationStore.getState().lanes[laneId];
        }
        const store = useEngineStore.getState();
        const bpm = Math.max(1, store.projectBpm || store.transport.bpm || 120);
        const sampleRate = resolveSampleRate(store.projectSampleRate, store.transport.sample_rate);
        const cursorBeat = Number.isFinite(editCursorBeat) && editCursorBeat >= 0
            ? editCursorBeat
            : frameToBeat(playheadFrames, bpm, sampleRate);
        const beatsPerBar = (store as typeof store & { projectBeatsPerBar?: number }).projectBeatsPerBar ?? 4;
        if (lane) {
            autoStore.createAutomationItem(lane.id, cursorBeat, beatsPerBar);
            await flushLaneToEngine(lane.id, 'shortcut:create-automation-item');
            autoStore.setTrackAutomationVisible(trackId, true);
            if (!autoStore.globalVisible) autoStore.toggleGlobalVisible();
        }
        return true;
    }

    if (matchesShortcutAction(e, 'delete_automation_item') && !e.repeat) {
        if (inPianoRoll || inDeviceRack || !selectedTrackId || selectedTrackId === 'master') return true;
        e.preventDefault();
        e.stopPropagation();
        const autoStore = useAutomationStore.getState();
        const touched = useLastTouchedParamStore.getState().lastTouched;
        const trackId = selectedTrackId;
        const paramKey = touched?.trackId === trackId && touched?.paramKey ? touched.paramKey : null;
        const lane = Object.values(autoStore.lanes).find((l) =>
            l.trackId === trackId && (paramKey ? l.paramKey === paramKey : true));
        if (!lane) return true;
        const store = useEngineStore.getState();
        const bpm = Math.max(1, store.projectBpm || store.transport.bpm || 120);
        const sampleRate = resolveSampleRate(store.projectSampleRate, store.transport.sample_rate);
        const cursorBeat = Number.isFinite(editCursorBeat) && editCursorBeat >= 0
            ? editCursorBeat
            : frameToBeat(playheadFrames, bpm, sampleRate);
        const changed = autoStore.deleteNearestAutomationItem(lane.id, cursorBeat);
        if (changed) await flushLaneToEngine(lane.id, 'shortcut:delete-automation-item');
        return true;
    }

    return false;
}

export async function handlePitchShortcuts(
    e: KeyboardEvent,
    ctx: ShortcutCtx,
): Promise<boolean> {
    const { selectedClipId, selectedClipIds, timelineClips, inPianoRoll, inDeviceRack } = ctx;

    if (matchesShortcutAction(e, 'pitch_plus_12') && !e.repeat) {
        if (inPianoRoll || inDeviceRack) return true;
        e.preventDefault();
        e.stopPropagation();
        const targets = selectedClipIds.length > 0 ? selectedClipIds : (selectedClipId ? [selectedClipId] : []);
        if (targets.length === 0) return true;
        const targetClips = timelineClips.filter((clip) => targets.includes(clip.id));
        if (targetClips.length === 0) return true;
        try {
            const responses = await Promise.all(
                targetClips.map((clip) => {
                    const currentPitch = Number.isFinite(clip.pitchShiftSemitones ?? NaN) ? (clip.pitchShiftSemitones ?? 0) : 0;
                    const nextPitch = Math.max(-48, Math.min(48, currentPitch + 12));
                    return engine.setClipPitchWithDeltas({ clipId: clip.id, pitchShiftSemitones: nextPitch });
                }),
            );
            await useEngineStore.getState().applyProjectDeltas(responses.flatMap((r) => r.deltas), 'shortcut:pitch-plus-12');
        } catch (err) {
            console.error('[Shortcuts] Pitch +12 failed:', err);
        }
        return true;
    }

    if (matchesShortcutAction(e, 'pitch_minus_12') && !e.repeat) {
        if (inPianoRoll || inDeviceRack) return true;
        e.preventDefault();
        e.stopPropagation();
        const targets = selectedClipIds.length > 0 ? selectedClipIds : (selectedClipId ? [selectedClipId] : []);
        if (targets.length === 0) return true;
        const targetClips = timelineClips.filter((clip) => targets.includes(clip.id));
        if (targetClips.length === 0) return true;
        try {
            const responses = await Promise.all(
                targetClips.map((clip) => {
                    const currentPitch = Number.isFinite(clip.pitchShiftSemitones ?? NaN) ? (clip.pitchShiftSemitones ?? 0) : 0;
                    const nextPitch = Math.max(-48, Math.min(48, currentPitch - 12));
                    return engine.setClipPitchWithDeltas({ clipId: clip.id, pitchShiftSemitones: nextPitch });
                }),
            );
            await useEngineStore.getState().applyProjectDeltas(responses.flatMap((r) => r.deltas), 'shortcut:pitch-minus-12');
        } catch (err) {
            console.error('[Shortcuts] Pitch -12 failed:', err);
        }
        return true;
    }

    return false;
}
