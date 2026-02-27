import { useCallback } from 'react';
import { VB_H, VB_W, bandDotY, freqToX, xToFreq, type EqBand8 } from '@/widgets/DeviceRack/lib/eqMath';
import { clamp01, clampEqGainDb } from '@/shared/lib/audioMath';
import type { EqContextMenu } from '@/widgets/DeviceRack/ui/PluginGuiSurfaceEqOverlays';

type Args = {
    eqSurfaceRef: React.RefObject<SVGSVGElement | null>;
    bands: EqBand8[];
    eqBandFilterTypes: string[];
    onParamChange: (paramName: string, value: number) => void;
    setSelectedEqBand: React.Dispatch<React.SetStateAction<number | null>>;
    beginEqBandGesture: (bandIdx: number) => void;
    setDragEqBand: React.Dispatch<React.SetStateAction<number | null>>;
    setEqContextMenu: React.Dispatch<React.SetStateAction<EqContextMenu | null>>;
    onBandCreated: (bandIdx: number) => void;
};

export function useEqSurfaceHandlers({
    eqSurfaceRef,
    bands,
    eqBandFilterTypes,
    onParamChange,
    setSelectedEqBand,
    beginEqBandGesture,
    setDragEqBand,
    setEqContextMenu,
    onBandCreated,
}: Args) {
    const handleMouseDown = useCallback((e: React.MouseEvent<SVGSVGElement>) => {
        // Do not cancel right-button mousedown: cancelling here suppresses
        // subsequent contextmenu on some platforms/browsers.
        if (e.button === 2) return;
        e.preventDefault();
        e.stopPropagation();
        const svg = eqSurfaceRef.current;
        if (!svg) return;
        const rect = svg.getBoundingClientRect();
        const svgX = ((e.clientX - rect.left) / rect.width) * VB_W;
        const svgY = ((e.clientY - rect.top) / rect.height) * VB_H;
        let nearest: EqBand8 | null = null;
        let nearestDist = Infinity;
        for (const band of bands) {
            if (!band.enabled) continue;
            const bx = freqToX(band.freq);
            const by = bandDotY(band);
            const dist = Math.sqrt((svgX - bx) ** 2 + (svgY - by) ** 2);
            if (dist < nearestDist) {
                nearestDist = dist;
                nearest = band;
            }
        }
        if (!nearest || nearestDist >= 25) return;
        setSelectedEqBand(nearest.idx);
        beginEqBandGesture(nearest.idx);
        setDragEqBand(nearest.idx);
    }, [bands, beginEqBandGesture, eqSurfaceRef, setDragEqBand, setSelectedEqBand]);

    const handleDoubleClick = useCallback((e: React.MouseEvent<SVGSVGElement>) => {
        e.preventDefault();
        e.stopPropagation();
        const svg = eqSurfaceRef.current;
        if (!svg) return;
        const rect = svg.getBoundingClientRect();
        const svgX = ((e.clientX - rect.left) / rect.width) * VB_W;
        const svgY = ((e.clientY - rect.top) / rect.height) * VB_H;
        let clickedBand: EqBand8 | null = null;
        let clickedDist = Infinity;
        for (const band of bands) {
            if (!band.enabled) continue;
            const bx = freqToX(band.freq);
            const by = bandDotY(band);
            const dist = Math.sqrt((svgX - bx) ** 2 + (svgY - by) ** 2);
            if (dist < clickedDist) {
                clickedDist = dist;
                clickedBand = band;
            }
        }
        if (clickedBand && clickedDist < 20) {
            onParamChange(`B${clickedBand.idx}En`, 0);
            return;
        }
        const clickFreq = xToFreq(svgX);
        const disabledBands = bands.filter((b) => !b.enabled);
        if (disabledBands.length === 0) return;
        let bestBand = disabledBands[0];
        let bestDelta = Infinity;
        for (const db of disabledBands) {
            const delta = Math.abs(Math.log2(clickFreq / db.freq));
            if (delta < bestDelta) {
                bestDelta = delta;
                bestBand = db;
            }
        }
        onParamChange(`B${bestBand.idx}Freq`, Math.round(clickFreq));
        const newBandFilterType = eqBandFilterTypes[bestBand.idx] ?? 'peaking';
        const newBandFilterOnly = newBandFilterType === 'lowpass' || newBandFilterType === 'highpass' || newBandFilterType === 'notch';
        if (newBandFilterOnly) {
            const clickQNorm = ((VB_H - 10) - svgY) / (VB_H - 20);
            const clampedQNorm = clamp01(clickQNorm);
            const clickQ = Math.exp(Math.log(0.1) + clampedQNorm * (Math.log(18) - Math.log(0.1)));
            onParamChange(`B${bestBand.idx}Q`, Math.round(clickQ * 100) / 100);
        } else {
            const clickGain = ((VB_H / 2 - svgY) / (VB_H / 2 - 10)) * 24;
            const clampedGain = clampEqGainDb(clickGain);
            onParamChange(`B${bestBand.idx}Gain`, Math.round(clampedGain * 10) / 10);
        }
        onBandCreated(bestBand.idx);
        onParamChange(`B${bestBand.idx}En`, 1);
        setSelectedEqBand(bestBand.idx);
    }, [bands, eqBandFilterTypes, eqSurfaceRef, onBandCreated, onParamChange, setSelectedEqBand]);

    const handleContextMenu = useCallback((e: React.MouseEvent<SVGSVGElement>) => {
        e.preventDefault();
        e.stopPropagation();
        const svg = eqSurfaceRef.current;
        if (!svg) return;
        const rect = svg.getBoundingClientRect();
        const svgX = ((e.clientX - rect.left) / rect.width) * VB_W;
        const svgY = ((e.clientY - rect.top) / rect.height) * VB_H;
        let nearest: EqBand8 | null = null;
        let nearestDist = Infinity;
        for (const band of bands) {
            if (!band.enabled) continue;
            const bx = freqToX(band.freq);
            const by = bandDotY(band);
            const dist = Math.sqrt((svgX - bx) ** 2 + (svgY - by) ** 2);
            if (dist < nearestDist) {
                nearestDist = dist;
                nearest = band;
            }
        }
        if (nearest && nearestDist < 30) {
            setEqContextMenu({ x: e.clientX, y: e.clientY, bandIdx: nearest.idx });
        }
    }, [bands, eqSurfaceRef, setEqContextMenu]);

    return { handleMouseDown, handleDoubleClick, handleContextMenu };
}
