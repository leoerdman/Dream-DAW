import { useMemo, useState, useCallback, useRef, useEffect } from 'react';
import { useEngineStore } from '@/shared/stores/useEngineStore';
import { useShallow } from 'zustand/react/shallow';
import type { DeviceSlot } from '../model/types';
import { getInternalPluginById, normalizeInternalPluginId, waveformIndexFromSamplePath } from '@/shared/lib/internalPlugins';
import { getEffectTypeByPluginId } from '@/shared/config/pluginManifest';
import { EFFECT_PARAM_CATALOG, INTERNAL_EFFECT_TYPE_BY_PLUGIN_ID, internalParamIdForControl } from '../model/deviceRackCatalog';
import type { PluginParam } from '../model/types';
import { normalizeStaticLaneValueForUi } from './useDeviceRackParamNormalize';
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
// BUG-M02 FIX: Custom equality to avoid recreating DeviceSlot objects blindly
function isDeviceSlotEqual(a: DeviceSlot, b: DeviceSlot): boolean {
    if (a === b) return true;
    if (a.id !== b.id || a.isBypassed !== b.isBypassed || a.isEnabled !== b.isEnabled) return false;
    if (a.name !== b.name || a.pluginId !== b.pluginId || a.effectType !== b.effectType) return false;
    if (a.samplePath !== b.samplePath || a.supportsSidechain !== b.supportsSidechain || a.sidechainSourceTrackId !== b.sidechainSourceTrackId) return false;
    if (a.params.length !== b.params.length) return false;
    for (let i = 0; i < a.params.length; i++) {
        if (a.params[i].name !== b.params[i].name || Math.abs(a.params[i].value - b.params[i].value) > 1e-6) return false;
    }
    return true;
}

export function useDeviceRackCore(selectedTrackId: string) {
    const prevSlotsRef = useRef<Record<string, DeviceSlot>>({});
    const [localBypassByTrack, setLocalBypassByTrack] = useState<Record<string, Record<string, boolean>>>({});
    const [localParamsByTrack, setLocalParamsByTrack] = useState<Record<string, Record<string, number>>>({});
    const [selectedDeviceIdsByTrack, setSelectedDeviceIdsByTrack] = useState<Record<string, string[]>>({});
    const [inlineSettingsOpenByTrack, setInlineSettingsOpenByTrack] = useState<Record<string, Record<string, boolean>>>({});
    const { tracksById, trackIds } = useEngineStore(useShallow((s) => ({
        tracksById: s.tracks.byId,
        trackIds: s.tracks.allIds,
    })));

    // BUG-S02-S04 FIX: Prune state for deleted tracks to prevent dictionary memory leaks.
    useEffect(() => {
        const activeIds = new Set(trackIds);
        const prune = <T,>(prev: Record<string, T>): Record<string, T> => {
            let changed = false;
            const next = { ...prev };
            for (const key of Object.keys(next)) {
                if (key !== 'master' && !activeIds.has(key)) {
                    delete next[key];
                    changed = true;
                }
            }
            return changed ? next : prev;
        };
        setLocalBypassByTrack(prune);
        setLocalParamsByTrack(prune);
        setSelectedDeviceIdsByTrack(prune);
        setInlineSettingsOpenByTrack(prune);
    }, [trackIds]);

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
        const nextSlots: Record<string, DeviceSlot> = {};
        const chain = nodes.map((node): DeviceSlot | null => {
            const id = (node.id ?? '').trim();
            const name = node.name ?? 'Unknown';
            const pluginId = (node.plugin_id ?? '').trim();
            if (!id || !pluginId) {
                return null;
            }
            const isBypassed = localBypass[id] ?? (node.is_bypassed ?? false);
            const isEnabled = !isBypassed;
            const isMissing = pluginId.startsWith('missing://');
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
                        const normalizedStaticValue = typeof staticValue === 'number' && Number.isFinite(staticValue)
                            ? normalizeStaticLaneValueForUi(effectType, paramDef.name, staticValue)
                            : undefined;
                        const fallbackValue = Number.isFinite(paramDef.value)
                            ? paramDef.value
                            : (Number.isFinite(paramDef.defaultValue) ? paramDef.defaultValue : paramDef.min);
                        return {
                            ...paramDef,
                            value: localValue
                                ?? normalizedStaticValue
                                ?? fallbackValue,
                        };
                    });
                }
            }
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
                const isSamplerNode = effectType === 'sampler'
                    || normalizeInternalPluginId(pluginId) === 'internal://instrument/sampler';
                if (isSamplerNode) {
                    const slotSamplePath = ((node as DeviceNodeModel).sampler_config?.sample_path ?? '').trim();
                    if (slotSamplePath) return slotSamplePath;
                    return (selectedTrack.sampler?.sample_path ?? '').trim();
                }
                return '';
            })();
            let waveformIndex: number | undefined;
            if (samplePath) {
                waveformIndex = waveformIndexFromSamplePath(samplePath);
            }
            const rawSlot: DeviceSlot = {
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
                sidechainSourceTrackId,
                supportsSidechain,
                waveformIndex,
                samplePath,
                sampleRackConfig: node.sampleRackConfig,
            };

            const prevSlot = prevSlotsRef.current[id];
            if (prevSlot && isDeviceSlotEqual(prevSlot, rawSlot)) {
                nextSlots[id] = prevSlot;
                return prevSlot;
            }
            nextSlots[id] = rawSlot;
            return rawSlot;
        }).filter((s): s is DeviceSlot => s !== null);

        prevSlotsRef.current = nextSlots;
        return chain;
    }, [selectedTrack, localBypass, localParams, staticLaneValueByParamId]);
    return {
        selectedTrack,
        isMaster,
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
