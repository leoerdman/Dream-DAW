import { useMemo, useState, useEffect } from 'react';
import { useEngineStore } from '@/shared/stores/useEngineStore';
import { useShallow } from 'zustand/react/shallow';
import type { DeviceSlot } from '../model/types';
import { getInternalPluginById, normalizeInternalPluginId, waveformIndexFromSamplePath } from '@/shared/lib/internalPlugins';
import { dbToMeterNorm } from '@/shared/lib/meterManifest';
import { EFFECT_PARAM_CATALOG, INTERNAL_EFFECT_TYPE_BY_PLUGIN_ID, internalParamIdForControl } from '../model/deviceRackCatalog';
import type { PluginParam } from '../model/types';

export function useDeviceRackCore(selectedTrackId: string) {
    const [localBypass, setLocalBypass] = useState<Record<string, boolean>>({});
    const [localParams, setLocalParams] = useState<Record<string, number>>({});
    const [selectedDeviceIds, setSelectedDeviceIds] = useState<string[]>([]);
    const [inlineSettingsOpen, setInlineSettingsOpen] = useState<Record<string, boolean>>({});

    const { tracksById, trackIds, meters } = useEngineStore(useShallow((s) => ({
        tracksById: s.tracks.byId,
        trackIds: s.tracks.allIds,
        meters: s.meters,
    })));

    // SSOT: Clear local state on track change
    useEffect(() => {
        setLocalBypass({});
        setLocalParams({});
        setSelectedDeviceIds([]);
    }, [selectedTrackId]);

    const isMaster = selectedTrackId === 'master';
    const trackIndex = trackIds.indexOf(selectedTrackId);
    const meterPair = isMaster ? null : (trackIndex >= 0 ? meters.tracks[trackIndex] : null);

    const inLevelL = isMaster
        ? dbToMeterNorm(meters.master_left.peak)
        : meterPair ? dbToMeterNorm(meterPair[0].peak) : 0;
    const inLevelR = isMaster
        ? dbToMeterNorm(meters.master_right.peak)
        : meterPair ? dbToMeterNorm(meterPair[1].peak) : 0;
    const outLevelL = inLevelL;
    const outLevelR = inLevelR;
    const outLevel = Math.max(outLevelL, outLevelR);

    const masterProjectTrack = useMemo(
        () => trackIds.map((id) => tracksById[id]).find((t) => t?.track_type === 'Master') ?? null,
        [trackIds, tracksById],
    );
    const selectedTrack = isMaster ? masterProjectTrack : (tracksById[selectedTrackId] ?? null);

    const staticLaneValueByParamId = useMemo(() => {
        const map = new Map<string, number>();
        const lanes = selectedTrack?.automation_lanes ?? [];
        for (const lane of lanes) {
            const paramId = (lane.param_id ?? '').trim();
            if (!paramId) continue;
            const points = lane.points ?? [];
            if (points.length === 0) continue;
            const last = points[points.length - 1];
            const value = Number(last?.value ?? 0);
            if (Number.isFinite(value)) map.set(paramId.toLowerCase(), value);
        }
        return map;
    }, [selectedTrack]);

    const buildChain = (externalParamsBySlotId: Record<string, PluginParam[]>) => {
        if (!selectedTrack) return [];

        const nodes = [
            ...(selectedTrack.sample_rack ? [{
                id: `sample-rack-${selectedTrack.id}`,
                name: 'Sample Rack',
                type: 'SampleRack',
                plugin_id: 'internal://instrument/sample-rack',
                is_bypassed: false,
                source: 'internal',
                sampleRackConfig: selectedTrack.sample_rack,
            }] : []),
            ...(!selectedTrack.sample_rack && selectedTrack.instrument ? [selectedTrack.instrument] : []),
            ...(selectedTrack.effects ?? []),
        ];

        return nodes.map((node: any): DeviceSlot | null => {
            const id = node.id ?? '';
            const name = node.name ?? 'Unknown';
            const pluginId = node.plugin_id ?? '';
            const isBypassed = localBypass[id] ?? (node.is_bypassed ?? false);
            const isEnabled = !isBypassed;

            const isVst = pluginId.startsWith('vst://') || pluginId.startsWith('au://') || pluginId.startsWith('clap://');
            const isMissing = pluginId.startsWith('missing://');

            const normalizedId = normalizeInternalPluginId(pluginId);
            const internalPlugin = normalizedId ? getInternalPluginById(normalizedId) : null;
            const isInternalEffect = !!internalPlugin;
            const effectType = (INTERNAL_EFFECT_TYPE_BY_PLUGIN_ID[normalizedId ?? pluginId] ?? 'vst') as DeviceSlot['effectType'];

            let params: PluginParam[] = [];
            let source: 'internal' | 'vst' | 'missing' = 'internal';

            if (isMissing) {
                source = 'missing';
            } else if (isVst) {
                source = 'vst';
                const vstParams = externalParamsBySlotId[id];
                if (vstParams) {
                    params = vstParams.map((p) => ({
                        ...p,
                        value: localParams[`${id}:${p.name}`] ?? p.value,
                    }));
                }
            } else if (isInternalEffect && effectType) {
                const catalog = EFFECT_PARAM_CATALOG[effectType];
                if (catalog) {
                    params = catalog.map((paramDef) => {
                        const localKey = `${id}:${paramDef.name}`;
                        const localValue = localParams[localKey];
                        const paramId = internalParamIdForControl(effectType, paramDef.name);
                        const scopedParamId = `slot:${id}:${paramId}`;
                        const staticValue = staticLaneValueByParamId.get(scopedParamId.toLowerCase());
                        return {
                            ...paramDef,
                            value: localValue ?? staticValue ?? paramDef.defaultValue,
                        };
                    });
                }
            }

            const vuLevel = isEnabled ? outLevel : 0;
            const vuLevelL = isEnabled ? outLevelL : 0;
            const vuLevelR = isEnabled ? outLevelR : 0;

            let displayName = name;
            if (internalPlugin) displayName = internalPlugin.name ?? name;

            const sidechainSourceTrackId = node.sidechain_source_track_id ?? null;
            const supportsSidechain = node.supports_sidechain_input ?? false;

            let waveformIndex: number | undefined;
            if (effectType === 'sampler' || node.type === 'SampleRack') {
                const samplePath = (() => {
                    const rack = node.sampleRackConfig as { pads?: Array<{ sample_path?: string }> } | undefined;
                    if (rack && Array.isArray(rack.pads) && rack.pads.length > 0) return rack.pads[0]?.sample_path ?? '';
                    const inst = selectedTrack?.instrument as { sampler_config?: { sample_path?: string } } | null | undefined;
                    return inst?.sampler_config?.sample_path ?? '';
                })();
                waveformIndex = waveformIndexFromSamplePath(samplePath);
            }

            return {
                id,
                name: displayName,
                pluginId,
                isEnabled,
                isBypassed,
                isVst,
                isMissing,
                effectType,
                source,
                params,
                vuLevel,
                vuLevelL,
                vuLevelR,
                sidechainSourceTrackId,
                supportsSidechain,
                waveformIndex,
                sampleRackConfig: node.sampleRackConfig,
            };
        }).filter((s): s is DeviceSlot => s !== null);
    };

    return {
        selectedTrack,
        isMaster,
        inLevelL,
        inLevelR,
        outLevelL,
        outLevelR,
        localBypass,
        setLocalBypass,
        localParams,
        setLocalParams,
        selectedDeviceIds,
        setSelectedDeviceIds,
        inlineSettingsOpen,
        setInlineSettingsOpen,
        buildChain,
    };
}
