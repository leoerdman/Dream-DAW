/**
 * useDeviceRackLogic — All state, effects, and callbacks for DeviceRack.
 *
 * Extracted from DeviceRack.tsx to enforce single-responsibility:
 *   • DeviceRack.tsx  → pure JSX rendering (~400 LOC)
 *   • useDeviceRackLogic → business logic, store subscriptions, effects (~1200 LOC)
 *
 * @module widgets/DeviceRack/model/useDeviceRackLogic
 */

import { useMemo, useState, useCallback, useEffect, useRef } from 'react';
import { useEngineStore } from '@/shared/stores/useEngineStore';
import { useDragStore } from '@/shared/stores/useDragStore';
import { useShallow } from 'zustand/react/shallow';
import * as engineApi from '@/shared/api/engineApi';
import { useStatusStore } from '@/shared/stores/useStatusStore';
import { useAutomationStore } from '@/shared/stores/useAutomationStore';
import type { DeviceSlot, PluginParam, QuickPreset } from '../model/types';
import {
    RUNTIME_PARAM_INDEX_BY_EFFECT,
    internalParamIdForControl,
    EFFECT_PARAM_CATALOG,
    resolveQuickPresetParams,
    clampAndSnapParamValue,
    randomParamValue,
    defaultParamForReset,
} from '../model/deviceRackCatalog';
import type { BrowserDragItem } from '@/shared/lib/arrangementTypes';
import { canDropInZone } from '@/shared/lib/dndMatrix';
import {
    getInternalPluginById,
    normalizeInternalPluginId,
    waveformIndexFromSamplePath,
} from '@/shared/lib/internalPlugins';
import { linearToMeterNorm, dbToMeterNorm } from '@/shared/lib/meterUtils';
import { normalizePickedPath, errorMessage } from '@/shared/lib/helpers';

// ── Types ────────────────────────────────────────────────────────────────

type AdaptiveSender = {
    send: (value: number, pushUndoStep: boolean) => void;
    cancel: () => void;
};

type PendingGestureCommit = {
    source: 'internal' | 'vst';
    trackId: string;
    deviceId: string;
    paramName: string;
    value: number;
    paramIndex?: number;
};

type AutoCtxMenuState = {
    x: number;
    y: number;
    paramName: string;
    deviceId: string;
} | null;

export interface DeviceRackLogic {
    // ── Data ──
    chain: DeviceSlot[];
    selectedTrack: ReturnType<typeof useEngineStore.getState>['projectTracks'][number] | null;
    selectedTrackId: string;
    selectedDeviceIds: string[];
    isMaster: boolean;
    inLevelL: number;
    inLevelR: number;
    outLevelL: number;
    outLevelR: number;
    isDropActive: boolean;
    draggingItem: ReturnType<typeof useDragStore.getState>['draggingItem'];
    sidechainOptions: Array<{ id: string; name: string }>;
    pluginCapability: Record<string, { supported: boolean; reason?: string }>;
    pluginRuntimeBySlot: Record<string, engineApi.PluginSlotRuntimeStatus>;
    inlineSettingsOpen: Record<string, boolean>;
    paramSnapshotsByDevice: Record<string, { A?: Record<string, number>; B?: Record<string, number>; active?: 'A' | 'B' }>;
    openEditorsByTrack: Record<string, Set<string>>;
    autoCtxMenu: AutoCtxMenuState;
    automationLanes: ReturnType<typeof useAutomationStore.getState>['lanes'];

    // ── Refs ──
    rackRef: React.RefObject<HTMLDivElement | null>;
    activeParamGesturesRef: React.RefObject<Set<string>>;

    // ── Handlers ──
    toggleDevice: (device: DeviceSlot) => void;
    selectDevice: (deviceId: string, additive: boolean) => void;
    setPluginParam: (deviceId: string, paramName: string, value: number) => void;
    sendInternalParam: (
        device: DeviceSlot,
        paramName: string,
        value: number,
        options?: { gestureKey?: string; forcePushUndo?: boolean },
    ) => void;
    beginParamGesture: (deviceId: string, paramName: string, gestureGroupId?: string) => void;
    endParamGesture: (deviceId: string, paramName: string) => void;
    applyQuickPreset: (device: DeviceSlot, preset: QuickPreset) => void;
    randomizeInternalPluginParams: (device: DeviceSlot) => void;
    resetInternalPluginParams: (device: DeviceSlot) => void;
    storeParamSnapshot: (device: DeviceSlot, slot: 'A' | 'B') => void;
    recallParamSnapshot: (device: DeviceSlot, slot: 'A' | 'B') => void;
    toggleParamSnapshot: (device: DeviceSlot) => void;
    applyQuickUtilityScene: (device: DeviceSlot, scene: 'center' | 'mono' | 'wide') => void;
    ensureSlotRuntimeActive: (slotId: string) => Promise<engineApi.PluginSlotRuntimeStatus | null>;
    setPluginSidechainSource: (slotId: string, sourceTrackId: string) => Promise<void>;
    handleParamContextMenu: (e: React.MouseEvent, paramName: string, deviceId: string) => void;
    setAutoCtxMenu: React.Dispatch<React.SetStateAction<AutoCtxMenuState>>;
    setInlineSettingsOpen: React.Dispatch<React.SetStateAction<Record<string, boolean>>>;
    addAutomationLane: ReturnType<typeof useAutomationStore.getState>['addLane'];
    removeAutomationLane: ReturnType<typeof useAutomationStore.getState>['removeLane'];
    toggleGlobalAutomation: ReturnType<typeof useAutomationStore.getState>['toggleGlobalVisible'];
    statusClear: () => void;
    statusError: (msg: string) => void;
    fetchProject: () => Promise<void>;
    togglePluginEditor: (trackId: string, slotId: string) => Promise<void>;
}

