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
import { useEqBandDragEffect } from '@/widgets/DeviceRack/model/useEqBandDragEffect';
import type { SampleRackConfig } from '@bindings/SampleRackConfig';

/* ── Module-level EQ filter type cache (persists across component remounts) ── */
// BUG-H12 FIX: Use a Map with a max-size eviction to prevent memory leak.
// Over long sessions with many EQ create/delete cycles, old entries are evicted.
const MAX_EQ_CACHE_SIZE = 64;
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
            // BUG-H12 FIX: Evict oldest entries when cache exceeds max size.
            if (eqFilterTypeCache.size > MAX_EQ_CACHE_SIZE) {
                const firstKey = eqFilterTypeCache.keys().next().value;
                if (firstKey !== undefined) eqFilterTypeCache.delete(firstKey);
            }
        }
        setEqBandFilterTypes((prev) => {
            if (prev.length === next.length && prev.every((v, i) => v === next[i])) return prev;
            return next;
        });
    }, [device.id, resolvedEqBandFilterTypes]);

    // ── Spectrum analyzer state ──
    const [eqSpectrumEnabled, setEqSpectrumEnabled] = useState(false);
    const [spectrumData, setSpectrumData] = useState<number[] | null>(null);
    const lastSpectrumRef = useRef<number[] | null>(null);

    // Poll spectrum data from the Rust FFT engine at ~20fps when enabled
    // BUG-P17 FIX: Check active flag BEFORE invoke to prevent stale result stacking on rapid toggle.
    useEffect(() => {
        if (!eqSpectrumEnabled) { setSpectrumData(null); return; }
        let active = true;
        let errorBackoff = 50; // BUG-H13 FIX: Start with 50ms, double on error, max 2000ms.
        const poll = async () => {
            try {
                const { invoke } = await import('@tauri-apps/api/core');
                while (active) {
                    if (!active) break; // Pre-invoke guard
                    try {
                        const data = await invoke<number[]>('get_spectrum_data');
                        if (!active) break;
                        errorBackoff = 50; // Reset backoff on success.
                        if (Array.isArray(data) && data.length > 0) {
                            const prev = lastSpectrumRef.current;
                            if (prev && prev.length === data.length) {
                                const smoothed = data.map((v, i) => prev[i] * 0.65 + v * 0.35);
                                lastSpectrumRef.current = smoothed;
                                setSpectrumData(smoothed);
                            } else {
                                lastSpectrumRef.current = data;
                                setSpectrumData(data);
                            }
                        } else {
                            lastSpectrumRef.current = null;
                            setSpectrumData(null);
                        }
                        await new Promise(r => setTimeout(r, 50)); // ~20fps
                    } catch {
                        // BUG-H13 FIX: Exponential backoff on repeated errors.
                        errorBackoff = Math.min(errorBackoff * 2, 2000);
                        await new Promise(r => setTimeout(r, errorBackoff));
                    }
                }
            } catch { /* silence errors when component unmounts */ }
        };
        poll();
        return () => {
            active = false;
            lastSpectrumRef.current = null;
        };
    }, [eqSpectrumEnabled]);
    // SSOT: canonical source of sample rate — consumed by EQ biquad curve renderer
    const projectSampleRate = useEngineStore(s => resolveSampleRate(s.projectSampleRate, s.transport.sample_rate));

    useEffect(() => {
        const isSamplerSurface = device.effectType === 'sampler' || device.effectType === 'instrument';
        if (!isSamplerSurface) {
            setWaveformPeaks(null);
            return;
        }
        const samplePath = device.samplePath?.trim();
        if (!samplePath) {
            // BUG-80 FIX: Clear stale waveform when device/sample changes.
            setWaveformPeaks(null);
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
    }, [device.id, device.effectType, device.samplePath]);

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

    useEqBandDragEffect({
        dragEqBand,
        eqSurfaceRef,
        resolvedEqBandFilterTypes,
        onParamChange,
        endEqBandGesture,
        setDragEqBand,
    });

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
