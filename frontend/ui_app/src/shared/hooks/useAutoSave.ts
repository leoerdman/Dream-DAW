import { useEffect, useRef } from 'react';
import { autoSaveIfDirty, setArrangementViewport } from '../api/engine';
import { useTimelineStore } from '@/shared/stores/useTimelineStore';

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

const AUTO_SAVE_INTERVAL_MS = 3 * 60 * 1000; // 3 minutes

export function useAutoSave(intervalMs: number = AUTO_SAVE_INTERVAL_MS) {
    const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);
    // BUG-C003 FIX: Use a ref for inFlight state so it persists across effect re-runs (when intervalMs changes).
    const inFlightRef = useRef(false);

    useEffect(() => {
        const tick = async () => {
            // Skip auto-save when tab is hidden (no point saving while user
            // is in another app — also avoids plugin state capture overhead).
            if (document.hidden) return;
            if (inFlightRef.current) return; // Prevent overlapping saves

            inFlightRef.current = true;
            try {
                // Sync current viewport to backend so auto-save persists scroll/zoom.
                try {
                    const tl = useTimelineStore.getState();
                    await setArrangementViewport(tl.pixelsPerBeat, tl.scrollLeft, tl.scrollTop);
                } catch (viewportErr) {
                    // BUG-H08 FIX: Log instead of silently swallowing.
                    // Persistent viewport sync failures were invisible.
                    console.warn('[AutoSave] Viewport sync failed (non-fatal):', viewportErr);
                }
                const result = await autoSaveIfDirty();
                if (result.saved) {
                    console.info(`[AutoSave] Saved → ${result.path}`);
                }
            } catch (err) {
                // Non-fatal: log and keep timer running
                console.warn('[AutoSave] Failed:', err);
            } finally {
                inFlightRef.current = false;
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
