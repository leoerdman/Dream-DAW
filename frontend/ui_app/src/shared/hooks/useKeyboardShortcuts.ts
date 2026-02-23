import { useCallback, useEffect, useRef } from 'react';
import type { KeyboardShortcutsConfig } from '@/shared/hooks/keyboardShortcuts/types';
import { handleClipAndTrackShortcuts } from '@/shared/hooks/keyboardShortcuts/clipAndTrack';
import { handleTransportAndEditingShortcuts } from '@/shared/hooks/keyboardShortcuts/transportAndEditing';
import { buildRuntimeContext, shouldIgnoreKeyboardShortcut } from '@/shared/hooks/keyboardShortcuts/utils';
import type { TimelineClip } from '@/shared/lib/arrangementTypes';

export type { KeyboardShortcutsConfig } from '@/shared/hooks/keyboardShortcuts/types';

export function useKeyboardShortcuts(config: KeyboardShortcutsConfig) {
    const configRef = useRef(config);
    const clipboardRef = useRef<TimelineClip[]>([]);

    useEffect(() => {
        configRef.current = config;
    }, [config]);

    const handleKeyDown = useCallback(async (e: KeyboardEvent) => {
        if (e.defaultPrevented || e.isComposing) return;
        if (shouldIgnoreKeyboardShortcut(e)) return;
        const ctx = buildRuntimeContext(configRef.current, e);
        const env = { e, ctx, clipboardRef };

        if (await handleTransportAndEditingShortcuts(env)) return;
        if (await handleClipAndTrackShortcuts(env)) return;
    }, []);

    useEffect(() => {
        window.addEventListener('keydown', handleKeyDown, { capture: true });
        return () => {
            window.removeEventListener('keydown', handleKeyDown, { capture: true });
        };
    }, [handleKeyDown]);
}
