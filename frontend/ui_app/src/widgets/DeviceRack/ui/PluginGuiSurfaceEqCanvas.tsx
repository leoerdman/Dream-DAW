import React from 'react';
import {
    VB_W,
    VB_H,
    MARGIN_L,
    MARGIN_R,
    freqToX,
    xToFreq,
    gainToY,
    bandDotY,
    type EqBand8,
} from '@/widgets/DeviceRack/lib/eqMath';
import {
    EqBandContextMenu,
    EqBandOverlays,
    type EqContextMenu,
} from './PluginGuiSurfaceEqOverlays';

type Props = {
    deviceId: string;
    bands: EqBand8[];
    dragEqBand: number | null;
    selectedEqBand: number | null;
    setSelectedEqBand: React.Dispatch<React.SetStateAction<number | null>>;
    setDragEqBand: React.Dispatch<React.SetStateAction<number | null>>;
    beginEqBandGesture: (bandIdx: number) => void;
    onParamChange: (paramName: string, value: number) => void;
    eqBandFilterTypes: string[];
    setEqBandFilterTypes: React.Dispatch<React.SetStateAction<string[]>>;
    eqContextMenu: EqContextMenu | null;
    setEqContextMenu: React.Dispatch<React.SetStateAction<EqContextMenu | null>>;
    eqSurfaceRef: React.RefObject<SVGSVGElement | null>;
    eqSpectrumEnabled: boolean;
    setEqSpectrumEnabled: React.Dispatch<React.SetStateAction<boolean>>;
    spectrumPath: string | null;
    curvePath: string;
    fillPath: string;
};

const FREQ_LABELS = [
    { freq: 20, label: '20' }, { freq: 30, label: '30' }, { freq: 50, label: '50' },
    { freq: 100, label: '100' }, { freq: 200, label: '200' }, { freq: 500, label: '500' },
    { freq: 1000, label: '1k' }, { freq: 2000, label: '2k' }, { freq: 5000, label: '5k' },
    { freq: 10000, label: '10k' }, { freq: 20000, label: '20k' },
];
const FREQ_SUB_LINES = [40, 60, 80, 150, 300, 400, 700, 800, 1500, 3000, 4000, 7000, 8000, 15000];

