// ═══════════════════════════════════════════════════════════════════════════
// Dream DAW — useTimelineEngine (React Integration Hook)
// ═══════════════════════════════════════════════════════════════════════════
//
// Thin React bridge for the canvas-based TimelineEngine.
//
// Responsibilities:
//   1. Create and manage TimelineEngine lifecycle
//   2. Provide a canvas ref for React JSX
//   3. Feed data to the engine via useEffect
//   4. Wire callbacks from engine to React props
//   5. Expose viewport snapshot for cold-path operations
//
// This hook does NOT re-render on scroll/zoom/drag.
// It only re-renders when engine emits a debounced viewport flush
// (needed for waveform mip-level selection, clip culling thresholds).
//
// ═══════════════════════════════════════════════════════════════════════════

import { useRef, useEffect, useState, useMemo } from 'react';
import { TimelineEngine } from './TimelineEngine';
import type { TimelineEngineConfig } from './TimelineEngine.types';
import type { ViewportSnapshot } from './ViewportMatrix';

// ── Config ────────────────────────────────────────────────────────────────

export interface UseTimelineEngineConfig {
    beatsPerBar: number;
    bpm: number;
    sampleRate: number;
    totalBeats: number;
    trackCount: number;
    trackHeight: number;
    /** Optional per-track heights (length == trackCount). */
    trackHeights?: number[];
    rulerHeight: number;
    bottomPaddingPx?: number;
    initialPpb?: number;
    snapBeats?: number;
    snapEnabled?: boolean;
    automationVisible: boolean;
}

// ── Return type ───────────────────────────────────────────────────────────

export interface UseTimelineEngineReturn {
    /** Ref to attach to the <canvas> element. */
    canvasRef: React.RefObject<HTMLCanvasElement | null>;
    /** The engine instance (for imperative access). */
    engineRef: React.RefObject<TimelineEngine | null>;
    /** Debounced viewport state (for cold-path React operations). */
    viewportState: ViewportSnapshot;
}

// ── Hook ──────────────────────────────────────────────────────────────────

export function useTimelineEngine(
    config: UseTimelineEngineConfig,
): UseTimelineEngineReturn {
    const canvasRef = useRef<HTMLCanvasElement | null>(null);
    const engineRef = useRef<TimelineEngine | null>(null);

    const [viewportState, setViewportState] = useState<ViewportSnapshot>({
        scrollX: 0,
        scrollY: 0,
        ppb: config.initialPpb ?? 20,
        viewportWidth: 0,
        viewportHeight: 0,
    });
    const initialConfigRef = useRef<UseTimelineEngineConfig>(config);

    // ── Create engine once ────────────────────────────────────────────
    useEffect(() => {
        const initialConfig = initialConfigRef.current;
        const engineConfig: TimelineEngineConfig = {
            beatsPerBar: initialConfig.beatsPerBar,
            bpm: initialConfig.bpm,
            sampleRate: initialConfig.sampleRate,
            snapBeats: initialConfig.snapBeats,
            snapEnabled: initialConfig.snapEnabled,
            automationVisible: initialConfig.automationVisible,
            viewport: {
                totalBeats: initialConfig.totalBeats,
                trackCount: initialConfig.trackCount,
                trackHeight: initialConfig.trackHeight,
                trackHeights: initialConfig.trackHeights,
                rulerHeight: initialConfig.rulerHeight,
                bottomPaddingPx: initialConfig.bottomPaddingPx,
                initialPpb: initialConfig.initialPpb,
            },
        };

        const engine = new TimelineEngine(engineConfig);
        engineRef.current = engine;

        // Wire viewport flush with rAF throttling to prevent React/Zustand render thrashing
        // during high-frequency native trackpad scrolling/zooming.
        // ENTERPRISE FIX: Always capture the latest snapshot so the rAF callback
        // applies the most recent viewport data. Previously, intermediate snapshots
        // were silently dropped when a rAF was already queued — this caused the
        // master lane grid (and all viewport-derived UI) to desync from the
        // actual scroll/zoom position until the *next* scroll event.
        let flushRafId = 0;
        let latestSnap: ViewportSnapshot | null = null;
        engine.onViewportFlush = (snap) => {
            latestSnap = snap;
            if (flushRafId) return;
            flushRafId = requestAnimationFrame(() => {
                flushRafId = 0;
                if (latestSnap) {
                    setViewportState(latestSnap);
                    latestSnap = null;
                }
            });
        };

        // Attach to canvas when available
        const canvas = canvasRef.current;
        if (canvas) {
            engine.attach(canvas);
        }

        return () => {
            if (flushRafId) cancelAnimationFrame(flushRafId);
            engine.destroy();
            engineRef.current = null;
        };
    }, []); // Intentionally empty — engine created once

    // ── Sync config changes to engine ─────────────────────────────────
    useEffect(() => {
        const engine = engineRef.current;
        if (!engine) return;
        engine.setConfig({
            beatsPerBar: config.beatsPerBar,
            bpm: config.bpm,
            sampleRate: config.sampleRate,
            snapBeats: config.snapBeats,
            snapEnabled: config.snapEnabled,
            automationVisible: config.automationVisible,
            viewport: {
                totalBeats: config.totalBeats,
                trackCount: config.trackCount,
                trackHeight: config.trackHeight,
                trackHeights: config.trackHeights,
                rulerHeight: config.rulerHeight,
                bottomPaddingPx: config.bottomPaddingPx,
            },
        });
    }, [
        config.beatsPerBar, config.bpm, config.sampleRate,
        config.totalBeats, config.trackCount, config.trackHeight,
        config.trackHeights,
        config.rulerHeight, config.bottomPaddingPx, config.snapBeats, config.snapEnabled,
        config.automationVisible,
    ]);

    return useMemo(() => ({
        canvasRef,
        engineRef,
        viewportState,
    }), [viewportState]);
}
