import { useMemo, useState, useCallback, useRef, useEffect } from 'react';
import { useEngineStore } from '@/shared/stores/useEngineStore';
import { useShallow } from 'zustand/react/shallow';
import type { DeviceSlot } from '../model/types';
import type { RackInfo } from '../model/types';
import { getInternalPluginById, normalizeInternalPluginId, waveformIndexFromSamplePath } from '@/shared/lib/internalPlugins';
import { getEffectTypeByPluginId } from '@/shared/config/pluginManifest';
import { EFFECT_PARAM_CATALOG, INTERNAL_EFFECT_TYPE_BY_PLUGIN_ID, internalParamIdForControl } from '../model/deviceRackCatalog';
import { dbToMeterNorm } from '@/shared/lib/meterManifest';
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
    sidechain_send_mode?: string;
    supports_sidechain_input?: boolean;
    sampleRackConfig?: SampleRackConfig;
    sample_rack?: SampleRackConfig;
    sampler_config?: { sample_path?: string };
    /** ENTERPRISE: Rack metadata from trackAdapter (present when device is a rack). */
    rack?: RackInfo;
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
// BUG-006 FIX: Deep-compare `rack` fields instead of reference equality.
// Reference comparison always fails because the store creates new rack objects.
function isRackInfoEqual(a: DeviceSlot['rack'], b: DeviceSlot['rack']): boolean {
    if (a === b) return true;
    if (!a || !b) return false;
    if (a.rack_type !== b.rack_type) return false;
    if (a.is_expanded !== b.is_expanded) return false;
    if (a.chains.length !== b.chains.length) return false;
    for (let i = 0; i < a.chains.length; i++) {
        const ca = a.chains[i], cb = b.chains[i];
        if (ca.id !== cb.id || ca.name !== cb.name || ca.deviceCount !== cb.deviceCount
            || ca.is_solo !== cb.is_solo || ca.is_disabled !== cb.is_disabled
            || Math.abs(ca.volume - cb.volume) > 1e-6 || Math.abs(ca.pan - cb.pan) > 1e-6) return false;
    }
    if (a.macro_controls.length !== b.macro_controls.length) return false;
    for (let i = 0; i < a.macro_controls.length; i++) {
        const ma = a.macro_controls[i], mb = b.macro_controls[i];
        if (ma.name !== mb.name || Math.abs(ma.value - mb.value) > 1e-6) return false;
    }
    return true;
}

