import { useState, useEffect, useRef, useMemo } from 'react';
import * as engineApi from '@/shared/api/engine';
import type { DeviceSlot, PluginParam } from '../model/types';

export function useDeviceProbes(
    chain: DeviceSlot[],
    _selectedTrackId: string,
    selectedTrack: { id: string } | null,
) {
    const [pluginCapability, setPluginCapability] = useState<Record<string, { supported: boolean; reason?: string }>>({});
    const [pluginRuntimeBySlot, setPluginRuntimeBySlot] = useState<Record<string, engineApi.PluginSlotRuntimeStatus>>({});
    const [externalParamsBySlotId, setExternalParamsBySlotId] = useState<Record<string, PluginParam[]>>({});

    // Refs to read current state inside effects WITHOUT adding them to dep arrays.
    // This breaks the circular dependency: effect → setState → dep change → effect.
    const capabilityRef = useRef(pluginCapability);
    const externalParamsRef = useRef(externalParamsBySlotId);
    useEffect(() => {
        capabilityRef.current = pluginCapability;
    }, [pluginCapability]);
    useEffect(() => {
        externalParamsRef.current = externalParamsBySlotId;
    }, [externalParamsBySlotId]);

    const selectedTrackId = selectedTrack?.id;

    // ── VST capability probes ──
    useEffect(() => {
        let cancelled = false;
        if (!selectedTrackId) return;
        const vstDevices = chain.filter((d) => d.isVst);
        const missing = vstDevices.filter((d) => capabilityRef.current[d.id] == null);
        if (missing.length === 0) return;

        (async () => {
            const results = await Promise.all(
                missing.map(async (device) => {
                    try {
                        const cap = await engineApi.canOpenPluginEditorForSlot(selectedTrackId, device.id);
                        return [device.id, { supported: cap.supported, reason: cap.reason ?? undefined }] as const;
                    } catch (err) {
                        console.error('[Dream] Capability probe failed:', err);
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
    }, [chain, selectedTrackId]);

    // ── VST runtime status probes ──
    useEffect(() => {
        let cancelled = false;
        if (!selectedTrackId) return;
        const targets = chain.filter((d) => d.isVst);
        if (targets.length === 0) return;

        (async () => {
            const entries = await Promise.all(
                targets.map(async (device) => {
                    try {
                        const status = await engineApi.getPluginSlotRuntimeStatus(selectedTrackId, device.id);
                        return [device.id, status] as const;
                    } catch (err) {
                        console.error('[Dream] getPluginSlotRuntimeStatus failed:', err);
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
    }, [chain, selectedTrackId]);

    // ── External param fetch ──
    useEffect(() => {
        let cancelled = false;
        if (!selectedTrackId) return;
        const vstDevices = chain.filter((d) => d.isVst);
        const missing = vstDevices.filter((d) => !externalParamsRef.current[d.id]);
        if (missing.length === 0) return;

        (async () => {
            const results = await Promise.all(
                missing.map(async (device) => {
                    try {
                        const params = await engineApi.getExternalPluginParamsForSlot(selectedTrackId, device.id);
                        const mapped: PluginParam[] = params.map((p) => ({
                            name: p.name, min: p.min, max: p.max, step: p.step,
                            suffix: '',
                            value: p.value,
                            defaultValue: Number.isFinite(p.defaultValue ?? Number.NaN)
                                ? (p.defaultValue as number)
                                : (Number.isFinite(p.value) ? p.value : (p.min + p.max) * 0.5),
                        }));
                        return [device.id, mapped] as const;
                    } catch (err) {
                        console.error('[Dream] getExternalPluginParamsForSlot failed:', err);
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
    }, [chain, selectedTrackId]);

    const visibleExternalParamsBySlotId = useMemo(() => {
        const aliveVstSlotIds = new Set(chain.filter((d) => d.isVst).map((d) => d.id));
        const next: Record<string, PluginParam[]> = {};
        for (const [slotId, params] of Object.entries(externalParamsBySlotId)) {
            if (aliveVstSlotIds.has(slotId)) next[slotId] = params;
        }
        return next;
    }, [chain, externalParamsBySlotId]);

    return {
        pluginCapability,
        pluginRuntimeBySlot,
        setPluginRuntimeBySlot,
        externalParamsBySlotId: visibleExternalParamsBySlotId,
    };
}
