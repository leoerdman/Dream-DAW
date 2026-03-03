import { useState, useCallback, useRef, useEffect } from 'react';
import type { DeviceSlot, QuickPreset } from '../model/types';
import { resolveQuickPresetParams, randomParamValue, defaultParamForReset } from '../model/presets';

// BUG-S01 FIX: Persist snapshots in a global module variable to survive DeviceRack unmounts
const globalSnapshotStorage: Record<string, { A?: Record<string, number>; B?: Record<string, number>; active?: 'A' | 'B' }> = {};

export function useDeviceSnapshots(applyParamBatch: (device: DeviceSlot, entries: Array<{ paramName: string, value: number }>) => void) {
    const [paramSnapshotsByDevice, setParamSnapshotsByDevice] = useState<
        Record<string, { A?: Record<string, number>; B?: Record<string, number>; active?: 'A' | 'B' }>
    >(globalSnapshotStorage);

    const snapshotsRef = useRef(paramSnapshotsByDevice);
    useEffect(() => {
        snapshotsRef.current = paramSnapshotsByDevice;
    }, [paramSnapshotsByDevice]);

    const storeParamSnapshot = useCallback((device: DeviceSlot, slot: 'A' | 'B') => {
        const snapshot: Record<string, number> = {};
        for (const p of device.params) snapshot[p.name] = p.value;
        setParamSnapshotsByDevice((prev) => {
            const next = {
                ...prev,
                [device.id]: { ...(prev[device.id] ?? {}), [slot]: snapshot, active: slot },
            };
            Object.assign(globalSnapshotStorage, next);
            return next;
        });
    }, []);

    const recallParamSnapshot = useCallback((device: DeviceSlot, slot: 'A' | 'B') => {
        // BUG-28 FIX: Read from ref instead of stale closure.
        const snapshot = snapshotsRef.current[device.id]?.[slot];
        if (!snapshot) return;
        const entries = Object.entries(snapshot).map(([paramName, value]) => ({ paramName, value: value as number }));
        applyParamBatch(device, entries);
        setParamSnapshotsByDevice((prev) => {
            const next = { ...prev, [device.id]: { ...(prev[device.id] ?? {}), active: slot } };
            Object.assign(globalSnapshotStorage, next);
            return next;
        });
    }, [applyParamBatch]);

    const toggleParamSnapshot = useCallback((device: DeviceSlot) => {
        // BUG-28 FIX: Read from ref instead of stale closure.
        const state = snapshotsRef.current[device.id];
        if (!state?.A || !state?.B) return;
        const next: 'A' | 'B' = state.active === 'A' ? 'B' : 'A';
        recallParamSnapshot(device, next);
    }, [recallParamSnapshot]);

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
        // BUG-U08 FIX: Resolve canonical param names from device.params (case-insensitive).
        const byLower = new Map(device.params.map((p) => [p.name.toLowerCase(), p.name]));
        const resolve = (name: string) => byLower.get(name.toLowerCase()) ?? name;
        const values = scene === 'mono'
            ? [{ paramName: resolve('Pan'), value: 0 }, { paramName: resolve('Width'), value: 0 }, { paramName: resolve('Mono'), value: 1 }]
            : scene === 'wide'
                ? [{ paramName: resolve('Pan'), value: 0 }, { paramName: resolve('Width'), value: 150 }, { paramName: resolve('Mono'), value: 0 }]
                : [{ paramName: resolve('Pan'), value: 0 }, { paramName: resolve('Width'), value: 100 }, { paramName: resolve('Mono'), value: 0 }];
        applyParamBatch(device, values);
    }, [applyParamBatch]);

    return {
        paramSnapshotsByDevice,
        storeParamSnapshot,
        recallParamSnapshot,
        toggleParamSnapshot,
        applyQuickPreset,
        randomizeInternalPluginParams,
        resetInternalPluginParams,
        applyQuickUtilityScene,
    };
}
