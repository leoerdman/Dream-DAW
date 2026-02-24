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

/**
 * Normalize automation lane values from project-model scale to UI-display scale.
 *
 * Many imported projects (e.g. Ableton) store values in native/linear units:
 *   - Gain as linear amplitude (0–1) instead of dB
 *   - Mix/Depth/Tone as 0.0–1.0 instead of 0–100%
 *   - Pan as -1..1 instead of -100..100
 *
 * This function mirrors the backend conversion in `runtime_device_import_params.rs`
 * so that the frontend reads the same scale the user sees in the knobs.
 *
 * Heuristic: if a percentage param is ≤ 1.0, it's probably a 0–1 fraction.
 * If it's already > 1.0, it's already in % and we leave it alone.
 */
function normalizeStaticLaneValueForUi(
    effectType: DeviceSlot['effectType'],
    paramName: string,
    value: number,
): number {
    if (!Number.isFinite(value)) return value;
    const key = paramName.toLowerCase();

    // ── Helper: detect likely-fraction (0–1) and rescale to 0–100% ──
    const asPct = (v: number) => (Math.abs(v) <= 1.0 ? v * 100 : v);
    // ── Helper: dB conversion for linear gain ──
    const asDb = (v: number, min: number, max: number) => {
        if (v <= 1.0e-5) return min;
        return Math.max(min, Math.min(max, 20 * Math.log10(v)));
    };

    switch (effectType) {
        case 'utility':
            if (key === 'gain') return asDb(value, -60, 24);
            if (key === 'pan') return asPct(value);
            if (key === 'width') return value <= 2.0 ? value * 100 : value;
            if (key === 'mono') return value >= 0.5 ? 1 : 0;
            break;
        case 'reverb':
            if (['size', 'damp', 'dry/wet', 'width', 'low damp', 'mod depth'].includes(key))
                return asPct(value);
            break;
        case 'chorus':
            if (['depth', 'mix', 'spread'].includes(key)) return asPct(value);
            if (key === 'fb') return Math.abs(value) <= 1.0 ? value * 100 : value;
            break;
        case 'saturator':
            if (['tone', 'mix', 'color'].includes(key)) return asPct(value);
            if (key === 'drive') return asDb(value, 0, 36);
            if (key === 'output') return asDb(value, -24, 6);
            break;
        case 'delay':
            if (['fb', 'dry/wet', 'mod depth'].includes(key)) return asPct(value);
            break;
        case 'compressor':
            if (key === 'mix') return asPct(value);
            break;
        case 'autoFilter':
            if (['res', 'depth', 'env', 'mix'].includes(key)) return asPct(value);
            break;
        case 'gate':
            if (key === 'duck') return value >= 0.5 ? 1 : 0;
            break;
        case 'limiter':
            if (key === 'auto rel') return value >= 0.5 ? 1 : 0;
            if (key === 'link') return asPct(value);
            break;
        case 'distortion':
            if (['drive', 'tone', 'mix', 'tight'].includes(key)) return asPct(value);
            if (key === 'output') return asDb(value, -24, 6);
            if (key === 'cab sim') return value >= 0.5 ? 1 : 0;
            if (key === 'bias') return Math.abs(value) <= 1.0 ? value * 100 : value;
            break;
        case 'bitcrusher':
            if (['mix', 'jitter', 'dither'].includes(key)) return asPct(value);
            if (key === 'stereo') return value >= 0.5 ? 1 : 0;
            break;
        case 'phaser':
            if (['depth', 'mix', 'spread'].includes(key)) return asPct(value);
            if (key === 'fb') return Math.abs(value) <= 1.0 ? value * 100 : value;
            break;
        case 'flanger':
            if (['depth', 'mix'].includes(key)) return asPct(value);
            if (key === 'fb') return Math.abs(value) <= 1.0 ? value * 100 : value;
            break;
        case 'autoPan':
            if (['depth', 'mix'].includes(key)) return asPct(value);
            break;
        case 'noiseMachine':
            if (key === 'level') return asDb(value, -60, 0);
            if (key === 'stereo') return asPct(value);
            if (key === 'pan') return asPct(value);
            break;
    }
    return value;
}

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
            const id = (node.id ?? '').trim();
            const name = node.name ?? 'Unknown';
            const pluginId = (node.plugin_id ?? '').trim();
            // SSOT guard: skip malformed rack nodes that cannot be addressed by
            // runtime commands (no slot id or plugin id). These nodes caused
            // "ghost" devices with unrelated controls and no DSP effect.
            if (!id || !pluginId) {
                return null;
            }
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
                const isSamplerNode = effectType === 'sampler'
                    || normalizeInternalPluginId(pluginId) === 'internal://instrument/sampler';
                if (isSamplerNode) {
                    const slotSamplePath = ((node as DeviceNodeModel).sampler_config?.sample_path ?? '').trim();
                    if (slotSamplePath) return slotSamplePath;
                    // Fallback for current project snapshots where sampler sample state
                    // is stored on track.sampler instead of instrument node payload.
                    return (selectedTrack.sampler?.sample_path ?? '').trim();
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
