// ═══════════════════════════════════════════════════════════════════════════
// Dream DAW — Global Keyboard Shortcuts
// ═══════════════════════════════════════════════════════════════════════════
//
// Centralized keyboard shortcut handler for the DAW.
//
// Uses native-aware metaKey detection:
//   macOS: Cmd (⌘) is the meta key
//   Win/Linux: Ctrl is the meta key
//
// All shortcuts prevent default browser behavior and stop propagation.
//
// ═══════════════════════════════════════════════════════════════════════════

import { useEffect, useCallback, useRef } from 'react';
import * as engine from '@/shared/api/engine';
import type { ProjectTrack } from '@/shared/stores/useEngineStore';
import type { TimelineClip } from '@/shared/lib/arrangementTypes';
import { useEngineStore } from '@/shared/stores/useEngineStore';
import { beatToFrame, beatDurationToFrames, frameToBeat } from '@/shared/lib/audioMath';

// ── Types ────────────────────────────────────────────────────────────────

export interface KeyboardShortcutsConfig {
    /** UUID of the currently selected clip (null if none). */
    selectedClipId: string | null;
    selectedClipIds: string[];
    selectedTrackId: string;
    projectTracks: ProjectTrack[];

    /** Current playhead position in sample frames. */
    playheadFrames: number;
    /** Edit cursor beat in arrangement (negative means hidden/inactive). */
    editCursorBeat?: number;
    timelineClips: TimelineClip[];
    marqueeSelection: { startBeat: number; endBeat: number; startTrack: number; endTrack: number } | null;

    /** Callback after a successful clip operation (to refresh project state). */
    onProjectMutated: () => void;

    /** Callback to toggle playback. */
    onTogglePlayback: () => void;

    /** Callback to update clip selection (e.g. after duplicate/paste). */
    onClipSelectionChanged: (clipIds: string[]) => void;
}

// ── Platform Detection ───────────────────────────────────────────────────

// Bug #47: navigator.platform is deprecated. Prefer userAgentData when available,
// fall back to checking the user-agent string directly.
const isMac = (() => {
    if (typeof navigator === 'undefined') return false;
    // Modern API (Chrome 90+, Edge 90+)
    const uad = (navigator as Navigator & { userAgentData?: { platform: string } }).userAgentData;
    if (uad?.platform) return uad.platform === 'macOS';
    // Fallback: user-agent string
    return /mac/i.test(navigator.userAgent) && !/iphone|ipad/i.test(navigator.userAgent);
})();

/**
 * Returns true if the OS-appropriate modifier key is held.
 * macOS: metaKey (⌘), Windows/Linux: ctrlKey.
 */
function isModKey(e: KeyboardEvent): boolean {
    return isMac ? e.metaKey : e.ctrlKey;
}

function getScopedEditorElement(e: KeyboardEvent, scope: string): HTMLElement | null {
    const target = e.target as HTMLElement | null;
    const closest = target?.closest?.(`[data-keyboard-scope="${scope}"]`) ?? null;
    if (closest) return closest as HTMLElement;
    const path = typeof e.composedPath === 'function' ? e.composedPath() : [];
    for (const node of path) {
        if (!(node instanceof HTMLElement)) continue;
        if (node.dataset?.keyboardScope === scope) return node;
    }
    return null;
}

// ── Hook Implementation ──────────────────────────────────────────────────

/**
 * Global keyboard shortcuts handler for the DAW.
 *
 * Must be called once at the app root level (e.g., in DawShell).
 * All shortcuts are unregistered on unmount.
 *
 * ## Shortcuts
 *
 * | Keys | Action |
 * |------|--------|
 * | Space | Toggle playback |
 * | Cmd/Ctrl + Z | Undo |
 * | Cmd/Ctrl + Shift + Z | Redo |
 * | Cmd/Ctrl + E | Split selected clip at playhead |
 * | Cmd/Ctrl + L | Loop selection (toggle) |
 * | Backspace / Delete | Delete selected clip |
 *
 * Note: Project shortcuts (Cmd+S/Shift+S/N/O) are handled by
 * the `useProjectManager` hook.
 */
