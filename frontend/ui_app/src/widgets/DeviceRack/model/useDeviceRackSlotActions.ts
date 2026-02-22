import { useCallback, useMemo } from 'react';
import * as engineApi from '@/shared/api/engine';
import { errorMessage } from '@/shared/lib/helpers';
import type { ProjectDelta } from '@/shared/api/engine';

interface TrackLike {
    id: string;
    name: string;
    effects: Array<{ id: string }>;
}

interface DeviceLike {
    id: string;
    isEnabled?: boolean;
    source?: 'internal' | 'external';
}

interface RuntimeBySlot {
    [slotId: string]: engineApi.PluginSlotRuntimeStatus;
}

interface UseDeviceRackSlotActionsArgs {
    selectedTrack: TrackLike | null;
    localBypass: Record<string, boolean>;
    setLocalBypass: React.Dispatch<React.SetStateAction<Record<string, boolean>>>;
    projectTracks: Array<{ id: string; name: string; effects: Array<{ id: string }> }>;
    pluginRuntimeBySlot: RuntimeBySlot;
    setPluginRuntimeBySlot: React.Dispatch<React.SetStateAction<RuntimeBySlot>>;
    applyProjectDeltas: (deltas: ProjectDelta[], reason?: string) => Promise<void>;
    statusError: (msg: string) => void;
    statusClear: () => void;
}

export function useDeviceRackSlotActions({
    selectedTrack,
    localBypass,
    setLocalBypass,
    projectTracks,
    pluginRuntimeBySlot,
    setPluginRuntimeBySlot,
    applyProjectDeltas,
    statusError,
    statusClear,
}: UseDeviceRackSlotActionsArgs) {
    const toggleDevice = useCallback((device: DeviceLike) => {
        const currentBypassed = localBypass[device.id] ?? !device.isEnabled;
        const nextBypassed = !currentBypassed;
        setLocalBypass((prev) => ({ ...prev, [device.id]: nextBypassed }));

        if (!selectedTrack) return;

        void engineApi.setSlotBypassWithDeltas(selectedTrack.id, device.id, nextBypassed)
            .then((response) => applyProjectDeltas(response.deltas, 'device-rack:bypass'))
            .catch((err) => console.error('[DeviceRack] setSlotBypass failed:', err));

        if (device.source === 'internal') {
            const trackIdx = projectTracks.findIndex((t) => t.id === selectedTrack.id);
            const slotIdx = selectedTrack.effects.findIndex((fx) => fx.id === device.id);
            if (trackIdx >= 0 && slotIdx >= 0) {
                void engineApi.bypassDevice(trackIdx, slotIdx, nextBypassed)
                    .catch((err: unknown) => console.error('[DeviceRack] bypassDevice failed:', err));
            }
        }
    }, [localBypass, selectedTrack, setLocalBypass, applyProjectDeltas, projectTracks]);

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
                    statusError(`Plugin activation failed: ${errorMessage(retryErr)}`);
                    return null;
                }
            }
            statusError(`Plugin activation failed: ${errorMessage(err)}`);
            return null;
        }
    }, [selectedTrack, pluginRuntimeBySlot, statusError, statusClear, setPluginRuntimeBySlot]);

    const setPluginSidechainSource = useCallback(async (slotId: string, sourceTrackId: string) => {
        if (!selectedTrack) return;
        try {
            const response = await engineApi.setPluginSidechainSourceWithDeltas(
                selectedTrack.id,
                slotId,
                sourceTrackId || 'none',
            );
            await applyProjectDeltas(response.deltas, 'device-rack:set-sidechain-source');
            statusClear();
        } catch (err) {
            statusError(`Failed to set plugin sidechain source: ${errorMessage(err)}`);
        }
    }, [selectedTrack, applyProjectDeltas, statusClear, statusError]);

    const sidechainOptions = useMemo(
        () => projectTracks
            .filter((t) => t.id !== (selectedTrack?.id ?? ''))
            .map((t) => ({ id: t.id, name: t.name })),
        [projectTracks, selectedTrack?.id],
    );

    return {
        toggleDevice,
        ensureSlotRuntimeActive,
        setPluginSidechainSource,
        sidechainOptions,
    };
}
