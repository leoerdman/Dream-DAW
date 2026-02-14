// ═══════════════════════════════════════════════════════════════════════════
// Dream DAW — Push-Based Telemetry (Event-Driven)
// ═══════════════════════════════════════════════════════════════════════════
//
// LEVIATHAN Epic 1: Replaced the requestAnimationFrame polling loop with
// a Tauri event listener. The Rust backend now pushes `telemetry_tick`
// events at 30fps containing transport state + meter readings.
//
// Architecture:
//   1. Rust thread sleeps 33ms, builds transport+meters snapshot, emits event
//   2. Frontend `listen('telemetry_tick')` receives the payload
//   3. Playhead position → `transform: translateX(px)` on a ref
//   4. Meter levels → `transform: scaleY(rms)` on meter bar refs
//   5. Loop never touches React state — zero re-renders
//
// Benefits over rAF + invoke():
//   - Zero IPC invoke() overhead per frame (was 2 invokes × 60fps = 120 IPC/s)
//   - Rust controls the tick rate (30fps), frontend is purely reactive
//   - CPU savings: no requestAnimationFrame spin when tab is hidden
//
// ═══════════════════════════════════════════════════════════════════════════

import { useEffect, useRef } from 'react';
import { listen, type UnlistenFn } from '@tauri-apps/api/event';

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

/** Shape of the telemetry_tick event payload from Rust. */
interface TelemetryPayload {
    transport: {
        is_playing: boolean;
        position_frames: number;
        position_seconds: number;
        bpm: number;
        loop_enabled: boolean;
        loop_start: number;
        loop_end: number;
    };
    meters: {
        tracks: [
            { rms: number; peak: number; clipping: boolean },
            { rms: number; peak: number; clipping: boolean },
        ][];
        master_left: { rms: number; peak: number; clipping: boolean };
        master_right: { rms: number; peak: number; clipping: boolean };
    };
}

// ── Hook ────────────────────────────────────────────────────────────────

/**
 * Push-based telemetry hook: subscribes to `telemetry_tick` events from Rust.
 *
 * Directly mutates DOM via refs — zero React re-renders.
 * The Rust backend pushes transport + meter data at ~30fps.
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
    // Store config/refs in refs to avoid re-subscribing on every render
    const configRef = useRef(config);
    const refsRef = useRef(refs);

    useEffect(() => {
        configRef.current = config;
        refsRef.current = refs;
    }, [config, refs]);

    useEffect(() => {
        const enabled = config.enabled !== false;
        if (!enabled) return;

        let unlisten: UnlistenFn | null = null;

        const setup = async () => {
            unlisten = await listen<TelemetryPayload>('telemetry_tick', (event) => {
                const { transport, meters } = event.payload;

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
                if (meterEls && meterEls.length > 0 && meters.tracks) {
                    const tracks = meters.tracks;

                    for (let i = 0; i < meterEls.length && i < tracks.length; i++) {
                        const el = meterEls[i];
                        if (!el) continue;

                        // Use max of L/R channels for single-bar display
                        const [left, right] = tracks[i];
                        const level = Math.max(left.rms, right.rms);

                        // Convert from dB to linear (0-1 range)
                        // dB range: -60 to 0, map to 0 to 1
                        const dbMin = -60;
                        const clamped = Math.min(1, Math.max(0, (level - dbMin) / -dbMin));

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
                }
            });
        };

        setup();

        return () => {
            unlisten?.();
        };
    }, [config.enabled]);
}
