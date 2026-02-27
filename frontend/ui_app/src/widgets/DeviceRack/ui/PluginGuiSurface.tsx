import { useMemo, useState, useCallback, useEffect, useRef } from 'react';
import * as engineApi from '@/shared/api/engine';
import { useEngineStore } from '@/shared/stores/useEngineStore';
import { resolveSampleRate } from '@/shared/lib/audioMath';
import { downsamplePeaks, selectFinestMipLevel } from '@/shared/lib/waveformUtils';
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

    const projectSampleRate = useEngineStore(s => resolveSampleRate(s.projectSampleRate, s.transport.sample_rate));

    const [eqSpectrumEnabled, setEqSpectrumEnabled] = useState(false);

    useEffect(() => {
        const isSamplerSurface = device.effectType === 'sampler' || device.effectType === 'instrument';
        if (!isSamplerSurface) {
            setWaveformPeaks(null);
            return;
        }
        const samplePath = device.samplePath?.trim();
        if (!samplePath) {
            setWaveformPeaks(null);
            return;
        }
        let cancelled = false;
        engineApi.getWaveformPeaksBinary(samplePath)
            .then((wf) => {
                if (cancelled) return;
                const rawPeaks = selectFinestMipLevel(wf.mip_levels);
                if (rawPeaks.length === 0) {
                    setWaveformPeaks(null);
                    return;
                }
                setWaveformPeaks(downsamplePeaks(rawPeaks, 960));
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

    // ── EQ Performance: local drag overlay ──────────────────────────
    // During band drag, param changes are applied to a local Map for
    // zero-latency visual feedback. The IPC call still fires normally.
    const pendingDragOverrides = useRef<Map<string, number>>(new Map());
    const [dragRenderTick, setDragRenderTick] = useState(0);

    // When drag ends, clear local overrides (store state will have caught up).
    const prevDragBandRef = useRef<number | null>(null);
    if (prevDragBandRef.current !== null && dragEqBand === null) {
        pendingDragOverrides.current.clear();
    }
    prevDragBandRef.current = dragEqBand;

    const onParamChangeLocal = useCallback((paramName: string, value: number) => {
        if (dragEqBand !== null) {
            pendingDragOverrides.current.set(paramName.toLowerCase(), value);
            setDragRenderTick((t) => t + 1);
        }
        onParamChange(paramName, value);
    }, [dragEqBand, onParamChange]);

    // Merge device.params with local drag overrides for instant curve feedback.
    const mergedEqParams = useMemo(() => {
        if (pendingDragOverrides.current.size === 0) return device.params;
        return device.params.map((p) => {
            const override = pendingDragOverrides.current.get(p.name.toLowerCase());
            return override !== undefined ? { ...p, value: override } : p;
        });
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [device.params, dragRenderTick]);

    useEqBandDragEffect({
        dragEqBand,
        eqSurfaceRef,
        resolvedEqBandFilterTypes,
        onParamChange: onParamChangeLocal,
        endEqBandGesture,
        setDragEqBand,
    });

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
                spectrumData={null}
                selectedEqBand={selectedEqBand}
                setSelectedEqBand={setSelectedEqBand}
                eqContextMenu={eqContextMenu}
                setEqContextMenu={setEqContextMenu}
                eqSpectrumEnabled={eqSpectrumEnabled}
                setEqSpectrumEnabled={setEqSpectrumEnabled}
                beginEqBandGesture={beginEqBandGesture}
                onParamChange={onParamChangeLocal}
                mergedParams={mergedEqParams}
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
