import { useMemo, useState, useCallback } from 'react';
import { useEngineStore } from '@/shared/stores/useEngineStore';
import { useShallow } from 'zustand/react/shallow';
import type { DeviceSlot } from '../model/types';
import { getInternalPluginById, normalizeInternalPluginId, waveformIndexFromSamplePath } from '@/shared/lib/internalPlugins';
import { getEffectTypeByPluginId } from '@/shared/config/pluginManifest';
import { dbToMeterNorm } from '@/shared/lib/meterManifest';
import { EFFECT_PARAM_CATALOG, INTERNAL_EFFECT_TYPE_BY_PLUGIN_ID, internalParamIdForControl } from '../model/deviceRackCatalog';
import type { PluginParam } from '../model/types';

type AutomationLanePoint = { value?: number };
type AutomationLane = { param_id?: string; points?: AutomationLanePoint[] };
type SampleRackPad = { sample_path?: string };
type SampleRackConfig = { pads?: SampleRackPad[] };

type DeviceNodeModel = {
    id?: string;
    name?: string;
    type?: string;
    plugin_id?: string;
    is_bypassed?: boolean;
    sidechain_source_track_id?: string | null;
    supports_sidechain_input?: boolean;
    sampleRackConfig?: SampleRackConfig;
    sample_rack?: SampleRackConfig;
    sampler_config?: { sample_path?: string };
};

type SelectedTrackModel = {
    id: string;
    name?: string;
    track_type: string;
    automation_lanes?: AutomationLane[];
    sampler?: { sample_path?: string } | null;
    sample_rack?: SampleRackConfig;
    instrument?: DeviceNodeModel | null;
    effects?: DeviceNodeModel[];
} | null;

