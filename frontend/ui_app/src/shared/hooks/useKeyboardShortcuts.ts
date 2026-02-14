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

// ── Types ────────────────────────────────────────────────────────────────

export interface KeyboardShortcutsConfig {
    /** UUID of the currently selected clip (null if none). */
    selectedClipId: string | null;

    /** Current playhead position in sample frames. */
    playheadFrames: number;

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
 * | Cmd/Ctrl + E | Split selected clip at playhead |
 * | Backspace / Delete | Delete selected clip |
 *
 * Note: Project shortcuts (Cmd+S/Shift+S/N/O) are handled by
 * the `useProjectManager` hook.
 */
export function useKeyboardShortcuts(config: KeyboardShortcutsConfig) {
    const {
        selectedClipId,
        playheadFrames,
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

            // ── Space: Toggle Playback ─────────────────────────────
            if (e.code === 'Space' && !e.repeat) {
                if (inPianoRoll) return;
                e.preventDefault();
                e.stopPropagation();
                onTogglePlayback();
                return;
            }

            // ── Cmd/Ctrl + E: Split at Playhead ────────────────────
            if (isModKey(e) && e.key.toLowerCase() === 'e') {
                if (inPianoRoll) return;
                e.preventDefault();
                e.stopPropagation();

                if (!selectedClipId) return;

                try {
                    await engine.splitClip(selectedClipId, playheadFrames);
                    onProjectMutated();
                } catch (err) {
                    console.error('[Shortcuts] Split clip failed:', err);
                }
                return;
            }

            // ── Backspace / Delete: Delete Selected Clip ───────────
            if (e.key === 'Backspace' || e.key === 'Delete') {
                if (inPianoRoll) {
                    const selectedCount = Number(pianoRollScope?.dataset?.selectedNotes ?? '0');
                    // When notes are selected, PianoRoll owns Delete/Backspace.
                    if (selectedCount > 0) return;
                }
                e.preventDefault();
                e.stopPropagation();

                if (!selectedClipId) return;

                try {
                    await engine.deleteClip(selectedClipId);
                    onProjectMutated();
                } catch (err) {
                    console.error('[Shortcuts] Delete clip failed:', err);
                }
                return;
            }
        },
        [selectedClipId, playheadFrames, onProjectMutated, onTogglePlayback],
    );

    useEffect(() => {
        window.addEventListener('keydown', handleKeyDown, { capture: true });
        return () => {
            window.removeEventListener('keydown', handleKeyDown, { capture: true });
        };
    }, [handleKeyDown]);
}
