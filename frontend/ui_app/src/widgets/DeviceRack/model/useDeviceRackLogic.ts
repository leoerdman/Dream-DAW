/**
 * useDeviceRackLogic — All state, effects, and callbacks for DeviceRack.
 *
 * Refactored into a pure composition layer for FSD compliance.
 * Delegates to domain-specific micro-hooks.
 *
 * @module widgets/DeviceRack/model/useDeviceRackLogic
 */

import { useState, useCallback, useEffect, useRef } from 'react';
import { useEngineStore } from '@/shared/stores/useEngineStore';
import { useShallow } from 'zustand/react/shallow';
import { useStatusStore } from '@/shared/stores/useStatusStore';
import { useAutomationStore } from '@/shared/stores/useAutomationStore';
import type { BrowserDragItem } from '@/shared/lib/arrangementTypes';
import type { PluginSlotRuntimeStatus, ProjectDelta } from '@/shared/api/engine';

// Micro-hook imports
import { useDeviceRackCore } from './useDeviceRackCore';
import { useDeviceProbes } from './useDeviceProbes';
import { useDeviceParamGestures } from './useDeviceParamGestures';
import { useDeviceSnapshots } from './useDeviceSnapshots';
import { useDeviceKeyboardShortcuts } from './useDeviceKeyboardShortcuts';
import { useDeviceRackDnD } from './useDeviceRackDnD';
import { useDeviceRackSlotActions } from './useDeviceRackSlotActions';
import { useDeviceRackLifecycle } from './useDeviceRackLifecycle';
import type { AutomationLane } from '@/shared/stores/useAutomationStore';
import type { DeviceSlot, QuickPreset } from './types';

// --- Types ---
type AutoCtxMenuState = {
    x: number;
    y: number;
    paramName: string;
    deviceId: string;
} | null;

// The returned type interface remains identical to the original file to avoid breaking `DeviceRack.tsx`
export interface DeviceRackLogicOutput {
    chain: DeviceSlot[];
    selectedTrack: ReturnType<typeof useDeviceRackCore>['selectedTrack'];
    selectedTrackId: string;
    selectedDeviceIds: string[];
    isMaster: boolean;
    inLevelL: number;
    inLevelR: number;
    outLevelL: number;
    outLevelR: number;
    isDropActive: boolean;
    draggingItem: BrowserDragItem | null;
    sidechainOptions: Array<{ id: string; name: string }>;
    pluginCapability: Record<string, { supported: boolean; reason?: string }>;
    pluginRuntimeBySlot: Record<string, PluginSlotRuntimeStatus>;
    inlineSettingsOpen: Record<string, boolean>;
    paramSnapshotsByDevice: Record<string, { A?: Record<string, number>; B?: Record<string, number>; active?: 'A' | 'B' }>;
    openEditorsByTrack: Record<string, Set<string>>;
    autoCtxMenu: AutoCtxMenuState;
    automationLanes: Record<string, AutomationLane>;
    rackRef: React.RefObject<HTMLDivElement | null>;
    activeParamGesturesRef: React.RefObject<Set<string>>;
    toggleDevice: (device: DeviceSlot) => void;
    selectDevice: (deviceId: string, additive: boolean) => void;
    setPluginParam: (deviceId: string, paramName: string, value: number) => void;
    sendInternalParam: (device: DeviceSlot, paramName: string, value: number, options?: { gestureKey?: string; forcePushUndo?: boolean }) => void;
    beginParamGesture: (deviceId: string, paramName: string, gestureGroupId?: string) => void;
    endParamGesture: (deviceId: string, paramName: string) => void;
    applyQuickPreset: (device: DeviceSlot, preset: QuickPreset) => void;
    randomizeInternalPluginParams: (device: DeviceSlot) => void;
    resetInternalPluginParams: (device: DeviceSlot) => void;
    storeParamSnapshot: (device: DeviceSlot, slot: 'A' | 'B') => void;
    recallParamSnapshot: (device: DeviceSlot, slot: 'A' | 'B') => void;
    toggleParamSnapshot: (device: DeviceSlot) => void;
    applyQuickUtilityScene: (device: DeviceSlot, scene: 'center' | 'mono' | 'wide') => void;
    ensureSlotRuntimeActive: (slotId: string) => Promise<PluginSlotRuntimeStatus | null>;
    setPluginSidechainSource: (slotId: string, sourceTrackId: string) => Promise<void>;
    handleParamContextMenu: (e: React.MouseEvent, paramName: string, deviceId: string) => void;
    setAutoCtxMenu: React.Dispatch<React.SetStateAction<AutoCtxMenuState>>;
    setInlineSettingsOpen: React.Dispatch<React.SetStateAction<Record<string, boolean>>>;
    addAutomationLane: (trackId: string, paramName: string, paramKey: string, color?: string) => string;
    removeAutomationLane: (laneId: string) => void;
    toggleGlobalAutomation: () => void;
    statusClear: () => void;
    statusError: (msg: string) => void;
    applyProjectDeltas: (deltas: ProjectDelta[], reason?: string) => Promise<void>;
    togglePluginEditor: (trackId: string, slotId: string) => Promise<void>;
}

