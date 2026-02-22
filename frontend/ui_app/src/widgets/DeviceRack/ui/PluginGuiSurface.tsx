import { useMemo, useState, useCallback, useEffect, useRef } from 'react';
import * as engineApi from '@/shared/api/engine';
import { useEngineStore } from '@/shared/stores/useEngineStore';
import { useDragStore } from '@/shared/stores/useDragStore';
import { resolveSampleRate } from '@/shared/lib/audioMath';
import { PluginKnob } from '@/widgets/DeviceRack/StandardPluginControls';
import { pluginPanelKnobGrid } from '@/widgets/DeviceRack/ui/styles';
import { canDropInZone } from '@/shared/lib/dndMatrix';
import { SampleRack } from '@/widgets/SampleRack/SampleRack';
import { EssenceSynth } from '@/widgets/DeviceRack/EssenceSynth';
import { normalizeInternalPluginId } from '@/shared/lib/internalPlugins';
import { renderStandardPluginGuiSurface } from '@/widgets/DeviceRack/ui/PluginGuiSurfaceStandard';
import {
    VB_W, VB_H, MARGIN_L, MARGIN_R,
    EQ_FILTER_LABELS, EQ_FILTER_ICONS,
    freqToX, xToFreq, gainToY, bandDotY, isFilterOnlyType,
    buildEqCurvePaths, buildSpectrumPath, parseBandsFromParams,
    type EqBand8,
} from '@/widgets/DeviceRack/lib/eqMath';
import type { DeviceSlot } from '@/widgets/DeviceRack/model/types';
import type { SampleRackConfig } from '@bindings/SampleRackConfig';

const pluginPanelCardBaseStyle: React.CSSProperties = {
    border: '1px solid var(--plugin-card-border)',
    borderRadius: 'var(--plugin-card-radius)',
    padding: 'var(--plugin-card-pad-y) var(--plugin-card-pad-x)',
    display: 'grid',
    gridTemplateRows: '1fr auto',
    gap: 'var(--plugin-card-gap)',
    background: 'var(--plugin-card-bg-main)',
};

const pluginPanelMetaStyle: React.CSSProperties = {
    display: 'flex',
    justifyContent: 'space-between',
    fontSize: 'var(--font-size-xs)',
    color: 'var(--plugin-meta-color)',
    fontFamily: 'var(--font-mono)',
};

/* ── Module-level EQ filter type cache (persists across component remounts) ── */
const eqFilterTypeCache = new Map<string, string[]>();

