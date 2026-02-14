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

import { useEffect, useCallback } from 'react';
import * as engine from '@/shared/api/engine';
import type { ProjectTrack, TimelineClip } from '@/shared/stores/useEngineStore';
import { useEngineStore } from '@/shared/stores/useEngineStore';

// ── Types ────────────────────────────────────────────────────────────────

export interface KeyboardShortcutsConfig {
    /** UUID of the currently selected clip (null if none). */
    selectedClipId: string | null;
    selectedClipIds: string[];
    selectedTrackId: string;
    projectTracks: ProjectTrack[];

    /** Current playhead position in sample frames. */
    playheadFrames: number;
    timelineClips: TimelineClip[];

    /** Callback after a successful clip operation (to refresh project state). */
    onProjectMutated: () => void;

    /** Callback to toggle playback. */
    onTogglePlayback: () => void;
}

// ── Platform Detection ───────────────────────────────────────────────────

const isMac = navigator.platform.toUpperCase().indexOf('MAC') >= 0;

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

let clipboard: TimelineClip[] = [];

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
    const {
        selectedClipId,
        selectedClipIds,
        selectedTrackId,
        projectTracks,
        playheadFrames,
        timelineClips,
        onProjectMutated,
        onTogglePlayback,
    } = config;

    const handleKeyDown = useCallback(
        async (e: KeyboardEvent) => {
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
            if (e.code === 'Space' && !e.repeat) {
                if (inPianoRoll || inDeviceRack) return;
                e.preventDefault();
                e.stopPropagation();
                onTogglePlayback();
                return;
            }

            // ── Cmd/Ctrl + Z: Undo ────────────────────────────────
            if (isModKey(e) && !e.shiftKey && e.key.toLowerCase() === 'z') {
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

            // ── Cmd/Ctrl + Shift + Z: Redo ────────────────────────
            if (isModKey(e) && e.shiftKey && e.key.toLowerCase() === 'z') {
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
                    await engine.addTrackAdvanced('audio', insertAfterIndex);
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
                    await engine.addTrackAdvanced('midi', insertAfterIndex);
                    onProjectMutated();
                } catch (err) {
                    console.error('[Shortcuts] New MIDI track failed:', err);
                }
                return;
            }

            // ── Cmd/Ctrl + E: Split at Playhead ────────────────────
            if (isModKey(e) && e.key.toLowerCase() === 'e') {
                if (inPianoRoll || inDeviceRack) return;
                e.preventDefault();
                e.stopPropagation();

                const targets = selectedClipIds.length > 0
                    ? selectedClipIds
                    : (selectedClipId ? [selectedClipId] : []);
                if (targets.length === 0) return;

                try {
                    await Promise.all(targets.map((id) => engine.splitClip(id, playheadFrames)));
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

                const bpm = Math.max(1, useEngineStore.getState().projectBpm || useEngineStore.getState().transport.bpm || 120);
                const minStart = Math.min(...selected.map((c) => c.startBeat));
                const maxEnd = Math.max(...selected.map((c) => c.startBeat + c.durationBeats));
                const spanBeats = Math.max(0.0001, maxEnd - minStart);
                const sampleRate = useEngineStore.getState().projectSampleRate || 44100;
                const framesPerBeat = (60 / bpm) * sampleRate;

                try {
                    await Promise.all(
                        selected.map((clip) => {
                            const destBeat = clip.startBeat + spanBeats;
                            const destFrames = Math.max(0, Math.round(destBeat * framesPerBeat));
                            return engine.duplicateClip(clip.id, destFrames);
                        }),
                    );
                    onProjectMutated();
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
                clipboard = selected;
                return;
            }

            // ── Cmd/Ctrl + V: Paste copied clip(s) ──────────────────
            if (isModKey(e) && e.key.toLowerCase() === 'v') {
                if (inPianoRoll || inDeviceRack) return;
                e.preventDefault();
                e.stopPropagation();
                if (clipboard.length === 0) return;

                const bpm = Math.max(1, useEngineStore.getState().projectBpm || useEngineStore.getState().transport.bpm || 120);
                const sampleRate = useEngineStore.getState().projectSampleRate || 44100;
                const framesPerBeat = (60 / bpm) * sampleRate;
                const cursorBeat = playheadFrames / framesPerBeat;
                const firstBeat = clipboard[0].startBeat;

                try {
                    await Promise.all(
                        clipboard.map((clip) => {
                            const relative = clip.startBeat - firstBeat;
                            const destBeat = cursorBeat + relative;
                            const destFrames = Math.max(0, Math.round(destBeat * framesPerBeat));
                            return engine.duplicateClip(clip.id, destFrames);
                        }),
                    );
                    onProjectMutated();
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
                clipboard = selected;
                try {
                    await Promise.all(selected.map((c) => engine.deleteClip(c.id)));
                    onProjectMutated();
                } catch (err) {
                    console.error('[Shortcuts] Cut clip failed:', err);
                }
                return;
            }

            // ── Backspace / Delete: Delete Selected Clip ───────────
            if (e.key === 'Backspace' || e.key === 'Delete') {
                if (inDeviceRack && selectedDeviceId.length > 0) {
                    // DeviceRack owns Delete when a plugin/device card is selected.
                    return;
                }
                if (inPianoRoll) {
                    // PianoRoll owns Delete/Backspace whenever editor focus is inside it.
                    // This prevents accidental clip/track deletions while editing notes.
                    return;
                }
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

                // Enforce minimum 4 beats (1 bar in 4/4)
                if (endBeat - startBeat < 4) {
                    endBeat = startBeat + 4;
                }

                // Convert beats → frames
                const beatsToFrames = (beat: number) =>
                    Math.round((beat * 60 * sr) / bpm);

                const startFrames = beatsToFrames(startBeat);
                const endFrames = beatsToFrames(endBeat);

                store.setLoop(true, startFrames, endFrames);
                return;
            }
        },
        [
            selectedClipId,
            selectedClipIds,
            selectedTrackId,
            projectTracks,
            playheadFrames,
            timelineClips,
            onProjectMutated,
            onTogglePlayback,
        ],
    );

    useEffect(() => {
        window.addEventListener('keydown', handleKeyDown, { capture: true });
        return () => {
            window.removeEventListener('keydown', handleKeyDown, { capture: true });
        };
    }, [handleKeyDown]);
}