export function useDeviceRackLogic(
    selectedTrackId: string,
    onDropPluginToTrack?: (item: BrowserDragItem, trackId: string) => Promise<void>,
): DeviceRackLogicOutput {
    const rackRef = useRef<HTMLDivElement>(null);
    const prevTrackIdRef = useRef<string>(selectedTrackId);

    // Global stores
    const { openEditorsByTrack, togglePluginEditor, projectTracks , applyProjectDeltas } = useEngineStore(useShallow((s) => ({
        openEditorsByTrack: s.openEditorsByTrack,
        togglePluginEditor: s.togglePluginEditor,
        projectTracks: s.projectTracks,
        applyProjectDeltas: s.applyProjectDeltas,
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
    const trackEffectRefs = (core.selectedTrack?.effects ?? [])
        .map((fx) => fx.id)
        .filter((id): id is string => typeof id === 'string' && id.length > 0)
        .map((id) => ({ id }));
    const trackForOps = core.selectedTrack
        ? {
            id: core.selectedTrack.id,
            track_type: core.selectedTrack.track_type,
            effects: trackEffectRefs,
        }
        : null;

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
        trackForOps,
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
        trackForOps,
        core.setInlineSettingsOpen,
        applyProjectDeltas,
        statusClear,
        statusError
    );

    const dnd = useDeviceRackDnD(
        rackRef,
        core.selectedTrack,
        onDropPluginToTrack,
        applyProjectDeltas,
        statusClear,
        statusError,
    );

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

    const {
        toggleDevice,
        ensureSlotRuntimeActive,
        setPluginSidechainSource,
        sidechainOptions,
    } = useDeviceRackSlotActions({
        selectedTrack: core.selectedTrack
            ? {
                id: core.selectedTrack.id,
                name: core.selectedTrack.name ?? 'Track',
                effects: trackEffectRefs,
            }
            : null,
        localBypass: core.localBypass,
        setLocalBypass: core.setLocalBypass,
        projectTracks: projectTracks.map((track) => ({
            id: track.id,
            name: track.name,
            effects: track.effects ?? [],
        })),
        pluginRuntimeBySlot,
        setPluginRuntimeBySlot,
        applyProjectDeltas,
        statusError,
        statusClear,
    });

    const { setSelectedDeviceIds, setLocalParams } = core;

    const selectDevice = useCallback((deviceId: string, additive: boolean) => {
        setSelectedDeviceIds((prev) => {
            if (!additive) return [deviceId];
            return prev.includes(deviceId) ? prev.filter((id) => id !== deviceId) : [...prev, deviceId];
        });
    }, [setSelectedDeviceIds]);

    const setPluginParam = useCallback((deviceId: string, paramName: string, value: number) => {
        setLocalParams((prev) => ({ ...prev, [`${deviceId}:${paramName}`]: value }));
    }, [setLocalParams]);

    const toggleDeviceSafe = useCallback((device: DeviceSlot) => {
        toggleDevice({
            id: device.id,
            isEnabled: device.isEnabled,
            source: device.source === 'internal' ? 'internal' : 'external',
        });
    }, [toggleDevice]);

    useDeviceRackLifecycle({
        selectedTrackId,
        chain,
        openEditorsByTrack,
        prevTrackIdRef,
        cleanupGestures: gestures.cleanupGestures,
        setSelectedDeviceIds: core.setSelectedDeviceIds,
        setInlineSettingsOpen: core.setInlineSettingsOpen,
    });

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
        toggleDevice: toggleDeviceSafe,
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
        applyProjectDeltas,
        togglePluginEditor,
    };
}