export const PluginGuiSurface = ({
    device,
    onParamChange,
    onParamGestureStart,
    onParamGestureEnd,
    onApplyUtilityScene,
    onDropSample,
    onLoadSample,
    onParamContextMenu,
}: {
    device: DeviceSlot;
    onParamChange: (paramName: string, value: number) => void;
    onParamGestureStart?: (paramName: string, gestureGroupId?: string) => void;
    onParamGestureEnd?: (paramName: string) => void;
    onApplyUtilityScene?: (scene: 'center' | 'mono' | 'wide') => void;
    onDropSample?: (samplePath: string) => void;
    onLoadSample?: () => void;
    onParamContextMenu?: (e: React.MouseEvent, paramName: string) => void;
}) => {
    const [waveformPeaks, setWaveformPeaks] = useState<engineApi.PeakPair[] | null>(null);
    const eqSurfaceRef = useRef<SVGSVGElement | null>(null);
    const [dragEqBand, setDragEqBand] = useState<number | null>(null);
    const [selectedEqBand, setSelectedEqBand] = useState<number | null>(null);
    const [eqContextMenu, setEqContextMenu] = useState<{ x: number; y: number; bandIdx: number } | null>(null);
    // Persist EQ filter types across component remounts via module-level cache
    const [eqBandFilterTypes, setEqBandFilterTypes] = useState<string[]>(() => {
        const cached = eqFilterTypeCache.get(device.id);
        return cached ?? ['highpass', 'lowshelf', 'peaking', 'peaking', 'peaking', 'peaking', 'highshelf', 'lowpass'];
    });
    useEffect(() => { eqFilterTypeCache.set(device.id, eqBandFilterTypes); }, [device.id, eqBandFilterTypes]);

    // ── Spectrum analyzer state ──
    const [eqSpectrumEnabled, setEqSpectrumEnabled] = useState(false);
    const [spectrumData, setSpectrumData] = useState<number[] | null>(null);

    // Poll spectrum data from the Rust FFT engine at ~20fps when enabled
    useEffect(() => {
        if (!eqSpectrumEnabled) { setSpectrumData(null); return; }
        let active = true;
        const poll = async () => {
            try {
                const { invoke } = await import('@tauri-apps/api/core');
                while (active) {
                    const data = await invoke<number[]>('get_spectrum_data');
                    if (!active) break;
                    setSpectrumData(data);
                    await new Promise(r => setTimeout(r, 50)); // ~20fps
                }
            } catch { /* silence errors when component unmounts */ }
        };
        poll();
        return () => { active = false; };
    }, [eqSpectrumEnabled]);
    const guiMode = (device.guiMode || '').toLowerCase();
    const normalizedInternalId = normalizeInternalPluginId(device.pluginId || guiMode || device.name.toLowerCase());
    // SSOT: canonical source of sample rate — consumed by EQ biquad curve renderer
    const projectSampleRate = useEngineStore(s => resolveSampleRate(s.projectSampleRate, s.transport.sample_rate));

    useEffect(() => {
        const samplePath = device.samplePath?.trim();
        if (!samplePath) {
            return;
        }
        let cancelled = false;
        engineApi.getWaveformPeaksBinary(samplePath)
            .then((wf) => {
                if (cancelled) return;
                const level = wf.mip_levels[0] ?? wf.mip_levels[wf.mip_levels.length - 1];
                const peaks = level?.peaks ?? [];
                if (peaks.length === 0) {
                    setWaveformPeaks(null);
                    return;
                }
                const targetPointCount = 960;
                if (peaks.length <= targetPointCount) {
                    setWaveformPeaks(peaks);
                    return;
                }
                const reduced: engineApi.PeakPair[] = [];
                const bucket = peaks.length / targetPointCount;
                for (let i = 0; i < targetPointCount; i++) {
                    const start = Math.floor(i * bucket);
                    const end = Math.min(peaks.length, Math.max(start + 1, Math.floor((i + 1) * bucket)));
                    let min = 1;
                    let max = -1;
                    for (let j = start; j < end; j++) {
                        const p = peaks[j];
                        if (p.min < min) min = p.min;
                        if (p.max > max) max = p.max;
                    }
                    reduced.push({ min, max });
                }
                setWaveformPeaks(reduced);
            })
            .catch((err) => {
                if (!cancelled) {
                    console.warn('[DeviceRack] sampler waveform load failed:', err);
                    setWaveformPeaks(null);
                }
            });
        return () => {
            cancelled = true;
        };
    }, [device.samplePath]);

    const samplerWaveformPath = useMemo(() => {
        if (!waveformPeaks || waveformPeaks.length === 0) return null;
        const width = 1000;
        const centerY = 45;
        const amp = 40;
        const n = waveformPeaks.length;
        const top: string[] = [];
        const bottom: string[] = [];
        for (let i = 0; i < n; i++) {
            const x = (i / Math.max(1, n - 1)) * width;
            const p = waveformPeaks[i];
            const maxY = centerY - Math.max(-1, Math.min(1, p.max)) * amp;
            top.push(`${x.toFixed(2)} ${maxY.toFixed(2)}`);
        }
        for (let i = n - 1; i >= 0; i--) {
            const x = (i / Math.max(1, n - 1)) * width;
            const p = waveformPeaks[i];
            const minY = centerY - Math.max(-1, Math.min(1, p.min)) * amp;
            bottom.push(`${x.toFixed(2)} ${minY.toFixed(2)}`);
        }
        return `M ${top.join(' L ')} L ${bottom.join(' L ')} Z`;
    }, [waveformPeaks]);

    /* ── 8-band EQ gesture helpers ── */
    const beginEqBandGesture = useCallback((bandIdx: number) => {
        const gestureGroupId = `${device.id}:eq-band:${bandIdx}:${Date.now()}`;
        onParamGestureStart?.(`B${bandIdx}Freq`, gestureGroupId);
        onParamGestureStart?.(`B${bandIdx}Gain`, gestureGroupId);
    }, [device.id, onParamGestureStart]);

    const endEqBandGesture = useCallback((bandIdx: number) => {
        onParamGestureEnd?.(`B${bandIdx}Freq`);
        onParamGestureEnd?.(`B${bandIdx}Gain`);
    }, [onParamGestureEnd]);

    useEffect(() => {
        if (dragEqBand === null) return;
        const bandIdx = dragEqBand;
        const onMove = (e: MouseEvent) => {
            const surface = eqSurfaceRef.current;
            if (!surface) return;
            const rect = surface.getBoundingClientRect();
            const xNorm = Math.max(0, Math.min(1, (e.clientX - rect.left) / Math.max(1, rect.width)));
            const yNorm = Math.max(0, Math.min(rect.height, e.clientY - rect.top));
            // ── Convert mouse position to SVG viewBox coordinates ──
            const VB_H_DRAG = 200;
            const VB_W_DRAG = 480;
            const MARGIN_L_DRAG = 8;
            const MARGIN_R_DRAG = 8;
            const plotW_DRAG = VB_W_DRAG - MARGIN_L_DRAG - MARGIN_R_DRAG;
            const svgY = (yNorm / rect.height) * VB_H_DRAG;
            const svgX = xNorm * VB_W_DRAG;

            // ── Frequency: account for MARGIN_L in viewBox ──
            const freqNorm = Math.max(0, Math.min(1, (svgX - MARGIN_L_DRAG) / plotW_DRAG));
            const minF = Math.log10(20);
            const maxF = Math.log10(20000);
            const freq = Math.pow(10, minF + freqNorm * (maxF - minF));
            onParamChange(`B${bandIdx}Freq`, Math.round(freq));

            // ── Y axis: Q for filter-only (LP/HP/Notch), Gain for peaking/shelf ──
            const filterType = eqBandFilterTypes[bandIdx] ?? 'peaking';
            const filterOnly = filterType === 'lowpass' || filterType === 'highpass' || filterType === 'notch';
            if (filterOnly) {
                // Invert qToY: norm = ((VB_H-10) - svgY) / (VB_H-20)
                const qNorm = ((VB_H_DRAG - 10) - svgY) / (VB_H_DRAG - 20);
                const clampedQNorm = Math.max(0, Math.min(1, qNorm));
                const q = Math.exp(Math.log(0.1) + clampedQNorm * (Math.log(18) - Math.log(0.1)));
                onParamChange(`B${bandIdx}Q`, Math.round(q * 100) / 100);
            } else {
                const gainValue = ((VB_H_DRAG / 2 - svgY) / (VB_H_DRAG / 2 - 10)) * 24;
                const roundedGain = Math.max(-24, Math.min(24, gainValue));
                onParamChange(`B${bandIdx}Gain`, roundedGain);
            }
        };
        const onUp = () => {
            endEqBandGesture(bandIdx);
            setDragEqBand(null);
        };
        window.addEventListener('mousemove', onMove);
        window.addEventListener('mouseup', onUp);
        return () => {
            window.removeEventListener('mousemove', onMove);
            window.removeEventListener('mouseup', onUp);
        };
    }, [dragEqBand, onParamChange, endEqBandGesture, eqBandFilterTypes]);

    // Close context menu on click outside
    useEffect(() => {
        if (!eqContextMenu) return;
        const handler = () => setEqContextMenu(null);
        window.addEventListener('mousedown', handler);
        return () => window.removeEventListener('mousedown', handler);
    }, [eqContextMenu]);

    if (device.effectType === 'waveSynth') {
        return (
            <EssenceSynth
                params={device.params}
                onParamChange={onParamChange}
                onParamGestureStart={onParamGestureStart}
                onParamGestureEnd={onParamGestureEnd}
            />
        );
    }

    if (device.effectType === 'sample_rack' && device.sampleRackConfig) {
        return (
            <SampleRack
                trackId={device.id.replace('sample-rack-', '')}
                rackConfig={device.sampleRackConfig as SampleRackConfig}
            />
        );
    }

    if (device.effectType === 'sampler' || device.effectType === 'instrument') {
        const otherSamplerParams = device.params
            .slice(0, 12);
        const sampleName = device.samplePath ? device.samplePath.split('/').pop() : null;
        return (
            <div style={{
                display: 'grid',
                gridTemplateRows: '102px auto',
                height: '100%',
                gap: 4,
                borderRadius: 'var(--radius-lg)',
                background: 'var(--surface-tab-inactive)',
                overflow: 'hidden',
            }}>
                <div
                    style={{
                        position: 'relative',
                        overflow: 'hidden',
                        borderBottom: '1px solid rgba(90,178,255,0.22)',
                    }}
                    onMouseUp={() => {
                        const dragging = useDragStore.getState().draggingItem;
                        const acceptance = dragging ? canDropInZone(dragging, 'sampler-surface') : { allowed: false };
                        if (dragging?.path && acceptance.allowed) {
                            onDropSample?.(dragging.path);
                            useDragStore.getState().endDrag();
                        }
                    }}
                >
                    <div style={{
                        position: 'absolute',
                        inset: 0,
                        background: 'var(--surface-tab-inactive)',
                    }} />
                    <svg
                        viewBox="0 0 1000 90"
                        preserveAspectRatio="none"
                        style={{ position: 'absolute', left: 8, right: 8, top: 18, height: 58, width: 'calc(100% - 16px)' }}
                    >
                        <defs>
                            <linearGradient id="samplerWaveFill" x1="0" y1="0" x2="0" y2="1">
                                <stop offset="0%" stopColor="#ffcc58" stopOpacity="0.92" />
                                <stop offset="100%" stopColor="#f0a62a" stopOpacity="0.66" />
                            </linearGradient>
                        </defs>
                        <rect x="0" y="0" width="1000" height="90" fill="color-mix(in srgb, var(--surface-1) 90%, #0f1728)" />
                        {Array.from({ length: 18 }).map((_, i) => (
                            <line
                                key={`g-${i}`}
                                x1={(i / 17) * 1000}
                                y1={0}
                                x2={(i / 17) * 1000}
                                y2={90}
                                stroke="rgba(90,178,255,0.09)"
                                strokeWidth="1"
                            />
                        ))}
                        <line x1="0" y1="45" x2="1000" y2="45" stroke="rgba(255,255,255,0.12)" strokeWidth="1" />
                        {samplerWaveformPath ? (
                            <>
                                <path d={samplerWaveformPath} fill="url(#samplerWaveFill)" />
                                <path d={samplerWaveformPath} fill="none" stroke="rgba(255,214,110,0.85)" strokeWidth="1" />
                            </>
                        ) : (
                            <path
                                d="M 0 46 C 30 14, 60 78, 90 46 C 120 14, 150 78, 180 46 C 210 14, 240 78, 270 46 C 300 14, 330 78, 360 46 C 390 14, 420 78, 450 46 C 480 14, 510 78, 540 46 C 570 18, 600 74, 630 46 C 660 24, 690 68, 720 46 C 750 30, 780 62, 810 46 C 840 36, 870 56, 900 46 C 930 42, 960 50, 1000 46"
                                fill="none"
                                stroke="#ffbf3c"
                                strokeWidth="2.4"
                                strokeLinecap="round"
                            />
                        )}
                    </svg>
                    <div style={{
                        position: 'absolute',
                        left: 8,
                        top: 4,
                        color: '#d7dce7',
                        fontSize: 'var(--font-size-2xs)',
                        letterSpacing: '0.04em',
                        textTransform: 'uppercase',
                        fontWeight: 'var(--font-weight-bold)' as unknown as number,
                    }}>
                        Sample
                    </div>
                    <div style={{
                        position: 'absolute',
                        left: 8,
                        right: 88,
                        bottom: 3,
                        color: sampleName ? '#9fb6d9' : '#a8b0bd',
                        fontSize: 'var(--font-size-2xs)',
                        overflow: 'hidden',
                        textOverflow: 'ellipsis',
                        whiteSpace: 'nowrap',
                    }}>
                        {sampleName ?? 'Drop sample here or load from disk'}
                    </div>
                    <button
                        type="button"
                        onClick={() => onLoadSample?.()}
                        style={{
                            position: 'absolute',
                            right: 8,
                            top: 4,
                            border: '1px solid var(--color-overlay-light)',
                            borderRadius: 'var(--radius-sm)',
                            background: 'var(--surface-tab-inactive)',
                            color: '#dce9ff',
                            fontSize: 'var(--font-size-2xs)',
                            padding: '3px 7px',
                            cursor: 'pointer',
                        }}
                    >
                        Load
                    </button>
                </div>
                <div style={{
                    display: 'grid',
                    gridTemplateColumns: 'repeat(6, minmax(0, 1fr))',
                    gap: 8,
                    alignItems: 'center',
                    padding: '4px 8px 8px 8px',
                    background: 'rgba(16, 20, 28, 0.55)',
                }}>
                    {otherSamplerParams.map((p) => (
                        <PluginKnob
                            key={p.name}
                            param={p}
                            onChange={onParamChange}
                            onGestureStart={onParamGestureStart}
                            onGestureEnd={onParamGestureEnd}
                            compact
                        />
                    ))}
                </div>
            </div>
        );
    }

    if (device.effectType === 'eq') {
        const eqTitle = normalizedInternalId === 'internal://effect/eq-three' ? 'Band EQ' : 'EQ';

        const bands = parseBandsFromParams(device.params, eqBandFilterTypes);
        const out = device.params.find((p) => p.name.toLowerCase() === 'out')?.value ?? 0;
        const activeBandIdx = selectedEqBand ?? dragEqBand ?? 2;


        /* ── Build smooth EQ curve using eqMath.ts ── */
        const { curvePath, fillPath } = buildEqCurvePaths(bands, PROJECT_SR);

        /* ── Build spectrum analyzer SVG path ── */
        const spectrumPath = buildSpectrumPath(spectrumData);


        /* ── Frequency grid labels ── */
        /* ── Professional frequency grid with major and sub-gridlines ── */
        const freqLabels = [
            { freq: 20, label: '20' }, { freq: 30, label: '30' }, { freq: 50, label: '50' },
            { freq: 100, label: '100' }, { freq: 200, label: '200' }, { freq: 500, label: '500' },
            { freq: 1000, label: '1k' }, { freq: 2000, label: '2k' }, { freq: 5000, label: '5k' },
            { freq: 10000, label: '10k' }, { freq: 20000, label: '20k' },
        ];
        const freqSubLines = [40, 60, 80, 150, 300, 400, 700, 800, 1500, 3000, 4000, 7000, 8000, 15000];

        /* ── Resolve knob params for active band ── */
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
                {/* ── Left sidebar: Knobs only (no band label, no filter dropdown) ── */}
                <div style={{
                    width: 100,
                    flexShrink: 0,
                    display: 'flex',
                    flexDirection: 'column',
                    gap: 2,
                    padding: '6px 4px',
                    background: 'var(--color-bg-secondary)',
                    borderRadius: 'var(--plugin-card-radius)',
                    border: '1px solid var(--plugin-card-border)',
                    justifyContent: 'center',
                }}>
                    {/* FREQ knob — always shown */}
                    {freqParam && <PluginKnob key={`freq-${bi}`} param={freqParam} label="FREQ" onChange={onParamChange} onGestureStart={onParamGestureStart} onGestureEnd={onParamGestureEnd} compact />}
                    {/* GAIN knob — only for Peaking / Shelf */}
                    {!activeFilterOnly && gainParam && <PluginKnob key={`gain-${bi}`} param={gainParam} label="GAIN" onChange={onParamChange} onGestureStart={onParamGestureStart} onGestureEnd={onParamGestureEnd} compact />}
                    {/* RES (Q) knob — only for LP / HP / Notch */}
                    {activeFilterOnly && qParam && <PluginKnob key={`q-${bi}`} param={qParam} label="RES" onChange={onParamChange} onGestureStart={onParamGestureStart} onGestureEnd={onParamGestureEnd} compact />}
                    {/* OUT knob — always shown */}
                    {outParam && <PluginKnob key="out" param={outParam} onChange={onParamChange} onGestureStart={onParamGestureStart} onGestureEnd={onParamGestureEnd} compact />}
                    {/* Active bands count */}
                    <div style={{ fontSize: 9, color: 'rgba(160,190,220,0.4)', textAlign: 'center', fontFamily: 'Inter, sans-serif', marginTop: 2 }}>
                        {enabledBands.length}/8
                    </div>
                </div>

                {/* ── Center: EQ graph + band strip ── */}
                <div style={{ flex: 1, display: 'flex', flexDirection: 'column', gap: 4 }}>
                    <div style={{
                        ...pluginPanelCardBaseStyle,
                        background: 'var(--plugin-bg-eq)',
                        overflow: 'visible',
                        padding: 0,
                        position: 'relative',
                        flex: 1,
                    }}>
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

                                // Check if clicked on existing enabled band → disable it
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

                                // Create new band at click position
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
                                // Determine Y-axis value based on the band's filter type
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
                                <linearGradient id={`eqGrad-${device.id}`} x1="0" y1="0" x2="0" y2="1">
                                    <stop offset="0%" stopColor="#5ab2ff" stopOpacity="0.3" />
                                    <stop offset="100%" stopColor="#5ab2ff" stopOpacity="0" />
                                </linearGradient>
                            </defs>
                            {/* ── Horizontal gain grid lines ── */}
                            {[-24, -18, -12, -6, 0, 6, 12, 18, 24].map((db) => (
                                <line key={`hg-${db}`} x1={MARGIN_L} y1={gainToY(db)} x2={VB_W - MARGIN_R} y2={gainToY(db)}
                                    stroke={db === 0 ? 'rgba(80,160,255,0.35)' : 'rgba(60,130,220,0.08)'} strokeWidth={db === 0 ? 0.8 : 0.4} />
                            ))}
                            {/* ── Vertical frequency grid (major + sub) — lines only, labels in HTML overlay ── */}
                            {freqLabels.map((fl) => (
                                <line key={`vf-${fl.freq}`} x1={freqToX(fl.freq)} y1={4} x2={freqToX(fl.freq)} y2={VB_H - 12} stroke="rgba(60,130,220,0.12)" strokeWidth="0.5" />
                            ))}
                            {freqSubLines.map((f) => (
                                <line key={`vsub-${f}`} x1={freqToX(f)} y1={4} x2={freqToX(f)} y2={VB_H - 12} stroke="rgba(60,130,220,0.05)" strokeWidth="0.3" />
                            ))}
                            <defs>
                                <linearGradient id={`specGrad-${device.id}`} x1="0" y1="0" x2="0" y2="1">
                                    <stop offset="0%" stopColor="rgba(0,220,200,0.35)" />
                                    <stop offset="100%" stopColor="rgba(0,220,200,0)" />
                                </linearGradient>
                            </defs>
                            {spectrumPath && (
                                <path d={spectrumPath} fill={`url(#specGrad-${device.id})`} opacity="0.6" />
                            )}
                            <path d={fillPath} fill={`url(#eqGrad-${device.id})`} opacity="0.5" />
                            <path d={curvePath} fill="none" stroke="rgba(90,178,255,0.7)" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
                            {/* Empty state hint */}
                            {enabledBands.length === 0 && (
                                <text x={VB_W / 2} y={VB_H / 2} textAnchor="middle" fill="rgba(160,190,220,0.25)" fontSize="10" fontFamily="Inter, sans-serif">
                                    Double-click to add EQ point
                                </text>
                            )}
                        </svg>
                        {/* ── Spectrum analyzer toggle ── */}
                        <div
                            style={{
                                position: 'absolute',
                                top: 4,
                                right: 6,
                                zIndex: 10,
                                cursor: 'pointer',
                                width: 22,
                                height: 22,
                                borderRadius: 4,
                                display: 'flex',
                                alignItems: 'center',
                                justifyContent: 'center',
                                background: eqSpectrumEnabled ? 'rgba(0,220,200,0.15)' : 'rgba(90,178,255,0.06)',
                                border: `1px solid ${eqSpectrumEnabled ? 'rgba(0,220,200,0.4)' : 'rgba(90,178,255,0.1)'}`,
                                transition: 'all 0.2s ease',
                            }}
                            title={eqSpectrumEnabled ? 'Hide Spectrum' : 'Show Spectrum'}
                            onClick={() => setEqSpectrumEnabled(!eqSpectrumEnabled)}
                        >
                            <svg width="14" height="14" viewBox="0 0 14 14" fill="none">
                                <path d="M1 10 L3 6 L5 8 L7 3 L9 7 L11 5 L13 9" stroke={eqSpectrumEnabled ? 'rgba(0,220,200,0.9)' : 'rgba(160,190,220,0.4)'} strokeWidth="1.2" fill="none" strokeLinecap="round" strokeLinejoin="round" />
                            </svg>
                        </div>
                        {/* ── dB scale labels overlay (HTML layer — prevents SVG text stretch) ── */}
                        <div style={{ position: 'absolute', inset: 0, pointerEvents: 'none' }}>
                            {[-24, -18, -12, -6, 0, 6, 12, 18, 24].map((db) => (
                                <div key={`dblabel-${db}`} style={{
                                    position: 'absolute',
                                    left: `${((MARGIN_L + 2) / VB_W) * 100}%`,
                                    top: `${((gainToY(db) - 5) / VB_H) * 100}%`,
                                    fontSize: 8,
                                    fontFamily: 'Inter, sans-serif',
                                    color: db === 0 ? 'rgba(160,200,255,0.55)' : 'rgba(160,200,255,0.3)',
                                    whiteSpace: 'nowrap',
                                    lineHeight: 1,
                                }}>
                                    {db > 0 ? '+' : ''}{db}dB
                                </div>
                            ))}
                        </div>
                        {/* ── Frequency labels overlay (HTML layer — prevents SVG text stretch) ── */}
                        <div style={{ position: 'absolute', inset: 0, pointerEvents: 'none' }}>
                            {freqLabels.map((fl) => (
                                <div key={`flabel-${fl.freq}`} style={{
                                    position: 'absolute',
                                    left: `${(freqToX(fl.freq) / VB_W) * 100}%`,
                                    bottom: 2,
                                    transform: 'translateX(-50%)',
                                    fontSize: 8,
                                    fontFamily: 'Inter, sans-serif',
                                    color: 'rgba(160,200,255,0.5)',
                                    whiteSpace: 'nowrap',
                                    lineHeight: 1,
                                }}>
                                    {fl.label}
                                </div>
                            ))}
                        </div>
                        {/* ── Band dots overlay (HTML layer — no SVG stretch distortion) ── */}
                        <div style={{ position: 'absolute', inset: 0, pointerEvents: 'none' }}>
                            {bands.filter(b => b.enabled).map((band) => {
                                const bx = freqToX(band.freq);
                                const by = bandDotY(band);
                                const leftPct = (bx / VB_W) * 100;
                                const topPct = (by / VB_H) * 100;
                                const isActive = dragEqBand === band.idx || selectedEqBand === band.idx;
                                const iconPath = EQ_FILTER_ICONS[band.filterType] ?? EQ_FILTER_ICONS['peaking'];
                                const DOT_SIZE = 18;
                                return (
                                    <div key={band.idx} style={{
                                        position: 'absolute',
                                        left: `${leftPct}%`,
                                        top: `${topPct}%`,
                                        transform: 'translate(-50%, -50%)',
                                        pointerEvents: 'auto',
                                        cursor: 'grab',
                                    }}
                                        onMouseDown={(e) => {
                                            if (e.button === 2) return; // skip right-click
                                            e.stopPropagation();
                                            setSelectedEqBand(band.idx);
                                            beginEqBandGesture(band.idx);
                                            setDragEqBand(band.idx);
                                        }}
                                        onContextMenu={(e) => {
                                            e.preventDefault();
                                            e.stopPropagation();
                                            setEqContextMenu({ x: e.clientX, y: e.clientY, bandIdx: band.idx });
                                        }}
                                        onDoubleClick={(e) => {
                                            e.stopPropagation();
                                            onParamChange(`B${band.idx}En`, 0); // disable band
                                        }}
                                    >
                                        {/* Active ring */}
                                        {isActive && (
                                            <div style={{
                                                position: 'absolute',
                                                left: '50%', top: '50%',
                                                width: 32, height: 32,
                                                transform: 'translate(-50%, -50%)',
                                                borderRadius: '50%',
                                                border: `1px solid ${band.color}`,
                                                opacity: 0.5,
                                            }} />
                                        )}
                                        {/* Dot circle + icon */}
                                        <div style={{
                                            width: DOT_SIZE, height: DOT_SIZE,
                                            borderRadius: '50%',
                                            background: 'rgba(0,0,0,0.75)',
                                            border: `2px solid ${band.color}`,
                                            display: 'flex', alignItems: 'center', justifyContent: 'center',
                                        }}>
                                            <svg width={12} height={12} viewBox="0 0 10 10" style={{ overflow: 'visible' }}>
                                                <path d={iconPath} fill="none" stroke={band.color} strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" />
                                            </svg>
                                        </div>
                                        {/* Label */}
                                        {isActive && (
                                            <div style={{
                                                position: 'absolute',
                                                bottom: '100%', left: '50%',
                                                transform: 'translateX(-50%)',
                                                marginBottom: 4,
                                                color: band.color,
                                                fontSize: 10, fontWeight: 600,
                                                fontFamily: 'Inter, sans-serif',
                                                whiteSpace: 'nowrap',
                                            }}>
                                                {EQ_FILTER_LABELS[band.filterType] ?? 'Bell'}
                                            </div>
                                        )}
                                    </div>
                                );
                            })}
                        </div>
                        {/* Right-click context menu */}
                        {eqContextMenu && (() => {
                            const MENU_HEIGHT = 200; // approximate max height for all items
                            const SAFE_MARGIN = 60; // bottom bar safe zone
                            const flipUp = eqContextMenu.y + MENU_HEIGHT > window.innerHeight - SAFE_MARGIN;
                            return (
                                <div
                                    style={{
                                        position: 'fixed',
                                        left: eqContextMenu.x,
                                        ...(flipUp
                                            ? { bottom: window.innerHeight - eqContextMenu.y }
                                            : { top: eqContextMenu.y }),
                                        zIndex: 9999,
                                        background: 'var(--color-bg-elevated, #1e2128)',
                                        border: '1px solid rgba(90,178,255,0.2)',
                                        borderRadius: 6,
                                        padding: '4px 0',
                                        boxShadow: '0 8px 32px rgba(0,0,0,0.6)',
                                        minWidth: 120,
                                    }}
                                    onMouseDown={(e) => e.stopPropagation()}
                                >
                                    {Object.entries(EQ_FILTER_LABELS).map(([type, label]) => (
                                        <div
                                            key={type}
                                            style={{
                                                padding: '5px 14px',
                                                fontSize: 12,
                                                color: bands[eqContextMenu.bandIdx].filterType === type ? '#5ab2ff' : 'rgba(220,230,240,0.85)',
                                                cursor: 'pointer',
                                                fontWeight: bands[eqContextMenu.bandIdx].filterType === type ? 700 : 400,
                                            }}
                                            onMouseEnter={(e) => { (e.currentTarget as HTMLElement).style.background = 'rgba(90,178,255,0.12)'; }}
                                            onMouseLeave={(e) => { (e.currentTarget as HTMLElement).style.background = 'transparent'; }}
                                            onClick={() => {
                                                const FILTER_TYPE_MAP: Record<string, number> = {
                                                    highpass: 0, lowpass: 1, lowshelf: 2,
                                                    highshelf: 3, peaking: 4, notch: 5,
                                                };
                                                setEqBandFilterTypes(prev => {
                                                    const next = [...prev];
                                                    next[eqContextMenu.bandIdx] = type;
                                                    return next;
                                                });
                                                // Sync filter type change to backend DSP processor
                                                const typeValue = FILTER_TYPE_MAP[type] ?? 4;
                                                onParamChange(`B${eqContextMenu.bandIdx}Type`, typeValue);
                                                setEqContextMenu(null);
                                            }}
                                        >
                                            {label}
                                        </div>
                                    ))}
                                </div>
                            );
                        })()}
                    </div>
                    {/* Band strip */}
                    <div style={{ ...pluginPanelMetaStyle, alignItems: 'center', gap: 4, flexWrap: 'wrap' }}>
                        <span style={{ fontWeight: 600, marginRight: 4, fontSize: 10 }}>{eqTitle}</span>
                        {bands.filter(b => b.enabled).map((band) => (
                            <span
                                key={band.idx}
                                style={{
                                    color: band.color,
                                    cursor: 'pointer',
                                    padding: '1px 5px',
                                    borderRadius: 3,
                                    background: (selectedEqBand === band.idx || dragEqBand === band.idx) ? 'rgba(255,255,255,0.08)' : 'transparent',
                                    fontSize: 10,
                                    fontWeight: (selectedEqBand === band.idx || dragEqBand === band.idx) ? 700 : 400,
                                    transition: 'all 0.15s ease',
                                }}
                                onClick={() => setSelectedEqBand(band.idx)}
                                onDoubleClick={() => onParamChange(`B${band.idx}En`, 0)}
                            >
                                {band.freq >= 1000 ? `${(band.freq / 1000).toFixed(1)}k` : band.freq.toFixed(0)}
                            </span>
                        ))}
                        <span style={{ marginLeft: 'auto', fontSize: 10, opacity: 0.6 }}>Out {out > 0 ? '+' : ''}{out.toFixed(1)}dB</span>
                    </div>
                </div>
            </div>
        );
    }


    const standardSurface = renderStandardPluginGuiSurface(device, {
        onParamChange,
        onParamGestureStart,
        onParamGestureEnd,
        onApplyUtilityScene,
    });
    if (standardSurface) {
        return standardSurface;
    }



    return (
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 12 }}>
            {device.params.map((p) => (
                <PluginKnob
                    key={p.name}
                    param={p}
                    onChange={onParamChange}
                    onGestureStart={onParamGestureStart}
                    onGestureEnd={onParamGestureEnd}
                    onContextMenu={onParamContextMenu}
                />
            ))}
        </div>
    );
};
