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
import type { DeviceSlot } from '@/widgets/DeviceRack/model/types';
import type { SampleRackConfig } from '@bindings/SampleRackConfig';

const pluginPanelLayoutStyle: React.CSSProperties = {
    display: 'grid',
    gridTemplateRows: '90px auto',
    gap: 'var(--plugin-grid-gap)',
    height: '100%',
};

const pluginPanelCardBaseStyle: React.CSSProperties = {
    border: '1px solid var(--plugin-card-border)',
    borderRadius: 'var(--plugin-card-radius)',
    padding: 'var(--plugin-card-pad-y) var(--plugin-card-pad-x)',
    display: 'grid',
    gridTemplateRows: '1fr auto',
    gap: 'var(--plugin-card-gap)',
    background: 'var(--plugin-card-bg-main)',
};

const pluginPanelTitleStyle: React.CSSProperties = {
    fontSize: 'var(--font-size-xs)',
    color: 'var(--plugin-title-color)',
    letterSpacing: '0.05em',
    textTransform: 'uppercase',
    fontWeight: 'var(--font-weight-bold)' as unknown as number,
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
        const EQ_FILTER_LABELS: Record<string, string> = {
            highpass: 'HP', lowshelf: 'L.Shelf', peaking: 'Bell',
            highshelf: 'H.Shelf', lowpass: 'LP', notch: 'Notch',
        };
        // Filter type SVG icon paths — properly scaled 12×12 mini-icons
        const EQ_FILTER_ICONS: Record<string, string> = {
            highpass: 'M1 11 C2 11 3 10 4 8 C5 5 6 3 7 3 L11 3',
            lowpass: 'M1 3 L5 3 C6 3 7 5 8 8 C9 10 10 11 11 11',
            lowshelf: 'M1 9 C2 9 3 8 4 7 C5 5 5 3 6 3 L11 3',
            highshelf: 'M1 3 L6 3 C7 3 7 5 8 7 C9 8 10 9 11 9',
            peaking: 'M1 8 C3 8 4 3 6 3 C8 3 9 8 11 8',
            notch: 'M1 3 C3 3 4 3 5 9 C5.5 11 6.5 11 7 9 C8 3 9 3 11 3',
        };
        const EQ_BAND_COLORS = [
            '#e06cf5', '#5ab2ff', '#5cf5e0', '#d9a625', '#ff8b5b', '#7ceb8a', '#ff5c5c', '#f0c430',
        ];
        const eqTitle = normalizedInternalId === 'internal://effect/eq-three' ? 'Band EQ' : 'EQ';

        /* ── Read all 8 bands from device params ── */
        interface EqBand8 { idx: number; freq: number; gain: number; q: number; enabled: boolean; filterType: string; color: string }
        const bands: EqBand8[] = [];
        for (let i = 0; i < 8; i++) {
            const freq = device.params.find((p) => p.name.toLowerCase() === `b${i}freq`)?.value ?? [30, 100, 250, 800, 2500, 6000, 12000, 18000][i];
            const gain = device.params.find((p) => p.name.toLowerCase() === `b${i}gain`)?.value ?? 0;
            const q = device.params.find((p) => p.name.toLowerCase() === `b${i}q`)?.value ?? 0.71;
            const en = device.params.find((p) => p.name.toLowerCase() === `b${i}en`)?.value ?? 0;
            bands.push({ idx: i, freq, gain, q, enabled: en > 0.5, filterType: eqBandFilterTypes[i], color: EQ_BAND_COLORS[i] });
        }
        const out = device.params.find((p) => p.name.toLowerCase() === 'out')?.value ?? 0;
        const activeBandIdx = selectedEqBand ?? dragEqBand ?? 2;

        /* ── Coordinate helpers ── */
        const VB_W = 480;
        const VB_H = 200;
        const MARGIN_L = 8;
        const MARGIN_R = 8;
        const plotW = VB_W - MARGIN_L - MARGIN_R;

        const freqToX = (freq: number) => {
            const minF = Math.log10(20);
            const maxF = Math.log10(20000);
            return MARGIN_L + ((Math.log10(Math.max(20, Math.min(20000, freq))) - minF) / (maxF - minF)) * plotW;
        };
        const xToFreq = (x: number) => {
            const minF = Math.log10(20);
            const maxF = Math.log10(20000);
            const norm = Math.max(0, Math.min(1, (x - MARGIN_L) / plotW));
            return Math.pow(10, minF + norm * (maxF - minF));
        };
        const gainToY = (gain: number) => {
            const clamped = Math.max(-24, Math.min(24, gain));
            return VB_H / 2 - (clamped / 24) * (VB_H / 2 - 10);
        };

        /** Filter-only types: dot Y controls Q (resonance), not gain */
        const isFilterOnlyType = (ft: string) =>
            ft === 'lowpass' || ft === 'highpass' || ft === 'notch';

        /** Map Q [0.1 → 18.0] to viewBox Y.  High Q = top, low Q = bottom */
        const qToY = (q: number) => {
            const clamped = Math.max(0.1, Math.min(18, q));
            // Log scale: 0.1 → bottom (VB_H - 10), 18 → top (10)
            const norm = (Math.log(clamped) - Math.log(0.1)) / (Math.log(18) - Math.log(0.1));
            return (VB_H - 10) - norm * (VB_H - 20);
        };


        /** Get dot Y position: Q for filter-only types, gain for peaking/shelf */
        const bandDotY = (band: EqBand8) =>
            isFilterOnlyType(band.filterType) ? qToY(band.q) : gainToY(band.gain);

        /* ── Exact biquad coefficient computation (mirrors Rust BiquadCoeffs::new) ── */
        // Uses projectSampleRate from useEngineStore (SSOT — hoisted to top of PluginGuiSurface)
        const PROJECT_SR = projectSampleRate;
        type BiquadCoeffs = { b0: number; b1: number; b2: number; a1: number; a2: number };

        function computeBiquadCoeffs(
            filterType: string, freq: number, q: number, gainDb: number, sr: number,
        ): BiquadCoeffs {
            // SSOT: clamp ranges must match Rust eq.rs set_param()
            //   freq → clamp(20.0, 20000.0)
            //   gain → clamp(-24.0, 24.0)
            //   Q    → clamp(0.1, 18.0)
            const clampedFreq = Math.max(20, Math.min(20000, freq));
            const clampedQ = Math.max(0.1, Math.min(18, q));
            const clampedGain = Math.max(-24, Math.min(24, gainDb));
            const omega = 2 * Math.PI * clampedFreq / sr;
            const cosW = Math.cos(omega);
            const sinW = Math.sin(omega);
            const alpha = sinW / (2 * clampedQ);
            const A = Math.pow(10, clampedGain / 40); // sqrt of linear gain
            const twoSqrtAAlpha = 2 * Math.sqrt(A) * alpha;
            let b0: number, b1: number, b2: number, a0: number, a1n: number, a2n: number;
            switch (filterType) {
                case 'lowpass': {
                    b1 = 1 - cosW; b0 = b1 / 2; b2 = b0;
                    a0 = 1 + alpha; a1n = -2 * cosW; a2n = 1 - alpha;
                    break;
                }
                case 'highpass': {
                    b1 = -(1 + cosW); b0 = (1 + cosW) / 2; b2 = b0;
                    a0 = 1 + alpha; a1n = -2 * cosW; a2n = 1 - alpha;
                    break;
                }
                case 'notch': {
                    b0 = 1; b1 = -2 * cosW; b2 = 1;
                    a0 = 1 + alpha; a1n = -2 * cosW; a2n = 1 - alpha;
                    break;
                }
                case 'lowshelf': {
                    b0 = A * ((A + 1) - (A - 1) * cosW + twoSqrtAAlpha);
                    b1 = 2 * A * ((A - 1) - (A + 1) * cosW);
                    b2 = A * ((A + 1) - (A - 1) * cosW - twoSqrtAAlpha);
                    a0 = (A + 1) + (A - 1) * cosW + twoSqrtAAlpha;
                    a1n = -2 * ((A - 1) + (A + 1) * cosW);
                    a2n = (A + 1) + (A - 1) * cosW - twoSqrtAAlpha;
                    break;
                }
                case 'highshelf': {
                    b0 = A * ((A + 1) + (A - 1) * cosW + twoSqrtAAlpha);
                    b1 = -2 * A * ((A - 1) + (A + 1) * cosW);
                    b2 = A * ((A + 1) + (A - 1) * cosW - twoSqrtAAlpha);
                    a0 = (A + 1) - (A - 1) * cosW + twoSqrtAAlpha;
                    a1n = 2 * ((A - 1) - (A + 1) * cosW);
                    a2n = (A + 1) - (A - 1) * cosW - twoSqrtAAlpha;
                    break;
                }
                default: { // peaking (bell)
                    b0 = 1 + alpha * A; b1 = -2 * cosW; b2 = 1 - alpha * A;
                    a0 = 1 + alpha / A; a1n = -2 * cosW; a2n = 1 - alpha / A;
                    break;
                }
            }
            const inv = 1 / a0;
            return { b0: b0 * inv, b1: b1 * inv, b2: b2 * inv, a1: a1n * inv, a2: a2n * inv };
        }

        /** Exact biquad magnitude response at a given frequency in dB */
        function biquadMagnitudeDb(c: BiquadCoeffs, freq: number, sr: number): number {
            const w = 2 * Math.PI * freq / sr;
            const cosW = Math.cos(w);
            const cos2W = Math.cos(2 * w);
            const sinW = Math.sin(w);
            const sin2W = Math.sin(2 * w);
            const numRe = c.b0 + c.b1 * cosW + c.b2 * cos2W;
            const numIm = -(c.b1 * sinW + c.b2 * sin2W);
            const denRe = 1 + c.a1 * cosW + c.a2 * cos2W;
            const denIm = -(c.a1 * sinW + c.a2 * sin2W);
            const num2 = numRe * numRe + numIm * numIm;
            const den2 = denRe * denRe + denIm * denIm;
            if (den2 < 1e-30) return 0;
            const ratio = num2 / den2;
            // Floor to prevent -Infinity from log10(≈0) at deep notch points
            if (ratio < 1e-20) return -200;
            return 10 * Math.log10(ratio);
        }

        /* ── Build smooth EQ curve using exact biquad magnitude response ── */
        const curvePoints: string[] = [];
        const steps = 200;
        // Pre-compute coefficients for all enabled bands
        const bandCoeffs: (BiquadCoeffs | null)[] = bands.map((band) =>
            band.enabled
                ? computeBiquadCoeffs(band.filterType, band.freq, band.q, band.gain, PROJECT_SR)
                : null,
        );
        for (let i = 0; i <= steps; i++) {
            const x = MARGIN_L + (i / steps) * plotW;
            const freq = xToFreq(x);
            let totalGainDb = 0;
            for (let bi = 0; bi < bands.length; bi++) {
                const c = bandCoeffs[bi];
                if (!c) continue;
                totalGainDb += biquadMagnitudeDb(c, freq, PROJECT_SR);
            }
            const y = gainToY(totalGainDb);
            curvePoints.push(`${x.toFixed(2)},${y.toFixed(2)}`);
        }
        const curvePath = `M ${curvePoints.join(' L ')}`;
        const fillPath = `${curvePath} L ${VB_W - MARGIN_R},${VB_H / 2} L ${MARGIN_L},${VB_H / 2} Z`;

        /* ── Build spectrum analyzer SVG path (behind the EQ curve) ── */
        let spectrumPath = '';
        if (spectrumData && spectrumData.length > 0) {
            const specBins = spectrumData.length; // 256 bins
            const minF = Math.log10(20);
            const maxF = Math.log10(20000);
            const specPoints: string[] = [];
            for (let i = 0; i < specBins; i++) {
                // Frequency for this bin — logarithmic mapping matching EQ grid
                const t = i / (specBins - 1);
                const freq = Math.pow(10, Math.log10(20) + t * (Math.log10(20000) - Math.log10(20)));
                const x = MARGIN_L + ((Math.log10(freq) - minF) / (maxF - minF)) * plotW;
                // Map dB to viewBox Y: -120dB = bottom, 0dB = center
                const dbValue = spectrumData[i];
                const clampedDb = Math.max(-80, Math.min(6, dbValue));
                const normDb = (clampedDb + 80) / 86; // 0..1 from -80dB to +6dB
                const y = VB_H - normDb * (VB_H - 10);
                specPoints.push(`${x.toFixed(1)},${y.toFixed(1)}`);
            }
            spectrumPath = `M ${specPoints[0]} L ${specPoints.slice(1).join(' L ')} L ${VB_W - MARGIN_R},${VB_H} L ${MARGIN_L},${VB_H} Z`;
        }

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

    if (device.effectType === 'utility') {
        const utilityTitle = normalizedInternalId === 'internal://effect/tuner'
            ? 'Tuner'
            : normalizedInternalId === 'internal://effect/external-audio-effect'
                ? 'External Audio Effect'
                : normalizedInternalId === 'internal://effect/auto-shift'
                    ? 'Auto Shift'
                    : normalizedInternalId === 'internal://effect/shifter'
                        ? 'Shifter'
                        : 'Utility';
        const isTuner = normalizedInternalId === 'internal://effect/tuner';
        const isExternalFx = normalizedInternalId === 'internal://effect/external-audio-effect';
        const isAutoShift = normalizedInternalId === 'internal://effect/auto-shift';
        const isShifter = normalizedInternalId === 'internal://effect/shifter';
        const gain = device.params.find((p) => p.name.toLowerCase() === 'gain')?.value ?? 0;
        const pan = device.params.find((p) => p.name.toLowerCase() === 'pan')?.value ?? 0;
        const width = device.params.find((p) => p.name.toLowerCase() === 'width')?.value ?? 100;
        const mono = (device.params.find((p) => p.name.toLowerCase() === 'mono')?.value ?? 0) > 0.5;
        const panPct = Math.max(-1, Math.min(1, pan / 100));
        const widthPct = Math.max(0, Math.min(1, width / 200));
        const shiftAmount = device.params.find((p) => p.name.toLowerCase().includes('shift'))?.value
            ?? device.params.find((p) => p.name.toLowerCase().includes('semitone'))?.value
            ?? 0;
        const hasUtilityCoreParams = device.params.some((p) => ['gain', 'pan', 'width', 'mono'].includes(p.name.toLowerCase()));
        return (
            <div style={pluginPanelLayoutStyle}>
                <div style={{
                    ...pluginPanelCardBaseStyle,
                    background: 'var(--plugin-bg-utility)',
                    display: 'grid',
                    gridTemplateColumns: '1fr 1fr',
                    gap: 10,
                    alignItems: 'center',
                }}>
                    {hasUtilityCoreParams ? (
                        <>
                            <div>
                                <div style={{ fontSize: 'var(--font-size-2xs)', color: '#9fa7b5', marginBottom: 4 }}>Pan</div>
                                <div style={{ position: 'relative', height: 8, borderRadius: 'var(--radius-full)', background: 'var(--color-bg-tertiary)' }}>
                                    <div style={{ position: 'absolute', left: '50%', top: 0, bottom: 0, width: 1, background: 'rgba(255,255,255,0.2)' }} />
                                    <div style={{
                                        position: 'absolute',
                                        top: -3,
                                        left: `calc(${(panPct * 50 + 50).toFixed(3)}% - 5px)`,
                                        width: 10,
                                        height: 14,
                                        borderRadius: 'var(--radius-md)',
                                        background: '#56a7ff',
                                        boxShadow: '0 0 6px rgba(86,167,255,0.45)',
                                    }} />
                                </div>
                            </div>
                            <div>
                                <div style={{ fontSize: 'var(--font-size-2xs)', color: '#9fa7b5', marginBottom: 4 }}>Stereo Width</div>
                                <div style={{ height: 8, borderRadius: 'var(--radius-full)', background: 'var(--color-bg-tertiary)', overflow: 'hidden' }}>
                                    <div style={{
                                        width: `${(widthPct * 100).toFixed(2)}%`,
                                        height: '100%',
                                        background: mono ? 'var(--color-bg-muted)' : 'var(--color-accent-primary)',
                                    }} />
                                </div>
                            </div>
                            <div style={{ ...pluginPanelTitleStyle, color: 'var(--color-text-secondary)' }}>
                                {utilityTitle}: <span style={{ color: 'var(--color-text-primary)', fontFamily: 'var(--font-mono)' }}>{gain.toFixed(1)} dB</span>
                            </div>
                            <div style={{ ...pluginPanelTitleStyle, color: mono ? 'var(--color-text-primary)' : 'var(--color-text-tertiary)' }}>
                                {mono ? 'Mono Enabled' : 'Stereo'}
                            </div>
                            <div style={{ gridColumn: '1 / span 2', display: 'flex', gap: 6, flexWrap: 'wrap' }}>
                                <button
                                    type="button"
                                    onClick={() => onApplyUtilityScene?.('center')}
                                    style={{ border: '1px solid var(--color-divider)', borderRadius: 'var(--radius-md)', background: 'var(--color-bg-header)', color: 'var(--color-text-secondary)', fontSize: 'var(--font-size-xs)', padding: '3px 8px', cursor: 'pointer' }}
                                >Center</button>
                                <button
                                    type="button"
                                    onClick={() => onApplyUtilityScene?.('mono')}
                                    style={{ border: '1px solid var(--color-divider)', borderRadius: 'var(--radius-md)', background: 'var(--color-bg-header)', color: 'var(--color-text-secondary)', fontSize: 'var(--font-size-xs)', padding: '3px 8px', cursor: 'pointer' }}
                                >Mono</button>
                                <button
                                    type="button"
                                    onClick={() => onApplyUtilityScene?.('wide')}
                                    style={{ border: '1px solid var(--color-divider)', borderRadius: 'var(--radius-md)', background: 'var(--color-bg-header)', color: 'var(--color-text-secondary)', fontSize: 'var(--font-size-xs)', padding: '3px 8px', cursor: 'pointer' }}
                                >Wide</button>
                            </div>
                        </>
                    ) : (
                        <>
                            <div style={{ gridColumn: '1 / span 2', ...pluginPanelTitleStyle, color: '#d9e3f2' }}>{utilityTitle}</div>
                            {isTuner && (
                                <div style={{ gridColumn: '1 / span 2', display: 'grid', gap: 4 }}>
                                    <div style={{ fontSize: 'var(--font-size-3xl)', color: '#a9d2ff', fontFamily: 'var(--font-mono)', textAlign: 'center' }}>A</div>
                                    <div style={{ height: 8, borderRadius: 'var(--radius-full)', background: '#1f2a36', position: 'relative' }}>
                                        <div style={{ position: 'absolute', left: '50%', top: 0, bottom: 0, width: 1, background: '#7ab6ff' }} />
                                    </div>
                                </div>
                            )}
                            {(isAutoShift || isShifter) && (
                                <div style={{ gridColumn: '1 / span 2', display: 'grid', gap: 4 }}>
                                    <div style={{ fontSize: 'var(--font-size-xs)', color: '#a5bed8', textTransform: 'uppercase', letterSpacing: '0.05em' }}>Shift</div>
                                    <div style={{ fontSize: 'var(--font-size-2xl)', color: '#dce9ff', fontFamily: 'var(--font-mono)' }}>{shiftAmount.toFixed(1)} st</div>
                                </div>
                            )}
                            {isExternalFx && (
                                <div style={{ gridColumn: '1 / span 2', fontSize: 'var(--font-size-xs)', color: '#c2cfdb', lineHeight: 1.4 }}>
                                    External routing host. Use device params below for send/return balance and compensation.
                                </div>
                            )}
                        </>
                    )}
                </div>
                <div style={pluginPanelKnobGrid('repeat(4, minmax(0, 1fr))')}>
                    {device.params.slice(0, 4).map((p) => (
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

    if (
        device.effectType === 'compressor'
    ) {
        const isTransientShaper = normalizedInternalId === 'internal://effect/transient-shaper';
        const thr = device.params.find((p) => p.name.toLowerCase() === 'thr')?.value ?? -18;
        const ratio = device.params.find((p) => p.name.toLowerCase() === 'ratio')?.value ?? 4;
        const pseudoGr = Math.max(0, Math.min(24, ((-thr) / 60) * ratio * 2.4));
        const atkMs = device.params.find((p) => p.name.toLowerCase() === 'atk')?.value
            ?? device.params.find((p) => p.name.toLowerCase().includes('attack'))?.value
            ?? 10;
        const relMs = device.params.find((p) => p.name.toLowerCase() === 'rel')?.value
            ?? device.params.find((p) => p.name.toLowerCase().includes('release'))?.value
            ?? 80;
        const attackNorm = Math.max(0, Math.min(1, Math.log10(Math.max(0.1, atkMs)) / Math.log10(200)));
        const releaseNorm = Math.max(0, Math.min(1, Math.log10(Math.max(1, relMs)) / Math.log10(1000)));
        return (
            <div style={pluginPanelLayoutStyle}>
                <div style={{
                    ...pluginPanelCardBaseStyle,
                    background: 'var(--plugin-bg-compressor)',
                    display: 'grid',
                    gridTemplateColumns: '1fr auto',
                    gap: 10,
                    alignItems: 'center',
                }}>
                    {isTransientShaper ? (
                        <div style={{ display: 'grid', gap: 6 }}>
                            <div style={{ ...pluginPanelTitleStyle, color: '#b9d7ff' }}>Transient Shaper</div>
                            <div style={{ height: 8, borderRadius: 'var(--radius-full)', background: 'var(--color-bg-tertiary)', overflow: 'hidden' }}>
                                <div style={{ width: `${(attackNorm * 100).toFixed(1)}%`, height: '100%', background: '#53b0ff' }} />
                            </div>
                            <div style={{ height: 8, borderRadius: 'var(--radius-full)', background: 'var(--color-bg-tertiary)', overflow: 'hidden' }}>
                                <div style={{ width: `${(releaseNorm * 100).toFixed(1)}%`, height: '100%', background: '#78d6ad' }} />
                            </div>
                            <div style={pluginPanelMetaStyle}>
                                <span>Attack {atkMs.toFixed(1)} ms</span>
                                <span>Release {relMs.toFixed(1)} ms</span>
                            </div>
                        </div>
                    ) : (
                        <svg viewBox="0 0 280 86" preserveAspectRatio="none" style={{ width: '100%', height: '100%' }}>
                            <rect x="0" y="0" width="280" height="86" fill="rgba(22,24,30,0.65)" />
                            <path d="M 14 70 L 120 70 Q 170 70 235 20 L 260 20" fill="none" stroke="#6ac3ff" strokeWidth="3" strokeLinecap="round" />
                            <line x1="14" y1="20" x2="14" y2="70" stroke="rgba(255,255,255,0.2)" />
                            <line x1="14" y1="70" x2="260" y2="70" stroke="rgba(255,255,255,0.2)" />
                        </svg>
                    )}
                    <div style={{ width: 46, height: 72, borderRadius: 'var(--radius-md)', background: 'var(--color-bg-tertiary)', border: '1px solid var(--color-divider)', padding: 3 }}>
                        <div style={{ width: '100%', height: `${(pseudoGr / 24) * 100}%`, marginTop: `${100 - (pseudoGr / 24) * 100}%`, background: 'var(--color-error)', borderRadius: 2 }} />
                    </div>
                    {!isTransientShaper && (
                        <div style={{ ...pluginPanelMetaStyle, gridColumn: '1 / -1' }}>
                            <span>Thr {thr.toFixed(1)} dB</span>
                            <span>Ratio {ratio.toFixed(1)}:1</span>
                            <span>Atk {atkMs.toFixed(1)} ms</span>
                            <span>Rel {relMs.toFixed(0)} ms</span>
                        </div>
                    )}
                </div>
                <div style={pluginPanelKnobGrid(`repeat(${Math.max(1, Math.min(4, device.params.length))}, minmax(0, 1fr))`)}>
                    {device.params.slice(0, 4).map((p) => (
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

    if (device.effectType === 'delay') {
        const delayTitle = normalizedInternalId === 'internal://effect/echo'
            ? 'Echo'
            : normalizedInternalId === 'internal://effect/beat-repeat'
                ? 'Beat Repeat'
                : normalizedInternalId === 'internal://effect/looper'
                    ? 'Looper'
                    : normalizedInternalId === 'internal://effect/spectral-time'
                        ? 'Spectral Time'
                        : normalizedInternalId === 'internal://effect/grain-delay'
                            ? 'Grain Delay'
                            : 'Delay';
        const isBeatRepeat = delayTitle === 'Beat Repeat';
        const isLooper = delayTitle === 'Looper';
        const isSpectralTime = delayTitle === 'Spectral Time';
        const time = device.params.find((p) => p.name.toLowerCase() === 'time')?.value ?? 280;
        const fb = device.params.find((p) => p.name.toLowerCase() === 'fb')?.value ?? 30;
        const mix = device.params.find((p) => p.name.toLowerCase() === 'dry/wet')?.value ?? 35;
        return (
            <div style={pluginPanelLayoutStyle}>
                <div style={{
                    ...pluginPanelCardBaseStyle,
                    background: 'var(--plugin-bg-delay)',
                }}>
                    <svg viewBox="0 0 320 52" preserveAspectRatio="none" style={{ width: '100%', height: '100%' }}>
                        <rect x="0" y="0" width="320" height="52" fill="rgba(14,20,30,0.6)" />
                        {!isLooper && !isSpectralTime && !isBeatRepeat && Array.from({ length: 8 }).map((_, i) => {
                            const x = 16 + i * 36;
                            const h = 24 * Math.pow((fb / 100), i);
                            return <rect key={i} x={x} y={26 - h / 2} width="10" height={h} fill={i === 0 ? '#7cc4ff' : '#4a9eff'} opacity={0.95 - i * 0.08} rx="1.5" />;
                        })}
                        {isBeatRepeat && Array.from({ length: 16 }).map((_, i) => {
                            const x = 10 + i * 18;
                            const on = i % 4 === 0 || i % 7 === 0;
                            return <rect key={i} x={x} y={on ? 12 : 18} width="12" height={on ? 28 : 16} fill={on ? '#78c3ff' : 'rgba(120,170,230,0.35)'} rx="2" />;
                        })}
                        {isLooper && (
                            <>
                                <circle cx="160" cy="26" r="16" fill="none" stroke="rgba(124,196,255,0.45)" strokeWidth="2" />
                                <path d="M 160 10 A 16 16 0 1 1 148 16" fill="none" stroke="#7cc4ff" strokeWidth="3" strokeLinecap="round" />
                            </>
                        )}
                        {isSpectralTime && Array.from({ length: 24 }).map((_, i) => {
                            const x = 6 + i * 13;
                            const h = 8 + (Math.sin(i * 0.8) + 1) * 14;
                            return <rect key={i} x={x} y={26 - h / 2} width="8" height={h} fill="rgba(138,205,255,0.85)" rx="1.5" />;
                        })}
                    </svg>
                    <div style={pluginPanelMetaStyle}>
                        <span>{delayTitle}</span>
                        <span>{time.toFixed(0)}ms</span>
                        <span>FB {fb.toFixed(0)}%</span>
                        <span>Mix {mix.toFixed(0)}%</span>
                    </div>
                </div>
                <div style={pluginPanelKnobGrid(`repeat(${Math.min(6, Math.max(3, device.params.length))}, minmax(0, 1fr))`)}>
                    {device.params.slice(0, 6).map((p) => (
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

    if (device.effectType === 'reverb') {
        const reverbTitle = normalizedInternalId === 'internal://effect/hybrid-reverb'
            ? 'Hybrid Reverb'
            : normalizedInternalId === 'internal://effect/corpus'
                ? 'Corpus'
                : normalizedInternalId === 'internal://effect/resonators'
                    ? 'Resonators'
                    : normalizedInternalId === 'internal://effect/spectral-resonator'
                        ? 'Spectral Resonator'
                        : 'Reverb';
        const decay = device.params.find((p) => p.name.toLowerCase() === 'decay')?.value ?? 45;
        const tone = device.params.find((p) => p.name.toLowerCase() === 'tone')?.value ?? 0;
        const reverbMix = device.params.find((p) => p.name.toLowerCase() === 'dry/wet')?.value ?? 50;
        const reverbSize = device.params.find((p) => p.name.toLowerCase() === 'size')?.value ?? 40;
        return (
            <div style={pluginPanelLayoutStyle}>
                <div style={{
                    ...pluginPanelCardBaseStyle,
                    background: 'var(--plugin-bg-reverb)',
                }}>
                    <div style={{ position: 'relative', overflow: 'hidden', borderRadius: 'var(--radius-md)', background: 'rgba(10,10,12,0.45)' }}>
                        {Array.from({ length: 5 }).map((_, i) => (
                            <div
                                key={i}
                                style={{
                                    position: 'absolute',
                                    left: `${15 + i * 14}%`,
                                    top: '50%',
                                    width: `${24 + i * 12}px`,
                                    height: `${24 + i * 12}px`,
                                    marginTop: `${-(12 + i * 6)}px`,
                                    borderRadius: '50%',
                                    border: '1px solid rgba(192, 145, 255, 0.35)',
                                }}
                            />
                        ))}
                    </div>
                    <div style={pluginPanelMetaStyle}>
                        <span>{reverbTitle}</span>
                        <span>Size {reverbSize.toFixed(0)}%</span>
                        <span>Decay {decay.toFixed(0)}%</span>
                        <span>Tone {tone.toFixed(0)}%</span>
                        <span>Mix {reverbMix.toFixed(0)}%</span>
                    </div>
                </div>
                <div style={pluginPanelKnobGrid(`repeat(${Math.min(6, Math.max(3, device.params.length))}, minmax(0, 1fr))`)}>
                    {device.params.slice(0, 6).map((p) => (
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

    if (device.effectType === 'chorus') {
        const rate = device.params.find((p) => p.name.toLowerCase() === 'rate')?.value ?? 1.2;
        const depth = device.params.find((p) => p.name.toLowerCase() === 'depth')?.value ?? 40;
        const chorusMix = device.params.find((p) => p.name.toLowerCase() === 'dry/wet')?.value ?? 50;
        return (
            <div style={pluginPanelLayoutStyle}>
                <div style={{
                    ...pluginPanelCardBaseStyle,
                    background: 'var(--plugin-bg-chorus)',
                }}>
                    <svg viewBox="0 0 320 52" preserveAspectRatio="none" style={{ width: '100%', height: '100%' }}>
                        <rect x="0" y="0" width="320" height="52" fill="rgba(12, 11, 18, 0.65)" />
                        <path d="M 0 26 C 40 8, 80 44, 120 26 C 160 8, 200 44, 240 26 C 280 8, 320 44, 320 26" fill="none" stroke="#c867ff" strokeWidth="2.2" />
                        <path d="M 0 26 C 40 44, 80 8, 120 26 C 160 44, 200 8, 240 26 C 280 44, 320 8, 320 26" fill="none" stroke="#4ac0ff" strokeWidth="2.2" opacity="0.9" />
                    </svg>
                    <div style={pluginPanelMetaStyle}>
                        <span>{rate.toFixed(1)}Hz</span>
                        <span>Depth {depth.toFixed(0)}%</span>
                        <span>Mix {chorusMix.toFixed(0)}%</span>
                    </div>
                </div>
                <div style={pluginPanelKnobGrid(`repeat(${Math.min(5, Math.max(3, device.params.length))}, minmax(0, 1fr))`)}>
                    {device.params.slice(0, 5).map((p) => (
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

    if (device.effectType === 'saturator') {
        const satTitle = normalizedInternalId === 'internal://effect/drum-buss'
            ? 'Drum Buss'
            : normalizedInternalId === 'internal://effect/dynamic-tube'
                ? 'Dynamic Tube'
                : 'Saturator';
        const drive = device.params.find((p) => p.name.toLowerCase() === 'drive')?.value ?? 3;
        const satTone = device.params.find((p) => p.name.toLowerCase() === 'tone')?.value ?? 0;
        const satMix = device.params.find((p) => p.name.toLowerCase() === 'dry/wet')?.value ?? 100;
        const driveClamp = Math.max(0, Math.min(24, drive));
        const knee = Math.max(12, 80 - driveClamp * 2.8);
        return (
            <div style={pluginPanelLayoutStyle}>
                <div style={{
                    ...pluginPanelCardBaseStyle,
                    background: 'var(--plugin-bg-saturator)',
                }}>
                    <svg viewBox="0 0 320 52" preserveAspectRatio="none" style={{ width: '100%', height: '100%' }}>
                        <rect x="0" y="0" width="320" height="52" fill="rgba(20, 13, 9, 0.7)" />
                        <line x1="12" y1="46" x2="308" y2="6" stroke="rgba(255,172,89,0.18)" strokeWidth="1" strokeDasharray="3,3" />
                        <path d={`M 12 46 C ${knee} 46, ${160 - knee / 2} 6, 160 6 C ${160 + knee / 2} 6, ${320 - knee} 46, 308 46`} fill="none" stroke="#ffac59" strokeWidth={Math.max(2, 2 + driveClamp / 8)} strokeLinecap="round" />
                    </svg>
                    <div style={pluginPanelMetaStyle}>
                        <span>{satTitle}</span>
                        <span>Drive {drive.toFixed(1)} dB</span>
                        {satTone !== 0 && <span>Tone {satTone.toFixed(0)}%</span>}
                        <span>Mix {satMix.toFixed(0)}%</span>
                    </div>
                </div>
                <div style={pluginPanelKnobGrid(`repeat(${Math.min(4, Math.max(3, device.params.length))}, minmax(0, 1fr))`)}>
                    {device.params.slice(0, 4).map((p) => (
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

    if (device.effectType === 'limiter') {
        const thr = device.params.find((p) => p.name.toLowerCase() === 'thr')?.value ?? -0.3;
        const ceil = device.params.find((p) => p.name.toLowerCase() === 'ceil')?.value ?? -0.1;
        const safety = Math.max(0, Math.min(1, 1 - Math.abs(thr - ceil) / 30));
        const limGr = Math.max(0, Math.abs(thr) * 0.8);
        return (
            <div style={pluginPanelLayoutStyle}>
                <div style={{ ...pluginPanelCardBaseStyle, background: 'var(--plugin-bg-limiter)' }}>
                    <div style={{ ...pluginPanelTitleStyle, color: '#a4d9d3' }}>Lookahead Limiter</div>
                    <div style={{ height: 10, borderRadius: 'var(--radius-full)', background: 'var(--color-bg-tertiary)', overflow: 'hidden' }}>
                        <div style={{ width: `${(safety * 100).toFixed(1)}%`, height: '100%', background: 'var(--color-success)' }} />
                    </div>
                    <div style={pluginPanelMetaStyle}>
                        <span>Thr {thr.toFixed(1)} dB</span>
                        <span>Ceil {ceil.toFixed(1)} dB</span>
                        <span>GR ~{limGr.toFixed(1)} dB</span>
                    </div>
                </div>
                <div style={pluginPanelKnobGrid('repeat(3, minmax(0, 1fr))')}>
                    {device.params.slice(0, 3).map((p) => (
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

    if (device.effectType === 'gate') {
        const thr = device.params.find((p) => p.name.toLowerCase() === 'thr')?.value ?? -40;
        const range = device.params.find((p) => p.name.toLowerCase() === 'range')?.value ?? -80;
        const gateAtk = device.params.find((p) => p.name.toLowerCase() === 'atk')?.value ?? device.params.find((p) => p.name.toLowerCase().includes('attack'))?.value ?? 0.1;
        const gateRel = device.params.find((p) => p.name.toLowerCase() === 'rel')?.value ?? device.params.find((p) => p.name.toLowerCase().includes('release'))?.value ?? 50;
        const openness = Math.max(0, Math.min(1, (80 + thr) / 80));
        return (
            <div style={pluginPanelLayoutStyle}>
                <div style={{ ...pluginPanelCardBaseStyle, background: 'var(--plugin-bg-gate)' }}>
                    <div style={{ ...pluginPanelTitleStyle, color: '#b8dfad' }}>Noise Gate</div>
                    <div style={{ height: 34, borderRadius: 'var(--radius-md)', background: 'var(--color-bg-tertiary)', position: 'relative' }}>
                        <div style={{ position: 'absolute', left: 0, top: 0, bottom: 0, width: `${(openness * 100).toFixed(1)}%`, background: 'var(--color-success)' }} />
                    </div>
                    <div style={pluginPanelMetaStyle}>
                        <span>Thr {thr.toFixed(1)} dB</span>
                        <span>Range {range.toFixed(1)} dB</span>
                        <span>Atk {gateAtk.toFixed(1)} ms</span>
                        <span>Rel {gateRel.toFixed(0)} ms</span>
                    </div>
                </div>
                <div style={pluginPanelKnobGrid('repeat(5, minmax(0, 1fr))')}>
                    {device.params.slice(0, 5).map((p) => (
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

    if (device.effectType === 'autoFilter' || device.effectType === 'autoPan' || device.effectType === 'phaser' || device.effectType === 'flanger') {
        const params = device.params;
        const isVocoder = normalizedInternalId === 'internal://effect/vocoder';
        const modRate = params.find((p) => p.name.toLowerCase() === 'rate')?.value ?? 0;
        const modDepth = params.find((p) => p.name.toLowerCase() === 'depth')?.value ?? 0;
        const modMix = params.find((p) => p.name.toLowerCase() === 'dry/wet')?.value ?? params.find((p) => p.name.toLowerCase() === 'amount')?.value ?? 50;
        const modFreq = params.find((p) => p.name.toLowerCase() === 'freq' || p.name.toLowerCase() === 'frequency')?.value ?? 0;
        const title = isVocoder
            ? 'Vocoder'
            : device.effectType === 'autoFilter'
                ? 'Auto Filter'
                : device.effectType === 'autoPan'
                    ? 'Auto Pan'
                    : device.effectType === 'phaser'
                        ? 'Phaser'
                        : 'Flanger';
        const hue = device.effectType === 'autoFilter'
            ? '#4cc9d8'
            : device.effectType === 'autoPan'
                ? '#6db3ff'
                : device.effectType === 'phaser'
                    ? '#998bff'
                    : '#66b3ff';
        return (
            <div style={pluginPanelLayoutStyle}>
                <div style={{
                    ...pluginPanelCardBaseStyle,
                    background: 'var(--plugin-bg-mod)',
                }}>
                    <svg viewBox="0 0 320 52" preserveAspectRatio="none" style={{ width: '100%', height: '100%' }}>
                        <rect x="0" y="0" width="320" height="52" fill="rgba(8, 10, 14, 0.65)" />
                        {!isVocoder && (
                            <path d="M 0 30 C 32 10, 64 46, 96 26 C 128 6, 160 44, 192 24 C 224 8, 256 42, 288 22 C 304 12, 320 26, 320 26" fill="none" stroke={hue} strokeWidth="2.4" />
                        )}
                        {isVocoder && Array.from({ length: 20 }).map((_, i) => {
                            const x = 8 + i * 15;
                            const h = 8 + ((i * 17) % 34);
                            return <rect key={i} x={x} y={42 - h} width="9" height={h} rx="1.5" fill="rgba(120,200,255,0.9)" />;
                        })}
                    </svg>
                    <div style={pluginPanelMetaStyle}>
                        <span>{title}</span>
                        {modRate > 0 && <span>{modRate.toFixed(2)} Hz</span>}
                        {modDepth > 0 && <span>Depth {modDepth.toFixed(0)}%</span>}
                        {modFreq > 0 && <span>Freq {modFreq.toFixed(0)} Hz</span>}
                        <span>Mix {modMix.toFixed(0)}%</span>
                    </div>
                </div>
                <div style={pluginPanelKnobGrid(`repeat(${Math.min(6, Math.max(3, params.length))}, minmax(0, 1fr))`)}>
                    {params.slice(0, 6).map((p) => (
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

    if (device.effectType === 'distortion' || device.effectType === 'bitcrusher') {
        const title = device.effectType === 'bitcrusher'
            ? 'Bitcrusher'
            : normalizedInternalId === 'internal://effect/amp'
                ? 'Amp'
                : normalizedInternalId === 'internal://effect/cabinet'
                    ? 'Cabinet'
                    : normalizedInternalId === 'internal://effect/erosion'
                        ? 'Erosion'
                        : normalizedInternalId === 'internal://effect/overdrive'
                            ? 'Overdrive'
                            : normalizedInternalId === 'internal://effect/pedal'
                                ? 'Pedal'
                                : normalizedInternalId === 'internal://effect/roar'
                                    ? 'Roar'
                                    : 'Distortion';
        const color = device.effectType === 'distortion' ? '#ff965e' : '#f2de72';
        const drive = device.params.find((p) => p.name.toLowerCase() === 'drive')?.value ?? 0;
        const mix = device.params.find((p) => p.name.toLowerCase() === 'mix')?.value ?? 0;
        const tone = device.params.find((p) => p.name.toLowerCase() === 'tone')?.value ?? 0;
        const isAmp = title === 'Amp' || title === 'Cabinet';
        const isErosion = title === 'Erosion';
        const isBit = title === 'Bitcrusher';
        return (
            <div style={pluginPanelLayoutStyle}>
                <div style={{
                    ...pluginPanelCardBaseStyle,
                    background: 'var(--plugin-bg-distortion)',
                }}>
                    <div style={{ ...pluginPanelTitleStyle, color: '#d6c1a5' }}>{title}</div>
                    <svg viewBox="0 0 320 52" preserveAspectRatio="none" style={{ width: '100%', height: 44 }}>
                        <rect x="0" y="0" width="320" height="52" fill="rgba(20, 13, 9, 0.65)" />
                        {!isAmp && !isErosion && !isBit && (
                            <path d="M 8 44 L 48 12 L 88 44 L 128 12 L 168 44 L 208 12 L 248 44 L 312 16" fill="none" stroke={color} strokeWidth="2.2" />
                        )}
                        {isAmp && (
                            <>
                                {Array.from({ length: 7 }).map((_, i) => (
                                    <line key={i} x1={18 + i * 45} y1={8} x2={18 + i * 45} y2={44} stroke="rgba(255,170,110,0.35)" />
                                ))}
                                <path d="M 6 43 C 52 38, 86 16, 126 18 C 166 20, 210 42, 260 36 C 282 33, 302 29, 316 22" fill="none" stroke="#ffb57a" strokeWidth="2.4" />
                            </>
                        )}
                        {isErosion && (
                            <>
                                {Array.from({ length: 24 }).map((_, i) => {
                                    const x = 8 + i * 13;
                                    const h = 8 + ((i * 19) % 30);
                                    return <rect key={i} x={x} y={42 - h} width="6" height={h} rx="1" fill="rgba(255,156,94,0.82)" />;
                                })}
                            </>
                        )}
                        {isBit && (
                            <>
                                {Array.from({ length: 16 }).map((_, i) => {
                                    const x = 12 + i * 18;
                                    const high = i % 2 === 0 || i % 5 === 0;
                                    return <rect key={i} x={x} y={high ? 14 : 26} width="12" height={high ? 24 : 12} fill="rgba(242,222,114,0.9)" rx="1.5" />;
                                })}
                            </>
                        )}
                    </svg>
                    <div style={pluginPanelMetaStyle}>
                        <span>Drive {drive.toFixed(1)}</span>
                        <span>Tone {tone.toFixed(2)}</span>
                        <span>Mix {mix.toFixed(2)}</span>
                    </div>
                </div>
                <div style={pluginPanelKnobGrid(`repeat(${Math.min(4, Math.max(3, device.params.length))}, minmax(0, 1fr))`)}>
                    {device.params.slice(0, 4).map((p) => (
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

    if (device.effectType === 'noiseMachine') {
        const type = Math.round(device.params.find((p) => p.name.toLowerCase() === 'type')?.value ?? 0);
        const level = device.params.find((p) => p.name.toLowerCase() === 'level')?.value ?? -30;
        const stereo = device.params.find((p) => p.name.toLowerCase() === 'stereo')?.value ?? 0.5;
        const typeLabel = type <= 0 ? 'Vinyl' : type === 1 ? 'Air' : 'Storm';
        return (
            <div style={pluginPanelLayoutStyle}>
                <div style={{
                    ...pluginPanelCardBaseStyle,
                    background: 'var(--plugin-bg-noise)',
                }}>
                    <div style={{ ...pluginPanelTitleStyle, color: '#a5d6b0' }}>Noise Machine</div>
                    <svg viewBox="0 0 320 52" preserveAspectRatio="none" style={{ width: '100%', height: 44 }}>
                        <rect x="0" y="0" width="320" height="52" fill="rgba(12, 18, 12, 0.65)" />
                        <path d="M 4 26 L 12 10 L 20 38 L 28 18 L 36 42 L 44 14 L 52 34 L 60 8 L 68 40 L 76 20 L 84 36 L 92 12 L 100 44 L 108 16 L 116 38 L 124 22 L 132 40 L 140 10 L 148 34 L 156 18 L 164 42 L 172 14 L 180 36 L 188 8 L 196 40 L 204 20 L 212 38 L 220 12 L 228 44 L 236 16 L 244 34 L 252 22 L 260 40 L 268 10 L 276 38 L 284 18 L 292 42 L 300 14 L 308 36 L 316 26" fill="none" stroke="#72d68a" strokeWidth="1.6" />
                    </svg>
                    <div style={pluginPanelMetaStyle}>
                        <span>{typeLabel}</span>
                        <span>Level {level.toFixed(1)} dB</span>
                        <span>Stereo {(stereo * 100).toFixed(0)}%</span>
                    </div>
                </div>
                <div style={pluginPanelKnobGrid(`repeat(${Math.min(6, device.params.length)}, minmax(0, 1fr))`)}>
                    {device.params.slice(0, 6).map((p) => (
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

    if (device.effectType === 'analyzer' || device.effectType === 'spectrum' || device.effectType === 'midiPitch' || device.effectType === 'midiScale' || device.effectType === 'midiVelocity' || device.effectType === 'midiRandom') {
        const title = device.effectType === 'analyzer' || device.effectType === 'spectrum'
            ? 'Analyzer'
            : device.effectType === 'midiPitch'
                ? 'MIDI Pitch'
                : device.effectType === 'midiScale'
                    ? (normalizedInternalId === 'internal://midi-fx/chord' ? 'Chord' : 'MIDI Scale')
                    : device.effectType === 'midiVelocity'
                        ? (normalizedInternalId === 'internal://midi-fx/note-length' ? 'Note Length' : normalizedInternalId === 'internal://midi-fx/cc-control' ? 'CC Control' : normalizedInternalId === 'internal://midi-fx/expression-control' ? 'Expression Control' : 'MIDI Velocity')
                        : (normalizedInternalId === 'internal://midi-fx/arpeggiator' ? 'Arpeggiator' : 'MIDI Random');
        const spectrumBars = Array.from({ length: 24 }).map((_, idx) => {
            const t = idx / 23;
            const h = 18 + Math.sin((idx + 1) * 0.62) * 9 + (1 - Math.abs(0.5 - t) * 2) * 20;
            return { x: 8 + idx * 13, h: Math.max(4, h) };
        });
        const semitones = device.params.find((p) => p.name.toLowerCase() === 'semitones')?.value ?? 0;
        const root = device.params.find((p) => p.name.toLowerCase() === 'root')?.value ?? 0;
        const chance = device.params.find((p) => p.name.toLowerCase() === 'chance')?.value ?? 0;
        const velGain = device.params.find((p) => p.name.toLowerCase() === 'gain')?.value ?? 1;
        const velOffset = device.params.find((p) => p.name.toLowerCase() === 'offset')?.value ?? 0;
        const isNoteLength = normalizedInternalId === 'internal://midi-fx/note-length';
        const isCcControl = normalizedInternalId === 'internal://midi-fx/cc-control';
        const isExpressionControl = normalizedInternalId === 'internal://midi-fx/expression-control';
        const isArp = normalizedInternalId === 'internal://midi-fx/arpeggiator';
        const noteNames = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];
        const activeRoot = Math.max(0, Math.min(11, Math.round(root) % 12));
        return (
            <div style={pluginPanelLayoutStyle}>
                <div style={{ ...pluginPanelCardBaseStyle, background: 'var(--plugin-bg-midi)' }}>
                    <div style={{ ...pluginPanelTitleStyle, color: '#b8c8e8' }}>{title}</div>
                    {device.effectType === 'spectrum' && (
                        <svg viewBox="0 0 320 52" preserveAspectRatio="none" style={{ width: '100%', height: 46 }}>
                            <rect x="0" y="0" width="320" height="52" fill="rgba(8, 10, 14, 0.7)" />
                            {spectrumBars.map((bar, idx) => (
                                <rect
                                    key={idx}
                                    x={bar.x}
                                    y={46 - bar.h}
                                    width="8"
                                    height={bar.h}
                                    rx="1.2"
                                    fill={bar.h > 30 ? 'rgba(255,180,102,0.92)' : 'rgba(122,198,255,0.92)'}
                                />
                            ))}
                        </svg>
                    )}
                    {device.effectType === 'analyzer' && (
                        <div style={{
                            display: 'grid',
                            gridTemplateColumns: '1fr 1fr',
                            gap: 6,
                            padding: '4px 8px',
                            height: 80,
                            background: 'rgba(8, 10, 14, 0.7)',
                            borderRadius: 'var(--radius-md)',
                        }}>
                            {/* Left channel meter */}
                            <div style={{ display: 'flex', flexDirection: 'column', gap: 3 }}>
                                <div style={{ fontSize: 9, color: '#7a9ec4', fontFamily: 'var(--font-mono)', letterSpacing: '0.05em' }}>PEAK L</div>
                                <div style={{ flex: 1, background: '#0d1117', borderRadius: 2, overflow: 'hidden', position: 'relative' }}>
                                    <div style={{
                                        position: 'absolute', bottom: 0, left: 0, right: 0,
                                        height: `${Math.max(1, Math.min(100, (1 - Math.max(0, -device.vuLevelL) / 60) * 100))}%`,
                                        background: device.vuLevelL > -3 ? 'var(--color-error)' : device.vuLevelL > -12 ? 'var(--color-warning)' : 'var(--color-success)',
                                        borderRadius: 2,
                                        transition: 'height 60ms linear',
                                    }} />
                                </div>
                                <div style={{ fontSize: 10, color: '#95bdff', fontFamily: 'var(--font-mono)', textAlign: 'center' }}>
                                    {device.vuLevelL > -100 ? device.vuLevelL.toFixed(1) : '-∞'}
                                </div>
                            </div>
                            {/* Right channel meter */}
                            <div style={{ display: 'flex', flexDirection: 'column', gap: 3 }}>
                                <div style={{ fontSize: 9, color: '#7a9ec4', fontFamily: 'var(--font-mono)', letterSpacing: '0.05em' }}>PEAK R</div>
                                <div style={{ flex: 1, background: '#0d1117', borderRadius: 2, overflow: 'hidden', position: 'relative' }}>
                                    <div style={{
                                        position: 'absolute', bottom: 0, left: 0, right: 0,
                                        height: `${Math.max(1, Math.min(100, (1 - Math.max(0, -device.vuLevelR) / 60) * 100))}%`,
                                        background: device.vuLevelR > -3 ? 'var(--color-error)' : device.vuLevelR > -12 ? 'var(--color-warning)' : 'var(--color-success)',
                                        borderRadius: 2,
                                        transition: 'height 60ms linear',
                                    }} />
                                </div>
                                <div style={{ fontSize: 10, color: '#95bdff', fontFamily: 'var(--font-mono)', textAlign: 'center' }}>
                                    {device.vuLevelR > -100 ? device.vuLevelR.toFixed(1) : '-∞'}
                                </div>
                            </div>
                        </div>
                    )}
                    {device.effectType === 'midiPitch' && (
                        <div style={{ display: 'grid', placeItems: 'center', height: 46 }}>
                            <div style={{ fontFamily: 'var(--font-mono)', fontSize: 'var(--font-size-3xl)', color: '#95bdff' }}>
                                {semitones >= 0 ? '+' : ''}{semitones.toFixed(0)} st
                            </div>
                        </div>
                    )}
                    {device.effectType === 'midiScale' && (
                        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(12, minmax(0, 1fr))', gap: 3, height: 46, alignItems: 'center' }}>
                            {noteNames.map((n, idx) => (
                                <div
                                    key={n}
                                    style={{
                                        borderRadius: 'var(--radius-sm)',
                                        border: idx === activeRoot ? '1px solid #8bc27a' : '1px solid rgba(255,255,255,0.14)',
                                        background: idx === activeRoot ? 'rgba(139,194,122,0.22)' : 'rgba(160,180,210,0.1)',
                                        color: idx === activeRoot ? '#d9f3d1' : '#a8b7cd',
                                        fontSize: 'var(--font-size-2xs)',
                                        textAlign: 'center',
                                        padding: '3px 0',
                                    }}
                                >
                                    {n}
                                </div>
                            ))}
                        </div>
                    )}
                    {device.effectType === 'midiVelocity' && (
                        <div style={{ display: 'grid', gap: 6, height: 46 }}>
                            {isNoteLength ? (
                                <>
                                    <div style={{ height: 8, borderRadius: 'var(--radius-full)', background: 'var(--color-bg-tertiary)', overflow: 'hidden' }}>
                                        <div style={{ width: `${Math.max(0, Math.min(100, velGain * 50)).toFixed(1)}%`, height: '100%', background: 'var(--color-accent-primary)' }} />
                                    </div>
                                    <div style={{ fontSize: 'var(--font-size-xs)', color: '#c5d7ea', fontFamily: 'var(--font-mono)' }}>Gate {(velGain * 100).toFixed(0)}%</div>
                                </>
                            ) : (
                                <>
                                    <div style={{ height: 8, borderRadius: 'var(--radius-full)', background: 'var(--color-bg-tertiary)', overflow: 'hidden' }}>
                                        <div style={{ width: `${Math.max(0, Math.min(200, velGain * 100)).toFixed(1)}%`, height: '100%', background: 'var(--color-accent-primary)' }} />
                                    </div>
                                    <div style={{ height: 8, borderRadius: 'var(--radius-full)', background: '#1e2430', overflow: 'hidden', position: 'relative' }}>
                                        <div style={{ position: 'absolute', left: '50%', top: 0, bottom: 0, width: 1, background: 'rgba(255,255,255,0.2)' }} />
                                        <div style={{
                                            position: 'absolute',
                                            left: `calc(${Math.max(0, Math.min(100, (velOffset + 64) / 128 * 100)).toFixed(1)}% - 5px)`,
                                            top: -2,
                                            width: 10,
                                            height: 12,
                                            borderRadius: 'var(--radius-md)',
                                            background: isCcControl || isExpressionControl ? '#8ecb7c' : '#d9a25c',
                                        }} />
                                    </div>
                                </>
                            )}
                        </div>
                    )}
                    {device.effectType === 'midiRandom' && (
                        <div style={{ display: 'grid', alignItems: 'center', gap: 4, height: 46 }}>
                            <div style={{ height: 8, borderRadius: 'var(--radius-full)', background: 'var(--color-bg-tertiary)', overflow: 'hidden' }}>
                                <div style={{ width: `${Math.max(0, Math.min(100, chance * 100)).toFixed(1)}%`, height: '100%', background: 'var(--color-accent-primary)' }} />
                            </div>
                            <div style={{ fontSize: 'var(--font-size-xs)', color: '#cfa4e6', fontFamily: 'var(--font-mono)' }}>
                                {isArp
                                    ? `Arp Gate ${(chance * 100).toFixed(0)}% | Steps ${Math.max(1, Math.round(Math.abs(semitones) || 8))}`
                                    : `Chance ${(chance * 100).toFixed(0)}% | Range ±${Math.abs(semitones).toFixed(0)} st`}
                            </div>
                        </div>
                    )}
                    <div style={pluginPanelMetaStyle}>
                        <span>{device.effectType === 'analyzer' || device.effectType === 'spectrum' ? 'Analyzer (native)' : 'MIDI FX (import-compatible)'}</span>
                    </div>
                </div>
                {device.params.length > 0 && (
                    <div style={pluginPanelKnobGrid(`repeat(${Math.min(4, Math.max(2, device.params.length))}, minmax(0, 1fr))`)}>
                        {device.params.map((p) => (
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
                )}
            </div>
        );
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
