import { useCallback, useMemo, useRef } from 'react';
import * as engineApi from '@/shared/api/engine';
import { useEngineStore } from '@/shared/stores/useEngineStore';
import type { DeviceSlot } from '../model/types';
import { clampAndSnapParamValue } from '../model/presets';
import { RUNTIME_PARAM_INDEX_BY_EFFECT, internalParamIdForControl } from '../model/deviceRackCatalog';
import type { AdaptiveSender, PendingGestureCommit } from './useDeviceParamGestureTypes';

type DeviceParamTrack = {
    id: string;
    effects: Array<{ id: string }>;
} | null;

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
    const throttledRuntimeSlotSendsRef = useRef<
        Map<
            string,
            {
                queue: (paramIndex: number, value: number) => void;
                cancel: () => void;
            }
        >
    >(new Map());
    const adaptiveParamIntervalMsRef = useRef<number>(24);
    const pendingGestureCommitsRef = useRef<Map<string, Map<string, PendingGestureCommit>>>(new Map());
    const activeParamGesturesRef = useRef<Set<string>>(new Set());
    const pushedUndoForGestureRef = useRef<Set<string>>(new Set());
    const gestureGroupByParamKeyRef = useRef<Map<string, string>>(new Map());
    const trackIndexById = useMemo(() => new Map(trackIds.map((trackId, index) => [trackId, index] as const)), [trackIds]);

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
                        .catch((err) => {
                            console.error('[DeviceRack] parameter send failed:', err);
                        })
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
                            .catch((err) => {
                                console.error('[DeviceRack] parameter send failed:', err);
                            })
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

    const createAdaptiveRuntimeBatchSender = useCallback(
        (
            emit: (updates: Array<{ paramIndex: number; value: number }>) => Promise<void> | void,
        ): { queue: (paramIndex: number, value: number) => void; cancel: () => void } => {
            let timer: number | null = null;
            const pendingByParam = new Map<number, number>();
            let lastSentAt = 0;

            const schedule = () => {
                if (timer != null || pendingByParam.size === 0) return;
                const now = performance.now();
                const delay = Math.max(0, adaptiveParamIntervalMsRef.current - (now - lastSentAt));
                timer = window.setTimeout(() => {
                    timer = null;
                    if (pendingByParam.size === 0) return;
                    const payload = Array.from(pendingByParam.entries()).map(([paramIndex, value]) => ({
                        paramIndex,
                        value,
                    }));
                    pendingByParam.clear();
                    const startedAt = performance.now();
                    lastSentAt = startedAt;
                    void Promise.resolve(emit(payload))
                        .catch(() => { /* Errors are handled by caller. */ })
                        .finally(() => {
                            const elapsed = Math.max(1, performance.now() - startedAt);
                            const target = Math.max(16, Math.min(48, elapsed * 1.25));
                            adaptiveParamIntervalMsRef.current =
                                adaptiveParamIntervalMsRef.current * 0.7 + target * 0.3;
                            if (pendingByParam.size > 0) schedule();
                        });
                }, delay);
            };

            return {
                queue: (paramIndex: number, value: number) => {
                    pendingByParam.set(paramIndex, value);
                    schedule();
                },
                cancel: () => {
                    if (timer != null) {
                        window.clearTimeout(timer);
                        timer = null;
                    }
                    pendingByParam.clear();
                },
            };
        },
        [],
    );

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
                if (effectiveGestureKey) {
                    let runtimeSender = throttledExternalRuntimeSendsRef.current.get(key);
                    if (!runtimeSender) {
                        runtimeSender = createAdaptiveParamSender(async (v: number) => {
                            await engineApi.setExternalPluginParamForSlot(selectedTrack.id, device.id, paramIndex, v, {
                                pushUndoStep: false,
                            });
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
            const trackIdx = isMaster
                ? MASTER_TRACK_INDEX
                : (trackIndexById.get(selectedTrack.id) ?? -1);
            const effectSlotIdx = selectedTrack.effects.findIndex((fx) => fx.id === device.id);
            const pushPluginParam = (paramIndex: number, paramValue: number): boolean => {
                if ((!isMaster && trackIdx < 0) || effectSlotIdx < 0) return false;
                const runtimeKey = `${selectedTrack.id}:${device.id}:runtime-slot`;
                let sender = throttledRuntimeSlotSendsRef.current.get(runtimeKey);
                if (!sender) {
                    sender = createAdaptiveRuntimeBatchSender(async (updates) => {
                        await engineApi.setDeviceParamsRuntime(trackIdx, effectSlotIdx, updates);
                    });
                    throttledRuntimeSlotSendsRef.current.set(runtimeKey, sender);
                }
                // Runtime path should be smooth but rate-limited to avoid audio thread contention.
                sender.queue(paramIndex, paramValue);
                return true;
            };

            let runtimePushed = false;
            if (device.source === 'internal') {
                const effectMap = RUNTIME_PARAM_INDEX_BY_EFFECT[device.effectType];
                if (effectMap) {
                    const key = paramName.toLowerCase();
                    const index = effectMap[key];
                    if (index != null) {
                        runtimePushed = pushPluginParam(index, value);
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
                // For devices/params without a runtime slot path (e.g. instrument/sampler),
                // keep audio responsive during drag by sending non-undo live updates.
                if (!runtimePushed) {
                    const liveKey = `${selectedTrack.id}:${device.id}:${scopedParamId}:live`;
                    let liveSender = throttledParamSendsRef.current.get(liveKey);
                    if (!liveSender) {
                        liveSender = createAdaptiveParamSender(async (v: number) => {
                            await engineApi.setInternalPluginParam(
                                selectedTrack.id,
                                device.id,
                                scopedParamId,
                                v,
                                { pushUndoStep: false },
                            );
                        });
                        throttledParamSendsRef.current.set(liveKey, liveSender);
                    }
                    liveSender.send(value, false);
                }
                return;
            }

            let sender = throttledParamSendsRef.current.get(key);
            if (!sender) {
                sender = createAdaptiveParamSender(async (v: number, pushUndo: boolean) => {
                    try {
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
                    } catch (err) {
                        // Fallback: apply command even when delta envelope cannot be produced.
                        console.warn('[DeviceRack] setInternalPluginParamWithDeltas failed, falling back:', err);
                        await engineApi.setInternalPluginParam(
                            selectedTrack.id,
                            device.id,
                            scopedParamId,
                            v,
                            { pushUndoStep: pushUndo },
                        );
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
                    void engineApi.setExternalPluginParamForSlotWithDeltas(
                        entry.trackId, entry.deviceId, entry.paramIndex, entry.value,
                        { pushUndoStep: index === 0 },
                    ).then((response) => useEngineStore.getState().applyProjectDeltas(response.deltas, 'device-rack:external-param-commit'))
                        .catch((err) => {
                            console.error('[DeviceRack] setExternalPluginParam(commit) failed:', err);
                        });
                    return;
                }

                const effectType = chain.find((d) => d.id === entry.deviceId)?.effectType;
                if (!effectType) return;
                const scopedParamId = `slot:${entry.deviceId}:${internalParamIdForControl(effectType, entry.paramName)}`;
                void engineApi.setInternalPluginParamWithDeltas(
                    entry.trackId, entry.deviceId, scopedParamId, entry.value,
                    { pushUndoStep: index === 0 },
                ).then(async (response) => {
                    if (response.deltas.length > 0) {
                        await useEngineStore.getState().applyProjectDeltas(response.deltas, 'device-rack:param-commit');
                    }
                }).catch(async (err) => {
                    console.warn('[DeviceRack] setInternalPluginParamWithDeltas(commit) failed, falling back:', err);
                    try {
                        await engineApi.setInternalPluginParam(
                            entry.trackId,
                            entry.deviceId,
                            scopedParamId,
                            entry.value,
                            { pushUndoStep: index === 0 },
                        );
                    } catch (fallbackErr) {
                        console.error('[DeviceRack] setInternalPluginParam(commit) fallback failed:', fallbackErr);
                    }
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
        normalizedEntries.forEach((entry, idx) => {
            sendInternalParam(device, entry.paramName, entry.value, { forcePushUndo: idx === 0 });
        });
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

    return { activeParamGesturesRef, sendInternalParam, beginParamGesture, endParamGesture, applyParamBatch, cleanupGestures };
}
