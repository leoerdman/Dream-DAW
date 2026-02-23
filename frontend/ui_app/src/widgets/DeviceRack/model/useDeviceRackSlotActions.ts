import { useCallback, useMemo } from 'react';
import * as engineApi from '@/shared/api/engine';
import { errorMessage } from '../model/deviceRackCatalog';
import type { ProjectDelta } from '@/shared/api/engine';

interface TrackLike {
    id: string;
    name: string;
    instrumentId?: string;
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
    trackIds: string[];
    tracksById: Record<string, { id: string; name: string; instrumentId?: string; effects: Array<{ id: string }> }>;
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
    trackIds,
    tracksById,
    pluginRuntimeBySlot,
    setPluginRuntimeBySlot,
    applyProjectDeltas,
    statusError,
    statusClear,
}: UseDeviceRackSlotActionsArgs) {
    const MASTER_TRACK_INDEX = 65535;
    const INSTRUMENT_SLOT_INDEX = 255;
    const trackIndexById = useMemo(() => new Map(trackIds.map((trackId, index) => [trackId, index] as const)), [trackIds]);

    const resolveTrackIdForSlot = useCallback((slotId: string): string | null => {
        if (selectedTrack?.effects.some((fx) => fx.id === slotId) || selectedTrack?.instrumentId === slotId) {
            return selectedTrack.id;
        }
        for (const trackId of trackIds) {
            const track = tracksById[trackId];
            if (track?.instrumentId === slotId || track?.effects?.some((fx) => fx.id === slotId)) {
                return track.id;
            }
        }
        return selectedTrack?.id ?? null;
    }, [selectedTrack, trackIds, tracksById]);

    const toggleDevice = useCallback((device: DeviceLike) => {
        const currentBypassed = localBypass[device.id] ?? !device.isEnabled;
        const nextBypassed = !currentBypassed;
        setLocalBypass((prev) => ({ ...prev, [device.id]: nextBypassed }));

        const targetTrackId = resolveTrackIdForSlot(device.id);
        if (!targetTrackId) return;

        void engineApi.setSlotBypassWithDeltas(targetTrackId, device.id, nextBypassed)
            .then((response) => applyProjectDeltas(response.deltas, 'device-rack:bypass'))
            .catch((err) => console.error('[DeviceRack] setSlotBypass failed:', err));

        if (device.source === 'internal') {
            const trackIdx = trackIndexById.get(targetTrackId)
                ?? (selectedTrack?.id === targetTrackId ? MASTER_TRACK_INDEX : -1);
            const ownerTrack = tracksById[targetTrackId];
            const ownerEffects = ownerTrack?.effects ?? selectedTrack?.effects ?? [];
            const ownerInstrumentId = ownerTrack?.instrumentId ?? selectedTrack?.instrumentId;
            const isInstrumentSlot = ownerInstrumentId === device.id;
            const effectSlotIdx = ownerEffects.findIndex((fx) => fx.id === device.id);
            const slotIdx = isInstrumentSlot ? INSTRUMENT_SLOT_INDEX : effectSlotIdx;
            if (trackIdx >= 0 && slotIdx >= 0) {
                void engineApi.bypassDevice(trackIdx, slotIdx, nextBypassed)
                    .catch((err: unknown) => console.error('[DeviceRack] bypassDevice failed:', err));
            }
        }
    }, [localBypass, resolveTrackIdForSlot, setLocalBypass, applyProjectDeltas, trackIndexById, tracksById]);

    const ensureSlotRuntimeActive = useCallback(async (slotId: string) => {
        if (!selectedTrack) return null;
        const targetTrackId = resolveTrackIdForSlot(slotId);
        if (!targetTrackId) return null;
        const known = pluginRuntimeBySlot[slotId];
        if (known?.runtime === 'unsupported') {
            statusError(known.message ?? 'This plugin format is not supported by runtime in this build.');
            return null;
        }

        const runActivation = async () => {
            await engineApi.ensurePluginSlotActive(targetTrackId, slotId);
            const status = await engineApi.getPluginSlotRuntimeStatus(targetTrackId, slotId);
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
    }, [selectedTrack, resolveTrackIdForSlot, pluginRuntimeBySlot, statusError, statusClear, setPluginRuntimeBySlot]);

    const setPluginSidechainSource = useCallback(async (slotId: string, sourceTrackId: string) => {
        const targetTrackId = resolveTrackIdForSlot(slotId);
        if (!targetTrackId) return;
        try {
            const response = await engineApi.setPluginSidechainSourceWithDeltas(
                targetTrackId,
                slotId,
                sourceTrackId || 'none',
            );
            await applyProjectDeltas(response.deltas, 'device-rack:set-sidechain-source');
            statusClear();
        } catch (err) {
            statusError(`Failed to set plugin sidechain source: ${errorMessage(err)}`);
        }
    }, [resolveTrackIdForSlot, applyProjectDeltas, statusClear, statusError]);

    const sidechainOptions = useMemo(
        () => trackIds
            .map((trackId) => tracksById[trackId])
            .filter((track): track is NonNullable<typeof track> => Boolean(track))
            .filter((track) => track.id !== (selectedTrack?.id ?? ''))
            .map((track) => ({ id: track.id, name: track.name })),
        [trackIds, tracksById, selectedTrack?.id],
    );

    return {
        toggleDevice,
        ensureSlotRuntimeActive,
        setPluginSidechainSource,
        sidechainOptions,
    };
}