export function useKeyboardShortcuts(config: KeyboardShortcutsConfig) {
    const configRef = useRef(config);
    const clipboardRef = useRef<TimelineClip[]>([]);
    useEffect(() => {
        configRef.current = config;
    }, [config]);

    const handleKeyDown = useCallback(
        async (e: KeyboardEvent) => {
            const {
                selectedClipId,
                selectedClipIds,
                selectedTrackId,
                projectTracks,
                playheadFrames,
                editCursorBeat = -1,
                timelineClips,
                marqueeSelection,
                onProjectMutated,
                onTogglePlayback,
                onClipSelectionChanged,
            } = configRef.current;

            // Ignore if user is typing in an input
            const target = e.target as HTMLElement;
            if (
                target.tagName === 'INPUT' ||
                target.tagName === 'TEXTAREA' ||
                target.isContentEditable
            ) {
                return;
            }

            const pianoRollScope = getScopedEditorElement(e, 'piano-roll');
            const inPianoRoll = Boolean(pianoRollScope);
            const deviceRackScope = getScopedEditorElement(e, 'device-rack');
            const inDeviceRack = Boolean(deviceRackScope);
            const selectedDeviceId = deviceRackScope?.dataset?.selectedDeviceId ?? '';
            const selectedTrackIndex = projectTracks.findIndex((t) => t.id === selectedTrackId);
            const insertAfterIndex =
                selectedTrackId &&
                    selectedTrackId !== 'master' &&
                    selectedTrackIndex >= 0
                    ? selectedTrackIndex
                    : null;

            // ── Space: Toggle Playback ─────────────────────────────
            // Start-anchor resolution (selection/cursor) is centralized
            // in DawShell on transport start to keep behavior identical
            // for both Space and TransportBar play button.
            if (e.code === 'Space' && !e.repeat) {
                e.preventDefault();
                e.stopPropagation();

                // Bug #51: only stop a browser preview when the transport is
                // currently stopped (i.e. we are about to START playback).
                // Calling stopPreview while playing could interrupt sample audition.
                const transportState = useEngineStore.getState().transport;
                const isPlaying = transportState.is_playing;
                if (!isPlaying) {
                    void engine.stopPreview().catch((err) => {
                        console.warn('[Keyboard] stopPreview before playback failed:', err);
                    });
                }

                onTogglePlayback();
                return;
            }

            // ── Cmd/Ctrl + Z: Undo ────────────────────────────────
            if (isModKey(e) && !e.shiftKey && e.key.toLowerCase() === 'z' && !e.repeat) {
                e.preventDefault();
                e.stopPropagation();
                try {
                    await engine.undo();
                    onProjectMutated();
                } catch (err) {
                    console.warn('[Keyboard] Undo failed:', err);
                }
                return;
            }

            // ── Cmd/Ctrl + Shift + Z  OR  Ctrl + Y: Redo ─────────
            const isRedo =
                (isModKey(e) && e.shiftKey && e.key.toLowerCase() === 'z') ||
                (e.ctrlKey && !e.shiftKey && !e.metaKey && e.key.toLowerCase() === 'y');
            if (isRedo && !e.repeat) {
                e.preventDefault();
                e.stopPropagation();
                try {
                    await engine.redo();
                    onProjectMutated();
                } catch (err) {
                    console.warn('[Keyboard] Redo failed:', err);
                }
                return;
            }

            // ── Cmd/Ctrl + T: New Audio Track ─────────────────────
            if (isModKey(e) && !e.shiftKey && e.key.toLowerCase() === 't') {
                e.preventDefault();
                e.stopPropagation();
                try {
                    await engine.addTrackAdvanced(
                        'audio',
                        insertAfterIndex,
                        undefined,
                        selectedTrackId && selectedTrackId !== 'master' ? selectedTrackId : null,
                    );
                    onProjectMutated();
                } catch (err) {
                    console.error('[Shortcuts] New audio track failed:', err);
                }
                return;
            }

            // ── Cmd/Ctrl + Shift + T: New MIDI Track ──────────────
            if (isModKey(e) && e.shiftKey && e.key.toLowerCase() === 't') {
                e.preventDefault();
                e.stopPropagation();
                try {
                    await engine.addTrackAdvanced(
                        'midi',
                        insertAfterIndex,
                        undefined,
                        selectedTrackId && selectedTrackId !== 'master' ? selectedTrackId : null,
                    );
                    onProjectMutated();
                } catch (err) {
                    console.error('[Shortcuts] New MIDI track failed:', err);
                }
                return;
            }

            // ── Cmd/Ctrl + Shift + M: Create MIDI Clip(s) from Selection Box ──
            if (isModKey(e) && e.shiftKey && e.key.toLowerCase() === 'm') {
                if (inPianoRoll || inDeviceRack) return;
                e.preventDefault();
                e.stopPropagation();

                if (!marqueeSelection) return;

                const minTrack = Math.min(marqueeSelection.startTrack, marqueeSelection.endTrack);
                const maxTrack = Math.max(marqueeSelection.startTrack, marqueeSelection.endTrack);

                const store = useEngineStore.getState();
                const bpm = Math.max(1, store.projectBpm || store.transport.bpm || 120);
                const sampleRate = store.projectSampleRate || store.transport.sample_rate || 44100;

                const startBeat = Math.min(marqueeSelection.startBeat, marqueeSelection.endBeat);
                const endBeat = Math.max(marqueeSelection.startBeat, marqueeSelection.endBeat);
                const durationBeats = Math.max(0.25, endBeat - startBeat);
                const positionFrames = Math.max(0, beatToFrame(startBeat, bpm, sampleRate));
                // Bug fix: use beatDurationToFrames (duration conversion) not beatToFrame
                // (position conversion) to get the correct frame count for the clip duration.
                const durationFrames = Math.max(1, beatDurationToFrames(durationBeats, bpm, sampleRate));

                const midiTrackIndices: number[] = [];
                for (let i = minTrack; i <= maxTrack; i++) {
                    const track = projectTracks[i];
                    if (!track) continue;
                    const trackType = (track.track_type ?? '').toLowerCase();
                    // Bug #61: only create clips on true MIDI tracks — skip group,
                    // master, bus, and return tracks.
                    if (!trackType.includes('midi')) continue;
                    if (trackType.includes('group') || trackType.includes('master') ||
                        trackType.includes('bus') || trackType.includes('return')) continue;
                    midiTrackIndices.push(i);
                }
                if (midiTrackIndices.length === 0) return;

                try {
                    await Promise.all(
                        midiTrackIndices.map((trackIndex) =>
                            engine.createMidiClip(trackIndex, positionFrames, durationFrames),
                        ),
                    );
                    onProjectMutated();
                } catch (err) {
                    console.error('[Shortcuts] Create MIDI clips from box failed:', err);
                }
                return;
            }

            // ── Cmd/Ctrl + E: Split at Playhead ────────────────────
            if (isModKey(e) && e.key.toLowerCase() === 'e' && !e.repeat) {
                if (inPianoRoll || inDeviceRack) return;
                e.preventDefault();
                e.stopPropagation();

                try {
                    const store = useEngineStore.getState();
                    const bpm = Math.max(1, store.projectBpm || store.transport.bpm || 120);
                    const sampleRate = store.projectSampleRate || store.transport.sample_rate || 44100;
                    const splitBeat = Number.isFinite(editCursorBeat) && editCursorBeat >= 0
                        ? (editCursorBeat as number)
                        : frameToBeat(playheadFrames, bpm, sampleRate);
                    const splitFrame = Math.max(0, beatToFrame(splitBeat, bpm, sampleRate));
                    const hasThinMultiCursor = Boolean(marqueeSelection)
                        && Math.abs((marqueeSelection?.endBeat ?? 0) - (marqueeSelection?.startBeat ?? 0)) <= 1e-6
                        && marqueeSelection != null
                        && marqueeSelection.startTrack !== marqueeSelection.endTrack;

                    const targets = selectedClipIds.length > 0
                        ? selectedClipIds
                        : (selectedClipId ? [selectedClipId] : []);
                    const selectedTrackIndex = projectTracks.findIndex((t) => t.id === selectedTrackId);

                    const EPS = 1e-6;
                    const containsSplit = (clip: TimelineClip) => {
                        const start = clip.startBeat;
                        const end = clip.startBeat + clip.durationBeats;
                        return splitBeat > start + EPS && splitBeat < end - EPS;
                    };

                    let clipsAtPlayhead = (targets.length > 0
                        // Ableton-like: split ALL selected clips that intersect split cursor.
                        ? timelineClips.filter((clip) => targets.includes(clip.id))
                        // No explicit selection: split only on the selected track.
                        : timelineClips.filter((clip) => clip.trackIndex === selectedTrackIndex))
                        .filter(containsSplit);

                    if (hasThinMultiCursor && marqueeSelection) {
                        const minTrack = Math.min(marqueeSelection.startTrack, marqueeSelection.endTrack);
                        const maxTrack = Math.max(marqueeSelection.startTrack, marqueeSelection.endTrack);
                        // Multi-cursor: override to only tracks within the marquee range
                        clipsAtPlayhead = timelineClips
                            .filter((clip) => clip.trackIndex >= minTrack && clip.trackIndex <= maxTrack)
                            .filter(containsSplit);
                    }

                    if (clipsAtPlayhead.length === 0) return;
                    // Sequential split: prevents stale-state races from parallel backend calls
                    for (const clip of clipsAtPlayhead) {
                        await engine.splitClip(clip.id, splitFrame);
                    }
                    onProjectMutated();
                } catch (err) {
                    console.error('[Shortcuts] Split clip failed:', err);
                }
                return;
            }

            // ── Cmd/Ctrl + D: Duplicate selected clip(s) ───────────
            if (isModKey(e) && e.key.toLowerCase() === 'd') {
                if (inPianoRoll || inDeviceRack) return;
                e.preventDefault();
                e.stopPropagation();

                const targets = selectedClipIds.length > 0
                    ? selectedClipIds
                    : (selectedClipId ? [selectedClipId] : []);
                if (targets.length === 0) return;

                const selected = timelineClips
                    .filter((c) => targets.includes(c.id))
                    .sort((a, b) => a.startBeat - b.startBeat);
                if (selected.length === 0) return;

                const store = useEngineStore.getState();
                const bpm = Math.max(1, store.projectBpm || store.transport.bpm || 120);
                // Bug fix: avoid Math.min/max with spread on large arrays (stack overflow risk).
                let minStart = Infinity, maxEnd = -Infinity;
                for (const c of selected) {
                    if (c.startBeat < minStart) minStart = c.startBeat;
                    const end = c.startBeat + c.durationBeats;
                    if (end > maxEnd) maxEnd = end;
                }
                const spanBeats = Math.max(0.0001, maxEnd - minStart);
                const sampleRate = store.projectSampleRate || 44100;

                try {
                    const results = await Promise.all(
                        selected.map((clip) => {
                            const destBeat = clip.startBeat + spanBeats;
                            const destFrames = Math.max(0, beatToFrame(destBeat, bpm, sampleRate));
                            return engine.duplicateClip(clip.id, destFrames);
                        }),
                    );
                    onProjectMutated();
                    // Auto-select the newly duplicated clips.
                    onClipSelectionChanged(results.map((r) => r.new_id));
                } catch (err) {
                    console.error('[Shortcuts] Duplicate clip failed:', err);
                }
                return;
            }

            // ── Cmd/Ctrl + J: Merge selected clip(s) ────────────────
            if (isModKey(e) && e.key.toLowerCase() === 'j') {
                if (inPianoRoll || inDeviceRack) return;
                e.preventDefault();
                e.stopPropagation();

                const targets = selectedClipIds.length > 0
                    ? selectedClipIds
                    : (selectedClipId ? [selectedClipId] : []);
                if (targets.length < 2) return;

                const selected = timelineClips.filter((c) => targets.includes(c.id));
                if (selected.length < 2) return;
                const sameTrack = selected.every((c) => c.trackIndex === selected[0].trackIndex);
                if (!sameTrack) return;

                try {
                    await engine.mergeClips(selected.map((c) => c.id));
                    onProjectMutated();
                } catch (err) {
                    console.error('[Shortcuts] Merge clips failed:', err);
                }
                return;
            }

            // ── Cmd/Ctrl + C: Copy selected clip(s) ─────────────────
            if (isModKey(e) && e.key.toLowerCase() === 'c') {
                if (inPianoRoll || inDeviceRack) return;
                e.preventDefault();
                e.stopPropagation();
                const targets = selectedClipIds.length > 0
                    ? selectedClipIds
                    : (selectedClipId ? [selectedClipId] : []);
                const selected = timelineClips
                    .filter((c) => targets.includes(c.id))
                    .sort((a, b) => a.startBeat - b.startBeat);
                if (selected.length === 0) return;
                // Bug #59: deep-clone to prevent later mutations from corrupting the clipboard.
                clipboardRef.current = selected.map((c) => ({ ...c }));
                return;
            }

            // ── Cmd/Ctrl + V: Paste copied clip(s) ──────────────────
            if (isModKey(e) && e.key.toLowerCase() === 'v') {
                if (inPianoRoll || inDeviceRack) return;
                e.preventDefault();
                e.stopPropagation();
                if (clipboardRef.current.length === 0) return;

                const store = useEngineStore.getState();
                const bpm = Math.max(1, store.projectBpm || store.transport.bpm || 120);
                const sampleRate = store.projectSampleRate || 44100;
                const fallbackBeat = frameToBeat(playheadFrames, bpm, sampleRate);
                const cursorBeat = editCursorBeat >= 0 ? editCursorBeat : fallbackBeat;
                const firstBeat = clipboardRef.current[0].startBeat;

                // Bug #63: if cursor is near beat 0 and clipboard has clips with
                // relative offsets, destBeat could go negative, collapsing the group.
                // Clamp the group start to 0 and shift all clips accordingly.
                const minRelative = Math.min(...clipboardRef.current.map((c) => c.startBeat - firstBeat));
                const groupStartBeat = Math.max(0, cursorBeat + minRelative);
                const groupOffset = groupStartBeat - (cursorBeat + minRelative);

                // Cross-track paste: compute track offset from clipboard anchor
                // to the currently selected track.
                const anchorTrackIndex = clipboardRef.current[0].trackIndex;
                const selectedTrackIdx = projectTracks.findIndex((t) => t.id === selectedTrackId);
                const trackDelta = selectedTrackIdx >= 0 ? selectedTrackIdx - anchorTrackIndex : 0;

                try {
                    const results = await Promise.all(
                        clipboardRef.current.map((clip) => {
                            const relative = clip.startBeat - firstBeat;
                            const destBeat = Math.max(0, cursorBeat + relative + groupOffset);
                            const destFrames = Math.max(0, beatToFrame(destBeat, bpm, sampleRate));
                            return engine.duplicateClip(clip.id, destFrames);
                        }),
                    );

                    // Move duplicated clips to the target track(s) if cross-track paste.
                    if (trackDelta !== 0) {
                        await Promise.all(
                            results.map((r, i) => {
                                const clip = clipboardRef.current[i];
                                const relative = clip.startBeat - firstBeat;
                                const destBeat = Math.max(0, cursorBeat + relative + groupOffset);
                                const destFrames = Math.max(0, beatToFrame(destBeat, bpm, sampleRate));
                                const targetTrack = Math.max(0, Math.min(projectTracks.length - 1, clip.trackIndex + trackDelta));
                                return engine.moveClip(r.new_id, targetTrack, destFrames);
                            }),
                        );
                    }

                    onProjectMutated();
                    // Auto-select the newly pasted clips.
                    onClipSelectionChanged(results.map((r) => r.new_id));
                } catch (err) {
                    console.error('[Shortcuts] Paste clip failed:', err);
                }
                return;
            }

            // ── Cmd/Ctrl + X: Cut selected clip(s) ──────────────────
            if (isModKey(e) && e.key.toLowerCase() === 'x') {
                if (inPianoRoll || inDeviceRack) return;
                e.preventDefault();
                e.stopPropagation();
                const targets = selectedClipIds.length > 0
                    ? selectedClipIds
                    : (selectedClipId ? [selectedClipId] : []);
                const selected = timelineClips
                    .filter((c) => targets.includes(c.id))
                    .sort((a, b) => a.startBeat - b.startBeat);
                if (selected.length === 0) return;
                // Bug #59: deep-clone snapshot before delete, so clipboard is not
                // affected if the objects are mutated after the cut.
                clipboardRef.current = selected.map((c) => ({ ...c }));
                try {
                    await Promise.all(selected.map((c) => engine.deleteClip(c.id)));
                    onProjectMutated();
                    // Clear selection after cut — original clips are gone.
                    onClipSelectionChanged([]);
                } catch (err) {
                    console.error('[Shortcuts] Cut clip failed:', err);
                }
                return;
            }

            // ── Backspace / Delete: Delete Selected Clip/Track ─────
            if ((e.key === 'Backspace' || e.key === 'Delete') && !e.repeat) {
                if (inDeviceRack && selectedDeviceId.length > 0) {
                    // DeviceRack owns Delete when a plugin/device card is selected.
                    return;
                }
                if (inPianoRoll) {
                    // PianoRoll owns Delete/Backspace whenever editor focus is inside it.
                    // This prevents accidental clip/track deletions while editing notes.
                    return;
                }
                // TrackInspector owns Delete when a track header has focus.
                const inTrackInspector = Boolean(getScopedEditorElement(e, 'track-inspector'));
                if (inTrackInspector) return;
                e.preventDefault();
                e.stopPropagation();

                const targets = selectedClipIds.length > 0
                    ? selectedClipIds
                    : (selectedClipId ? [selectedClipId] : []);
                if (targets.length === 0) return;

                try {
                    await Promise.all(targets.map((id) => engine.deleteClip(id)));
                    onProjectMutated();
                } catch (err) {
                    console.error('[Shortcuts] Delete clip failed:', err);
                }
                return;
            }

            // ── 0: Toggle Clip Mute ──────────────────────────────
            // Muted clips remain on the timeline but don't play.
            // Visual: dark overlay, greyed out.
            // Bug #57: accept both Digit0 and Numpad0.
            if ((e.key === '0' || e.code === 'Numpad0') && !isModKey(e) && !e.shiftKey) {
                if (inPianoRoll || inDeviceRack) return;
                e.preventDefault();
                e.stopPropagation();

                const targets = selectedClipIds.length > 0
                    ? selectedClipIds
                    : (selectedClipId ? [selectedClipId] : []);
                if (targets.length === 0) return;

                // Determine new mute state: if ANY selected clip is unmuted, mute all; else unmute all.
                const targetSet = new Set(targets);
                const selected = timelineClips.filter(c => targetSet.has(c.id));
                const anyUnmuted = selected.some(c => !c.muted);
                const newMutedState = anyUnmuted;

                try {
                    if (targets.length === 1) {
                        await engine.setClipMuted(targets[0], newMutedState);
                    } else {
                        await engine.setClipsMuted(targets, newMutedState);
                    }
                    onProjectMutated();
                } catch (err) {
                    console.error('[Shortcuts] Toggle clip mute failed:', err);
                }
                return;
            }

            // ── S: Toggle Track Solo ─────────────────────────────────
            // Solos/unsolos the currently selected track.
            if (e.key.toLowerCase() === 's' && !isModKey(e) && !e.shiftKey && !e.altKey) {
                if (inPianoRoll || inDeviceRack) return;
                e.preventDefault();
                e.stopPropagation();

                if (!selectedTrackId || selectedTrackId === 'master') return;
                if (selectedTrackIndex < 0) return;

                const track = projectTracks[selectedTrackIndex];
                if (!track) return;

                // Bug #56: await the command and propagate errors properly.
                const newSoloed = !track.is_solo;
                try {
                    await engine.setTrackSolo(selectedTrackIndex, newSoloed);
                } catch (err) {
                    console.error('[Shortcuts] setTrackSolo failed:', err);
                }
                return;
            }

            // ── M: Toggle Track Mute ────────────────────────────────
            // Mutes/unmutes the currently selected track.
            if (e.key.toLowerCase() === 'm' && !isModKey(e) && !e.shiftKey && !e.altKey) {
                if (inPianoRoll || inDeviceRack) return;
                e.preventDefault();
                e.stopPropagation();

                if (!selectedTrackId || selectedTrackId === 'master') return;
                if (selectedTrackIndex < 0) return;

                const track = projectTracks[selectedTrackIndex];
                if (!track) return;

                // Bug #56: await the command and propagate errors properly.
                const newMuted = !track.is_mute;
                try {
                    await engine.setTrackMute(selectedTrackIndex, newMuted);
                } catch (err) {
                    console.error('[Shortcuts] setTrackMute failed:', err);
                }
                return;
            }

            // ── B: Bounce selected clips/area to new track ──────────
            if (e.key.toLowerCase() === 'b' && !isModKey(e) && !e.shiftKey && !e.altKey) {
                if (inPianoRoll || inDeviceRack) return;
                e.preventDefault();
                e.stopPropagation();

                const targets = selectedClipIds.length > 0
                    ? selectedClipIds
                    : (selectedClipId ? [selectedClipId] : []);

                try {
                    if (targets.length > 0) {
                        await engine.bounceSelectionToTrack({ clipIds: targets });
                        onProjectMutated();
                        return;
                    }

                    if (!marqueeSelection) return;
                    const store = useEngineStore.getState();
                    const bpm = store.projectBpm || store.transport.bpm || 120;
                    const sr = store.projectSampleRate || store.transport.sample_rate || 44100;
                    const beatsToFrames = (beat: number) => beatToFrame(beat, bpm, sr);
                    const startBeat = Math.min(marqueeSelection.startBeat, marqueeSelection.endBeat);
                    const endBeat = Math.max(marqueeSelection.startBeat, marqueeSelection.endBeat);
                    if (endBeat - startBeat <= 1e-6) return;

                    await engine.bounceSelectionToTrack({
                        rangeStartFrames: Math.max(0, beatsToFrames(startBeat)),
                        rangeEndFrames: Math.max(1, beatsToFrames(endBeat)),
                        startTrackIndex: Math.min(marqueeSelection.startTrack, marqueeSelection.endTrack),
                        endTrackIndex: Math.max(marqueeSelection.startTrack, marqueeSelection.endTrack),
                    });
                    onProjectMutated();
                } catch (err) {
                    console.error('[Shortcuts] Bounce selection failed:', err);
                }
                return;
            }

            // ── Cmd/Ctrl + L: Loop Selection ─────────────────────────
            // Selects the bounding box of all selected clips and sets
            // the loop region to it. Pressing again toggles off.
            if (isModKey(e) && e.key.toLowerCase() === 'l') {
                if (inPianoRoll || inDeviceRack) return;
                e.preventDefault();
                e.stopPropagation();

                const store = useEngineStore.getState();
                const transport = store.transport;
                const bpm = store.projectBpm || transport.bpm || 120;
                const sr = store.projectSampleRate || transport.sample_rate || 44100;

                const marqueeStartBeat = marqueeSelection
                    ? Math.min(marqueeSelection.startBeat, marqueeSelection.endBeat)
                    : 0;
                const marqueeEndBeat = marqueeSelection
                    ? Math.max(marqueeSelection.startBeat, marqueeSelection.endBeat)
                    : 0;
                const hasMarqueeRange = Boolean(marqueeSelection) && marqueeEndBeat - marqueeStartBeat > 1e-6;

                if (hasMarqueeRange) {
                    const beatsToFrames = (beat: number) => beatToFrame(beat, bpm, sr);
                    const startFrames = beatsToFrames(Math.max(0, marqueeStartBeat));
                    const endFrames = beatsToFrames(Math.max(marqueeStartBeat + 0.25, marqueeEndBeat));
                    store.setLoop(true, startFrames, endFrames);
                    return;
                }

                // If loop is already on, toggle OFF
                if (transport.loop_enabled) {
                    store.setLoop(false, transport.loop_start, transport.loop_end);
                    return;
                }

                // Compute bounds from selected clips
                const targets = selectedClipIds.length > 0
                    ? selectedClipIds
                    : (selectedClipId ? [selectedClipId] : []);

                if (targets.length === 0) {
                    // No selection — just toggle loop with current region
                    store.setLoop(!transport.loop_enabled, transport.loop_start, transport.loop_end);
                    return;
                }

                const targetSet = new Set(targets);
                const selected = timelineClips.filter(c => targetSet.has(c.id));

                if (selected.length === 0) {
                    store.setLoop(!transport.loop_enabled, transport.loop_start, transport.loop_end);
                    return;
                }

                // Bounding box: earliest start beat → latest end beat
                let startBeat = Infinity;
                let endBeat = -Infinity;
                for (const clip of selected) {
                    startBeat = Math.min(startBeat, clip.startBeat);
                    endBeat = Math.max(endBeat, clip.startBeat + clip.durationBeats);
                }

                // Bug #55: minimum loop length should be 1 bar, computed from the
                // actual time signature, not hardcoded to 4 beats.
                // Use beatsPerBar from store if available, otherwise fall back to 4.
                const loopStore = useEngineStore.getState();
                const loopBeatsPerBar =
                    (loopStore as typeof loopStore & { projectBeatsPerBar?: number }).projectBeatsPerBar ?? 4;
                if (endBeat - startBeat < loopBeatsPerBar) {
                    endBeat = startBeat + loopBeatsPerBar;
                }

                // Convert beats → frames
                const beatsToFrames = (beat: number) => beatToFrame(beat, bpm, sr);

                const startFrames = beatsToFrames(startBeat);
                const endFrames = beatsToFrames(endBeat);

                store.setLoop(true, startFrames, endFrames);
                return;
            }
        },
        [],
    );

    useEffect(() => {
        window.addEventListener('keydown', handleKeyDown, { capture: true });
        return () => {
            window.removeEventListener('keydown', handleKeyDown, { capture: true });
        };
    }, [handleKeyDown]);
}
