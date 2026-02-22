/**
 * useDeviceRackLogic — All state, effects, and callbacks for DeviceRack.
 *
 * Refactored into a pure composition layer for FSD compliance.
 * Delegates to domain-specific micro-hooks.
 *
 * @module widgets/DeviceRack/model/useDeviceRackLogic
 */

import { useMemo, useState, useCallback, useEffect, useRef } from 'react';
import { useEngineStore } from '@/shared/stores/useEngineStore';
import { useShallow } from 'zustand/react/shallow';
import { useStatusStore } from '@/shared/stores/useStatusStore';
import { useAutomationStore } from '@/shared/stores/useAutomationStore';
import * as engineApi from '@/shared/api/engineApi';
import type { BrowserDragItem } from '@/shared/lib/arrangementTypes';
import { errorMessage } from '@/shared/lib/helpers';

// Micro-hook imports
import { useDeviceRackCore } from './useDeviceRackCore';
import { useDeviceProbes } from './useDeviceProbes';
import { useDeviceParamGestures } from './useDeviceParamGestures';
import { useDeviceSnapshots } from './useDeviceSnapshots';
import { useDeviceKeyboardShortcuts } from './useDeviceKeyboardShortcuts';
import { useDeviceRackDnD } from './useDeviceRackDnD';
import type { DeviceRackLogic } from './types';
import type { AutomationLane } from '@/shared/stores/useAutomationStore';

// --- Types ---
type AutoCtxMenuState = {
    x: number;
    y: number;
    paramName: string;
    deviceId: string;
} | null;

// The returned type interface remains identical to the original file to avoid breaking `DeviceRack.tsx`
export interface DeviceRackLogicOutput {
    chain: any[];
    selectedTrack: any;
    selectedTrackId: string;
    selectedDeviceIds: string[];
    isMaster: boolean;
    inLevelL: number;
    inLevelR: number;
    outLevelL: number;
    outLevelR: number;
    isDropActive: boolean;
    draggingItem: any;
    sidechainOptions: Array<{ id: string; name: string }>;
    pluginCapability: Record<string, { supported: boolean; reason?: string }>;
    pluginRuntimeBySlot: Record<string, engineApi.PluginSlotRuntimeStatus>;
    inlineSettingsOpen: Record<string, boolean>;
    paramSnapshotsByDevice: Record<string, { A?: Record<string, number>; B?: Record<string, number>; active?: 'A' | 'B' }>;
    openEditorsByTrack: Record<string, Set<string>>;
    autoCtxMenu: AutoCtxMenuState;
    automationLanes: Record<string, AutomationLane>;
    rackRef: React.RefObject<HTMLDivElement | null>;
    activeParamGesturesRef: React.RefObject<Set<string>>;
    toggleDevice: (device: any) => void;
    selectDevice: (deviceId: string, additive: boolean) => void;
    setPluginParam: (deviceId: string, paramName: string, value: number) => void;
    sendInternalParam: (device: any, paramName: string, value: number, options?: { gestureKey?: string; forcePushUndo?: boolean }) => void;
    beginParamGesture: (deviceId: string, paramName: string, gestureGroupId?: string) => void;
    endParamGesture: (deviceId: string, paramName: string) => void;
    applyQuickPreset: (device: any, preset: any) => void;
    randomizeInternalPluginParams: (device: any) => void;
    resetInternalPluginParams: (device: any) => void;
    storeParamSnapshot: (device: any, slot: 'A' | 'B') => void;
    recallParamSnapshot: (device: any, slot: 'A' | 'B') => void;
    toggleParamSnapshot: (device: any) => void;
    applyQuickUtilityScene: (device: any, scene: 'center' | 'mono' | 'wide') => void;
    ensureSlotRuntimeActive: (slotId: string) => Promise<engineApi.PluginSlotRuntimeStatus | null>;
    setPluginSidechainSource: (slotId: string, sourceTrackId: string) => Promise<void>;
    handleParamContextMenu: (e: React.MouseEvent, paramName: string, deviceId: string) => void;
    setAutoCtxMenu: React.Dispatch<React.SetStateAction<AutoCtxMenuState>>;
    setInlineSettingsOpen: React.Dispatch<React.SetStateAction<Record<string, boolean>>>;
    addAutomationLane: any;
    removeAutomationLane: any;
    toggleGlobalAutomation: any;
    statusClear: () => void;
    statusError: (msg: string) => void;
    fetchProject: () => Promise<void>;
    togglePluginEditor: (trackId: string, slotId: string) => Promise<void>;
}

