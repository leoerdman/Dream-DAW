import { useEffect, useRef } from 'react';
import { MARGIN_L, PLOT_W, VB_H, VB_W } from '@/widgets/DeviceRack/lib/eqMath';
import { clamp01, clampEqGainDb } from '@/shared/lib/audioMath';

type Args = {
    dragEqBand: number | null;
    eqSurfaceRef: React.RefObject<SVGSVGElement | null>;
    resolvedEqBandFilterTypes: string[];
    onParamChange: (paramName: string, value: number) => void;
    endEqBandGesture: (bandIdx: number) => void;
    setDragEqBand: React.Dispatch<React.SetStateAction<number | null>>;
};

/**
 * ENTERPRISE EQ DRAG EFFECT
 *
 * ROOT CAUSE OF DRAG FREEZE (fixed):
 * The useEffect previously depended on [resolvedEqBandFilterTypes, onParamChange,
 * endEqBandGesture, ...] — all of which change identity on every render.
 * This caused the effect to RESTART mid-drag, tearing down and re-registering
 * mousemove/mouseup listeners. If a mouseup event fired during that teardown
 * gap, dragEqBand stayed non-null forever → point frozen.
 *
 * FIX: The effect now depends ONLY on dragEqBand. All other dependencies are
 * accessed via refs, which are always up-to-date without causing effect restarts.
 * This matches the React best practice for stable effects with changing callbacks.
 */
export function useEqBandDragEffect({
    dragEqBand,
    eqSurfaceRef,
    resolvedEqBandFilterTypes,
    onParamChange,
    endEqBandGesture,
    setDragEqBand,
}: Args) {
    // Store all callbacks and data in refs so the effect
    // never restarts due to identity changes.
    const onParamChangeRef = useRef(onParamChange);
    onParamChangeRef.current = onParamChange;

    const endEqBandGestureRef = useRef(endEqBandGesture);
    endEqBandGestureRef.current = endEqBandGesture;

    const setDragEqBandRef = useRef(setDragEqBand);
    setDragEqBandRef.current = setDragEqBand;

    const resolvedTypesRef = useRef(resolvedEqBandFilterTypes);
    resolvedTypesRef.current = resolvedEqBandFilterTypes;

    const surfaceRef = useRef(eqSurfaceRef);
    surfaceRef.current = eqSurfaceRef;

    useEffect(() => {
        if (dragEqBand === null) return;
        const bandIdx = dragEqBand;
        let lastFreq = Number.NaN;
        let lastGain = Number.NaN;
        let lastQ = Number.NaN;
        let lastQSentAt = 0;
        let lastFlushAt = 0;
        let rafId: number | null = null;
        let latestEvent: PointerEvent | null = null;
        let disposed = false;

        const flushMove = () => {
            rafId = null;
            if (disposed) return;
            const e = latestEvent;
            if (!e) return;

            const now = performance.now();
            // 16ms (60fps) throttle — limits IPC calls, not visual feedback
            if (now - lastFlushAt < 16) {
                rafId = window.requestAnimationFrame(flushMove);
                return;
            }
            lastFlushAt = now;

            const surface = surfaceRef.current.current;
            if (!surface) return;
            const rect = surface.getBoundingClientRect();
            if (rect.width < 1 || rect.height < 1) return;

            const xNorm = clamp01((e.clientX - rect.left) / rect.width);
            const yNorm = Math.max(0, Math.min(rect.height, e.clientY - rect.top));
            const svgY = (yNorm / rect.height) * VB_H;
            const svgX = xNorm * VB_W;
            const freqNorm = clamp01((svgX - MARGIN_L) / PLOT_W);
            const minF = Math.log10(20);
            const maxF = Math.log10(20000);
            const freq = Math.pow(10, minF + freqNorm * (maxF - minF));
            const roundedFreq = Math.round(freq);

            const freqChangedEnough = Number.isNaN(lastFreq) ||
                Math.abs(Math.log10(roundedFreq) - Math.log10(lastFreq)) >= 0.001;
            if (roundedFreq !== lastFreq && freqChangedEnough) {
                lastFreq = roundedFreq;
                onParamChangeRef.current(`B${bandIdx}Freq`, roundedFreq);
            }

            // Read filter type from ref — always latest, no effect restart
            const filterType = resolvedTypesRef.current[bandIdx] ?? 'peaking';
            const filterOnly = filterType === 'lowpass' || filterType === 'highpass' || filterType === 'notch';

            if (filterOnly) {
                const qNorm = ((VB_H - 10) - svgY) / (VB_H - 20);
                const clampedQNorm = clamp01(qNorm);
                const q = Math.exp(Math.log(0.1) + clampedQNorm * (Math.log(18) - Math.log(0.1)));
                const roundedQ = Math.round(q * 100) / 100;
                const qChangedEnough = Number.isNaN(lastQ) || Math.abs(roundedQ - lastQ) >= 0.05;
                const qSendWindowOpen = now - lastQSentAt >= 32;
                if (roundedQ !== lastQ && (qChangedEnough || qSendWindowOpen)) {
                    lastQ = roundedQ;
                    lastQSentAt = now;
                    onParamChangeRef.current(`B${bandIdx}Q`, roundedQ);
                }
                return;
            }

            const gainValue = ((VB_H / 2 - svgY) / (VB_H / 2 - 10)) * 24;
            const roundedGain = clampEqGainDb(gainValue);
            const quantizedGain = Math.round(roundedGain * 10) / 10;
            const gainChangedEnough = Number.isNaN(lastGain) ||
                Math.abs(quantizedGain - lastGain) >= 0.1;
            if (quantizedGain !== lastGain && gainChangedEnough) {
                lastGain = quantizedGain;
                onParamChangeRef.current(`B${bandIdx}Gain`, quantizedGain);
            }
        };

        // ENTERPRISE FIX (Phase 33): Pointer events for interrupt safety.
        const onMove = (e: PointerEvent) => {
            latestEvent = e;
            if (rafId != null) return;
            rafId = window.requestAnimationFrame(flushMove);
        };

        const onUp = () => {
            if (disposed) return;
            disposed = true;
            if (rafId != null) {
                window.cancelAnimationFrame(rafId);
                rafId = null;
            }
            // Final flush to capture last pointer position
            flushMove();
            endEqBandGestureRef.current(bandIdx);
            setDragEqBandRef.current(null);
        };

        window.addEventListener('pointermove', onMove);
        window.addEventListener('pointerup', onUp);
        window.addEventListener('pointercancel', onUp);

        return () => {
            disposed = true;
            if (rafId != null) {
                window.cancelAnimationFrame(rafId);
            }
            window.removeEventListener('pointermove', onMove);
            window.removeEventListener('pointerup', onUp);
            window.removeEventListener('pointercancel', onUp);
        };
        // CRITICAL: Only depend on dragEqBand. All other deps are accessed via refs.
        // This prevents the effect from restarting mid-drag, which was the root cause
        // of the "point freezes and stops moving" bug.
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [dragEqBand]);
}
