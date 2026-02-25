// ═══════════════════════════════════════════════════════════════════════════
// Dream DAW — useViewportMachine Hook
// ═══════════════════════════════════════════════════════════════════════════
//
// React integration layer for ViewportMachine. This hook:
//   1. Creates and manages the lifecycle of a ViewportMachine instance
//   2. Attaches it to a container ref
//   3. Handles resize observation
//   4. Bridges debounced flushes to React state (for waveform/culling updates)
//
// Usage:
//   const { vmRef, containerProps, reactState } = useViewportMachine({
//       totalBeats: 1024,
//       trackCount: 9,
//       trackHeight: 48,
//   });
//
// ═══════════════════════════════════════════════════════════════════════════

import { useRef, useCallback, useEffect, useState, useMemo } from 'react';
import { ViewportMachine, type ViewportSnapshot } from './ViewportMachine';

// ── Types ────────────────────────────────────────────────────────────────

export interface UseViewportMachineConfig {
    /** Total beats in the project. */
    totalBeats: number;
    /** Number of tracks. */
    trackCount: number;
    /** Track height in pixels. */
    trackHeight: number;
    /** Initial pixels per beat (zoom level). */
    initialPpb?: number;
}

export interface UseViewportMachineReturn {
    /** Ref to the ViewportMachine instance — use for imperative access. */
    vmRef: React.RefObject<ViewportMachine | null>;

    /** Ref to attach to the container div. */
    containerRef: React.RefObject<HTMLDivElement | null>;

    /**
     * Debounced React state — updated ~150ms after scroll/zoom stops.
     * Use ONLY for waveform mip-level selection and clip culling.
     * Do NOT use for positioning (that's CSS vars).
     */
    reactState: ViewportSnapshot;

    /**
     * Snap coordinate functions from the machine.
     */
    screenToBeats: (clientX: number) => number;
    beatsToScreen: (beat: number) => number;
    screenToTrack: (clientY: number) => number;
}

// ── Hook ─────────────────────────────────────────────────────────────────

export function useViewportMachine(config: UseViewportMachineConfig): UseViewportMachineReturn {
    const { totalBeats, trackCount, trackHeight, initialPpb = 20 } = config;

    const containerRef = useRef<HTMLDivElement | null>(null);
    const vmRef = useRef<ViewportMachine | null>(null);

    // React state — only updated on debounced flush (cold path)
    const [reactState, setReactState] = useState<ViewportSnapshot>({
        scrollX: 0,
        scrollY: 0,
        pixelsPerBeat: initialPpb,
        viewportWidth: 0,
        viewportHeight: 0,
    });
    const initialConfigRef = useRef<UseViewportMachineConfig | null>(null);
    if (initialConfigRef.current == null) {
        initialConfigRef.current = config;
    }

    // Stable flush callback
    const onFlush = useCallback((snapshot: ViewportSnapshot) => {
        setReactState(snapshot);
    }, []);

    // Create ViewportMachine once
    useEffect(() => {
        const initialConfig = initialConfigRef.current;
        if (!initialConfig) return;
        const vm = new ViewportMachine({
            totalBeats: initialConfig.totalBeats,
            trackCount: initialConfig.trackCount,
            trackHeight: initialConfig.trackHeight,
            initialPpb: initialConfig.initialPpb ?? 20,
            onFlush,
        });
        vmRef.current = vm;

        return () => {
            vm.detach();
            vmRef.current = null;
        };
    }, [onFlush]);

    // Attach to container when ref is available
    useEffect(() => {
        const vm = vmRef.current;
        const el = containerRef.current;
        if (!vm || !el) return;

        vm.attach(el);
        return () => vm.detach();
    }, []);

    // Resize observer — update viewport dimensions
    useEffect(() => {
        const el = containerRef.current;
        if (!el) return;

        const ro = new ResizeObserver((entries) => {
            for (const entry of entries) {
                const { width, height } = entry.contentRect;
                vmRef.current?.updateViewportSize(width, height);
            }
        });
        ro.observe(el);
        return () => ro.disconnect();
    }, []);

    // Sync config changes to the machine
    useEffect(() => {
        vmRef.current?.updateConfig({ totalBeats, trackCount, trackHeight });
    }, [totalBeats, trackCount, trackHeight]);

    // Coordinate conversion functions (stable references)
    const screenToBeats = useCallback((clientX: number) => {
        return vmRef.current?.screenToBeats(clientX) ?? 0;
    }, []);

    const beatsToScreen = useCallback((beat: number) => {
        return vmRef.current?.beatsToScreen(beat) ?? 0;
    }, []);

    const screenToTrack = useCallback((clientY: number) => {
        return vmRef.current?.screenToTrack(clientY) ?? 0;
    }, []);

    return useMemo(() => ({
        vmRef,
        containerRef,
        reactState,
        screenToBeats,
        beatsToScreen,
        screenToTrack,
    }), [reactState, screenToBeats, beatsToScreen, screenToTrack]);
}
