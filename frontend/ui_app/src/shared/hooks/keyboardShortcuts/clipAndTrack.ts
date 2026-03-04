import * as engine from '@/shared/api/engine';
import { beatToFrame, frameToBeat, resolveBpm, resolveSampleRate, DEFAULT_TIME_SIG_NUMERATOR } from '@/shared/lib/audioMath';
import { useEngineStore } from '@/shared/stores/useEngineStore';
import type { TimelineClip } from '@/shared/lib/arrangementTypes';
import type { KeyboardShortcutHandlerEnv } from './types';
import { getScopedEditorElement, isModKey, matchesShortcutAction } from './utils';
import { extractNewClipIdsFromDeltas } from '@/shared/lib/clipDeltaUtils';
import {
    normalizeRegion,
    splitRegionBoundaries,
    collectRegionClips,
    collectOverlappingClips,
} from './transportAndEditingRegions';

/**
 * ENTERPRISE: Module-level region bounds stored alongside clipboard clips.
 * When a marquee selection is active during Cmd+C, its bounds are captured.
 * During Cmd+V, the region width (not clip bounding box) is used for offset,
 * preserving empty space within the copied region.
 */
let _clipboardRegionBounds: { startBeat: number; endBeat: number } | null = null;

/**
 * Optimistically removes clips from the engine store state so the canvas
 * redraws immediately, without waiting for the async IPC round-trip.
 * Returns a rollback function that restores the previous state on failure.
 * SSOT: All three state containers are derived from a single filtered array.
 */
function optimisticRemoveClips(clipIds: string[]): () => void {
    const idSet = new Set(clipIds);
    const state = useEngineStore.getState();
    const snapshot = {
        timelineClips: state.timelineClips,
        clipsById: state.clipsById,
        clips: state.clips,
    };

    const nextTimelineClips = state.timelineClips.filter((c: TimelineClip) => !idSet.has(c.id));
    // SSOT: Derive maps from the single filtered array — no independent construction.
    const nextClipsById: Record<string, TimelineClip> = {};
    const nextAllIds: string[] = [];
    for (const c of nextTimelineClips) {
        nextClipsById[c.id] = c;
        nextAllIds.push(c.id);
    }
    useEngineStore.setState({
        timelineClips: nextTimelineClips,
        clipsById: nextClipsById,
        clips: { byId: nextClipsById, allIds: nextAllIds },
    });

    return () => useEngineStore.setState(snapshot);
}