// ── Hook ─────────────────────────────────────────────────────────────────

export function useDeviceRackLogic(
    selectedTrackId: string,
    onDropPluginToTrack?: (item: BrowserDragItem, trackId: string) => Promise<void>,
): DeviceRackLogic {
    const [localBypass, setLocalBypass] = useState<Record<string, boolean>>({});
    const [localParams, setLocalParams] = useState<Record<string, number>>({});
    const [pluginCapability, setPluginCapability] = useState<
        Record<string, { supported: boolean; reason?: string }>
    >({});
    const [pluginRuntimeBySlot, setPluginRuntimeBySlot] = useState<Record<string, engineApi.PluginSlotRuntimeStatus>>({});
    const [externalParamsBySlotId, setExternalParamsBySlotId] = useState<Record<string, PluginParam[]>>({});
    const [inlineSettingsOpen, setInlineSettingsOpen] = useState<Record<string, boolean>>({});
    const [selectedDeviceIds, setSelectedDeviceIds] = useState<string[]>([]);
    const {
        openEditorsByTrack,
        togglePluginEditor,
        projectTracks,
        meters,
        fetchProject,
    } = useEngineStore(useShallow((s) => ({
        openEditorsByTrack: s.openEditorsByTrack,
        togglePluginEditor: s.togglePluginEditor,
        projectTracks: s.projectTracks,
        meters: s.meters,
        fetchProject: s.fetchProject,
    })));
    const prevTrackIdRef = useRef<string>(selectedTrackId);
    const [paramSnapshotsByDevice, setParamSnapshotsByDevice] = useState<
        Record<string, { A?: Record<string, number>; B?: Record<string, number>; active?: 'A' | 'B' }>
    >({});
    const statusError = useStatusStore((s) => s.setError);
    const statusClear = useStatusStore((s) => s.clear);
    const throttledParamSendsRef = useRef<Map<string, AdaptiveSender>>(new Map());
    const throttledExternalParamSendsRef = useRef<Map<string, AdaptiveSender>>(new Map());
    const adaptiveParamIntervalMsRef = useRef<number>(24);
    const pendingGestureCommitsRef = useRef<Map<string, Map<string, PendingGestureCommit>>>(new Map());
    const activeParamGesturesRef = useRef<Set<string>>(new Set());
    const pushedUndoForGestureRef = useRef<Set<string>>(new Set());
    const gestureGroupByParamKeyRef = useRef<Map<string, string>>(new Map());
    const rackRef = useRef<HTMLDivElement>(null);
    const [isDropActive, setIsDropActive] = useState(false);
    const draggingItem = useDragStore((s) => s.draggingItem);

    // ── Automation context menu state ──
    const [autoCtxMenu, setAutoCtxMenu] = useState<AutoCtxMenuState>(null);
    const addAutomationLane = useAutomationStore((s) => s.addLane);
    const removeAutomationLane = useAutomationStore((s) => s.removeLane);
    const automationLanes = useAutomationStore((s) => s.lanes);
    const toggleGlobalAutomation = useAutomationStore((s) => s.toggleGlobalVisible);

    const handleParamContextMenu = useCallback(
        (e: React.MouseEvent, paramName: string, deviceId: string) => {
            e.preventDefault();
            e.stopPropagation();
            setAutoCtxMenu({ x: e.clientX, y: e.clientY, paramName, deviceId });
        },
        [],
    );

    // Close context menu on click outside
    useEffect(() => {
        if (!autoCtxMenu) return;
        const close = () => setAutoCtxMenu(null);
        window.addEventListener('mousedown', close);
        return () => window.removeEventListener('mousedown', close);
    }, [autoCtxMenu]);

    // ── Track & meter data ──
    const isMaster = selectedTrackId === 'master';
    const trackIndex = projectTracks.findIndex((t) => t.id === selectedTrackId);
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
        () => projectTracks.find((t) => t.track_type === 'Master') ?? null,
        [projectTracks],
    );
    const selectedTrack = isMaster
        ? masterProjectTrack
        : (trackIndex >= 0 ? projectTracks[trackIndex] : null);
    const dropTargetTrack = selectedTrack;
    const dropTargetTrackRef = useRef<typeof dropTargetTrack>(dropTargetTrack);
    const onDropPluginToTrackRef = useRef(onDropPluginToTrack);
    const fetchProjectRef = useRef(fetchProject);
    const statusClearRef = useRef(statusClear);
    const statusErrorRef = useRef(statusError);

    const sidechainOptions = useMemo(
        () => projectTracks
            .filter((t) => t.id !== (selectedTrack?.id ?? ''))
            .map((t) => ({ id: t.id, name: t.name })),
        [projectTracks, selectedTrack?.id],
    );

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

    // ── Ref sync effects ──
    useEffect(() => { dropTargetTrackRef.current = dropTargetTrack; }, [dropTargetTrack]);
    useEffect(() => { onDropPluginToTrackRef.current = onDropPluginToTrack; }, [onDropPluginToTrack]);
    useEffect(() => {
        fetchProjectRef.current = fetchProject;
        statusClearRef.current = statusClear;
        statusErrorRef.current = statusError;
    }, [fetchProject, statusClear, statusError]);

    // ── Close native editors on track leave ──
    useEffect(() => {
        const prevId = prevTrackIdRef.current;
        prevTrackIdRef.current = selectedTrackId;
        if (prevId === selectedTrackId) return;

        const prevSlots = openEditorsByTrack[prevId];
        if (prevSlots && prevSlots.size > 0 && prevId) {
            for (const slotId of prevSlots) {
                engineApi.closePluginWindowForSlot(prevId, slotId).catch((err) =>
                    console.warn('[DeviceRack] close editor on track leave failed:', err),
                );
            }
            useEngineStore.setState((s) => ({
                openEditorsByTrack: { ...s.openEditorsByTrack, [prevId]: new Set<string>() },
            }));
        }
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [selectedTrackId]);

    // ── SSOT: Clear ephemeral UI state on track switch ──
    useEffect(() => {
        setLocalParams({});
        setLocalBypass({});
        for (const sender of throttledParamSendsRef.current.values()) sender.cancel();
        throttledParamSendsRef.current.clear();
        for (const sender of throttledExternalParamSendsRef.current.values()) sender.cancel();
        throttledExternalParamSendsRef.current.clear();
        pendingGestureCommitsRef.current.clear();
        activeParamGesturesRef.current.clear();
        pushedUndoForGestureRef.current.clear();
        gestureGroupByParamKeyRef.current.clear();
    }, [selectedTrackId]);

    // ── Build device chain ──
    const chain = useMemo((): DeviceSlot[] => {
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
            } as {
                id: string;
                name: string;
                type: string;
                plugin_id: string;
                is_bypassed: boolean;
                source: 'internal';
                sampleRackConfig: unknown;
            }] : []),
            ...(!selectedTrack.sample_rack && selectedTrack.instrument ? [selectedTrack.instrument] : []),
            ...(selectedTrack.effects ?? []),
        ];

        type DeviceNodeShape = {
            id?: string;
            name?: string;
            plugin_id?: string;
            is_bypassed?: boolean;
            external_parameter_count?: number;
            sidechain_source_track_id?: string | null;
            supports_sidechain_input?: boolean | null;
            type?: string;
            rack_type?: string;
            sampleRackConfig?: unknown;
        };

        // Helper: convert a single DeviceNode to a DeviceSlot.
        const nodeToSlot = (node: (typeof nodes)[number]): DeviceSlot | null => {
            const shape = node as DeviceNodeShape;
            const id = shape?.id ?? '';
            const name = shape?.name ?? 'Unknown';
            const pluginId = shape?.plugin_id ?? '';
            const isBypassed = localBypass[id] ?? (shape?.is_bypassed ?? false);
            const isEnabled = !isBypassed;

            const isVst = pluginId.startsWith('vst://') || pluginId.startsWith('au://') || pluginId.startsWith('clap://');
            const isMissing = pluginId.startsWith('missing://');

            const normalizedId = normalizeInternalPluginId(pluginId);
            const internalPlugin = normalizedId ? getInternalPluginById(normalizedId) : null;
            const isInternalEffect = !!internalPlugin;
            const effectType = internalPlugin?.effectType ?? '';

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
            if (internalPlugin) {
                displayName = internalPlugin.displayName ?? internalPlugin.name ?? name;
            }

            const sidechainSourceTrackId = (shape as { sidechain_source_track_id?: string | null }).sidechain_source_track_id ?? null;
            const supportsSidechain = (shape as { supports_sidechain_input?: boolean | null }).supports_sidechain_input ?? false;

            let waveformIndex: number | undefined;
            if (effectType === 'sampler' || shape.type === 'SampleRack') {
                const samplePath = (() => {
                    const rack = shape.sampleRackConfig as { pads?: Array<{ sample_path?: string }> } | undefined;
                    if (rack && Array.isArray(rack.pads) && rack.pads.length > 0) {
                        return rack.pads[0]?.sample_path ?? '';
                    }
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
                sampleRackConfig: shape.sampleRackConfig,
            };
        };

        return nodes.map(nodeToSlot).filter((s): s is DeviceSlot => s !== null);
    }, [selectedTrack, localBypass, localParams, outLevel, outLevelL, outLevelR, externalParamsBySlotId, staticLaneValueByParamId]);

    // ── Sidechain ──
    const setPluginSidechainSource = useCallback(async (slotId: string, sourceTrackId: string) => {
        if (!selectedTrack) return;
        try {
            console.log('[DeviceRack] setPluginSidechainSource:', {
                trackId: selectedTrack.id,
                slotId,
                sourceTrackId: sourceTrackId || 'none',
            });
            await engineApi.setPluginSidechainSource(selectedTrack.id, slotId, sourceTrackId || 'none');
            await fetchProject();
            statusClear();
        } catch (err) {
            console.error('[DeviceRack] setPluginSidechainSource failed:', err);
            const msg = err instanceof Error ? err.message : String(err);
            statusError(`Failed to set plugin sidechain source: ${msg}`);
        }
    }, [selectedTrack, fetchProject, statusClear, statusError]);

    // ── Adaptive param sender factory ──
    const createAdaptiveParamSender = useCallback(
        (emit: (value: number, pushUndoStep: boolean) => Promise<void> | void): AdaptiveSender => {
            let timer: number | null = null;
            let pending: { value: number; pushUndoStep: boolean } | null = null;
            let lastSentAt = 0;

            const schedule = () => {
                if (timer != null || !pending) return;
                const now = performance.now();
                const delay = Math.max(0, adaptiveParamIntervalMsRef.current - (now - lastSentAt));
                timer = window.setTimeout(() => {
                    timer = null;
                    const payload = pending;
                    pending = null;
                    if (!payload) return;

                    const startedAt = performance.now();
                    lastSentAt = startedAt;
                    void Promise.resolve(emit(payload.value, payload.pushUndoStep))
                        .catch(() => { /* Errors are handled by caller. */ })
                        .finally(() => {
                            const elapsed = Math.max(1, performance.now() - startedAt);
                            const target = Math.max(16, Math.min(48, elapsed * 1.25));
                            adaptiveParamIntervalMsRef.current =
                                adaptiveParamIntervalMsRef.current * 0.7 + target * 0.3;
                            if (pending) schedule();
                        });
                }, delay);
            };

            return {
                send: (value: number, pushUndoStep: boolean) => {
                    if (pushUndoStep) {
                        if (timer != null) { window.clearTimeout(timer); timer = null; }
                        pending = null;
                        const startedAt = performance.now();
                        lastSentAt = startedAt;
                        void Promise.resolve(emit(value, true))
                            .catch(() => { /* Errors are handled by caller. */ })
                            .finally(() => {
                                const elapsed = Math.max(1, performance.now() - startedAt);
                                const target = Math.max(16, Math.min(48, elapsed * 1.25));
                                adaptiveParamIntervalMsRef.current =
                                    adaptiveParamIntervalMsRef.current * 0.7 + target * 0.3;
                            });
                        return;
                    }
                    pending = { value, pushUndoStep: pending?.pushUndoStep === true ? true : false };
                    schedule();
                },
                cancel: () => {
                    if (timer != null) { window.clearTimeout(timer); timer = null; }
                    pending = null;
                },
            };
        },
        [],
    );

    // ── Ensure slot runtime ──
    const ensureSlotRuntimeActive = useCallback(async (slotId: string) => {
        if (!selectedTrack) return null;
        const known = pluginRuntimeBySlot[slotId];
        if (known?.runtime === 'unsupported') {
            statusError(known.message ?? 'This plugin format is not supported by runtime in this build.');
            return null;
        }

        const runActivation = async () => {
            await engineApi.ensurePluginSlotActive(selectedTrack.id, slotId);
            const status = await engineApi.getPluginSlotRuntimeStatus(selectedTrack.id, slotId);
            setPluginRuntimeBySlot((prev) => ({ ...prev, [slotId]: status }));
            return status;
        };

        try {
            const status = await runActivation();
            statusClear();
            return status;
        } catch (err) {
            const firstMsg = errorMessage(err).toLowerCase();
            const shouldRescan = firstMsg.includes('cannot find native binary')
                || firstMsg.includes('plugin not found')
                || firstMsg.includes('failed to load plugin');
            if (shouldRescan) {
                try {
                    await engineApi.scanPluginFolders();
                    const status = await runActivation();
                    statusClear();
                    return status;
                } catch (retryErr) {
                    console.error('[DeviceRack] ensureSlotRuntimeActive retry failed:', retryErr);
                    statusError(`Plugin activation failed: ${errorMessage(retryErr)}`);
                    return null;
                }
            }
            console.error('[DeviceRack] ensureSlotRuntimeActive failed:', err);
            statusError(`Plugin activation failed: ${errorMessage(err)}`);
            return null;
        }
    }, [selectedTrack, pluginRuntimeBySlot, statusError, statusClear]);

    // ── Toggle device bypass ──
    const toggleDevice = useCallback((device: DeviceSlot) => {
        const currentBypassed = localBypass[device.id] ?? !device.isEnabled;
        const nextBypassed = !currentBypassed;
        setLocalBypass((prev) => ({ ...prev, [device.id]: nextBypassed }));

        if (!selectedTrack) return;

        void engineApi.setSlotBypass(
            selectedTrack.id.toString(),
            device.id,
            nextBypassed,
        ).catch((err) => {
            console.error('[DeviceRack] setSlotBypass failed:', err);
        });

        if (device.source === 'internal') {
            const trackIdx = projectTracks.findIndex((t) => t.id === selectedTrack.id);
            const slotIdx = selectedTrack.effects.findIndex((fx) => fx.id === device.id);
            if (trackIdx >= 0 && slotIdx >= 0) {
                void engineApi.bypassDevice(trackIdx, slotIdx, nextBypassed).catch((err) => {
                    console.error('[DeviceRack] bypassDevice failed:', err);
                });
            }
        }
    }, [localBypass, selectedTrack, projectTracks]);

    // ── Param setters ──
    const setPluginParam = useCallback((deviceId: string, paramName: string, value: number) => {
        setLocalParams((prev) => ({ ...prev, [`${deviceId}:${paramName}`]: value }));
    }, []);

    const sendInternalParam = useCallback(
        (
            device: DeviceSlot,
            paramName: string,
            value: number,
            options?: { gestureKey?: string; forcePushUndo?: boolean },
        ) => {
            if (!selectedTrack) return;

            const effectiveGestureKey = options?.gestureKey
                ? (gestureGroupByParamKeyRef.current.get(options.gestureKey) ?? options.gestureKey)
                : undefined;
            const pushUndoStep = options?.forcePushUndo ?? (!effectiveGestureKey);

            if (device.source === 'vst') {
                const idxFromList = device.params.findIndex((p) => p.name === paramName);
                const idxFromName = (() => {
                    const m = paramName.match(/(\d+)/);
                    return m ? Number.parseInt(m[1], 10) : -1;
                })();
                const paramIndex = idxFromList >= 0 ? idxFromList : idxFromName;
                if (paramIndex < 0 || !Number.isFinite(paramIndex)) return;

                const paramDef = idxFromList >= 0 ? device.params[idxFromList] : null;
                const normalized = paramDef
                    ? (value - paramDef.min) / Math.max(1e-9, paramDef.max - paramDef.min)
                    : value;
                const clamped = Math.min(1, Math.max(0, normalized));

                const key = `${selectedTrack.id}:${device.id}:${paramIndex}`;
                let sender = throttledExternalParamSendsRef.current.get(key);
                if (!sender) {
                    sender = createAdaptiveParamSender(async (v: number, pushUndo: boolean) => {
                        await engineApi.setExternalPluginParamForSlot(selectedTrack.id, device.id, paramIndex, v, {
                            pushUndoStep: pushUndo,
                        });
                    });
                    throttledExternalParamSendsRef.current.set(key, sender);
                }

                sender.send(clamped, pushUndoStep);
                if (effectiveGestureKey) {
                    const bucket = pendingGestureCommitsRef.current.get(effectiveGestureKey) ?? new Map();
                    bucket.set(`${device.id}:${paramIndex}`, {
                        source: 'vst',
                        trackId: selectedTrack.id,
                        deviceId: device.id,
                        paramName,
                        value: clamped,
                        paramIndex,
                    });
                    pendingGestureCommitsRef.current.set(effectiveGestureKey, bucket);
                }
                return;
            }

            const MASTER_TRACK_INDEX = 65535;
            const trackIdx = isMaster
                ? MASTER_TRACK_INDEX
                : projectTracks.findIndex((t) => t.id === selectedTrack.id);
            const effectSlotIdx = selectedTrack.effects.findIndex((fx) => fx.id === device.id);
            const pushPluginParam = (paramIndex: number, paramValue: number) => {
                if ((!isMaster && trackIdx < 0) || effectSlotIdx < 0) return;
                void engineApi.setDeviceParam(trackIdx, effectSlotIdx, paramIndex, paramValue).catch((err) => {
                    console.error('[DeviceRack] setDeviceParam failed:', err);
                });
            };

            if (device.source === 'internal') {
                const effectMap = RUNTIME_PARAM_INDEX_BY_EFFECT[device.effectType];
                if (effectMap) {
                    const key = paramName.toLowerCase();
                    const index = effectMap[key];
                    if (index != null) {
                        pushPluginParam(index, value);
                    }
                }
            }

            const paramId = internalParamIdForControl(device.effectType, paramName);
            const scopedParamId = `slot:${device.id}:${paramId}`;
            const key = `${selectedTrack.id}:${device.id}:${scopedParamId}`;

            let sender = throttledParamSendsRef.current.get(key);
            if (!sender) {
                sender = createAdaptiveParamSender(async (v: number, pushUndo: boolean) => {
                    await engineApi.setInternalPluginParam(
                        selectedTrack.id,
                        device.id,
                        scopedParamId,
                        v,
                        { pushUndoStep: pushUndo },
                    );
                });
                throttledParamSendsRef.current.set(key, sender);
            }
            sender.send(value, pushUndoStep);
            if (effectiveGestureKey) {
                const bucket = pendingGestureCommitsRef.current.get(effectiveGestureKey) ?? new Map();
                bucket.set(`${device.id}:${scopedParamId}`, {
                    source: 'internal',
                    trackId: selectedTrack.id,
                    deviceId: device.id,
                    paramName,
                    value,
                });
                pendingGestureCommitsRef.current.set(effectiveGestureKey, bucket);
            }
        },
        [selectedTrack, projectTracks, isMaster, createAdaptiveParamSender],
    );

    // ── Gesture lifecycle ──
    const beginParamGesture = useCallback((deviceId: string, paramName: string, gestureGroupId?: string) => {
        if (!selectedTrack) return;
        const gestureKey = `${selectedTrack.id}:${deviceId}:${paramName.toLowerCase()}`;
        activeParamGesturesRef.current.add(gestureKey);
        pushedUndoForGestureRef.current.delete(gestureKey);
        if (gestureGroupId) {
            gestureGroupByParamKeyRef.current.set(gestureKey, gestureGroupId);
            pushedUndoForGestureRef.current.delete(gestureGroupId);
        }
    }, [selectedTrack]);

    const endParamGesture = useCallback((deviceId: string, paramName: string) => {
        if (!selectedTrack) return;
        const gestureKey = `${selectedTrack.id}:${deviceId}:${paramName.toLowerCase()}`;
        const gestureGroupId = gestureGroupByParamKeyRef.current.get(gestureKey);
        const commitKey = gestureGroupId ?? gestureKey;

        const pending = pendingGestureCommitsRef.current.get(commitKey);
        if (pending && pending.size > 0) {
            const entries = Array.from(pending.values());
            pendingGestureCommitsRef.current.delete(commitKey);
            entries.forEach((entry, index) => {
                if (entry.source === 'vst') {
                    if (entry.paramIndex == null) return;
                    void engineApi.setExternalPluginParamForSlot(
                        entry.trackId, entry.deviceId, entry.paramIndex, entry.value,
                        { pushUndoStep: index === 0 },
                    ).catch((err) => {
                        console.error('[DeviceRack] setExternalPluginParam(commit) failed:', err);
                    });
                    return;
                }

                const effectType = chain.find((d) => d.id === entry.deviceId)?.effectType;
                if (!effectType) return;
                const scopedParamId = `slot:${entry.deviceId}:${internalParamIdForControl(effectType, entry.paramName)}`;
                void engineApi.setInternalPluginParam(
                    entry.trackId, entry.deviceId, scopedParamId, entry.value,
                    { pushUndoStep: index === 0 },
                ).catch((err) => {
                    console.error('[DeviceRack] setInternalPluginParam(commit) failed:', err);
                });
            });
        }

        activeParamGesturesRef.current.delete(gestureKey);
        pushedUndoForGestureRef.current.delete(gestureKey);
        if (gestureGroupId) {
            pushedUndoForGestureRef.current.delete(gestureGroupId);
            gestureGroupByParamKeyRef.current.delete(gestureKey);
        }
    }, [selectedTrack, chain]);

    // ── Param batch operations ──
    const applyParamBatch = useCallback((
        device: DeviceSlot,
        entries: Array<{ paramName: string; value: number }>,
    ) => {
        if (!selectedTrack || entries.length === 0) return;
        const byName = new Map(device.params.map((p) => [p.name.toLowerCase(), p]));
        const normalizedEntries = entries.map((entry) => {
            const def = byName.get(entry.paramName.toLowerCase());
            return {
                paramName: def?.name ?? entry.paramName,
                value: def ? clampAndSnapParamValue(def, entry.value) : entry.value,
            };
        });
        setLocalParams((prev) => {
            const next = { ...prev };
            for (const entry of normalizedEntries) {
                next[`${device.id}:${entry.paramName}`] = entry.value;
            }
            return next;
        });
        normalizedEntries.forEach((entry, idx) => {
            sendInternalParam(device, entry.paramName, entry.value, { forcePushUndo: idx === 0 });
        });
    }, [selectedTrack, sendInternalParam]);

    // ── Snapshot operations ──
    const storeParamSnapshot = useCallback((device: DeviceSlot, slot: 'A' | 'B') => {
        const snapshot: Record<string, number> = {};
        for (const p of device.params) snapshot[p.name] = p.value;
        setParamSnapshotsByDevice((prev) => ({
            ...prev,
            [device.id]: { ...(prev[device.id] ?? {}), [slot]: snapshot, active: slot },
        }));
    }, []);

    const recallParamSnapshot = useCallback((device: DeviceSlot, slot: 'A' | 'B') => {
        const snapshot = paramSnapshotsByDevice[device.id]?.[slot];
        if (!snapshot) return;
        const entries = Object.entries(snapshot).map(([paramName, value]) => ({ paramName, value }));
        applyParamBatch(device, entries);
        setParamSnapshotsByDevice((prev) => ({
            ...prev,
            [device.id]: { ...(prev[device.id] ?? {}), active: slot },
        }));
    }, [applyParamBatch, paramSnapshotsByDevice]);

    const toggleParamSnapshot = useCallback((device: DeviceSlot) => {
        const state = paramSnapshotsByDevice[device.id];
        if (!state?.A || !state?.B) return;
        const next: 'A' | 'B' = state.active === 'A' ? 'B' : 'A';
        recallParamSnapshot(device, next);
    }, [paramSnapshotsByDevice, recallParamSnapshot]);

    // ── Preset / randomize / reset ──
    const applyQuickPreset = useCallback((device: DeviceSlot, preset: QuickPreset) => {
        const entries = resolveQuickPresetParams(device, preset);
        applyParamBatch(device, entries);
    }, [applyParamBatch]);

    const randomizeInternalPluginParams = useCallback((device: DeviceSlot) => {
        const entries = device.params.map((param) => ({ paramName: param.name, value: randomParamValue(param) }));
        applyParamBatch(device, entries);
    }, [applyParamBatch]);

    const resetInternalPluginParams = useCallback((device: DeviceSlot) => {
        const entries = device.params.map((param) => ({ paramName: param.name, value: defaultParamForReset(param) }));
        applyParamBatch(device, entries);
    }, [applyParamBatch]);

    const applyQuickUtilityScene = useCallback((device: DeviceSlot, scene: 'center' | 'mono' | 'wide') => {
        if (device.effectType !== 'utility') return;
        const values = scene === 'mono'
            ? [{ paramName: 'Pan', value: 0 }, { paramName: 'Width', value: 0 }, { paramName: 'Mono', value: 1 }]
            : scene === 'wide'
                ? [{ paramName: 'Pan', value: 0 }, { paramName: 'Width', value: 150 }, { paramName: 'Mono', value: 0 }]
                : [{ paramName: 'Pan', value: 0 }, { paramName: 'Width', value: 100 }, { paramName: 'Mono', value: 0 }];
        applyParamBatch(device, values);
    }, [applyParamBatch]);

    // ── Sync effects ──
    useEffect(() => {
        setSelectedDeviceIds((prev) => prev.filter((id) => chain.some((d) => d.id === id)));
        setInlineSettingsOpen((prev) => {
            const next: Record<string, boolean> = {};
            const ids = new Set(chain.map((d) => d.id));
            for (const [id, isOpen] of Object.entries(prev)) {
                if (ids.has(id) && isOpen) next[id] = true;
            }
            return next;
        });
    }, [chain]);

    useEffect(() => {
        activeParamGesturesRef.current.clear();
        pushedUndoForGestureRef.current.clear();
        gestureGroupByParamKeyRef.current.clear();
        pendingGestureCommitsRef.current.clear();
        throttledParamSendsRef.current.forEach((s) => s.cancel());
        throttledExternalParamSendsRef.current.forEach((s) => s.cancel());
        throttledParamSendsRef.current.clear();
        throttledExternalParamSendsRef.current.clear();
    }, [selectedTrackId]);

    useEffect(() => { setSelectedDeviceIds([]); }, [selectedTrackId]);

    // ── Keyboard shortcuts ──
    useEffect(() => {
        const onKeyDown = async (e: KeyboardEvent) => {
            const tag = (e.target as HTMLElement | null)?.tagName?.toLowerCase();
            if (tag === 'input' || tag === 'textarea' || (e.target as HTMLElement | null)?.isContentEditable) return;
            if (!selectedTrack) return;

            if ((e.metaKey || e.ctrlKey) && e.key === 'c' && selectedDeviceIds.length > 0) {
                e.preventDefault();
                e.stopImmediatePropagation();
                try {
                    const deviceName = await engineApi.copyDeviceFromTrack(selectedTrack.id, selectedDeviceIds[0]);
                    statusClear();
                    console.log(`[DeviceRack] Copied device: ${deviceName}`);
                } catch (err) {
                    console.error('[DeviceRack] copyDeviceFromTrack failed:', err);
                    statusError('Failed to copy device.');
                }
                return;
            }

            if ((e.metaKey || e.ctrlKey) && e.key === 'v') {
                e.preventDefault();
                e.stopImmediatePropagation();
                try {
                    await engineApi.pasteDeviceToTrack(selectedTrack.id, 'auto');
                    await fetchProject();
                    statusClear();
                    console.log('[DeviceRack] Pasted device to track:', selectedTrack.id);
                } catch (err) {
                    console.error('[DeviceRack] pasteDeviceToTrack failed:', err);
                    statusError(String(err));
                }
                return;
            }

            if ((e.key !== 'Delete' && e.key !== 'Backspace') || selectedDeviceIds.length === 0) return;
            e.preventDefault();
            e.stopImmediatePropagation();
            try {
                for (const deviceId of selectedDeviceIds) {
                    await engineApi.removePluginFromTrack(selectedTrack.id, deviceId);
                }
                setInlineSettingsOpen((prev) => {
                    const next = { ...prev };
                    for (const deviceId of selectedDeviceIds) delete next[deviceId];
                    return next;
                });
                setSelectedDeviceIds([]);
                await fetchProject();
                statusClear();
            } catch (err) {
                console.error('[DeviceRack] removePluginFromTrack failed:', err);
                statusError('Failed to remove plugin from track.');
            }
        };
        window.addEventListener('keydown', onKeyDown);
        return () => window.removeEventListener('keydown', onKeyDown);
    }, [selectedDeviceIds, selectedTrack, fetchProject, statusClear, statusError]);

    // ── VST capability probes ──
    useEffect(() => {
        let cancelled = false;
        const vstDevices = chain.filter((d) => d.isVst);
        if (!selectedTrack) return;
        const missing = vstDevices.filter((d) => pluginCapability[d.id] == null);
        if (missing.length === 0) return;

        (async () => {
            const results = await Promise.all(
                missing.map(async (device) => {
                    try {
                        const cap = await engineApi.canOpenPluginEditorForSlot(selectedTrack.id, device.id);
                        return [device.id, { supported: cap.supported, reason: cap.reason ?? undefined }] as const;
                    } catch (err) {
                        console.error('[DeviceRack] Capability probe failed:', err);
                        return [device.id, { supported: false, reason: 'Capability check failed.' }] as const;
                    }
                }),
            );
            if (cancelled) return;
            setPluginCapability((prev) => {
                const next = { ...prev };
                for (const [id, cap] of results) next[id] = cap;
                return next;
            });
        })();
        return () => { cancelled = true; };
    }, [chain, pluginCapability, selectedTrack]);

    // ── VST runtime status probes ──
    useEffect(() => {
        let cancelled = false;
        if (!selectedTrack) return;
        const targets = chain.filter((d) => d.isVst);
        if (targets.length === 0) return;

        (async () => {
            const entries = await Promise.all(
                targets.map(async (device) => {
                    try {
                        const status = await engineApi.getPluginSlotRuntimeStatus(selectedTrack.id, device.id);
                        return [device.id, status] as const;
                    } catch (err) {
                        console.error('[DeviceRack] getPluginSlotRuntimeStatus failed:', err);
                        return [device.id, {
                            loaded: false, editorSupported: true, runtime: 'unknown',
                            sidechainReady: false, message: 'Runtime status unavailable',
                        } as engineApi.PluginSlotRuntimeStatus] as const;
                    }
                }),
            );
            if (cancelled) return;
            setPluginRuntimeBySlot((prev) => {
                const next = { ...prev };
                for (const [slotId, status] of entries) next[slotId] = status;
                return next;
            });
        })();
        return () => { cancelled = true; };
    }, [chain, selectedTrack]);

    // ── External param fetch ──
    useEffect(() => {
        let cancelled = false;
        if (!selectedTrack) return;
        const vstDevices = chain.filter((d) => d.isVst);
        const missing = vstDevices.filter((d) => !externalParamsBySlotId[d.id]);
        if (missing.length === 0) return;

        (async () => {
            const results = await Promise.all(
                missing.map(async (device) => {
                    try {
                        const params = await engineApi.getExternalPluginParamsForSlot(selectedTrack.id, device.id);
                        const mapped: PluginParam[] = params.map((p) => ({
                            name: p.name, min: p.min, max: p.max, step: p.step,
                            suffix: '', value: p.value, defaultValue: (p.min + p.max) * 0.5,
                        }));
                        return [device.id, mapped] as const;
                    } catch (err) {
                        console.error('[DeviceRack] getExternalPluginParamsForSlot failed:', err);
                        return [device.id, [] as PluginParam[]] as const;
                    }
                }),
            );
            if (cancelled) return;
            setExternalParamsBySlotId((prev) => {
                const next = { ...prev };
                for (const [slotId, params] of results) next[slotId] = params;
                return next;
            });
        })();
        return () => { cancelled = true; };
    }, [chain, selectedTrack, externalParamsBySlotId]);

    // ── Cleanup stale external params ──
    useEffect(() => {
        const aliveVstSlotIds = new Set(chain.filter((d) => d.isVst).map((d) => d.id));
        setExternalParamsBySlotId((prev) => {
            const next: Record<string, PluginParam[]> = {};
            let changed = false;
            for (const [slotId, params] of Object.entries(prev)) {
                if (aliveVstSlotIds.has(slotId)) next[slotId] = params;
                else changed = true;
            }
            return changed ? next : prev;
        });
    }, [chain]);

    // ── Drag & drop ──
    useEffect(() => {
        const onMouseMove = (e: MouseEvent) => {
            const dragging = useDragStore.getState().draggingItem;
            const targetTrack = dropTargetTrackRef.current;
            if (!dragging || !targetTrack || !canDropInZone(dragging, 'device-rack').allowed) {
                setIsDropActive(false);
                return;
            }
            const rect = rackRef.current?.getBoundingClientRect();
            if (!rect) return;
            const inside =
                e.clientX >= rect.left && e.clientX <= rect.right &&
                e.clientY >= rect.top && e.clientY <= rect.bottom;
            setIsDropActive(inside);
        };

        const onMouseUp = async (e: MouseEvent) => {
            const dragging = useDragStore.getState().draggingItem;
            const targetTrack = dropTargetTrackRef.current;
            if (!dragging || !targetTrack || !canDropInZone(dragging, 'device-rack').allowed) return;
            const rect = rackRef.current?.getBoundingClientRect();
            if (!rect) return;
            const inside =
                e.clientX >= rect.left && e.clientX <= rect.right &&
                e.clientY >= rect.top && e.clientY <= rect.bottom;
            if (!inside) {
                setIsDropActive(false);
                return;
            }

            try {
                const dropHandler = onDropPluginToTrackRef.current;
                if (dropHandler) {
                    await dropHandler(dragging, targetTrack.id);
                } else {
                    const hint = dragging.slotHint ?? 'auto';
                    const slot: 'instrument' | 'effect' =
                        hint === 'instrument'
                            ? 'instrument'
                            : hint === 'effect'
                                ? 'effect'
                                : targetTrack.track_type === 'Midi' && !targetTrack.instrument
                                    ? 'instrument'
                                    : 'effect';
                    await engineApi.addPluginToTrack(targetTrack.id, dragging.path, dragging.name, slot);
                    await fetchProjectRef.current();
                }
                statusClearRef.current();
            } catch (err) {
                console.error('[DeviceRack] addPluginToTrack failed:', err);
                statusErrorRef.current('Failed to add plugin to track.');
            } finally {
                useDragStore.getState().endDrag();
                setIsDropActive(false);
            }
        };

        window.addEventListener('mousemove', onMouseMove, true);
        window.addEventListener('mouseup', onMouseUp, true);
        return () => {
            window.removeEventListener('mousemove', onMouseMove, true);
            window.removeEventListener('mouseup', onMouseUp, true);
        };
    }, []);

    // ── Select device ──
    const selectDevice = useCallback((deviceId: string, additive: boolean) => {
        setSelectedDeviceIds((prev) => {
            if (!additive) return [deviceId];
            return prev.includes(deviceId)
                ? prev.filter((id) => id !== deviceId)
                : [...prev, deviceId];
        });
    }, []);

    return {
        chain,
        selectedTrack,
        selectedTrackId,
        selectedDeviceIds,
        isMaster,
        inLevelL,
        inLevelR,
        outLevelL,
        outLevelR,
        isDropActive,
        draggingItem,
        sidechainOptions,
        pluginCapability,
        pluginRuntimeBySlot,
        inlineSettingsOpen,
        paramSnapshotsByDevice,
        openEditorsByTrack,
        autoCtxMenu,
        automationLanes,
        rackRef,
        activeParamGesturesRef,
        toggleDevice,
        selectDevice,
        setPluginParam,
        sendInternalParam,
        beginParamGesture,
        endParamGesture,
        applyQuickPreset,
        randomizeInternalPluginParams,
        resetInternalPluginParams,
        storeParamSnapshot,
        recallParamSnapshot,
        toggleParamSnapshot,
        applyQuickUtilityScene,
        ensureSlotRuntimeActive,
        setPluginSidechainSource,
        handleParamContextMenu,
        setAutoCtxMenu,
        setInlineSettingsOpen,
        addAutomationLane,
        removeAutomationLane,
        toggleGlobalAutomation,
        statusClear,
        statusError,
        fetchProject,
        togglePluginEditor,
    };
}
