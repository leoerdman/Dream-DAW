// ═══════════════════════════════════════════════════════════════════════════
// Dream DAW — Zero-Render Telemetry Loop
// ═══════════════════════════════════════════════════════════════════════════
//
// This hook updates the playhead line and VU meters at 60fps by writing
// directly to DOM style properties — completely bypassing React's
// reconciliation cycle.
//
// Why: Calling `setState()` 60 times/second would cause React to re-render
// the entire Timeline (hundreds of DOM nodes). Direct DOM manipulation
// keeps React's virtual DOM untouched while the visual elements move
// fluidly.
//
// Architecture:
//   1. `requestAnimationFrame` loop polls Rust via `getTransport()`
//   2. Playhead position → `transform: translateX(px)` on a ref
//   3. Meter levels → `transform: scaleY(rms)` on meter bar refs
//   4. Loop never touches React state — zero re-renders
//
// ═══════════════════════════════════════════════════════════════════════════

import { useEffect, useRef, useCallback } from 'react';
import * as engine from '@/shared/api/engine';

// ── Types ────────────────────────────────────────────────────────────────

export interface TelemetryRefs {
    /** Ref to the playhead line <div>. Must have `position: absolute`. */
    playheadRef: React.RefObject<HTMLDivElement | null>;

    /** Refs to VU meter bar elements (one per track, L+R combined via max). */
    meterRefs?: React.RefObject<(HTMLDivElement | null)[]>;
}

export interface TelemetryConfig {
    /** Pixels per beat for converting position_seconds → pixels. */
    bpm: number;

    /** Pixels per beat for positioning. */
    pixelsPerBeat: number;

    /** Sample rate for frame-to-second conversion. */
    sampleRate: number;

    /** Whether the loop should be active. Set false to pause. */
    enabled?: boolean;

    /** Scroll offset in pixels (subtracted from playhead position). */
    scrollOffsetPx?: number;
}

// ── Hook ────────────────────────────────────────────────────────────────

/**
 * Zero-render telemetry loop for playhead and meter animation.
 *
 * Usage:
 * ```tsx
 * const playheadRef = useRef<HTMLDivElement>(null);
 * useTelemetryLoop(
 *   { playheadRef },
 *   { bpm: 120, pixelsPerBeat: 24, sampleRate: 44100 }
 * );
 * ```
 */
export function useTelemetryLoop(
    refs: TelemetryRefs,
    config: TelemetryConfig,
) {
    const rafId = useRef<number | null>(null);
    const isRunning = useRef(false);

    // Store config in ref to avoid re-creating the loop on config changes
    const configRef = useRef(config);
    configRef.current = config;

    const refsRef = useRef(refs);
    refsRef.current = refs;

    const loop = useCallback(async () => {
        if (!isRunning.current) return;

        try {
            const transport = await engine.getTransport();

            // ── Update Playhead Position ──────────────────────────
            const playheadEl = refsRef.current.playheadRef.current;
            if (playheadEl) {
                const { bpm, pixelsPerBeat, scrollOffsetPx = 0 } = configRef.current;

                // Convert seconds → beats → pixels
                const beatsPerSecond = bpm / 60;
                const positionBeats = transport.position_seconds * beatsPerSecond;
                const positionPx = positionBeats * pixelsPerBeat - scrollOffsetPx;

                playheadEl.style.transform = `translateX(${positionPx}px)`;

                // Show/hide based on visibility
                if (positionPx < -2 || positionPx > window.innerWidth) {
                    playheadEl.style.opacity = '0';
                } else {
                    playheadEl.style.opacity = '1';
                }
            }

            // ── Update VU Meters ─────────────────────────────────
            const meterEls = refsRef.current.meterRefs?.current;
            if (meterEls && meterEls.length > 0) {
                try {
                    const meters = await engine.getMeters();
                    const tracks = meters.tracks;

                    for (let i = 0; i < meterEls.length && i < tracks.length; i++) {
                        const el = meterEls[i];
                        if (!el) continue;

                        // Use max of L/R channels for single-bar display
                        const [left, right] = tracks[i];
                        const level = Math.max(left.rms, right.rms);

                        // Clamp to [0, 1] and apply
                        const clamped = Math.min(1, Math.max(0, level));
                        el.style.transform = `scaleY(${clamped})`;
                        el.style.transformOrigin = 'bottom';

                        // Color: green → yellow → red
                        if (left.clipping || right.clipping) {
                            el.style.backgroundColor = '#e53e3e';
                        } else if (clamped > 0.7) {
                            el.style.backgroundColor = '#d69e2e';
                        } else {
                            el.style.backgroundColor = '#38a169';
                        }
                    }
                } catch {
                    // Meters unavailable — skip this frame
                }
            }
        } catch {
            // Transport unavailable — skip this frame
        }

        // Continue loop
        if (isRunning.current) {
            rafId.current = requestAnimationFrame(loop);
        }
    }, []);

    useEffect(() => {
        const enabled = config.enabled !== false;

        if (enabled) {
            isRunning.current = true;
            rafId.current = requestAnimationFrame(loop);
        }

        return () => {
            isRunning.current = false;
            if (rafId.current !== null) {
                cancelAnimationFrame(rafId.current);
                rafId.current = null;
            }
        };
    }, [config.enabled, loop]);
}
