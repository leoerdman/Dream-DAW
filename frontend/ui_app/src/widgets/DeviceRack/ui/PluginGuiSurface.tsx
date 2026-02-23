import { useMemo, useState, useCallback, useEffect, useRef } from 'react';
import * as engineApi from '@/shared/api/engine';
import { useEngineStore } from '@/shared/stores/useEngineStore';
import { resolveSampleRate } from '@/shared/lib/audioMath';
import { SampleRack } from '@/widgets/SampleRack/SampleRack';
import { EssenceSynth } from '@/widgets/DeviceRack/EssenceSynth';
import { renderStandardPluginGuiSurface } from '@/widgets/DeviceRack/ui/PluginGuiSurfaceStandard';
import { PluginGuiSurfaceSampler } from '@/widgets/DeviceRack/ui/PluginGuiSurfaceSampler';
import { PluginGuiSurfaceFallback } from '@/widgets/DeviceRack/ui/PluginGuiSurfaceFallback';
import { PluginGuiSurfaceEq } from '@/widgets/DeviceRack/ui/PluginGuiSurfaceEq';
import { deriveEqBandFilterTypes } from '@/widgets/DeviceRack/lib/eqMath';
import type { DeviceSlot } from '@/widgets/DeviceRack/model/types';
import type { SampleRackConfig } from '@bindings/SampleRackConfig';

/* ── Module-level EQ filter type cache (persists across component remounts) ── */
const eqFilterTypeCache = new Map<string, string[]>();
const EQ_DEFAULT_TYPES = ['highpass', 'lowshelf', 'peaking', 'peaking', 'peaking', 'peaking', 'highshelf', 'lowpass'];

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
        return cached ?? EQ_DEFAULT_TYPES;
    });
    const resolvedEqBandFilterTypes = useMemo(
        () => deriveEqBandFilterTypes(device.params, eqBandFilterTypes),
        [device.params, eqBandFilterTypes],
    );
    useEffect(() => {
        const cached = eqFilterTypeCache.get(device.id);
        const next = resolvedEqBandFilterTypes;
        if (!cached || cached.length !== next.length || cached.some((v, i) => v !== next[i])) {
            eqFilterTypeCache.set(device.id, next);
        }
        setEqBandFilterTypes((prev) => {
            if (prev.length === next.length && prev.every((v, i) => v === next[i])) return prev;
            return next;
        });
    }, [device.id, resolvedEqBandFilterTypes]);

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
        onParamGestureStart?.(`B${bandIdx}Q`, gestureGroupId);
    }, [device.id, onParamGestureStart]);

    const endEqBandGesture = useCallback((bandIdx: number) => {
        onParamGestureEnd?.(`B${bandIdx}Freq`);
        onParamGestureEnd?.(`B${bandIdx}Gain`);
        onParamGestureEnd?.(`B${bandIdx}Q`);
    }, [onParamGestureEnd]);

    useEffect(() => {
        if (dragEqBand === null) return;
        const bandIdx = dragEqBand;
        let lastFreq = Number.NaN;
        let lastGain = Number.NaN;
        let lastQ = Number.NaN;
        let lastQSentAt = 0;
        let rafId: number | null = null;
        let latestEvent: MouseEvent | null = null;

        const flushMove = () => {
            rafId = null;
            const e = latestEvent;
            if (!e) return;
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
            const roundedFreq = Math.round(freq);
            if (roundedFreq !== lastFreq) {
                lastFreq = roundedFreq;
                onParamChange(`B${bandIdx}Freq`, roundedFreq);
            }

            // ── Y axis: Q for filter-only (LP/HP/Notch), Gain for peaking/shelf ──
            const filterType = resolvedEqBandFilterTypes[bandIdx] ?? 'peaking';
            const filterOnly = filterType === 'lowpass' || filterType === 'highpass' || filterType === 'notch';
            if (filterOnly) {
                // Invert qToY: norm = ((VB_H-10) - svgY) / (VB_H-20)
                const qNorm = ((VB_H_DRAG - 10) - svgY) / (VB_H_DRAG - 20);
                const clampedQNorm = Math.max(0, Math.min(1, qNorm));
                const q = Math.exp(Math.log(0.1) + clampedQNorm * (Math.log(18) - Math.log(0.1)));
                // HP/LP/Notch are most expensive during drag because both Freq and Q update.
                // Gate Q updates to lower UI/backend pressure while preserving final value on mouseup.
                const roundedQ = Math.round(q * 10) / 10;
                const now = performance.now();
                const qChangedEnough = Number.isNaN(lastQ) || Math.abs(roundedQ - lastQ) >= 0.2;
                const qSendWindowOpen = now - lastQSentAt >= 80;
                if (roundedQ !== lastQ && (qChangedEnough || qSendWindowOpen)) {
                    lastQ = roundedQ;
                    lastQSentAt = now;
                    onParamChange(`B${bandIdx}Q`, roundedQ);
                }
            } else {
                const gainValue = ((VB_H_DRAG / 2 - svgY) / (VB_H_DRAG / 2 - 10)) * 24;
                const roundedGain = Math.max(-24, Math.min(24, gainValue));
                const quantizedGain = Math.round(roundedGain * 10) / 10;
                if (quantizedGain !== lastGain) {
                    lastGain = quantizedGain;
                    onParamChange(`B${bandIdx}Gain`, quantizedGain);
                }
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
            // Commit latest cursor point before ending gesture.
            flushMove();
            endEqBandGesture(bandIdx);
            setDragEqBand(null);
        };
        window.addEventListener('mousemove', onMove);
        window.addEventListener('mouseup', onUp);
        return () => {
            if (rafId != null) {
                window.cancelAnimationFrame(rafId);
                rafId = null;
            }
            window.removeEventListener('mousemove', onMove);
            window.removeEventListener('mouseup', onUp);
        };
    }, [dragEqBand, onParamChange, endEqBandGesture, resolvedEqBandFilterTypes]);

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
        return (
            <PluginGuiSurfaceSampler
                device={device}
                samplerWaveformPath={samplerWaveformPath}
                onParamChange={onParamChange}
                onParamGestureStart={onParamGestureStart}
                onParamGestureEnd={onParamGestureEnd}
                onDropSample={onDropSample}
                onLoadSample={onLoadSample}
            />
        );
    }

    if (device.effectType === 'eq') {
        return (
            <PluginGuiSurfaceEq
                device={device}
                projectSampleRate={projectSampleRate}
                eqBandFilterTypes={resolvedEqBandFilterTypes}
                setEqBandFilterTypes={setEqBandFilterTypes}
                eqSurfaceRef={eqSurfaceRef}
                dragEqBand={dragEqBand}
                setDragEqBand={setDragEqBand}
                selectedEqBand={selectedEqBand}
                setSelectedEqBand={setSelectedEqBand}
                eqContextMenu={eqContextMenu}
                setEqContextMenu={setEqContextMenu}
                eqSpectrumEnabled={eqSpectrumEnabled}
                setEqSpectrumEnabled={setEqSpectrumEnabled}
                spectrumData={spectrumData}
                beginEqBandGesture={beginEqBandGesture}
                onParamChange={onParamChange}
                onParamGestureStart={onParamGestureStart}
                onParamGestureEnd={onParamGestureEnd}
            />
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
        <PluginGuiSurfaceFallback
            device={device}
            onParamChange={onParamChange}
            onParamGestureStart={onParamGestureStart}
            onParamGestureEnd={onParamGestureEnd}
            onParamContextMenu={onParamContextMenu}
        />
    );
};
