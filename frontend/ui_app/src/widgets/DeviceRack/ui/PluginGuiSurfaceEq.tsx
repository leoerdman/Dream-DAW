import React, { useCallback, useMemo, useState } from 'react';
import {
    VB_W, VB_H, MARGIN_L, MARGIN_R, freqToX, gainToY, isFilterOnlyType,
    buildEqCurvePaths, buildSpectrumPath, parseBandsFromParams, EQ_BAND_COLORS, EQ_RANDOM_POINT_COLORS
} from '@/widgets/DeviceRack/lib/eqMath';
import type { DeviceSlot } from '@/widgets/DeviceRack/model/types';
import { normalizeInternalPluginId } from '@/shared/lib/internalPlugins';
import { useEqSurfaceHandlers } from '@/widgets/DeviceRack/model/useEqSurfaceHandlers';
import { EqBandContextMenu, EqBandOverlays, type EqContextMenu } from './PluginGuiSurfaceEqOverlays';
import { PluginGuiSurfaceEqControls } from './PluginGuiSurfaceEqControls';
import { PluginGuiSurfaceEqBandStrip } from './PluginGuiSurfaceEqBandStrip';
import { EQ_FREQ_LABELS, EQ_FREQ_SUB_LINES, pluginPanelCardBaseStyle, pluginPanelMetaStyle } from './PluginGuiSurfaceEqLayout';

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

const EQ_BAND_COLOR_CACHE = new Map<string, string[]>();
const EQ_BAND_COUNT = 8;

function pickRandomBandColor(exclude?: string): string {
    const colorPool: readonly string[] = EQ_RANDOM_POINT_COLORS;
    const poolSize = colorPool.length;
    if (poolSize <= 0) return 'var(--color-effect-eq)';
    if (poolSize === 1) return colorPool[0] ?? 'var(--color-effect-eq)';
    let next = colorPool[Math.floor(Math.random() * poolSize)] ?? 'var(--color-effect-eq)';
    if (exclude && next === exclude) {
        next = colorPool[(Math.floor(Math.random() * (poolSize - 1)) + 1) % poolSize] ?? next;
    }
    return next;
}

