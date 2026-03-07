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
    // BUG-024 FIX: Track last-synced viewport to skip IPC when unchanged.
    const lastViewportRef = useRef({ ppb: -1, sl: -1, st: -1 });

    useEffect(() => {
        const tick = async () => {
            // Skip auto-save when tab is hidden (no point saving while user
            // is in another app — also avoids plugin state capture overhead).
            // BUG-048 FIX: Use nullish coalescing for environments where Page Visibility API is unavailable.
            if (document.hidden ?? false) return;
            if (inFlightRef.current) return; // Prevent overlapping saves

            inFlightRef.current = true;
            try {
                // Sync current viewport to backend so auto-save persists scroll/zoom.
                try {
                    const tl = useTimelineStore.getState();
                    const { ppb, sl, st } = lastViewportRef.current;
                    // BUG-024 FIX: Only sync viewport if it actually changed since last save.
                    if (tl.pixelsPerBeat !== ppb || tl.scrollLeft !== sl || tl.scrollTop !== st) {
                        await setArrangementViewport(tl.pixelsPerBeat, tl.scrollLeft, tl.scrollTop);
                        lastViewportRef.current = { ppb: tl.pixelsPerBeat, sl: tl.scrollLeft, st: tl.scrollTop };
                    }
                } catch (viewportErr) {
                    // BUG-H08 FIX: Log instead of silently swallowing.
                    // Persistent viewport sync failures were invisible.
                    console.warn('[Dream] Viewport sync failed (non-fatal):', viewportErr);
                }
                const result = await autoSaveIfDirty();
                if (result.saved) {
                    console.info(`[Dream] Saved → ${result.path}`);
                }
            } catch (err) {
                // Non-fatal: log and keep timer running
                console.warn('[Dream] Failed:', err);
            } finally {
                inFlightRef.current = false;
            }
        };

        // JS `setInterval` truncates Infinity to 0 causing infinite loops!
        if (intervalMs === Infinity || intervalMs <= 0) return;

        timerRef.current = setInterval(tick, intervalMs);

        return () => {
            if (timerRef.current !== null) {
                clearInterval(timerRef.current);
            }
        };
    }, [intervalMs]);
}