function isDeviceSlotEqual(a: DeviceSlot, b: DeviceSlot): boolean {
    if (a === b) return true;
    if (a.id !== b.id || a.isBypassed !== b.isBypassed || a.isEnabled !== b.isEnabled) return false;
    if (a.name !== b.name || a.pluginId !== b.pluginId || a.effectType !== b.effectType) return false;
    if (a.samplePath !== b.samplePath || a.supportsSidechain !== b.supportsSidechain || a.sidechainSourceTrackId !== b.sidechainSourceTrackId || a.sidechainSendMode !== b.sidechainSendMode) return false;
    // BUG-006 FIX: Deep structural comparison for rack metadata.
    if (!isRackInfoEqual(a.rack, b.rack)) return false;
    // BUG-004 FIX: Compare per-slot VU levels.
    if (Math.abs((a.vuLevel ?? 0) - (b.vuLevel ?? 0)) > 1e-4) return false;
    if (Math.abs((a.pluginMetric ?? 0) - (b.pluginMetric ?? 0)) > 1e-4) return false;
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
    // PERF-OPT: Read only tracksById and trackIds via selector. `meters` was
    // previously included here, causing the entire DeviceRack chain to rebuild
    // at ~30fps because `meters` reference changes on every telemetry tick.
    // Now meters are read imperatively via `useEngineStore.getState()` inside
    // the `buildChain` callback where they're actually needed.
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
    const trackIndex = trackIds.indexOf(selectedTrackId);
    // PERF-OPT: Meters are now read imperatively from getState() instead of
    // being part of the selector (which caused ~30fps re-renders of the entire
    // DeviceRack). The `buildChain` callback reads `trackMetrics` from getState()
    // when it actually needs them. The `inLevel/outLevel` values returned below
    // are computed from getState() at call time — consumers that need live
    // metering should use subscription-based components (MixerChannelMeters pattern).
    const getMeters = useCallback(() => useEngineStore.getState().meters, []);
    const metersNow = getMeters();
    const meterPair = isMaster ? null : (trackIndex >= 0 ? metersNow.tracks[trackIndex] ?? null : null);
    const trackMetrics = isMaster
        ? metersNow.master_plugin_metrics
        : (trackIndex >= 0 ? metersNow.track_plugin_metrics?.[trackIndex] ?? null : null);
    const inLevelL = isMaster
        ? dbToMeterNorm(metersNow.master_left.peak)
        : meterPair ? dbToMeterNorm(meterPair[0].peak) : 0;
    const inLevelR = isMaster
        ? dbToMeterNorm(metersNow.master_right.peak)
        : meterPair ? dbToMeterNorm(meterPair[1].peak) : 0;
    // BUG-014 FIX: outLevel is intentionally the same as inLevel here because
    // per-slot output metering is handled via trackMetrics[slotIndex] (pluginMetric).
    // The track-level out level is used only as a fallback when pluginMetric is unavailable.
    const outLevelL = inLevelL;
    const outLevelR = inLevelR;
    // BUG-015 FIX: O(1) master track lookup — find master ID once, not O(N) on every render.
    const masterTrackId = useMemo(
        () => trackIds.find((id) => tracksById[id]?.track_type === 'Master') ?? null,
        [trackIds, tracksById],
    );
    const masterProjectTrack = masterTrackId ? (tracksById[masterTrackId] ?? null) : null;
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
        const rawEffects = selectedTrack.effects ?? [];
        const instrumentNodes = rawEffects.filter((node) => {
            const pluginId = normalizeInternalPluginId(node.plugin_id ?? '') ?? node.plugin_id ?? '';
            const effectType = getEffectTypeByPluginId(pluginId) ?? INTERNAL_EFFECT_TYPE_BY_PLUGIN_ID[pluginId];
            return effectType === 'instrument' || effectType === 'sampler' || effectType === 'waveSynth' || effectType === 'sample_rack';
        });
        const effectNodes = rawEffects.filter((node) => !instrumentNodes.includes(node));

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
            ...instrumentNodes,
            ...effectNodes,
        ];
        const nextSlots: Record<string, DeviceSlot> = {};
        const chain = nodes.map((node, slotIndex): DeviceSlot | null => {
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
                    // BUG-024 FIX: Each slot carries its own sampler_config.sample_path.
                    // Previously fell back to selectedTrack.sampler?.sample_path which is the
                    // track-level config — SSOT violation when multiple sampler devices exist.
                    return ((node as DeviceNodeModel).sampler_config?.sample_path ?? '').trim();
                }
                return '';
            })();
            let waveformIndex: number | undefined;
            if (samplePath) {
                waveformIndex = waveformIndexFromSamplePath(samplePath);
            }
            // BUG-004 FIX: Per-slot VU — use pluginMetric for the specific slot
            // instead of sharing the track-level output meter across all devices.
            const slotMetric = trackMetrics ? (trackMetrics[slotIndex] ?? 0.0) : 0.0;
            const slotVuLevel = isEnabled ? slotMetric : 0;

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
                sidechainSendMode: ((node as DeviceNodeModel).sidechain_send_mode ?? 'pre_fx') as DeviceSlot['sidechainSendMode'],
                supportsSidechain,
                waveformIndex,
                samplePath,
                sampleRackConfig: node.sampleRackConfig,
                // BUG-004 FIX: Per-slot VU metering from pluginMetric instead of
                // shared track output. Each device slot shows its own activity.
                vuLevel: slotVuLevel,
                vuLevelL: slotVuLevel,
                vuLevelR: slotVuLevel,
                pluginMetric: slotMetric,
                // ENTERPRISE: Preserve rack metadata for UI rendering.
                rack: (node as DeviceNodeModel).rack,
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
        // BUG-004 FIX: Removed outLevel/outLevelL/outLevelR from deps — per-slot VU
        // now computed from trackMetrics directly inside buildChain.
    }, [selectedTrack, localBypass, localParams, staticLaneValueByParamId, trackMetrics]);
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
