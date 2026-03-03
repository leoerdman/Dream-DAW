import { useEffect } from 'react';
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

export function useEqBandDragEffect({
    dragEqBand,
    eqSurfaceRef,
    resolvedEqBandFilterTypes,
    onParamChange,
    endEqBandGesture,
    setDragEqBand,
}: Args) {
    useEffect(() => {
        if (dragEqBand === null) return;
        const bandIdx = dragEqBand;
        let lastFreq = Number.NaN;
        let lastGain = Number.NaN;
        let lastQ = Number.NaN;
        let lastQSentAt = 0;
        let lastFlushAt = 0;
        let rafId: number | null = null;
        let latestEvent: MouseEvent | null = null;

        const flushMove = () => {
            rafId = null;
            const e = latestEvent;
            if (!e) return;
            // PERF: 16ms (60fps) throttle for smooth drag. The local overlay
            // provides instant visual feedback; this throttle only limits IPC calls.
            const now = performance.now();
            if (now - lastFlushAt < 16) {
                rafId = window.requestAnimationFrame(flushMove);
                return;
            }
            lastFlushAt = now;
            const surface = eqSurfaceRef.current;
            if (!surface) return;
            const rect = surface.getBoundingClientRect();
            const xNorm = clamp01((e.clientX - rect.left) / Math.max(1, rect.width));
            const yNorm = Math.max(0, Math.min(rect.height, e.clientY - rect.top));
            const svgY = (yNorm / rect.height) * VB_H;
            const svgX = xNorm * VB_W;
            const freqNorm = clamp01((svgX - MARGIN_L) / PLOT_W);
            const minF = Math.log10(20);
            const maxF = Math.log10(20000);
            const freq = Math.pow(10, minF + freqNorm * (maxF - minF));
            const roundedFreq = Math.round(freq);
            // Log-scale frequency delta: send when ≥0.1% change on log scale
            const freqChangedEnough = Number.isNaN(lastFreq) ||
                Math.abs(Math.log10(roundedFreq) - Math.log10(lastFreq)) >= 0.001;
            if (roundedFreq !== lastFreq && freqChangedEnough) {
                lastFreq = roundedFreq;
                onParamChange(`B${bandIdx}Freq`, roundedFreq);
            }
            const filterType = resolvedEqBandFilterTypes[bandIdx] ?? 'peaking';
            const filterOnly = filterType === 'lowpass' || filterType === 'highpass' || filterType === 'notch';
            if (filterOnly) {
                const qNorm = ((VB_H - 10) - svgY) / (VB_H - 20);
                const clampedQNorm = clamp01(qNorm);
                const q = Math.exp(Math.log(0.1) + clampedQNorm * (Math.log(18) - Math.log(0.1)));
                const roundedQ = Math.round(q * 100) / 100;
                // Lower Q threshold for smooth drag
                const qChangedEnough = Number.isNaN(lastQ) || Math.abs(roundedQ - lastQ) >= 0.05;
                const qSendWindowOpen = now - lastQSentAt >= 32;
                if (roundedQ !== lastQ && (qChangedEnough || qSendWindowOpen)) {
                    lastQ = roundedQ;
                    lastQSentAt = now;
                    onParamChange(`B${bandIdx}Q`, roundedQ);
                }
                return;
            }
            const gainValue = ((VB_H / 2 - svgY) / (VB_H / 2 - 10)) * 24;
            const roundedGain = clampEqGainDb(gainValue);
            const quantizedGain = Math.round(roundedGain * 10) / 10;
            // 0.1dB threshold for smooth, precise gain drag
            const gainChangedEnough = Number.isNaN(lastGain) ||
                Math.abs(quantizedGain - lastGain) >= 0.1;
            if (quantizedGain !== lastGain && gainChangedEnough) {
                lastGain = quantizedGain;
                onParamChange(`B${bandIdx}Gain`, quantizedGain);
            }
        };
        const onMove = (e: MouseEvent) => {
            latestEvent = e;
            if (rafId != null) return;
            rafId = window.requestAnimationFrame(flushMove);
        };
        const onUp = () => {
            if (rafId != null) {
                window.cancelAnimationFrame(rafId);
                rafId = null;
            }
            flushMove();
            endEqBandGesture(bandIdx);
            setDragEqBand(null);
        };
        window.addEventListener('mousemove', onMove);
        window.addEventListener('mouseup', onUp);
        return () => {
            if (rafId != null) {
                window.cancelAnimationFrame(rafId);
            }
            window.removeEventListener('mousemove', onMove);
            window.removeEventListener('mouseup', onUp);
        };
    }, [dragEqBand, endEqBandGesture, eqSurfaceRef, onParamChange, resolvedEqBandFilterTypes, setDragEqBand]);
}
