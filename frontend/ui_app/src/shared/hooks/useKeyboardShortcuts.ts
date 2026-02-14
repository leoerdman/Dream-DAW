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
import { save, open } from '@tauri-apps/plugin-dialog';
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
 * | Cmd/Ctrl + S | Save project |
 * | Cmd/Ctrl + Shift + S | Save project as... |
 * | Cmd/Ctrl + O | Open project... |
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

            // ── Space: Toggle Playback ─────────────────────────────
            if (e.code === 'Space' && !e.repeat) {
                e.preventDefault();
                e.stopPropagation();
                onTogglePlayback();
                return;
            }

            // ── Cmd/Ctrl + E: Split at Playhead ────────────────────
            if (isModKey(e) && e.key.toLowerCase() === 'e') {
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

            // ── Cmd/Ctrl + S: Save Project ─────────────────────────
            if (isModKey(e) && e.key.toLowerCase() === 's' && !e.shiftKey) {
                e.preventDefault();
                e.stopPropagation();

                try {
                    await engine.saveProject();
                } catch (_err) {
                    // If no file path set, fall through to Save As
                    try {
                        const path = await save({
                            title: 'Save Project As',
                            filters: [
                                { name: 'Dream DAW Project', extensions: ['dream'] },
                            ],
                        });
                        if (path) {
                            await engine.saveProjectAs(path);
                        }
                    } catch (saveErr) {
                        console.error('[Shortcuts] Save failed:', saveErr);
                    }
                }
                return;
            }

            // ── Cmd/Ctrl + Shift + S: Save As ──────────────────────
            if (isModKey(e) && e.key.toLowerCase() === 's' && e.shiftKey) {
                e.preventDefault();
                e.stopPropagation();

                try {
                    const path = await save({
                        title: 'Save Project As',
                        filters: [
                            { name: 'Dream DAW Project', extensions: ['dream'] },
                        ],
                    });
                    if (path) {
                        await engine.saveProjectAs(path);
                    }
                } catch (err) {
                    console.error('[Shortcuts] Save As failed:', err);
                }
                return;
            }

            // ── Cmd/Ctrl + O: Open Project ─────────────────────────
            if (isModKey(e) && e.key.toLowerCase() === 'o') {
                e.preventDefault();
                e.stopPropagation();

                try {
                    const result = await open({
                        title: 'Open Dream DAW Project',
                        multiple: false,
                        filters: [
                            { name: 'Dream DAW Project', extensions: ['dream'] },
                        ],
                    });
                    if (result) {
                        const filePath = typeof result === 'string' ? result : result;
                        await engine.openProject(filePath);
                        onProjectMutated();
                    }
                } catch (err) {
                    console.error('[Shortcuts] Open failed:', err);
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