export function useDeviceRackCore(selectedTrackId: string) {
    const [localBypassByTrack, setLocalBypassByTrack] = useState<Record<string, Record<string, boolean>>>({});
    const [localParamsByTrack, setLocalParamsByTrack] = useState<Record<string, Record<string, number>>>({});
    const [selectedDeviceIdsByTrack, setSelectedDeviceIdsByTrack] = useState<Record<string, string[]>>({});
    const [inlineSettingsOpenByTrack, setInlineSettingsOpenByTrack] = useState<Record<string, Record<string, boolean>>>({});

    const { tracksById, trackIds, meters } = useEngineStore(useShallow((s) => ({
        tracksById: s.tracks.byId,
        trackIds: s.tracks.allIds,
        meters: s.meters,
    })));

    const localBypass = useMemo(
        () => localBypassByTrack[selectedTrackId] ?? {},
        [localBypassByTrack, selectedTrackId],
    );
    const localParams = useMemo(
        () => localParamsByTrack[selectedTrackId] ?? {},
        [localParamsByTrack, selectedTrackId],
    );
    const selectedDeviceIds = useMemo(
        () => selectedDeviceIdsByTrack[selectedTrackId] ?? [],
        [selectedDeviceIdsByTrack, selectedTrackId],
    );
    const inlineSettingsOpen = useMemo(
        () => inlineSettingsOpenByTrack[selectedTrackId] ?? {},
        [inlineSettingsOpenByTrack, selectedTrackId],
    );

    const setLocalBypass: React.Dispatch<React.SetStateAction<Record<string, boolean>>> = useCallback((update) => {
        setLocalBypassByTrack((prev) => {
            const current = prev[selectedTrackId] ?? {};
            const nextValue = typeof update === 'function'
                ? update(current)
                : update;
            if (nextValue === current) return prev;
            return { ...prev, [selectedTrackId]: nextValue };
        });
    }, [selectedTrackId]);

    const setLocalParams: React.Dispatch<React.SetStateAction<Record<string, number>>> = useCallback((update) => {
        setLocalParamsByTrack((prev) => {
            const current = prev[selectedTrackId] ?? {};
            const nextValue = typeof update === 'function'
                ? update(current)
                : update;
            if (nextValue === current) return prev;
            return { ...prev, [selectedTrackId]: nextValue };
        });
    }, [selectedTrackId]);

    const setSelectedDeviceIds: React.Dispatch<React.SetStateAction<string[]>> = useCallback((update) => {
        setSelectedDeviceIdsByTrack((prev) => {
            const current = prev[selectedTrackId] ?? [];
            const nextValue = typeof update === 'function'
                ? update(current)
                : update;
            if (nextValue === current) return prev;
            return { ...prev, [selectedTrackId]: nextValue };
        });
    }, [selectedTrackId]);

    const setInlineSettingsOpen: React.Dispatch<React.SetStateAction<Record<string, boolean>>> = useCallback((update) => {
        setInlineSettingsOpenByTrack((prev) => {
            const current = prev[selectedTrackId] ?? {};
            const nextValue = typeof update === 'function'
                ? update(current)
                : update;
            if (nextValue === current) return prev;
            return { ...prev, [selectedTrackId]: nextValue };
        });
    }, [selectedTrackId]);

    const isMaster = selectedTrackId === 'master';
    const trackIndex = trackIds.indexOf(selectedTrackId);
    // BUG-23 FIX: Guard against trackIndex === -1 when selectedTrackId is not in trackIds.
    const meterPair = isMaster ? null : (trackIndex >= 0 ? meters.tracks[trackIndex] ?? null : null);

    const inLevelL = isMaster
        ? dbToMeterNorm(meters.master_left.peak)
        : meterPair ? dbToMeterNorm(meterPair[0].peak) : 0;
    const inLevelR = isMaster
        ? dbToMeterNorm(meters.master_right.peak)
        : meterPair ? dbToMeterNorm(meterPair[1].peak) : 0;
    // Note: outLevel currently aliases inLevel. Separate pre/post metering not yet implemented.
    const outLevelL = inLevelL;
    const outLevelR = inLevelR;
    const outLevel = Math.max(outLevelL, outLevelR);

    const masterProjectTrack = useMemo(
        () => trackIds.map((id) => tracksById[id]).find((t) => t?.track_type === 'Master') ?? null,
        [trackIds, tracksById],
    );
    const selectedTrack = (isMaster ? masterProjectTrack : (tracksById[selectedTrackId] ?? null)) as SelectedTrackModel;

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

    // BUG-21 FIX: Wrap in useCallback to prevent recreation every render.
    const buildChain = useCallback((externalParamsBySlotId: Record<string, PluginParam[]>) => {
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
                sidechain_source_track_id: null,
                supports_sidechain_input: false,
            }] : []),
            ...(!selectedTrack.sample_rack && selectedTrack.instrument ? [selectedTrack.instrument] : []),
            ...(selectedTrack.effects ?? []),
        ];

        return nodes.map((node): DeviceSlot | null => {
            const id = node.id ?? '';
            const name = node.name ?? 'Unknown';
            const pluginId = node.plugin_id ?? '';
            const isBypassed = localBypass[id] ?? (node.is_bypassed ?? false);
            const isEnabled = !isBypassed;

            const isMissing = pluginId.startsWith('missing://');
            // External = any plugin that is NOT internal:// and NOT missing://.
            // Covers: vst://, au://, clap://, path-based IDs (/Library/.../*.vst3), etc.
            const isVst = !pluginId.startsWith('internal://') && !isMissing && pluginId.length > 0;

            const normalizedId = normalizeInternalPluginId(pluginId);
            const internalPlugin = normalizedId ? getInternalPluginById(normalizedId) : null;
            const isInternalEffect = !!internalPlugin;
            const effectType = (
                getEffectTypeByPluginId(normalizedId ?? pluginId)
                ?? INTERNAL_EFFECT_TYPE_BY_PLUGIN_ID[normalizedId ?? pluginId]
                ?? 'vst'
            ) as DeviceSlot['effectType'];

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
                        const fallbackValue = Number.isFinite(paramDef.value)
                            ? paramDef.value
                            : (Number.isFinite(paramDef.defaultValue) ? paramDef.defaultValue : paramDef.min);
                        return {
                            ...paramDef,
                            value: localValue ?? staticValue ?? fallbackValue,
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

            const samplePath = (() => {
                if (node.type === 'SampleRack') {
                    const rack = node.sampleRackConfig;
                    if (rack && Array.isArray(rack.pads) && rack.pads.length > 0) {
                        return (rack.pads[0]?.sample_path ?? '').trim();
                    }
                    return '';
                }
                if (effectType === 'sampler') {
                    return (
                        selectedTrack?.sampler?.sample_path
                        ?? node.sampler_config?.sample_path
                        ?? selectedTrack?.instrument?.sampler_config?.sample_path
                        ?? ''
                    ).trim();
                }
                return '';
            })();

            let waveformIndex: number | undefined;
            if (samplePath) {
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
                samplePath,
                sampleRackConfig: node.sampleRackConfig,
            };
        }).filter((s): s is DeviceSlot => s !== null);
    }, [selectedTrack, localBypass, localParams, staticLaneValueByParamId, outLevel, outLevelL, outLevelR]);

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
