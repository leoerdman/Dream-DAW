import * as engine from '@/shared/api/engine';
import { useEngineStore } from '@/shared/stores/useEngineStore';
import { useGridStore } from '@/shared/stores/useGridStore';
import { useAutomationStore } from '@/shared/stores/useAutomationStore';
import { useTimelineStore } from '@/shared/stores/useTimelineStore';
import type { KeyboardShortcutHandlerEnv } from './types';
import { isModKey, matchesShortcutAction } from './utils';
import {
    duplicateSelectedClips,
    nudgeSelectedClips,
    nudgeSelectedClipsTrack,
    splitSelectedClipsAtCursor,
} from './transportAndEditingClipOps';
import {
    handleAutomationShortcuts,
    handlePitchShortcuts,
    handleRegionShortcuts,
} from './transportAndEditingHandlers';
import { handleCreateMidiClipRangeShortcut } from './transportAndEditingMidiRange';


export async function handleTransportAndEditingShortcuts(env: KeyboardShortcutHandlerEnv): Promise<boolean> {
    const { e, ctx } = env;
    const {
        selectedTrackId,
        onTogglePlayback,
        activePanel,
        insertAfterIndex,
    } = ctx;
    {
        const handled = await handleRegionShortcuts(e, ctx);
        if (handled) return true;
    }

    if (e.altKey && !isModKey(e) && !e.repeat && (e.code === 'ArrowLeft' || e.code === 'ArrowRight')) {
        if (activePanel !== 'arrangement') return false;
        e.preventDefault();
        e.stopPropagation();
        try {
            await nudgeSelectedClips(ctx, e.code === 'ArrowLeft' ? -1 : 1, e.shiftKey);
        } catch (err) {
            console.error('[Shortcuts] Nudge clip failed:', err);
        }
        return true;
    }

    if (e.altKey && !isModKey(e) && !e.repeat && (e.code === 'ArrowUp' || e.code === 'ArrowDown')) {
        if (activePanel !== 'arrangement') return false;
        e.preventDefault();
        e.stopPropagation();
        try {
            await nudgeSelectedClipsTrack(ctx, e.code === 'ArrowUp' ? -1 : 1, e.shiftKey);
        } catch (err) {
            console.error('[Shortcuts] Nudge clip track failed:', err);
        }
        return true;
    }

    // BUG-009 FIX: Removed duplicate hardcoded KeyS split handler.
    // Split is handled by matchesShortcutAction('split_clips') below.

    if (!isModKey(e) && !e.shiftKey && !e.altKey && !e.repeat && e.code === 'KeyD') {
        if (activePanel !== 'arrangement') return false;
        // BUG-103 FIX: Same pattern — defer event consumption until clips
        // are confirmed duplicated.  Without Cmd, this is the "bare-D"
        // shortcut for clip duplication.
        try {
            const duplicated = await duplicateSelectedClips(ctx);
            if (!duplicated || duplicated.length === 0) return false;
            e.preventDefault();
            e.stopPropagation();
        } catch (err) {
            console.error('[Shortcuts] Duplicate clip failed:', err);
        }
        return true;
    }

    if (e.code === 'Space' && !e.repeat) {
        // BUG-071 FIX: Don't toggle playback if user is typing in a text input.
        const active = document.activeElement;
        if (active && (active.tagName === 'INPUT' || active.tagName === 'TEXTAREA' || (active as HTMLElement).isContentEditable)) {
            return false;
        }
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

    if (matchesShortcutAction(e, 'grid_half_size') && !e.repeat) {
        if (activePanel === 'device-rack') return false;
        e.preventDefault();
        e.stopPropagation();
        useGridStore.getState().stepDivisionFiner();
        return true;
    }

    if (matchesShortcutAction(e, 'grid_double_size') && !e.repeat) {
        if (activePanel === 'device-rack') return false;
        e.preventDefault();
        e.stopPropagation();
        useGridStore.getState().stepDivisionCoarser();
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
        if (activePanel !== 'arrangement') return false;
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
        if (activePanel !== 'arrangement') return false;
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

    {
        const handled = await handleCreateMidiClipRangeShortcut(e, ctx);
        if (handled) return true;
    }

    if (matchesShortcutAction(e, 'split_clips') && !e.repeat) {
        if (activePanel !== 'arrangement') return false;
        e.preventDefault();
        e.stopPropagation();
        try {
            await splitSelectedClipsAtCursor(ctx);
        } catch (err) {
            console.error('[Shortcuts] Split clip failed:', err);
        }
        return true;
    }

    {
        const handled = await handleAutomationShortcuts(e, ctx);
        if (handled) return true;
    }
    {
        const handled = await handlePitchShortcuts(e, ctx);
        if (handled) return true;
    }

    if (matchesShortcutAction(e, 'panic_custom') && !e.repeat) {
        e.preventDefault();
        e.stopPropagation();
        try {
            await useEngineStore.getState().closeAllPluginEditors();
            useTimelineStore.getState().requestViewportRestore(20, 0, 0);
            useAutomationStore.getState().hideAllAutomation();
        } catch (err) {
            console.error('[Shortcuts] Panic failed:', err);
        }
        return true;
    }

    if (isModKey(e) && e.code === 'KeyD') {
        if (activePanel !== 'arrangement') return false;
        // BUG-103 FIX: Do NOT consume the event before confirming clips were
        // actually duplicated.  When no clips are selected, let the event
        // propagate so the TrackInspector's Cmd+D handler can duplicate the
        // selected track instead.
        try {
            const duplicated = await duplicateSelectedClips(ctx);
            if (!duplicated || duplicated.length === 0) return false;
            e.preventDefault();
            e.stopPropagation();
        } catch (err) {
            console.error('[Shortcuts] Duplicate clip failed:', err);
        }
        return true;
    }

    return false;
}
