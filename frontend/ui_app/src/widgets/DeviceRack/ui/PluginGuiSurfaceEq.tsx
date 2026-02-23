import React, { useMemo } from 'react';
import {
    VB_W, VB_H, MARGIN_L, MARGIN_R,
    freqToX, xToFreq, gainToY, bandDotY, isFilterOnlyType,
    buildEqCurvePaths, buildSpectrumPath, parseBandsFromParams,
    type EqBand8,
} from '@/widgets/DeviceRack/lib/eqMath';
import type { DeviceSlot } from '@/widgets/DeviceRack/model/types';
import { normalizeInternalPluginId } from '@/shared/lib/internalPlugins';
import {
    EqBandContextMenu,
    EqBandOverlays,
    type EqContextMenu,
} from './PluginGuiSurfaceEqOverlays';
import { PluginGuiSurfaceEqControls } from './PluginGuiSurfaceEqControls';
import { PluginGuiSurfaceEqBandStrip } from './PluginGuiSurfaceEqBandStrip';
import {
    EQ_FREQ_LABELS,
    EQ_FREQ_SUB_LINES,
    pluginPanelCardBaseStyle,
    pluginPanelMetaStyle,
} from './PluginGuiSurfaceEqLayout';

type Props = {
    device: DeviceSlot;
    projectSampleRate: number;
    eqBandFilterTypes: string[];
    setEqBandFilterTypes: React.Dispatch<React.SetStateAction<string[]>>;
    eqSurfaceRef: React.RefObject<SVGSVGElement | null>;
    dragEqBand: number | null;
    setDragEqBand: React.Dispatch<React.SetStateAction<number | null>>;
    selectedEqBand: number | null;
    setSelectedEqBand: React.Dispatch<React.SetStateAction<number | null>>;
    eqContextMenu: EqContextMenu | null;
    setEqContextMenu: React.Dispatch<React.SetStateAction<EqContextMenu | null>>;
    eqSpectrumEnabled: boolean;
    setEqSpectrumEnabled: React.Dispatch<React.SetStateAction<boolean>>;
    spectrumData: number[] | null;
    beginEqBandGesture: (bandIdx: number) => void;
    onParamChange: (paramName: string, value: number) => void;
    onParamGestureStart?: (paramName: string, gestureGroupId?: string) => void;
    onParamGestureEnd?: (paramName: string) => void;
};

