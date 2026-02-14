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
import { TimelineEngine, type TimelineEngineConfig } from './TimelineEngine';
import type { ViewportSnapshot } from './ViewportMatrix';

// ── Config ────────────────────────────────────────────────────────────────

export interface UseTimelineEngineConfig {
    beatsPerBar: number;
    bpm: number;
    sampleRate: number;
    totalBeats: number;
    trackCount: number;
    trackHeight: number;
    rulerHeight: number;
    initialPpb?: number;
    snapBeats?: number;
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

    // ── Create engine once ────────────────────────────────────────────
    useEffect(() => {
        const engineConfig: TimelineEngineConfig = {
            beatsPerBar: config.beatsPerBar,
            bpm: config.bpm,
            sampleRate: config.sampleRate,
            snapBeats: config.snapBeats,
            viewport: {
                totalBeats: config.totalBeats,
                trackCount: config.trackCount,
                trackHeight: config.trackHeight,
                rulerHeight: config.rulerHeight,
                initialPpb: config.initialPpb,
            },
        };

        const engine = new TimelineEngine(engineConfig);
        engineRef.current = engine;

        // Wire viewport flush
        engine.onViewportFlush = (snap) => {
            setViewportState(snap);
        };

        // Attach to canvas when available
        const canvas = canvasRef.current;
        if (canvas) {
            engine.attach(canvas);
        }

        return () => {
            engine.destroy();
            engineRef.current = null;
        };
        // eslint-disable-next-line react-hooks/exhaustive-deps
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
            viewport: {
                totalBeats: config.totalBeats,
                trackCount: config.trackCount,
                trackHeight: config.trackHeight,
                rulerHeight: config.rulerHeight,
            },
        });
    }, [
        config.beatsPerBar, config.bpm, config.sampleRate,
        config.totalBeats, config.trackCount, config.trackHeight,
        config.rulerHeight, config.snapBeats,
    ]);

    // ── Canvas ref callback (delayed attach for SSR compat) ───────────
    useEffect(() => {
        const engine = engineRef.current;
        const canvas = canvasRef.current;
        if (engine && canvas && !engine.viewport) {
            engine.attach(canvas);
        }
    });

    return useMemo(() => ({
        canvasRef,
        engineRef,
        viewportState,
    }), [viewportState]);
}
