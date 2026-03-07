import { useCallback, useMemo, useRef } from 'react';
import * as engineApi from '@/shared/api/engine';
import { useEngineStore } from '@/shared/stores/useEngineStore';
import type { DeviceSlot } from '../model/types';
import { clampAndSnapParamValue } from '../model/presets';
import { RUNTIME_PARAM_INDEX_BY_EFFECT, internalParamIdForControl } from '../model/deviceRackCatalog';
import type { AdaptiveSender, PendingGestureCommit } from './useDeviceParamGestureTypes';
import { createAdaptiveParamSenderFactory, createAdaptiveRuntimeBatchSenderFactory } from './useDeviceParamSenders';
import { useDeviceParamPruning } from './useDeviceParamPruning';
import { useAutomationStore } from '@/shared/stores/useAutomationStore';
import { useLastTouchedParamStore } from '@/shared/stores/useLastTouchedParamStore';
import { useStatusStore } from '@/shared/stores/useStatusStore';
type DeviceParamTrack = { id: string; effects: Array<{ id: string }> } | null;
export function useDeviceParamGestures(
    chain: DeviceSlot[],
    _selectedTrackId: string,
    selectedTrack: DeviceParamTrack,
    trackIds: string[],
    isMaster: boolean,
    setLocalParams: React.Dispatch<React.SetStateAction<Record<string, number>>>
) {
    const throttledParamSendsRef = useRef<Map<string, AdaptiveSender>>(new Map());
    const throttledExternalParamSendsRef = useRef<Map<string, AdaptiveSender>>(new Map());
    const throttledExternalRuntimeSendsRef = useRef<Map<string, AdaptiveSender>>(new Map());
    const throttledRuntimeSlotSendsRef = useRef<Map<string, { queue: (paramIndex: number, value: number) => void; cancel: () => void }>>(new Map());
    const pendingGestureCommitsRef = useRef<Map<string, Map<string, PendingGestureCommit>>>(new Map());
    const activeParamGesturesRef = useRef<Set<string>>(new Set());
    const pushedUndoForGestureRef = useRef<Set<string>>(new Set());
    const gestureGroupByParamKeyRef = useRef<Map<string, string>>(new Map());
    const trackIndexById = useMemo(() => new Map(trackIds.map((trackId, index) => [trackId, index] as const)), [trackIds]);
    const createAdaptiveParamSender = useMemo(() => createAdaptiveParamSenderFactory(), []);
    const createAdaptiveRuntimeBatchSender = useMemo(() => createAdaptiveRuntimeBatchSenderFactory(), []);
    const sendInternalParam = useCallback(
        (
            device: DeviceSlot,
            paramName: string,
            value: number,
            options?: { gestureKey?: string; forcePushUndo?: boolean },
        ) => {
            if (!selectedTrack) return;
            useLastTouchedParamStore.getState().setLastTouched({
                trackId: selectedTrack.id,
                deviceId: device.id,
                paramName,
                paramKey: `${device.id}:${paramName}`,
            });
            const effectiveGestureKey = options?.gestureKey
                ? (gestureGroupByParamKeyRef.current.get(options.gestureKey) ?? options.gestureKey)
                : undefined;
            const pushUndoStep = options?.forcePushUndo ?? (!effectiveGestureKey);
            if (device.source === 'vst') {
                const idxFromList = device.params.findIndex((p) => p.name === paramName || p.name.toLowerCase() === paramName.toLowerCase());
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
                if (effectiveGestureKey) {
                    let runtimeSender = throttledExternalRuntimeSendsRef.current.get(key);
                    if (!runtimeSender) {
                        runtimeSender = createAdaptiveParamSender(async (v: number) => {
                            await engineApi.setExternalPluginParamForSlotRuntime(
                                device.id,
                                device.pluginId,
                                paramIndex,
                                v,
                            );
                        });
                        throttledExternalRuntimeSendsRef.current.set(key, runtimeSender);
                    }
                    runtimeSender.send(clamped, false);
                } else {
                    let sender = throttledExternalParamSendsRef.current.get(key);
                    if (!sender) {
                        sender = createAdaptiveParamSender(async (v: number, pushUndo: boolean) => {
                            const response = await engineApi.setExternalPluginParamForSlotWithDeltas(selectedTrack.id, device.id, paramIndex, v, {
                                pushUndoStep: pushUndo,
                            });
                            await useEngineStore.getState().applyProjectDeltas(response.deltas, 'device-rack:external-param-gesture');
                        });
                        throttledExternalParamSendsRef.current.set(key, sender);
                    }
                    sender.send(clamped, pushUndoStep);
                }
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
            const pushPluginParam = (paramIndex: number, paramValue: number): boolean => {
                // BUG-EQ06 FIX: Compute trackIdx/effectSlotIdx at call time, NOT at sender
                // creation time. This prevents stale closure issues when effects are reordered.
                const currentTrackIdx = isMaster
                    ? MASTER_TRACK_INDEX
                    : (trackIndexById.get(selectedTrack.id) ?? -1);
                const currentEffectSlotIdx = selectedTrack.effects.findIndex((fx) => fx.id === device.id);
                if ((!isMaster && currentTrackIdx < 0) || currentEffectSlotIdx < 0) return false;
                const runtimeKey = `${selectedTrack.id}:${device.id}:runtime-slot`;
                let sender = throttledRuntimeSlotSendsRef.current.get(runtimeKey);
                if (!sender) {
                    sender = createAdaptiveRuntimeBatchSender(async (updates) => {
                        // BUG-EQ06 FIX: Re-resolve indices at flush time to avoid stale closures
                        const flushTrackIdx = isMaster
                            ? MASTER_TRACK_INDEX
                            : (trackIndexById.get(selectedTrack.id) ?? -1);
                        const flushEffectSlotIdx = selectedTrack.effects.findIndex((fx) => fx.id === device.id);
                        if ((!isMaster && flushTrackIdx < 0) || flushEffectSlotIdx < 0) return;
                        await engineApi.setDeviceParamsRuntime(flushTrackIdx, flushEffectSlotIdx, updates);
                    });
                    throttledRuntimeSlotSendsRef.current.set(runtimeKey, sender);
                }
                // Runtime path should be smooth but rate-limited to avoid audio thread contention.
                sender.queue(paramIndex, paramValue);
                return true;
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
                // PERFORMANCE FIX: during active gestures we keep internal FX updates
                // on runtime path only (audio-thread params). Project mutations and
                // UI delta reconciliation happen once on gesture commit.
                return;
            }
            let sender = throttledParamSendsRef.current.get(key);
            if (!sender) {
                sender = createAdaptiveParamSender(async (v: number, pushUndo: boolean) => {
                    const response = await engineApi.setInternalPluginParamWithDeltas(
                        selectedTrack.id,
                        device.id,
                        scopedParamId,
                        v,
                        { pushUndoStep: pushUndo },
                    );
                    if (response.deltas.length > 0) {
                        await useEngineStore.getState().applyProjectDeltas(response.deltas, 'device-rack:param-gesture');
                    }
                });
                throttledParamSendsRef.current.set(key, sender);
            }
            sender.send(value, pushUndoStep);
        },
        [selectedTrack, isMaster, createAdaptiveParamSender, createAdaptiveRuntimeBatchSender, trackIndexById],
    );
    const beginParamGesture = useCallback((deviceId: string, paramName: string, gestureGroupId?: string) => {
        if (!selectedTrack) return;
        const gestureKey = `${selectedTrack.id}:${deviceId}:${paramName.toLowerCase()}`;
        activeParamGesturesRef.current.add(gestureKey);
        pushedUndoForGestureRef.current.delete(gestureKey);
        if (gestureGroupId) {
            gestureGroupByParamKeyRef.current.set(gestureKey, gestureGroupId);
            pushedUndoForGestureRef.current.delete(gestureGroupId);
        }

        // ── ENTERPRISE: Touch-Knob → Auto-Show Automation Lane ──────────
        // When automation mode is active, touching any knob/fader automatically
        // creates the automation lane for that parameter (if not already present)
        // and makes it visible + expands the track. This gives Ableton-style UX
        // where interacting with a control instantly shows its automation curve.
        const autoStore = useAutomationStore.getState();
        if (autoStore.globalVisible) {
            const paramKey = `${deviceId}:${paramName}`;
            const existingLane = Object.values(autoStore.lanes).find(
                (lane) => lane.trackId === selectedTrack.id && lane.paramKey === paramKey,
            );
            if (existingLane) {
                // Lane exists — just ensure it's visible
                if (!existingLane.visible) {
                    useAutomationStore.getState().setLaneVisibility(existingLane.id, true);
                }
            } else {
                // Lane doesn't exist — create it with the track's color
                const track = useEngineStore.getState().tracks.byId[selectedTrack.id];
                const color = track?.color || 'var(--token-color-hex-58a6ff)';
                useAutomationStore.getState().addLane(selectedTrack.id, paramName, paramKey, color);
            }
            // Ensure the track is expanded in the automation view
            useAutomationStore.setState((s) => {
                const nextExpanded = new Set(s.expandedTracks);
                nextExpanded.add(selectedTrack.id);
                return { expandedTracks: nextExpanded };
            });
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
            // BUG-I02 FIX: Batch internal parameter gesture commits into one IPC call.
            void (async () => {
                const internalUpdatesByDevice = new Map<string, { trackId: string, updates: engineApi.InternalPluginParamUpdate[] }>();
                let pushedUndo = false;

                for (let index = 0; index < entries.length; index++) {
                    const entry = entries[index];
                    try {
                        if (entry.source === 'vst') {
                            if (entry.paramIndex == null) continue;
                            const response = await engineApi.setExternalPluginParamForSlotWithDeltas(
                                entry.trackId, entry.deviceId, entry.paramIndex, entry.value,
                                { pushUndoStep: !pushedUndo },
                            );
                            pushedUndo = true;
                            await useEngineStore.getState().applyProjectDeltas(response.deltas, 'device-rack:external-param-commit');
                        } else {
                            const effectType = chain.find((d) => d.id === entry.deviceId)?.effectType;
                            if (effectType == null) continue;
                            const scopedParamId = `slot:${entry.deviceId}:${internalParamIdForControl(effectType, entry.paramName)}`;

                            let deviceBatch = internalUpdatesByDevice.get(entry.deviceId);
                            if (!deviceBatch) {
                                deviceBatch = { trackId: entry.trackId, updates: [] };
                                internalUpdatesByDevice.set(entry.deviceId, deviceBatch);
                            }
                            deviceBatch.updates.push({ paramId: scopedParamId, value: entry.value });
                        }
                    } catch (err) {
                        console.error('[Dream] gesture commit failed:', err);
                        useStatusStore.getState().setError(`Param gesture commit failed: ${err instanceof Error ? err.message : String(err)}`);
                    }
                }

                for (const [deviceId, batch] of internalUpdatesByDevice.entries()) {
                    try {
                        const response = await engineApi.setInternalPluginParamBatchWithDeltas(
                            batch.trackId, deviceId, batch.updates, { pushUndoStep: !pushedUndo }
                        );
                        pushedUndo = true;
                        if (response.deltas.length > 0) {
                            await useEngineStore.getState().applyProjectDeltas(response.deltas, 'device-rack:param-commit');
                        }
                    } catch (err) {
                        console.error('[Dream] internal gesture batch commit failed:', err);
                        useStatusStore.getState().setError(`Param batch commit failed: ${err instanceof Error ? err.message : String(err)}`);
                    }
                }
            })();
        }
        activeParamGesturesRef.current.delete(gestureKey);
        pushedUndoForGestureRef.current.delete(gestureKey);
        if (gestureGroupId) {
            pushedUndoForGestureRef.current.delete(gestureGroupId);
            gestureGroupByParamKeyRef.current.delete(gestureKey);
        }
    }, [selectedTrack, chain]);
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
        setLocalParams((prev: Record<string, number>) => {
            const next = { ...prev };
            for (const entry of normalizedEntries) {
                next[`${device.id}:${entry.paramName}`] = entry.value;
            }
            return next;
        });
        // BUG-I04 FIX: Batch IPC call
        if (device.source !== 'vst' && device.source !== 'missing') {
            const effectType = device.effectType;
            if (effectType) {
                const updates = normalizedEntries.map(entry => ({
                    paramId: `slot:${device.id}:${internalParamIdForControl(effectType, entry.paramName)}`,
                    value: entry.value
                }));
                void engineApi.setInternalPluginParamBatchWithDeltas(
                    selectedTrack.id, device.id, updates, { pushUndoStep: true }
                )
                    .then(response => {
                        useEngineStore.getState().applyProjectDeltas(response.deltas, 'device-rack:param-batch');
                    })
                    .catch(err => { console.error('[Dream] applyParamBatch internal gesture batch commit failed:', err); useStatusStore.getState().setError(`Param batch apply failed: ${err instanceof Error ? err.message : String(err)}`); });
            }
        } else {
            normalizedEntries.forEach((entry, idx) => {
                sendInternalParam(device, entry.paramName, entry.value, { forcePushUndo: idx === 0 });
            });
        }
    }, [selectedTrack, sendInternalParam, setLocalParams]);
    const cleanupGestures = useCallback(() => {
        throttledParamSendsRef.current.forEach((s) => s.cancel());
        throttledExternalParamSendsRef.current.forEach((s) => s.cancel());
        throttledExternalRuntimeSendsRef.current.forEach((s) => s.cancel());
        throttledRuntimeSlotSendsRef.current.forEach((s) => s.cancel());
        throttledParamSendsRef.current.clear();
        throttledExternalParamSendsRef.current.clear();
        throttledExternalRuntimeSendsRef.current.clear();
        throttledRuntimeSlotSendsRef.current.clear();
        pendingGestureCommitsRef.current.clear();
        activeParamGesturesRef.current.clear();
        pushedUndoForGestureRef.current.clear();
        gestureGroupByParamKeyRef.current.clear();
    }, []);
    useDeviceParamPruning(
        chain,
        throttledParamSendsRef,
        throttledExternalParamSendsRef,
        throttledExternalRuntimeSendsRef,
        throttledRuntimeSlotSendsRef,
    );
    return { activeParamGesturesRef, sendInternalParam, beginParamGesture, endParamGesture, applyParamBatch, cleanupGestures };
}