export function PluginGuiSurfaceEq({
    device,
    projectSampleRate,
    eqBandFilterTypes,
    setEqBandFilterTypes,
    eqSurfaceRef,
    dragEqBand,
    setDragEqBand,
    selectedEqBand,
    setSelectedEqBand,
    eqContextMenu,
    setEqContextMenu,
    eqSpectrumEnabled,
    setEqSpectrumEnabled,
    spectrumData,
    beginEqBandGesture,
    onParamChange,
    onParamGestureStart,
    onParamGestureEnd,
}: Props): React.ReactNode {
    const normalizedInternalId = normalizeInternalPluginId(device.pluginId || (device.guiMode || '').toLowerCase() || device.name.toLowerCase());
    const eqTitle = normalizedInternalId === 'internal://effect/eq-three' ? 'Band EQ' : 'EQ';

    const bands = useMemo(
        () => parseBandsFromParams(device.params, eqBandFilterTypes),
        [device.params, eqBandFilterTypes],
    );
    const out = device.params.find((p) => p.name.toLowerCase() === 'out')?.value ?? 0;
    const activeBandIdx = selectedEqBand ?? dragEqBand ?? 2;
    const { curvePath, fillPath } = useMemo(
        () => buildEqCurvePaths(bands, projectSampleRate),
        [bands, projectSampleRate],
    );
    const spectrumPath = useMemo(
        () => (eqSpectrumEnabled ? buildSpectrumPath(spectrumData) : null),
        [eqSpectrumEnabled, spectrumData],
    );

    const bi = activeBandIdx;
    const freqParam = device.params.find((x) => x.name.toLowerCase() === `b${bi}freq`);
    const gainParam = device.params.find((x) => x.name.toLowerCase() === `b${bi}gain`);
    const qParam = device.params.find((x) => x.name.toLowerCase() === `b${bi}q`);
    const outParam = device.params.find((x) => x.name.toLowerCase() === 'out');
    const activeBand = bands[activeBandIdx];
    const enabledBands = bands.filter(b => b.enabled);
    const activeFilterOnly = activeBand ? isFilterOnlyType(activeBand.filterType) : false;

    return (
        <div style={{ display: 'flex', gap: 6, height: '100%' }}>
            <PluginGuiSurfaceEqControls
                activeBandIsFilterOnly={activeFilterOnly}
                freqParam={freqParam}
                gainParam={gainParam}
                qParam={qParam}
                outParam={outParam}
                enabledBandsCount={enabledBands.length}
                onParamChange={onParamChange}
                onParamGestureStart={onParamGestureStart}
                onParamGestureEnd={onParamGestureEnd}
            />

            <div style={{ flex: 1, display: 'flex', flexDirection: 'column', gap: 4 }}>
                <div
                    data-no-drag
                    style={{
                        ...pluginPanelCardBaseStyle,
                        background: 'linear-gradient(180deg, color-mix(in srgb, var(--color-bg-panel) 86%, var(--color-bg-header) 14%) 0%, color-mix(in srgb, var(--color-bg-panel) 78%, var(--color-bg-header) 22%) 100%)',
                        overflow: 'hidden',
                        padding: 0,
                        position: 'relative',
                        flex: 1,
                    }}
                >
                    <svg
                        ref={eqSurfaceRef}
                        width="100%"
                        height="100%"
                        viewBox={`0 0 ${VB_W} ${VB_H}`}
                        preserveAspectRatio="none"
                        style={{ cursor: 'crosshair', display: 'block' }}
                        onMouseDown={(e) => {
                            e.preventDefault();
                            e.stopPropagation();
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
                                if (dist < nearestDist) { nearestDist = dist; nearest = band; }
                            }
                            if (nearest && nearestDist < 30) {
                                setEqContextMenu({ x: e.clientX, y: e.clientY, bandIdx: nearest.idx });
                            }
                        }}
                    >
                        <defs>
                            <linearGradient id={`eqGrad-${device.id}`} x1="0" y1="0" x2="0" y2="1">
                                <stop offset="0%" stopColor="color-mix(in srgb, var(--color-text-primary) 32%, transparent)" stopOpacity="0.24" />
                                <stop offset="100%" stopColor="color-mix(in srgb, var(--color-text-primary) 12%, transparent)" stopOpacity="0" />
                            </linearGradient>
                            <filter id={`eqCurveGlow-${device.id}`} x="-20%" y="-20%" width="140%" height="140%">
                                <feGaussianBlur stdDeviation="1.2" result="blur" />
                                <feMerge>
                                    <feMergeNode in="blur" />
                                    <feMergeNode in="SourceGraphic" />
                                </feMerge>
                            </filter>
                        </defs>
                        <rect x={MARGIN_L} y={4} width={VB_W - MARGIN_L - MARGIN_R} height={VB_H - 16} fill="color-mix(in srgb, var(--color-bg-panel) 88%, var(--color-bg-header) 12%)" />
                        {[-24, -18, -12, -6, 0, 6, 12, 18, 24].map((db) => (
                            <line key={`hg-${db}`} x1={MARGIN_L} y1={gainToY(db)} x2={VB_W - MARGIN_R} y2={gainToY(db)} stroke={db === 0 ? 'color-mix(in srgb, var(--color-text-primary) 46%, transparent)' : 'color-mix(in srgb, var(--color-text-primary) 14%, transparent)'} strokeWidth={db === 0 ? 1.1 : 0.5} />
                        ))}
                        {EQ_FREQ_LABELS.map((fl) => (
                            <line key={`vf-${fl.freq}`} x1={freqToX(fl.freq)} y1={4} x2={freqToX(fl.freq)} y2={VB_H - 12} stroke="var(--token-color-rgba-255-255-255-0d12)" strokeWidth="0.5" />
                        ))}
                        {EQ_FREQ_SUB_LINES.map((f) => (
                            <line key={`vsub-${f}`} x1={freqToX(f)} y1={4} x2={freqToX(f)} y2={VB_H - 12} stroke="var(--token-color-rgba-255-255-255-0d06)" strokeWidth="0.3" />
                        ))}
                        <defs>
                            <linearGradient id={`specGrad-${device.id}`} x1="0" y1="0" x2="0" y2="1">
                                <stop offset="0%" stopColor="color-mix(in srgb, var(--color-text-primary) 18%, transparent)" />
                                <stop offset="100%" stopColor="color-mix(in srgb, var(--color-text-primary) 4%, transparent)" />
                            </linearGradient>
                        </defs>
                        {eqSpectrumEnabled && spectrumPath && (
                            <path d={spectrumPath} fill={`url(#specGrad-${device.id})`} opacity="0.36" />
                        )}
                        <path d={fillPath} fill={`url(#eqGrad-${device.id})`} opacity="0.26" />
                        <path
                            d={curvePath}
                            fill="none"
                            stroke="color-mix(in srgb, var(--color-text-primary) 82%, var(--color-bg-panel) 18%)"
                            strokeWidth="2.15"
                            strokeLinecap="round"
                            strokeLinejoin="round"
                            filter={`url(#eqCurveGlow-${device.id})`}
                            vectorEffect="non-scaling-stroke"
                            shapeRendering="geometricPrecision"
                        />
                        {enabledBands.length === 0 && (
                            <text x={VB_W / 2} y={VB_H / 2} textAnchor="middle" fill="var(--token-color-rgba-255-255-255-0d32)" fontSize="10" fontFamily="Inter, sans-serif">
                                Double-click to add EQ point
                            </text>
                        )}
                    </svg>
                    <div
                        style={{
                            position: 'absolute', top: 4, right: 6, zIndex: 10, cursor: 'pointer', width: 22, height: 22, borderRadius: 4,
                            display: 'flex', alignItems: 'center', justifyContent: 'center',
                            background: eqSpectrumEnabled ? 'var(--token-color-rgba-255-255-255-0d12)' : 'var(--token-color-rgba-255-255-255-0d07)',
                            border: `var(--space-px) solid ${eqSpectrumEnabled ? 'var(--token-color-rgba-255-255-255-0d34)' : 'var(--token-color-rgba-255-255-255-0d18)'}`,
                            transition: 'all 0.2s ease',
                        }}
                        title={eqSpectrumEnabled ? 'Hide Spectrum' : 'Show Spectrum'}
                        onClick={() => setEqSpectrumEnabled(!eqSpectrumEnabled)}
                    >
                        <svg width="14" height="14" viewBox="0 0 14 14" fill="none">
                            <path d="M1 10 L3 6 L5 8 L7 3 L9 7 L11 5 L13 9" stroke={eqSpectrumEnabled ? 'var(--token-color-rgba-245-245-245-0d92)' : 'var(--token-color-rgba-220-220-220-0d6)'} strokeWidth="1.2" fill="none" strokeLinecap="round" strokeLinejoin="round" />
                        </svg>
                    </div>
                    <div style={{ position: 'absolute', inset: 0, pointerEvents: 'none' }}>
                        {[-24, -18, -12, -6, 0, 6, 12, 18, 24].map((db) => (
                            <div key={`dblabel-${db}`} style={{
                                position: 'absolute', left: `${((MARGIN_L + 2) / VB_W) * 100}%`, top: `${((gainToY(db) - 5) / VB_H) * 100}%`,
                                fontSize: 8, fontFamily: 'Inter, sans-serif',
                                color: db === 0 ? 'color-mix(in srgb, var(--color-text-primary) 86%, transparent)' : 'color-mix(in srgb, var(--color-text-primary) 62%, transparent)',
                                whiteSpace: 'nowrap', lineHeight: 1,
                            }}>
                                {db > 0 ? '+' : ''}{db}dB
                            </div>
                        ))}
                    </div>
                    <div style={{ position: 'absolute', inset: 0, pointerEvents: 'none' }}>
                        {EQ_FREQ_LABELS.map((fl) => (
                            <div key={`flabel-${fl.freq}`} style={{
                                position: 'absolute', left: `${(freqToX(fl.freq) / VB_W) * 100}%`, bottom: 2, transform: 'translateX(-50%)',
                                fontSize: 8, fontFamily: 'Inter, sans-serif', color: 'color-mix(in srgb, var(--color-text-primary) 66%, transparent)', whiteSpace: 'nowrap', lineHeight: 1,
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
                <PluginGuiSurfaceEqBandStrip
                    eqTitle={eqTitle}
                    bands={bands}
                    selectedEqBand={selectedEqBand}
                    dragEqBand={dragEqBand}
                    out={out}
                    setSelectedEqBand={setSelectedEqBand}
                    onParamChange={onParamChange}
                    metaStyle={pluginPanelMetaStyle}
                />
            </div>
        </div>
    );
}
