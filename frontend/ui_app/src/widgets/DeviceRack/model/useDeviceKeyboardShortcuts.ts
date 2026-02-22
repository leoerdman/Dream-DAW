import { useEffect } from 'react';
import * as engineApi from '@/shared/api/engineApi';
import type { ProjectDelta } from '@/shared/api/engine';

export function useDeviceKeyboardShortcuts(
    selectedDeviceIds: string[],
    setSelectedDeviceIds: React.Dispatch<React.SetStateAction<string[]>>,
    selectedTrack: any,
    setInlineSettingsOpen: React.Dispatch<React.SetStateAction<Record<string, boolean>>>,
    fetchProject: () => Promise<void>,
    applyProjectDeltas: (deltas: ProjectDelta[], reason?: string) => Promise<void>,
    statusClear: () => void,
    statusError: (msg: string) => void
) {
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
                    const response = await engineApi.pasteDeviceToTrackWithDeltas(selectedTrack.id, 'auto');
                    await applyProjectDeltas(response.deltas, 'device-rack:paste-device');
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
                const batched: ProjectDelta[] = [];
                for (const deviceId of selectedDeviceIds) {
                    const response = await engineApi.removePluginFromTrackWithDeltas(selectedTrack.id, deviceId);
                    batched.push(...response.deltas);
                }
                setInlineSettingsOpen((prev) => {
                    const next = { ...prev };
                    for (const deviceId of selectedDeviceIds) delete next[deviceId];
                    return next;
                });
                setSelectedDeviceIds([]);
                await applyProjectDeltas(batched, 'device-rack:delete-plugin');
                statusClear();
            } catch (err) {
                console.error('[DeviceRack] removePluginFromTrack failed:', err);
                statusError('Failed to remove plugin from track.');
            }
        };
        window.addEventListener('keydown', onKeyDown);
        return () => window.removeEventListener('keydown', onKeyDown);
    }, [selectedDeviceIds, selectedTrack, fetchProject, applyProjectDeltas, statusClear, statusError, setSelectedDeviceIds, setInlineSettingsOpen]);
}
