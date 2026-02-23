import { useEffect, useMemo } from 'react';
import type { MutableRefObject } from 'react';
import type { DeviceSlot } from './types';
import type { AdaptiveSender } from './useDeviceParamGestureTypes';

type RuntimeBatchSender = { queue: (paramIndex: number, value: number) => void; cancel: () => void };

const pruneSenderMap = <T,>(map: Map<string, T>, chainDeviceIds: Set<string>) => {
    for (const key of map.keys()) {
        // Key format: "trackId:deviceId:..."
        const parts = key.split(':');
        const deviceId = parts.length >= 2 ? parts[1] : '';
        if (!deviceId || chainDeviceIds.has(deviceId)) continue;
        const entry = map.get(key);
        if (entry && typeof entry === 'object' && 'cancel' in entry) {
            (entry as { cancel: () => void }).cancel();
        }
        map.delete(key);
    }
};

export function useDeviceParamPruning(
    chain: DeviceSlot[],
    throttledParamSendsRef: MutableRefObject<Map<string, AdaptiveSender>>,
    throttledExternalParamSendsRef: MutableRefObject<Map<string, AdaptiveSender>>,
    throttledExternalRuntimeSendsRef: MutableRefObject<Map<string, AdaptiveSender>>,
    throttledRuntimeSlotSendsRef: MutableRefObject<Map<string, RuntimeBatchSender>>,
) {
    const chainDeviceIds = useMemo(() => new Set(chain.map((d) => d.id)), [chain]);
    useEffect(() => {
        pruneSenderMap(throttledParamSendsRef.current, chainDeviceIds);
        pruneSenderMap(throttledExternalParamSendsRef.current, chainDeviceIds);
        pruneSenderMap(throttledExternalRuntimeSendsRef.current, chainDeviceIds);
        pruneSenderMap(throttledRuntimeSlotSendsRef.current, chainDeviceIds);
    }, [
        chainDeviceIds,
        throttledParamSendsRef,
        throttledExternalParamSendsRef,
        throttledExternalRuntimeSendsRef,
        throttledRuntimeSlotSendsRef,
    ]);
}