function buildInitialEqBandColors(deviceId: string): string[] {
    const cached = EQ_BAND_COLOR_CACHE.get(deviceId);
    if (cached && cached.length === EQ_BAND_COUNT) return [...cached];
    // Build per-device randomized colors so new instances don't default to a
    // single repeated hue family.
    const seeded: string[] = [];
    for (let i = 0; i < EQ_BAND_COUNT; i++) {
        seeded.push(pickRandomBandColor(seeded[i - 1]));
    }
    EQ_BAND_COLOR_CACHE.set(deviceId, seeded);
    return seeded;
}

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
    const eqTitle = normalizedInternalId === 'internal://effect/eq-three'
        ? 'Band EQ'
        : normalizedInternalId === 'internal://effect/channel-eq'
            ? 'Channel EQ'
            : normalizedInternalId === 'internal://effect/eq-eight'
                ? 'EQ Eight'
                : 'EQ';
    const [eqBandColors, setEqBandColors] = useState<string[]>(() => buildInitialEqBandColors(device.id));

    const assignRandomBandColor = useCallback((bandIdx: number) => {
        setEqBandColors((prev) => {
            const next = [...prev];
            next[bandIdx] = pickRandomBandColor(prev[bandIdx] ?? EQ_BAND_COLORS[bandIdx]);
            EQ_BAND_COLOR_CACHE.set(device.id, next);
            return next;
        });
    }, [device.id]);

    const bands = useMemo(
        () => parseBandsFromParams(device.params, eqBandFilterTypes, eqBandColors),
        [device.params, eqBandFilterTypes, eqBandColors],
    );

    const out = device.params.find((p) => p.name.toLowerCase() === 'out')?.value ?? 0;
    const activeBandIdx = selectedEqBand ?? dragEqBand ?? 2;
    const { curvePath, fillPath } = useMemo(() => buildEqCurvePaths(bands, projectSampleRate), [bands, projectSampleRate]);
    const spectrumPath = useMemo(() => (eqSpectrumEnabled ? buildSpectrumPath(spectrumData) : null), [eqSpectrumEnabled, spectrumData]);

    const bi = activeBandIdx;
    const freqParam = device.params.find((x) => x.name.toLowerCase() === `b${bi}freq`);
    const gainParam = device.params.find((x) => x.name.toLowerCase() === `b${bi}gain`);
    const qParam = device.params.find((x) => x.name.toLowerCase() === `b${bi}q`);
    const outParam = device.params.find((x) => x.name.toLowerCase() === 'out');
    const activeBand = bands[activeBandIdx];
    const enabledBands = bands.filter(b => b.enabled);
    const curveColor = activeBand?.enabled
        ? activeBand.color
        : (enabledBands[0]?.color ?? EQ_BAND_COLORS[2]);
    const activeFilterOnly = activeBand ? isFilterOnlyType(activeBand.filterType) : false;
    const { handleMouseDown, handleDoubleClick, handleContextMenu } = useEqSurfaceHandlers({
        eqSurfaceRef,
        bands,
        eqBandFilterTypes,
        onParamChange,
        setSelectedEqBand,
        beginEqBandGesture,
        setDragEqBand,
        setEqContextMenu,
        onBandCreated: assignRandomBandColor,
    });

    return (
        <div style={{ display: 'flex', gap: 'var(--space-1-5)', height: '100%' }}>
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

            <div style={{ flex: 1, display: 'flex', flexDirection: 'column', gap: 'var(--space-1)' }}>
                <div
                    data-no-drag
                    style={{
                        ...pluginPanelCardBaseStyle,
                        background: 'linear-gradient(180deg, color-mix(in srgb, #2b2b2b 94%, black) 0%, color-mix(in srgb, #232323 96%, black) 100%)',
                        border: 'var(--space-px) solid color-mix(in srgb, #555 40%, transparent)',
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
                        onMouseDown={handleMouseDown}
                        onDoubleClick={handleDoubleClick}
                        onContextMenu={handleContextMenu}
                    >
                        <defs>
                            <linearGradient id={`eqGrad-${device.id}`} x1="0" y1="0" x2="0" y2="1">
                                <stop offset="0%" stopColor={`color-mix(in srgb, ${curveColor} 38%, transparent)`} stopOpacity="0.24" />
                                <stop offset="100%" stopColor={`color-mix(in srgb, ${curveColor} 12%, transparent)`} stopOpacity="0" />
                            </linearGradient>
                            <filter id={`eqCurveGlow-${device.id}`} x="-20%" y="-20%" width="140%" height="140%">
                                <feGaussianBlur stdDeviation="1.2" result="blur" />
                                <feMerge>
                                    <feMergeNode in="blur" />
                                    <feMergeNode in="SourceGraphic" />
                                </feMerge>
                            </filter>
                        </defs>
                        <rect x={MARGIN_L} y={4} width={VB_W - MARGIN_L - MARGIN_R} height={VB_H - 16} fill="color-mix(in srgb, #1f1f1f 96%, black)" />
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
                            stroke={curveColor}
                            strokeWidth="2.15"
                            strokeLinecap="round"
                            strokeLinejoin="round"
                            vectorEffect="non-scaling-stroke"
                            shapeRendering="geometricPrecision"
                        />
                        {enabledBands.length === 0 && (
                            <text x={VB_W / 2} y={VB_H / 2} textAnchor="middle" fill="var(--token-color-rgba-255-255-255-0d32)" fontSize="10" fontFamily="var(--font-sans)">
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
                        {[-18, -12, -6, 0, 6, 12, 18, 24].map((db) => (
                            <div key={`dblabel-${db}`} style={{
                                position: 'absolute', left: `${((MARGIN_L + 2) / VB_W) * 100}%`, top: `${((gainToY(db) - 5) / VB_H) * 100}%`,
                                fontSize: 'var(--font-size-micro)', fontFamily: 'var(--font-sans)',
                                color: db === 0 ? 'color-mix(in srgb, var(--color-text-primary) 86%, transparent)' : 'color-mix(in srgb, var(--color-text-primary) 62%, transparent)',
                                whiteSpace: 'nowrap', lineHeight: 1,
                            }}>
                                {db > 0 ? '+' : ''}{db}dB
                            </div>
                        ))}
                    </div>
                    <div style={{ position: 'absolute', inset: 0, pointerEvents: 'none' }}>
                        {EQ_FREQ_LABELS.map((fl, idx) => (
                            <div key={`flabel-${fl.freq}`} style={{
                                position: 'absolute',
                                left: `${(freqToX(fl.freq) / VB_W) * 100}%`,
                                bottom: 2,
                                transform: idx === 0
                                    ? 'translateX(0)'
                                    : idx === EQ_FREQ_LABELS.length - 1
                                        ? 'translateX(-100%)'
                                        : 'translateX(-50%)',
                                fontSize: 'var(--font-size-micro)', fontFamily: 'var(--font-sans)', color: 'color-mix(in srgb, var(--color-text-primary) 66%, transparent)', whiteSpace: 'nowrap', lineHeight: 1,
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