export function PluginGuiSurfaceEqCanvas({
    deviceId,
    bands,
    dragEqBand,
    selectedEqBand,
    setSelectedEqBand,
    setDragEqBand,
    beginEqBandGesture,
    onParamChange,
    eqBandFilterTypes,
    setEqBandFilterTypes,
    eqContextMenu,
    setEqContextMenu,
    eqSurfaceRef,
    eqSpectrumEnabled,
    setEqSpectrumEnabled,
    spectrumPath,
    curvePath,
    fillPath,
}: Props): React.ReactNode {
    return (
        <div style={{ position: 'relative', flex: 1 }}>
            <svg
                ref={eqSurfaceRef}
                width="100%"
                height="100%"
                viewBox={`0 0 ${VB_W} ${VB_H}`}
                preserveAspectRatio="none"
                style={{ cursor: 'crosshair', display: 'block' }}
                onMouseDown={(e) => {
                    if (e.button === 2) return;
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
                        if (dist < nearestDist) { nearestDist = dist; nearest = band; }
                    }
                    if (nearest && nearestDist < 25) {
                        setSelectedEqBand(nearest.idx);
                        beginEqBandGesture(nearest.idx);
                        setDragEqBand(nearest.idx);
                    }
                }}
                onDoubleClick={(e) => {
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
                        if (dist < clickedDist) { clickedDist = dist; clickedBand = band; }
                    }
                    if (clickedBand && clickedDist < 20) {
                        onParamChange(`B${clickedBand.idx}En`, 0);
                        return;
                    }
                    const clickFreq = xToFreq(svgX);
                    const disabledBands = bands.filter(b => !b.enabled);
                    if (disabledBands.length === 0) return;
                    let bestBand = disabledBands[0];
                    let bestDelta = Infinity;
                    for (const db of disabledBands) {
                        const delta = Math.abs(Math.log2(clickFreq / db.freq));
                        if (delta < bestDelta) { bestDelta = delta; bestBand = db; }
                    }
                    onParamChange(`B${bestBand.idx}Freq`, Math.round(clickFreq));
                    const newBandFilterType = eqBandFilterTypes[bestBand.idx] ?? 'peaking';
                    const newBandFilterOnly = newBandFilterType === 'lowpass' || newBandFilterType === 'highpass' || newBandFilterType === 'notch';
                    if (newBandFilterOnly) {
                        const clickQNorm = ((VB_H - 10) - svgY) / (VB_H - 20);
                        const clampedQNorm = Math.max(0, Math.min(1, clickQNorm));
                        const clickQ = Math.exp(Math.log(0.1) + clampedQNorm * (Math.log(18) - Math.log(0.1)));
                        onParamChange(`B${bestBand.idx}Q`, Math.round(clickQ * 100) / 100);
                    } else {
                        const clickGain = ((VB_H / 2 - svgY) / (VB_H / 2 - 10)) * 24;
                        const clampedGain = Math.max(-24, Math.min(24, clickGain));
                        onParamChange(`B${bestBand.idx}Gain`, Math.round(clampedGain * 10) / 10);
                    }
                    onParamChange(`B${bestBand.idx}En`, 1);
                    setSelectedEqBand(bestBand.idx);
                }}
                onContextMenu={(e) => {
                    e.preventDefault();
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
                        if (dist < nearestDist) { nearestDist = dist; nearest = band; }
                    }
                    if (nearest && nearestDist < 30) {
                        setEqContextMenu({ x: e.clientX, y: e.clientY, bandIdx: nearest.idx });
                    }
                }}
            >
                <defs>
                    <linearGradient id={`eqGrad-${deviceId}`} x1="0" y1="0" x2="0" y2="1">
                        <stop offset="0%" stopColor="var(--token-color-hex-5ab2ff)" stopOpacity="0.3" />
                        <stop offset="100%" stopColor="var(--token-color-hex-5ab2ff)" stopOpacity="0" />
                    </linearGradient>
                </defs>
                {[-24, -18, -12, -6, 0, 6, 12, 18, 24].map((db) => (
                    <line key={`hg-${db}`} x1={MARGIN_L} y1={gainToY(db)} x2={VB_W - MARGIN_R} y2={gainToY(db)} stroke={db === 0 ? 'var(--token-color-rgba-80-160-255-0d35)' : 'var(--token-color-rgba-60-130-220-0d08)'} strokeWidth={db === 0 ? 0.8 : 0.4} />
                ))}
                {FREQ_LABELS.map((fl) => (
                    <line key={`vf-${fl.freq}`} x1={freqToX(fl.freq)} y1={4} x2={freqToX(fl.freq)} y2={VB_H - 12} stroke="var(--token-color-rgba-60-130-220-0d12)" strokeWidth="0.5" />
                ))}
                {FREQ_SUB_LINES.map((f) => (
                    <line key={`vsub-${f}`} x1={freqToX(f)} y1={4} x2={freqToX(f)} y2={VB_H - 12} stroke="var(--token-color-rgba-60-130-220-0d05)" strokeWidth="0.3" />
                ))}
                <defs>
                    <linearGradient id={`specGrad-${deviceId}`} x1="0" y1="0" x2="0" y2="1">
                        <stop offset="0%" stopColor="var(--token-color-rgba-0-220-200-0d35)" />
                        <stop offset="100%" stopColor="var(--token-color-rgba-0-220-200-0)" />
                    </linearGradient>
                </defs>
                {spectrumPath && <path d={spectrumPath} fill={`url(#specGrad-${deviceId})`} opacity="0.6" />}
                <path d={fillPath} fill={`url(#eqGrad-${deviceId})`} opacity="0.5" />
                <path d={curvePath} fill="none" stroke="var(--token-color-rgba-90-178-255-0d7)" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
                {bands.filter((b) => b.enabled).length === 0 && (
                    <text x={VB_W / 2} y={VB_H / 2} textAnchor="middle" fill="var(--token-color-rgba-160-190-220-0d25)" fontSize="10" fontFamily="Inter, sans-serif">
                        Double-click to add EQ point
                    </text>
                )}
            </svg>

            <div
                style={{
                    position: 'absolute', top: 4, right: 6, zIndex: 10, cursor: 'pointer', width: 22, height: 22, borderRadius: 4,
                    display: 'flex', alignItems: 'center', justifyContent: 'center',
                    background: eqSpectrumEnabled ? 'var(--token-color-rgba-0-220-200-0d15)' : 'var(--token-color-rgba-90-178-255-0d06)',
                    border: `var(--space-px) solid ${eqSpectrumEnabled ? 'var(--token-color-rgba-0-220-200-0d4)' : 'var(--token-color-rgba-90-178-255-0d1)'}`,
                    transition: 'all 0.2s ease',
                }}
                title={eqSpectrumEnabled ? 'Hide Spectrum' : 'Show Spectrum'}
                onClick={() => setEqSpectrumEnabled(!eqSpectrumEnabled)}
            >
                <svg width="14" height="14" viewBox="0 0 14 14" fill="none">
                    <path d="M1 10 L3 6 L5 8 L7 3 L9 7 L11 5 L13 9" stroke={eqSpectrumEnabled ? 'var(--token-color-rgba-0-220-200-0d9)' : 'var(--token-color-rgba-160-190-220-0d4)'} strokeWidth="1.2" fill="none" strokeLinecap="round" strokeLinejoin="round" />
                </svg>
            </div>
            <div style={{ position: 'absolute', inset: 0, pointerEvents: 'none' }}>
                {[-24, -18, -12, -6, 0, 6, 12, 18, 24].map((db) => (
                    <div key={`dblabel-${db}`} style={{
                        position: 'absolute', left: `${((MARGIN_L + 2) / VB_W) * 100}%`, top: `${((gainToY(db) - 5) / VB_H) * 100}%`,
                        fontSize: 8, fontFamily: 'Inter, sans-serif',
                        color: db === 0 ? 'var(--token-color-rgba-160-200-255-0d55)' : 'var(--token-color-rgba-160-200-255-0d3)',
                        whiteSpace: 'nowrap', lineHeight: 1,
                    }}>
                        {db > 0 ? '+' : ''}{db}dB
                    </div>
                ))}
            </div>
            <div style={{ position: 'absolute', inset: 0, pointerEvents: 'none' }}>
                {FREQ_LABELS.map((fl) => (
                    <div key={`flabel-${fl.freq}`} style={{
                        position: 'absolute', left: `${(freqToX(fl.freq) / VB_W) * 100}%`, bottom: 2, transform: 'translateX(-50%)',
                        fontSize: 8, fontFamily: 'Inter, sans-serif', color: 'var(--token-color-rgba-160-200-255-0d5)', whiteSpace: 'nowrap', lineHeight: 1,
                    }}>
                        {fl.label}
                    </div>
                ))}
            </div>
            <EqBandOverlays
                bands={bands}
                dragEqBand={dragEqBand}
                selectedEqBand={selectedEqBand}
                setSelectedEqBand={setSelectedEqBand}
                beginEqBandGesture={beginEqBandGesture}
                setDragEqBand={setDragEqBand}
                setEqContextMenu={setEqContextMenu}
                onParamChange={onParamChange}
                vbW={VB_W}
                vbH={VB_H}
            />
            <EqBandContextMenu
                eqContextMenu={eqContextMenu}
                bands={bands}
                setEqBandFilterTypes={setEqBandFilterTypes}
                onParamChange={onParamChange}
                setEqContextMenu={setEqContextMenu}
            />
        </div>
    );
}
