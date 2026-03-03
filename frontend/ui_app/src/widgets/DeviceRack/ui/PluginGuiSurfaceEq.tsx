import React, { useCallback, useEffect, useMemo, useState } from 'react';
import {
    VB_W, VB_H, MARGIN_L, MARGIN_R, freqToX, gainToY, isFilterOnlyType,
    buildEqCurvePaths, buildSpectrumPath, parseBandsFromParams
} from '@/widgets/DeviceRack/lib/eqMath';
import type { DeviceSlot } from '@/widgets/DeviceRack/model/types';
import { normalizeInternalPluginId } from '@/shared/lib/internalPlugins';
import { useEngineStore } from '@/shared/stores/useEngineStore';
import { useEqSurfaceHandlers } from '@/widgets/DeviceRack/model/useEqSurfaceHandlers';
import { EqBandContextMenu, EqBandOverlays, type EqContextMenu } from './PluginGuiSurfaceEqOverlays';
import { PluginGuiSurfaceEqControls } from './PluginGuiSurfaceEqControls';
import { PluginGuiSurfaceEqBandStrip } from './PluginGuiSurfaceEqBandStrip';
import { EQ_FREQ_LABELS, EQ_FREQ_SUB_LINES, DB_GRID_LINES, pluginPanelCardBaseStyle, pluginPanelMetaStyle } from './PluginGuiSurfaceEqLayout';
import {
    assignNextEqBandColor,
    buildEqGradientStops,
    buildInitialEqBandColors,
} from './PluginGuiSurfaceEq.utils';

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
    /** Pre-merged params with local drag overrides for instant visual feedback. */
    mergedParams?: Array<{ name: string; value: number }>;
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
    beginEqBandGesture,
    onParamChange,
    mergedParams: mergedParamsProp,
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
            return assignNextEqBandColor(device.id, bandIdx, prev);
        });
    }, [device.id]);

    // Use pre-merged params from parent (with local drag overrides) for instant feedback,
    // falling back to device.params when mergedParams is not provided.
    const effectiveParams = mergedParamsProp ?? device.params;

    const bands = useMemo(
        () => parseBandsFromParams(effectiveParams, eqBandFilterTypes, eqBandColors),
        [effectiveParams, eqBandFilterTypes, eqBandColors],
    );

    const out = effectiveParams.find((p) => p.name.toLowerCase() === 'out')?.value ?? 0;
    const activeBandIdx = selectedEqBand ?? dragEqBand ?? 2;
    // ENTERPRISE: Extract boolean before useMemo for stable dependency identity.
    const isDragging = dragEqBand !== null;
    const { curvePath, fillPath } = useMemo(
        // PERF-FIX: Reduce curve resolution to 80 steps during drag for 60% fewer
        // biquad evaluations per frame. 80 is visually indistinguishable during
        // fast mouse movement. Full 200-step resolution restores on drag end.
        () => buildEqCurvePaths(bands, projectSampleRate, isDragging ? 140 : 200),
        [bands, projectSampleRate, isDragging],
    );

    const bi = activeBandIdx;
    // Use device.params for full PluginParam shape (min/max/suffix) but override
    // values from effectiveParams for live drag feedback on knobs.
    const mergeValue = (param: typeof device.params[0] | undefined) => {
        if (!param) return undefined;
        const merged = effectiveParams.find((x) => x.name.toLowerCase() === param.name.toLowerCase());
        return merged ? { ...param, value: merged.value } : param;
    };
    const freqParam = mergeValue(device.params.find((x) => x.name.toLowerCase() === `b${bi}freq`));
    const gainParam = mergeValue(device.params.find((x) => x.name.toLowerCase() === `b${bi}gain`));
    const qParam = mergeValue(device.params.find((x) => x.name.toLowerCase() === `b${bi}q`));
    const outParam = mergeValue(device.params.find((x) => x.name.toLowerCase() === 'out'));
    const activeBand = bands[activeBandIdx];
    const enabledBands = bands.filter(b => b.enabled);
    const curveStops = useMemo(() => buildEqGradientStops(enabledBands), [enabledBands]);
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
                eqSpectrumEnabled={eqSpectrumEnabled}
                setEqSpectrumEnabled={setEqSpectrumEnabled}
            />

            <div style={{ flex: 1, display: 'flex', flexDirection: 'column', gap: 'var(--space-1)' }}>
                <div
                    data-no-drag
                    style={{
                        ...pluginPanelCardBaseStyle,
                        background: 'var(--plugin-bg-eq)',
                        border: 'var(--space-px) solid var(--plugin-card-border)',
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
                            <linearGradient id={`eqCurveStroke-${device.id}`} x1="0" y1="0" x2="1" y2="0">
                                {curveStops.map((stop, idx) => (
                                    <stop key={`eqcurve-${idx}-${stop.offsetPct}`} offset={`${stop.offsetPct}%`} stopColor={stop.color} />
                                ))}
                            </linearGradient>
                            <filter id={`eqCurveGlow-${device.id}`} x="-20%" y="-20%" width="140%" height="140%">
                                <feGaussianBlur stdDeviation="1.2" result="blur" />
                                <feMerge>
                                    <feMergeNode in="blur" />
                                    <feMergeNode in="SourceGraphic" />
                                </feMerge>
                            </filter>
                        </defs>
                        <rect x={MARGIN_L} y={4} width={VB_W - MARGIN_L - MARGIN_R} height={VB_H - 16} fill="color-mix(in srgb, var(--color-bg-app) 40%, transparent)" />
                        {DB_GRID_LINES.map((db) => (
                            <line key={`hg-${db}`} x1={MARGIN_L} y1={gainToY(db)} x2={VB_W - MARGIN_R} y2={gainToY(db)} stroke={db === 0 ? 'color-mix(in srgb, var(--color-text-primary) 46%, transparent)' : (Math.abs(db) === 3 ? 'color-mix(in srgb, var(--color-text-primary) 8%, transparent)' : 'color-mix(in srgb, var(--color-text-primary) 14%, transparent)')} strokeWidth={db === 0 ? 1.1 : 0.5} />
                        ))}
                        {EQ_FREQ_LABELS.map((fl) => (
                            <line key={`vf-${fl.freq}`} x1={freqToX(fl.freq)} y1={4} x2={freqToX(fl.freq)} y2={VB_H - 12} stroke="var(--token-color-rgba-255-255-255-0d12)" strokeWidth="0.5" />
                        ))}
                        {EQ_FREQ_SUB_LINES.map((f) => (
                            <line key={`vsub-${f}`} x1={freqToX(f)} y1={4} x2={freqToX(f)} y2={VB_H - 12} stroke="var(--token-color-rgba-255-255-255-0d06)" strokeWidth="0.3" />
                        ))}
                        <PluginEqSpectrumOverlay deviceId={device.id} eqSpectrumEnabled={eqSpectrumEnabled} isDragging={isDragging} />
                        {enabledBands.length > 0 && (
                            <path d={fillPath} fill="color-mix(in srgb, var(--color-accent-primary) 12%, transparent)" />
                        )}
                        <path
                            d={curvePath}
                            fill="none"
                            stroke={enabledBands.length > 0
                                ? `url(#eqCurveStroke-${device.id})`
                                : 'color-mix(in srgb, var(--color-accent-primary) 72%, white)'}
                            strokeWidth="2.15"
                            strokeLinecap="round"
                            strokeLinejoin="round"
                            vectorEffect="non-scaling-stroke"
                            shapeRendering="geometricPrecision"
                        />
                        {enabledBands.length === 0 && (
                            <text x={VB_W / 2} y={VB_H / 2} textAnchor="middle" fill="var(--token-color-rgba-255-255-255-0d32)" fontSize="10" fontFamily="var(--font-role-body)">
                                Double-click to add EQ point
                            </text>
                        )}
                    </svg>
                    {/* Spectrum toggle moved to left controls panel */}
                    <div style={{ position: 'absolute', inset: 0, pointerEvents: 'none' }}>
                        {[-24, -18, -12, -6, 0, 6, 12, 18, 24].map((db) => (
                            <div key={`dblabel-${db}`} style={{
                                position: 'absolute', left: `${((MARGIN_L + 2) / VB_W) * 100}%`, top: `${((gainToY(db) - 5) / VB_H) * 100}%`,
                                fontSize: 'var(--font-size-micro)', fontFamily: 'var(--font-role-body)',
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
                                fontSize: 'var(--font-size-micro)', fontFamily: 'var(--font-role-body)', color: 'color-mix(in srgb, var(--color-text-primary) 66%, transparent)', whiteSpace: 'nowrap', lineHeight: 1,
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

const PluginEqSpectrumOverlay = React.memo(({ deviceId, eqSpectrumEnabled, isDragging }: { deviceId: string; eqSpectrumEnabled: boolean; isDragging: boolean }) => {
    // ENTERPRISE: Direct DOM manipulation for spectrum path eliminates React
    // re-render flicker. The path's `d` attribute is updated directly via ref,
    // completely bypassing React's reconciliation cycle.
    const pathRef = React.useRef<SVGPathElement | null>(null);
    const lastSpectrumRef = React.useRef<number[] | null>(null);
    const isDraggingRef = React.useRef(isDragging);
    isDraggingRef.current = isDragging;

    const trackIndex = useEngineStore((s) => {
        const allIds = s.tracks.allIds;
        for (let i = 0; i < allIds.length; i++) {
            const track = s.tracks.byId[allIds[i]];
            if (!track) continue;
            if (track.effects?.some((fx: { id: string }) => fx.id === deviceId)) {
                return i;
            }
        }
        return -1;
    });

    useEffect(() => {
        if (!eqSpectrumEnabled) {
            lastSpectrumRef.current = null;
            if (pathRef.current) pathRef.current.setAttribute('d', '');
            return;
        }
        let active = true;
        let errorBackoff = 50;

        const poll = async () => {
            try {
                const { invoke } = await import('@tauri-apps/api/core');
                while (active) {
                    try {
                        // During drag, poll at reduced rate to avoid IPC contention
                        if (isDraggingRef.current) {
                            await new Promise(r => setTimeout(r, 60));
                        }
                        const data = trackIndex >= 0
                            ? await invoke<number[]>('get_spectrum_data_for_track', { trackIndex })
                            : await invoke<number[]>('get_spectrum_data');
                        if (!active) break;
                        errorBackoff = 50;

                        if (Array.isArray(data) && data.length > 0) {
                            const prev = lastSpectrumRef.current;
                            let smoothed: number[];
                            if (prev && prev.length === data.length) {
                                // Exponential smoothing: 0.82 = less flicker
                                smoothed = data.map((v, i) => prev[i] * 0.82 + v * 0.18);
                            } else {
                                smoothed = data;
                            }
                            lastSpectrumRef.current = smoothed;
                            // DIRECT DOM UPDATE — no React state, no re-render, no flicker
                            const path = buildSpectrumPath(smoothed);
                            if (pathRef.current) {
                                pathRef.current.setAttribute('d', path);
                            }
                        } else if (lastSpectrumRef.current) {
                            // Backend returned empty array (maybe buffer under-run or silence).
                            // Smoothly decay to zero instead of instantly vanishing and blinking!
                            let allZero = true;
                            const decayed = lastSpectrumRef.current.map(v => {
                                const newVal = v * 0.82;
                                if (newVal > 0.1) allZero = false;
                                return newVal;
                            });
                            if (allZero) {
                                lastSpectrumRef.current = null;
                                if (pathRef.current) pathRef.current.setAttribute('d', '');
                            } else {
                                lastSpectrumRef.current = decayed;
                                const path = buildSpectrumPath(decayed);
                                if (pathRef.current) pathRef.current.setAttribute('d', path);
                            }
                        }
                        // Wait for next animation frame before polling again
                        await new Promise(r => requestAnimationFrame(r));
                    } catch (err) {
                        console.warn('[Dream] poll error (backoff):', err);
                        errorBackoff = Math.min(errorBackoff * 2, 2000);
                        await new Promise(r => setTimeout(r, errorBackoff));
                    }
                }
            } catch (err) {
                console.warn('[Dream] EQ spectrum poll stopped:', err);
            }
        };
        poll();
        return () => {
            active = false;
            lastSpectrumRef.current = null;
        };
    }, [eqSpectrumEnabled, trackIndex]);

    if (!eqSpectrumEnabled) return null;

    // Render an empty path element — its `d` attribute is updated directly by the poll loop
    return (
        <path
            ref={pathRef}
            d=""
            fill="color-mix(in srgb, var(--color-text-primary) 40%, transparent)"
            opacity="0.72"
        />
    );
});