export async function handleClipAndTrackShortcuts(env: KeyboardShortcutHandlerEnv): Promise<boolean> {
    const { e, ctx, clipboardRef } = env;
    const { selectedClipId, selectedClipIds, selectedTrackId, trackIds, tracksById, timelineClips, marqueeSelection, onClipSelectionChanged, activePanel, selectedTrackIndex, playheadFrames } = ctx;

    if (matchesShortcutAction(e, 'glue_clips')) {
        if (activePanel !== 'arrangement') return false;
        e.preventDefault();
        e.stopPropagation();

        try {
            // [ENTERPRISE FIX]: Support Cmd+J MIDI consolidation via Marquee
            const range = marqueeSelection ? normalizeRegion(marqueeSelection) : null;
            if (range && range.startTrack === range.endTrack) {
                const track = tracksById[range.startTrack];
                if (track?.track_type === 'midi') {
                    const store = useEngineStore.getState();
                    const bpm = resolveBpm(store.transport.bpm);
                    const sampleRate = resolveSampleRate(store.projectSampleRate, store.transport.sample_rate);
                    const startFrame = Math.max(0, Math.floor(beatToFrame(range.startBeat, bpm, sampleRate)));
                    const endFrame = Math.max(0, Math.floor(beatToFrame(range.endBeat, bpm, sampleRate)));
                    const durationFrames = endFrame - startFrame;

                    if (durationFrames > 0) {
                        const response = await engine.consolidateMidiRegionWithDeltas(
                            range.startTrack,
                            startFrame,
                            durationFrames
                        );
                        await store.applyProjectDeltas(response.deltas, 'shortcut-consolidate-midi');
                        // marqueeSelection is automatically cleared by DawShell when setting clip selection
                        onClipSelectionChanged([response.new_id]);
                        return true;
                    }
                }
            }

            const targets = selectedClipIds.length > 0 ? selectedClipIds : (selectedClipId ? [selectedClipId] : []);
            if (targets.length === 0) return true;
            const selected = timelineClips.filter((c) => targets.includes(c.id));
            if (selected.length === 0) return true;

            const hasAudio = selected.some((c) => c.type === 'audio');
            if (hasAudio) {
                const response = await engine.consolidateSelectionWithDeltas({ clipIds: selected.map(c => c.id) });
                await useEngineStore.getState().applyProjectDeltas(response.deltas, 'shortcut-consolidate-clips');
            } else {
                // For MIDI, we keep the existing merge logic if they are on same track for now
                if (selected.length >= 2 && selected.every((c) => c.trackIndex === selected[0].trackIndex)) {
                    const response = await engine.mergeClipsWithDeltas(selected.map((c) => c.id));
                    await useEngineStore.getState().applyProjectDeltas(response.deltas, 'shortcut-merge');
                }
            }
        } catch (err) {
            console.error('[Shortcuts] Merge/Bounce clips failed:', err);
        }
        return true;
    }

    if (isModKey(e) && e.code === 'KeyC') {
        if (activePanel !== 'arrangement') return false;
        e.preventDefault();
        e.stopPropagation();

        // ENTERPRISE: Non-destructive region-based copy (per Ableton/Logic best practice).
        // Copy does NOT split clips. It captures overlapping clips with region bounds.
        // Splitting only happens during destructive operations (Cut/Delete/Duplicate).
        const range = normalizeRegion(marqueeSelection);
        if (range) {
            const regionClips = collectOverlappingClips(range);
            if (regionClips.length > 0) {
                clipboardRef.current = regionClips.map((c) => ({ ...c }));
                _clipboardRegionBounds = {
                    startBeat: range.startBeat,
                    endBeat: range.endBeat,
                };
                void engine.copyClipsToGlobalClipboard(regionClips.map((c) => c.id));
            }
            return true;
        }

        // Fallback: whole-clip copy (no marquee)
        const targets = selectedClipIds.length > 0 ? selectedClipIds : (selectedClipId ? [selectedClipId] : []);
        const selected = timelineClips.filter((c) => targets.includes(c.id)).sort((a, b) => a.startBeat - b.startBeat);
        if (selected.length > 0) {
            clipboardRef.current = selected.map((c) => ({ ...c }));
            _clipboardRegionBounds = null;
            void engine.copyClipsToGlobalClipboard(selected.map((c) => c.id));
        } else if (selectedTrackIndex >= 0) {
            clipboardRef.current = [];
            _clipboardRegionBounds = null;
            void engine.copyTrackToGlobalClipboard(selectedTrackIndex);
        }
        return true;
    }

    if (isModKey(e) && e.code === 'KeyV') {
        if (activePanel !== 'arrangement') return false;
        e.preventDefault();
        e.stopPropagation();

        // If clip clipboard is empty, try pasting a track instead.
        if (clipboardRef.current.length === 0) {
            try {
                const insertIdx = selectedTrackIndex >= 0 ? selectedTrackIndex + 1 : undefined;
                const response = await engine.pasteTrackFromGlobalClipboard(insertIdx);
                await useEngineStore.getState().applyProjectDeltas(response.deltas, 'shortcut-paste-track');
            } catch {
                // Global track clipboard may be empty — silently ignore.
            }
            return true;
        }
        const store = useEngineStore.getState();
        const bpm = resolveBpm(store.transport.bpm);
        const sampleRate = resolveSampleRate(store.projectSampleRate);
        const cursorBeat = (ctx.editCursorBeat ?? -1) >= 0 ? (ctx.editCursorBeat as number) : frameToBeat(playheadFrames, bpm, sampleRate);

        // ENTERPRISE: Region-aware paste anchor.
        // When clipboard was copied with a marquee, use the region start (not
        // first clip start) as the anchor. This preserves empty space:
        //   Region [0..10], clip at beat 8 → paste at cursor → clip appears at cursor+8.
        const anchorBeat = _clipboardRegionBounds
            ? _clipboardRegionBounds.startBeat
            : clipboardRef.current[0].startBeat;

        let minRelative = Infinity;
        for (const c of clipboardRef.current) minRelative = Math.min(minRelative, c.startBeat - anchorBeat);
        const groupOffset = Math.max(0, cursorBeat + minRelative) - (cursorBeat + minRelative);

        // ENTERPRISE FIX: Always paste at cursor position (or playhead if no cursor).
        // Previous "smart paste" logic detected when paste position coincided with
        // source clips and shifted paste to after the source. This caused paste to
        // always land after the original regardless of cursor position — removing.
        // Standard DAW behavior: paste at cursor; overlapping duplicates are expected.
        const effectiveCursorBeat = cursorBeat;

        const anchorTrackIndex = clipboardRef.current[0].trackIndex;
        const selectedTrackIdx = selectedTrackIndex;
        const trackDelta = selectedTrackIdx >= 0 ? selectedTrackIdx - anchorTrackIndex : 0;

        // Detect cross-project paste: check if clipboard clip IDs exist in current project.
        const clipIdsInProject = new Set(timelineClips.map((c) => c.id));
        const isCrossProject = clipboardRef.current.length > 0
            && !clipboardRef.current.some((c) => clipIdsInProject.has(c.id));

        try {
            if (isCrossProject) {
                // Cross-project paste: use the global backend clipboard.
                const targetTrack = Math.max(0, Math.min(trackIds.length - 1, anchorTrackIndex + trackDelta));
                const posFrames = Math.max(0, beatToFrame(effectiveCursorBeat + groupOffset, bpm, sampleRate));
                const response = await engine.pasteClipsFromGlobalClipboard(targetTrack, posFrames);
                await useEngineStore.getState().applyProjectDeltas(response.deltas, 'shortcut-paste-cross-project');
                // BUG-018 FIX: Use SSOT helper instead of inline `(d: any)` casts.
                const nextSelection = extractNewClipIdsFromDeltas(response.deltas);
                if (nextSelection.length > 0) onClipSelectionChanged(nextSelection);
            } else {
                // ENTERPRISE FIX: Always pass the target track index explicitly.
                // Previously, same-track paste (trackDelta === 0) passed undefined
                // for targetTrackIndex, which used the source clip's track. This
                // failed when the user selected a different track to paste into.
                const results = await engine.duplicateMultipleClipsWithDeltas(clipboardRef.current.map((clip) => {
                    const destBeat = Math.max(0, effectiveCursorBeat + (clip.startBeat - anchorBeat) + groupOffset);
                    const destPositionFrames = Math.max(0, beatToFrame(destBeat, bpm, sampleRate));
                    const targetTrack = Math.max(0, Math.min(trackIds.length - 1, clip.trackIndex + trackDelta));
                    return {
                        id: clip.id,
                        newPositionFrames: destPositionFrames,
                        targetTrackIndex: targetTrack,
                    };
                }));
                await useEngineStore.getState().applyProjectDeltas(results.deltas, 'shortcut-paste');
                // BUG-018 FIX: Use SSOT helper instead of inline `(d: any)` casts.
                const nextSelection = extractNewClipIdsFromDeltas(results.deltas, results.new_id);
                onClipSelectionChanged(nextSelection);
            }
        } catch (err) {
            console.error('[Shortcuts] Paste clip failed:', err);
        }
        return true;
    }

    if (isModKey(e) && e.code === 'KeyX') {
        if (activePanel !== 'arrangement') return false;
        e.preventDefault();
        e.stopPropagation();

        // ENTERPRISE: Region-based cut with split-then-operate
        const range = normalizeRegion(marqueeSelection);
        if (range) {
            await splitRegionBoundaries(range);
            const regionClips = collectRegionClips(range);
            if (regionClips.length === 0) return true;
            // Copy portions to clipboard with region bounds
            clipboardRef.current = regionClips.map((c) => ({ ...c }));
            _clipboardRegionBounds = { startBeat: range.startBeat, endBeat: range.endBeat };
            void engine.copyClipsToGlobalClipboard(regionClips.map((c) => c.id));
            // Delete only the portions within the region
            const rollback = optimisticRemoveClips(regionClips.map((c) => c.id));
            onClipSelectionChanged([]);
            try {
                const batchedDeltas: engine.ProjectDelta[] = [];
                for (const c of regionClips) {
                    const r = await engine.deleteClipWithDeltas(c.id);
                    batchedDeltas.push(...r.deltas);
                }
                await useEngineStore.getState().applyProjectDeltas(batchedDeltas, 'shortcut-cut-region');
            } catch (err) {
                console.error('[Shortcuts] Region cut failed:', err);
                rollback();
            }
            return true;
        }

        // Fallback: whole-clip cut (no marquee)
        const targets = selectedClipIds.length > 0 ? selectedClipIds : (selectedClipId ? [selectedClipId] : []);
        const selected = timelineClips.filter((c) => targets.includes(c.id)).sort((a, b) => a.startBeat - b.startBeat);
        if (selected.length === 0) return true;
        clipboardRef.current = selected.map((c) => ({ ...c }));
        _clipboardRegionBounds = null;
        void engine.copyClipsToGlobalClipboard(selected.map((c) => c.id));
        const rollback = optimisticRemoveClips(selected.map((c) => c.id));
        onClipSelectionChanged([]);
        try {
            const batchedDeltas: engine.ProjectDelta[] = [];
            for (const c of selected) {
                const r = await engine.deleteClipWithDeltas(c.id);
                batchedDeltas.push(...r.deltas);
            }
            await useEngineStore.getState().applyProjectDeltas(batchedDeltas, 'shortcut-cut');
        } catch (err) {
            console.error('[Shortcuts] Cut clip failed:', err);
            rollback();
        }
        return true;
    }

    if ((e.key === 'Backspace' || e.key === 'Delete') && !e.repeat) {
        if (activePanel !== 'arrangement' || getScopedEditorElement(e, 'track-inspector')) return false;

        // ENTERPRISE: Region-based delete with split-then-operate
        const range = normalizeRegion(marqueeSelection);
        if (range) {
            e.preventDefault();
            e.stopPropagation();
            await splitRegionBoundaries(range);
            const regionClips = collectRegionClips(range);
            if (regionClips.length === 0) return true;
            const rollback = optimisticRemoveClips(regionClips.map((c) => c.id));
            onClipSelectionChanged([]);
            try {
                const batchedDeltas: engine.ProjectDelta[] = [];
                for (const c of regionClips) {
                    const r = await engine.deleteClipWithDeltas(c.id);
                    batchedDeltas.push(...r.deltas);
                }
                await useEngineStore.getState().applyProjectDeltas(batchedDeltas, 'shortcut-delete-region');
            } catch (err) {
                console.error('[Shortcuts] Region delete failed:', err);
                rollback();
            }
            return true;
        }

        // Fallback: whole-clip delete
        const targets = selectedClipIds.length > 0 ? selectedClipIds : (selectedClipId ? [selectedClipId] : []);
        if (targets.length === 0) return false;
        e.preventDefault();
        e.stopPropagation();
        const rollback = optimisticRemoveClips(targets);
        onClipSelectionChanged([]);
        try {
            const batchedDeltas: engine.ProjectDelta[] = [];
            for (const id of targets) {
                const r = await engine.deleteClipWithDeltas(id);
                batchedDeltas.push(...r.deltas);
            }
            await useEngineStore.getState().applyProjectDeltas(batchedDeltas, 'shortcut-delete');
        } catch (err) {
            console.error('[Shortcuts] Delete clip failed:', err);
            rollback();
        }
        return true;
    }

    if ((e.code === 'Digit0' || e.code === 'Numpad0') && !isModKey(e) && !e.shiftKey) {
        if (activePanel !== 'arrangement') return false;
        e.preventDefault();
        e.stopPropagation();

        // ENTERPRISE: Region-based mute with split-then-operate
        const range = normalizeRegion(marqueeSelection);
        if (range) {
            await splitRegionBoundaries(range);
            const regionClips = collectRegionClips(range);
            if (regionClips.length === 0) return true;
            const newMutedState = regionClips.some((c) => !c.muted);
            try {
                const regionIds = regionClips.map((c) => c.id);
                const response = regionIds.length === 1
                    ? await engine.setClipMutedWithDeltas(regionIds[0], newMutedState)
                    : await engine.setClipsMutedWithDeltas(regionIds, newMutedState);
                await useEngineStore.getState().applyProjectDeltas(response.deltas, 'shortcut-mute-region');
            } catch (err) {
                console.error('[Shortcuts] Region mute failed:', err);
            }
            return true;
        }

        // Fallback: whole-clip mute
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
        if (activePanel !== 'arrangement' || !selectedTrackId || selectedTrackId === 'master' || selectedTrackIndex < 0) return false;
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
        if (activePanel !== 'arrangement' || !selectedTrackId || selectedTrackId === 'master' || selectedTrackIndex < 0) return false;
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
        if (activePanel !== 'arrangement') return false;
        e.preventDefault();
        e.stopPropagation();
        const targets = selectedClipIds.length > 0 ? selectedClipIds : (selectedClipId ? [selectedClipId] : []);
        try {
            if (targets.length > 0) {
                const response = await engine.bounceSelectionToTrackWithDeltas({ clipIds: targets });
                await useEngineStore.getState().applyProjectDeltas(response.deltas, 'keyboard:bounce-selection');
            } else if (marqueeSelection) {
                const store = useEngineStore.getState();
                const bpm = resolveBpm(store.transport.bpm);
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
        if (activePanel !== 'arrangement') return false;
        e.preventDefault();
        e.stopPropagation();
        const store = useEngineStore.getState();
        const transport = store.transport;
        const bpm = resolveBpm(transport.bpm);
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
        // BUG-005: Derive beatsPerBar from timeSigNumerator instead of unsafe `as` cast.
        const beatsPerBar = store.timeSigNumerator ?? DEFAULT_TIME_SIG_NUMERATOR;
        if (endBeat - startBeat < beatsPerBar) endBeat = startBeat + beatsPerBar;
        store.setLoop(true, beatToFrame(startBeat, bpm, sr), beatToFrame(endBeat, bpm, sr));
        return true;
    }

    return false;
}
