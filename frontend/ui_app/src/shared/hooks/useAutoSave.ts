import { useEffect, useRef } from 'react';
import { autoSaveIfDirty } from '../api/engine';

// ═══════════════════════════════════════════════════════════════════════════
// Auto-Save Hook (Strike 6: Titanium Shield)
// ═══════════════════════════════════════════════════════════════════════════
//
// Fires every `intervalMs` (default 3 minutes). Calls the backend
// `auto_save_if_dirty` command which:
//   1. Checks the dirty flag (no-op if clean)
//   2. Checks file path exists (no-op for unsaved/new projects)
//   3. Captures plugin states
//   4. Atomic save (.tmp → fsync → .bak → rename)
//
// Pauses when the browser tab is hidden (Page Visibility API).
// ═══════════════════════════════════════════════════════════════════════════

const DEFAULT_INTERVAL_MS = 3 * 60 * 1000; // 3 minutes

export function useAutoSave(intervalMs: number = DEFAULT_INTERVAL_MS) {
    const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);

    useEffect(() => {
        // BUG-066 FIX: Guard against overlapping auto-saves.
        let inFlight = false;
        const tick = async () => {
            // Skip auto-save when tab is hidden (no point saving while user
            // is in another app — also avoids plugin state capture overhead).
            if (document.hidden) return;
            if (inFlight) return; // Prevent overlapping saves

            inFlight = true;
            try {
                const result = await autoSaveIfDirty();
                if (result.saved) {
                    console.info(`[AutoSave] Saved → ${result.path}`);
                }
            } catch (err) {
                // Non-fatal: log and keep timer running
                console.warn('[AutoSave] Failed:', err);
            } finally {
                inFlight = false;
            }
        };

        timerRef.current = setInterval(tick, intervalMs);

        return () => {
            if (timerRef.current !== null) {
                clearInterval(timerRef.current);
            }
        };
    }, [intervalMs]);
}
