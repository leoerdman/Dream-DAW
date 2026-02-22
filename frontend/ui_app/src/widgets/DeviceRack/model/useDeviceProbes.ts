import { useState, useEffect } from 'react';
import * as engineApi from '@/shared/api/engineApi';
import type { DeviceSlot, PluginParam } from '../model/types';

export function useDeviceProbes(
    chain: DeviceSlot[],
    selectedTrackId: string,
    selectedTrack: any,
) {
    const [pluginCapability, setPluginCapability] = useState<Record<string, { supported: boolean; reason?: string }>>({});
    const [pluginRuntimeBySlot, setPluginRuntimeBySlot] = useState<Record<string, engineApi.PluginSlotRuntimeStatus>>({});
    const [externalParamsBySlotId, setExternalParamsBySlotId] = useState<Record<string, PluginParam[]>>({});

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

    return {
        pluginCapability,
        pluginRuntimeBySlot,
        setPluginRuntimeBySlot,
        externalParamsBySlotId,
    };
}