export function useDeviceRackLogic(
    selectedTrackId: string,
    onDropPluginToTrack?: (item: BrowserDragItem, trackId: string) => Promise<void>,
): DeviceRackLogicOutput {
    const rackRef = useRef<HTMLDivElement>(null);
    const prevTrackIdRef = useRef<string>(selectedTrackId);

    // Global stores
    const { openEditorsByTrack, togglePluginEditor, projectTracks, fetchProject } = useEngineStore(useShallow((s) => ({
        openEditorsByTrack: s.openEditorsByTrack,
        togglePluginEditor: s.togglePluginEditor,
        projectTracks: s.projectTracks,
        fetchProject: s.fetchProject,
    })));
    const statusError = useStatusStore((s) => s.setError);
    const statusClear = useStatusStore((s) => s.clear);

    const [autoCtxMenu, setAutoCtxMenu] = useState<AutoCtxMenuState>(null);
    const addAutomationLane = useAutomationStore((s) => s.addLane);
    const removeAutomationLane = useAutomationStore((s) => s.removeLane);
    const automationLanes = useAutomationStore((s) => s.lanes);
    const toggleGlobalAutomation = useAutomationStore((s) => s.toggleGlobalVisible);

    // --- Core Data ---
    const core = useDeviceRackCore(selectedTrackId);

    // Build full chain with external parameters injected
    const { pluginCapability, pluginRuntimeBySlot, setPluginRuntimeBySlot, externalParamsBySlotId } = useDeviceProbes(
        core.buildChain({}), // Dummy chain to start (or handle dependency better)
        selectedTrackId,
        core.selectedTrack
    );
    const chain = core.buildChain(externalParamsBySlotId);

    // --- Gestures & Automation ---
    const gestures = useDeviceParamGestures(
        chain,
        selectedTrackId,
        core.selectedTrack,
        useEngineStore.getState().projectTracks,
        core.isMaster,
        core.setLocalParams
    );

    // --- Snapshots ---
    const snapshots = useDeviceSnapshots(gestures.applyParamBatch);

    // --- Shortcuts & DnD ---
    useDeviceKeyboardShortcuts(
        core.selectedDeviceIds,
        core.setSelectedDeviceIds,
        core.selectedTrack,
        core.setInlineSettingsOpen,
        fetchProject,
        statusClear,
        statusError
    );

    const dnd = useDeviceRackDnD(rackRef, core.selectedTrack, onDropPluginToTrack, fetchProject, statusClear, statusError);

    // --- Context Menu ---
    const handleParamContextMenu = useCallback((e: React.MouseEvent, paramName: string, deviceId: string) => {
        e.preventDefault();
        e.stopPropagation();
        setAutoCtxMenu({ x: e.clientX, y: e.clientY, paramName, deviceId });
    }, []);

    useEffect(() => {
        if (!autoCtxMenu) return;
        const close = () => setAutoCtxMenu(null);
        window.addEventListener('mousedown', close);
        return () => window.removeEventListener('mousedown', close);
    }, [autoCtxMenu]);

    // --- Specific local handlers ---
    const toggleDevice = useCallback((device: any) => {
        const currentBypassed = core.localBypass[device.id] ?? !device.isEnabled;
        const nextBypassed = !currentBypassed;
        core.setLocalBypass((prev) => ({ ...prev, [device.id]: nextBypassed }));

        if (!core.selectedTrack) return;

        void engineApi.setSlotBypass(core.selectedTrack.id.toString(), device.id, nextBypassed)
            .catch((err) => console.error('[DeviceRack] setSlotBypass failed:', err));

        if (device.source === 'internal') {
            const trackIdx = projectTracks.findIndex((t) => t.id === core.selectedTrack.id);
            const slotIdx = core.selectedTrack.effects.findIndex((fx: any) => fx.id === device.id);
            if (trackIdx >= 0 && slotIdx >= 0) {
                void engineApi.bypassDevice(trackIdx, slotIdx, nextBypassed)
                    .catch((err: any) => console.error('[DeviceRack] bypassDevice failed:', err));
            }
        }
    }, [core.localBypass, core.selectedTrack, projectTracks, core.setLocalBypass]);

    const selectDevice = useCallback((deviceId: string, additive: boolean) => {
        core.setSelectedDeviceIds((prev) => {
            if (!additive) return [deviceId];
            return prev.includes(deviceId) ? prev.filter((id) => id !== deviceId) : [...prev, deviceId];
        });
    }, [core.setSelectedDeviceIds]);

    const setPluginParam = useCallback((deviceId: string, paramName: string, value: number) => {
        core.setLocalParams((prev) => ({ ...prev, [`${deviceId}:${paramName}`]: value }));
    }, [core.setLocalParams]);

    // Ensure slot runtime
    const ensureSlotRuntimeActive = useCallback(async (slotId: string) => {
        if (!core.selectedTrack) return null;
        const known = pluginRuntimeBySlot[slotId];
        if (known?.runtime === 'unsupported') {
            statusError(known.message ?? 'This plugin format is not supported by runtime in this build.');
            return null;
        }

        const runActivation = async () => {
            await engineApi.ensurePluginSlotActive(core.selectedTrack.id, slotId);
            const status = await engineApi.getPluginSlotRuntimeStatus(core.selectedTrack.id, slotId);
            setPluginRuntimeBySlot((prev) => ({ ...prev, [slotId]: status }));
            return status;
        };

        try {
            const status = await runActivation();
            statusClear();
            return status;
        } catch (err) {
            const firstMsg = errorMessage(err).toLowerCase();
            const shouldRescan = firstMsg.includes('cannot find native binary') || firstMsg.includes('plugin not found') || firstMsg.includes('failed to load plugin');
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
    }, [core.selectedTrack, pluginRuntimeBySlot, statusError, statusClear, setPluginRuntimeBySlot]);

    const setPluginSidechainSource = useCallback(async (slotId: string, sourceTrackId: string) => {
        if (!core.selectedTrack) return;
        try {
            await engineApi.setPluginSidechainSource(core.selectedTrack.id, slotId, sourceTrackId || 'none');
            await fetchProject();
            statusClear();
        } catch (err: any) {
            statusError(`Failed to set plugin sidechain source: ${errorMessage(err)}`);
        }
    }, [core.selectedTrack, fetchProject, statusClear, statusError]);

    const sidechainOptions = useMemo(
        () => projectTracks.filter((t) => t.id !== (core.selectedTrack?.id ?? '')).map((t) => ({ id: t.id, name: t.name })),
        [projectTracks, core.selectedTrack?.id],
    );

    // Sync state layout
    useEffect(() => {
        core.setSelectedDeviceIds((prev) => prev.filter((id) => chain.some((d) => d.id === id)));
        core.setInlineSettingsOpen((prev) => {
            const next: Record<string, boolean> = {};
            const ids = new Set(chain.map((d) => d.id));
            for (const [id, isOpen] of Object.entries(prev)) {
                if (ids.has(id) && isOpen) next[id] = true;
            }
            return next;
        });
    }, [chain, core.setSelectedDeviceIds, core.setInlineSettingsOpen]);

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
    }, [selectedTrackId, openEditorsByTrack]);

    useEffect(() => {
        gestures.cleanupGestures();
    }, [selectedTrackId, gestures]);

    return {
        chain,
        selectedTrack: core.selectedTrack,
        selectedTrackId,
        selectedDeviceIds: core.selectedDeviceIds,
        isMaster: core.isMaster,
        inLevelL: core.inLevelL,
        inLevelR: core.inLevelR,
        outLevelL: core.outLevelL,
        outLevelR: core.outLevelR,
        isDropActive: dnd.isDropActive,
        draggingItem: dnd.draggingItem,
        sidechainOptions,
        pluginCapability,
        pluginRuntimeBySlot,
        inlineSettingsOpen: core.inlineSettingsOpen,
        paramSnapshotsByDevice: snapshots.paramSnapshotsByDevice,
        openEditorsByTrack,
        autoCtxMenu,
        automationLanes,
        rackRef,
        activeParamGesturesRef: gestures.activeParamGesturesRef,
        toggleDevice,
        selectDevice,
        setPluginParam,
        sendInternalParam: gestures.sendInternalParam,
        beginParamGesture: gestures.beginParamGesture,
        endParamGesture: gestures.endParamGesture,
        applyQuickPreset: snapshots.applyQuickPreset,
        randomizeInternalPluginParams: snapshots.randomizeInternalPluginParams,
        resetInternalPluginParams: snapshots.resetInternalPluginParams,
        storeParamSnapshot: snapshots.storeParamSnapshot,
        recallParamSnapshot: snapshots.recallParamSnapshot,
        toggleParamSnapshot: snapshots.toggleParamSnapshot,
        applyQuickUtilityScene: snapshots.applyQuickUtilityScene,
        ensureSlotRuntimeActive,
        setPluginSidechainSource,
        handleParamContextMenu,
        setAutoCtxMenu,
        setInlineSettingsOpen: core.setInlineSettingsOpen,
        addAutomationLane,
        removeAutomationLane,
        toggleGlobalAutomation,
        statusClear,
        statusError,
        fetchProject,
        togglePluginEditor,
    };
}
