import * as engine from '@/shared/api/engine';
import { clamp01, clampPitchShift, DEFAULT_TIME_SIG_NUMERATOR, frameToBeat, resolveBpm, resolveSampleRate } from '@/shared/lib/audioMath';
import { useAutomationStore } from '@/shared/stores/useAutomationStore';
import { useEngineStore } from '@/shared/stores/useEngineStore';
import { selectAllClips } from '@/shared/stores/entitySelectors';
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
    const points = lane.breakpoints.map((bp) => ({
        // BUG-E005 FIX: Keep beats as-is — no beat→frame→beat round-trip that causes drift.
        beat: Math.max(0, bp.beat),
        value: clamp01(bp.value),
        curveType: bp.curve === 'bezier' ? 'bezier' as const : bp.curve === 'step' ? 'step' as const : 'linear' as const,
    }));
    const response = await engine.setAutomationPointsWithDeltas(lane.trackId, lane.paramKey, points);
    await useEngineStore.getState().applyProjectDeltas(response.deltas, tag);
}

export async function handleRegionShortcuts(
    e: KeyboardEvent,
    ctx: ShortcutCtx,
): Promise<boolean> {
    const { marqueeSelection, onClipSelectionChanged, activePanel } = ctx;

    if (matchesShortcutAction(e, 'region_capture_a') && !e.repeat) {
        if (activePanel !== 'arrangement') return false;
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
        if (activePanel !== 'arrangement') return false;
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
        if (activePanel !== 'arrangement') return false;
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
        if (activePanel !== 'arrangement') return false;
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
        if (activePanel !== 'arrangement') return false;
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
        if (activePanel !== 'arrangement') return false;
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
    const { selectedTrackId, activePanel, editCursorBeat = -1, playheadFrames } = ctx;

    if (matchesShortcutAction(e, 'toggle_track_automation_visibility') && !e.repeat) {
        if (activePanel !== 'arrangement' || !selectedTrackId || selectedTrackId === 'master') return false;
        e.preventDefault();
        e.stopPropagation();
        useAutomationStore.getState().toggleTrackAutomation(selectedTrackId);
        return true;
    }

    if (matchesShortcutAction(e, 'create_envelope_last_touched') && !e.repeat) {
        if (activePanel !== 'arrangement' || !selectedTrackId || selectedTrackId === 'master') return false;
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
        if (activePanel !== 'arrangement' || !selectedTrackId || selectedTrackId === 'master') return false;
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
        const bpm = resolveBpm(store.transport.bpm);
        const sampleRate = resolveSampleRate(store.projectSampleRate, store.transport.sample_rate);
        const cursorBeat = Number.isFinite(editCursorBeat) && editCursorBeat >= 0
            ? editCursorBeat
            : frameToBeat(playheadFrames, bpm, sampleRate);
        // BUG-A002 FIX: Use actual store property instead of phantom type-cast that always returned 4.
        const beatsPerBar = store.transport.time_sig_numerator ?? DEFAULT_TIME_SIG_NUMERATOR;
        if (lane) {
            autoStore.createAutomationItem(lane.id, cursorBeat, beatsPerBar);
            await flushLaneToEngine(lane.id, 'shortcut:create-automation-item');
            autoStore.setTrackAutomationVisible(trackId, true);
            if (!autoStore.globalVisible) autoStore.toggleGlobalVisible();
        }
        return true;
    }

    if (matchesShortcutAction(e, 'delete_automation_item') && !e.repeat) {
        if (activePanel !== 'arrangement' || !selectedTrackId || selectedTrackId === 'master') return false;
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
        const bpm = resolveBpm(store.transport.bpm);
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
    const { selectedClipId, selectedClipIds, activePanel } = ctx;
    const timelineClips = selectAllClips(useEngineStore.getState());

    if (matchesShortcutAction(e, 'pitch_plus_12') && !e.repeat) {
        if (activePanel !== 'arrangement') return false;
        e.preventDefault();
        e.stopPropagation();
        const targets = selectedClipIds.length > 0 ? selectedClipIds : (selectedClipId ? [selectedClipId] : []);
        if (targets.length === 0) return true;
        const targetClips = timelineClips.filter((clip) => targets.includes(clip.id));
        if (targetClips.length === 0) return true;
        try {
            // SSOT FIX: Sequential pitch changes with batched delta apply.
            const batchedDeltas: engine.ProjectDelta[] = [];
            for (const clip of targetClips) {
                const currentPitch = Number.isFinite(clip.pitchShiftSemitones ?? NaN) ? (clip.pitchShiftSemitones ?? 0) : 0;
                const nextPitch = clampPitchShift(currentPitch + 12);
                const r = await engine.setClipPitchWithDeltas({ clipId: clip.id, pitchShiftSemitones: nextPitch });
                batchedDeltas.push(...r.deltas);
            }
            await useEngineStore.getState().applyProjectDeltas(batchedDeltas, 'shortcut:pitch-plus-12');
        } catch (err) {
            console.error('[Shortcuts] Pitch +12 failed:', err);
        }
        return true;
    }

    if (matchesShortcutAction(e, 'pitch_minus_12') && !e.repeat) {
        if (activePanel !== 'arrangement') return false;
        e.preventDefault();
        e.stopPropagation();
        const targets = selectedClipIds.length > 0 ? selectedClipIds : (selectedClipId ? [selectedClipId] : []);
        if (targets.length === 0) return true;
        const targetClips = timelineClips.filter((clip) => targets.includes(clip.id));
        if (targetClips.length === 0) return true;
        try {
            // SSOT FIX: Sequential pitch changes with batched delta apply.
            const batchedDeltas: engine.ProjectDelta[] = [];
            for (const clip of targetClips) {
                const currentPitch = Number.isFinite(clip.pitchShiftSemitones ?? NaN) ? (clip.pitchShiftSemitones ?? 0) : 0;
                const nextPitch = clampPitchShift(currentPitch - 12);
                const r = await engine.setClipPitchWithDeltas({ clipId: clip.id, pitchShiftSemitones: nextPitch });
                batchedDeltas.push(...r.deltas);
            }
            await useEngineStore.getState().applyProjectDeltas(batchedDeltas, 'shortcut:pitch-minus-12');
        } catch (err) {
            console.error('[Shortcuts] Pitch -12 failed:', err);
        }
        return true;
    }

    return false;
}
