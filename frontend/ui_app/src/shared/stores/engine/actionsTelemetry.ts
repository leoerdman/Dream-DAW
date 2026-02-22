import { listen, type UnlistenFn } from '@tauri-apps/api/event';
import type { StoreApi } from 'zustand';
import * as engine from '@/shared/api/engine';
import type {
    MeteringSnapshot,
    PluginCrashEvent,
    PluginRecoveryEvent,
    PluginSandboxSnapshot,
    TransportState,
} from '@/shared/api/engine';
import type { EngineStore } from '@/shared/stores/useEngineStore';
import {
    METER_STATE_UPDATE_EVERY_TICKS,
    patchSandboxInstancesById,
    PROJECT_HISTORY_SYNC_EVERY_TICKS,
} from '@/shared/stores/engine/storeHelpers';

interface SandboxSlotUpdateEvent {
    instanceId?: string;
    instanceIds?: string[];
}

let telemetryStarted = false;
let telemetryUnlisten: UnlistenFn | null = null;
let pluginSandboxUnlisten: UnlistenFn | null = null;
let pluginSandboxCrashUnlisten: UnlistenFn | null = null;
let pluginSandboxRecoveredUnlisten: UnlistenFn | null = null;
let pluginSandboxAutoBypassUnlisten: UnlistenFn | null = null;
let pluginSandboxAutoRecoveredUnlisten: UnlistenFn | null = null;
let pluginSandboxReloadedUnlisten: UnlistenFn | null = null;

let bpmPendingUntil = 0;
let meterFrameCounter = 0;
let latestMeters: MeteringSnapshot | null = null;
let pendingUpdate: Partial<EngineStore> = {};
let rafPending = false;

function flushPendingStoreUpdate(set: StoreApi<EngineStore>['setState']): void {
    rafPending = false;
    const update = pendingUpdate;
    pendingUpdate = {};
    if (Object.keys(update).length > 0) set(update);
}

function enqueuePendingStoreUpdate(
    set: StoreApi<EngineStore>['setState'],
    partial: Partial<EngineStore>,
): void {
    pendingUpdate = { ...pendingUpdate, ...partial };
    if (rafPending) return;
    rafPending = true;
    requestAnimationFrame(() => flushPendingStoreUpdate(set));
}

export function markBpmPending(ms: number): void {
    bpmPendingUntil = Date.now() + ms;
}

export function readLatestMeters(fallback: MeteringSnapshot): MeteringSnapshot {
    return latestMeters ?? fallback;
}

export function createTelemetryActions(
    set: StoreApi<EngineStore>['setState'],
    get: StoreApi<EngineStore>['getState'],
): Pick<EngineStore, 'startTelemetryLoop' | 'stopTelemetryLoop' | 'reloadCrashedSandboxPlugins' | 'togglePluginEditor' | 'closeAllPluginEditors'> {
    return {
        startTelemetryLoop: () => {
            if (telemetryStarted) return;
            telemetryStarted = true;

            queueMicrotask(() => {
                set({ telemetryRunning: true });
                void get().fetchProject('telemetry-startup');
            });
            let tickCounter = 0;

            void (async () => {
                try {
                    telemetryUnlisten = await listen<{ transport: TransportState; meters: MeteringSnapshot }>(
                        'telemetry_tick',
                        (event) => {
                            tickCounter++;
                            if (tickCounter % PROJECT_HISTORY_SYNC_EVERY_TICKS === 0) void get().syncProjectHistory();
                            const nextTransport = event.payload.transport;
                            const prev = get().transport;
                            const bpmProtected = Date.now() < bpmPendingUntil;
                            const effectiveTransport = bpmProtected ? { ...nextTransport, bpm: prev.bpm } : nextTransport;
                            const transportChanged = prev.is_playing !== effectiveTransport.is_playing
                                || prev.position_beats !== effectiveTransport.position_beats
                                || prev.position_frames !== effectiveTransport.position_frames
                                || prev.bpm !== effectiveTransport.bpm
                                || prev.loop_enabled !== effectiveTransport.loop_enabled
                                || prev.loop_start !== effectiveTransport.loop_start
                                || prev.loop_end !== effectiveTransport.loop_end;

                            latestMeters = event.payload.meters;
                            meterFrameCounter++;
                            const shouldUpdateMeterState = meterFrameCounter % METER_STATE_UPDATE_EVERY_TICKS === 0;
                            if (transportChanged) pendingUpdate = { ...pendingUpdate, transport: effectiveTransport, connected: true, lastError: null };
                            if (shouldUpdateMeterState) pendingUpdate = { ...pendingUpdate, meters: event.payload.meters, connected: true, lastError: null };
                            if (!get().connected && !pendingUpdate.connected) pendingUpdate = { ...pendingUpdate, connected: true, lastError: null };
                            enqueuePendingStoreUpdate(set, {});
                        },
                    );
                    pluginSandboxUnlisten = await listen<PluginSandboxSnapshot>('plugin_sandbox_tick', (event) => {
                        enqueuePendingStoreUpdate(set, { pluginSandbox: event.payload });
                    });
                    pluginSandboxCrashUnlisten = await listen<PluginCrashEvent>('plugin_sandbox_crashed', (event) => {
                        const crash = event.payload;
                        const state = get();
                        const nextSandbox = state.pluginSandbox ? {
                            ...state.pluginSandbox,
                            instances: state.pluginSandbox.instances.map((inst) => inst.plugin_instance_id === crash.instance_id ? {
                                ...inst, status: 'crashed' as const, bypass_requested: true, crash_count: Math.max(inst.crash_count, crash.crash_count), last_error: crash.reason,
                            } : inst),
                        } : state.pluginSandbox;
                        enqueuePendingStoreUpdate(set, { pluginSandbox: nextSandbox, lastError: `Plugin crashed: ${crash.plugin_name} (${crash.reason})` });
                    });
                    pluginSandboxRecoveredUnlisten = await listen<PluginRecoveryEvent>('plugin_sandbox_recovered', (event) => {
                        const recovery = event.payload;
                        const nextSandbox = patchSandboxInstancesById(get().pluginSandbox, new Set([recovery.instance_id]), (inst) => ({
                            ...inst, status: 'running' as const, bypass_requested: false, crash_count: Math.max(inst.crash_count, recovery.crash_count), restart_count: Math.max(inst.restart_count, recovery.restart_count), last_error: null,
                        }));
                        enqueuePendingStoreUpdate(set, { pluginSandbox: nextSandbox, lastError: null });
                    });
                    pluginSandboxAutoBypassUnlisten = await listen<SandboxSlotUpdateEvent>('plugin_sandbox_auto_bypass', (event) => {
                        const nextSandbox = patchSandboxInstancesById(get().pluginSandbox, new Set(event.payload.instanceIds ?? []), (inst) => ({
                            ...inst, bypass_requested: true, status: (inst.status === 'running' ? 'crashed' : inst.status) as typeof inst.status,
                        }));
                        enqueuePendingStoreUpdate(set, { pluginSandbox: nextSandbox });
                    });
                    pluginSandboxAutoRecoveredUnlisten = await listen<SandboxSlotUpdateEvent>('plugin_sandbox_auto_recovered', (event) => {
                        const nextSandbox = patchSandboxInstancesById(get().pluginSandbox, new Set(event.payload.instanceIds ?? []), (inst) => ({
                            ...inst, bypass_requested: false, status: 'running' as const, last_error: null,
                        }));
                        enqueuePendingStoreUpdate(set, { pluginSandbox: nextSandbox, lastError: null });
                    });
                    pluginSandboxReloadedUnlisten = await listen<SandboxSlotUpdateEvent>('plugin_sandbox_reloaded', (event) => {
                        const instanceIds = new Set([...(event.payload.instanceIds ?? []), ...(event.payload.instanceId ? [event.payload.instanceId] : [])]);
                        const nextSandbox = patchSandboxInstancesById(get().pluginSandbox, instanceIds, (inst) => ({ ...inst, status: 'spawning' as const }));
                        enqueuePendingStoreUpdate(set, { pluginSandbox: nextSandbox });
                    });
                } catch (e) {
                    telemetryStarted = false;
                    const msg = String(e);
                    if (get().lastError !== msg) set({ lastError: msg, connected: false, telemetryRunning: false });
                }
            })();
        },

        stopTelemetryLoop: () => {
            telemetryStarted = false;
            set({ telemetryRunning: false });
            telemetryUnlisten?.(); telemetryUnlisten = null;
            pluginSandboxUnlisten?.(); pluginSandboxUnlisten = null;
            pluginSandboxCrashUnlisten?.(); pluginSandboxCrashUnlisten = null;
            pluginSandboxRecoveredUnlisten?.(); pluginSandboxRecoveredUnlisten = null;
            pluginSandboxAutoBypassUnlisten?.(); pluginSandboxAutoBypassUnlisten = null;
            pluginSandboxAutoRecoveredUnlisten?.(); pluginSandboxAutoRecoveredUnlisten = null;
            pluginSandboxReloadedUnlisten?.(); pluginSandboxReloadedUnlisten = null;
        },

        reloadCrashedSandboxPlugins: async () => {
            const snapshot = get().pluginSandbox;
            if (!snapshot || !snapshot.enabled) return;
            const hasUnhealthy = snapshot.instances.some((inst) => inst.status === 'crashed' || inst.status === 'timed_out' || inst.bypass_requested);
            if (!hasUnhealthy) return;
            try {
                const response = await engine.reloadUnhealthyPluginSandboxes();
                set({ pluginSandbox: response.snapshot, lastError: response.errors.length > 0 ? `Sandbox reload failed: ${response.errors.join('; ')}` : null });
            } catch (e) {
                set({ lastError: `Sandbox reload failed: ${String(e)}` });
            }
        },

        togglePluginEditor: async (trackId: string, slotId: string) => {
            const { openEditorsByTrack } = get();
            const trackSet = openEditorsByTrack[trackId] || new Set<string>();
            const isOpen = trackSet.has(slotId);
            try {
                if (isOpen) {
                    await engine.closePluginWindowForSlot(trackId, slotId);
                    const nextSet = new Set(trackSet); nextSet.delete(slotId);
                    set((s) => ({ openEditorsByTrack: { ...s.openEditorsByTrack, [trackId]: nextSet } }));
                } else {
                    await engine.openPluginWindowForSlot(trackId, slotId);
                    const nextSet = new Set(trackSet); nextSet.add(slotId);
                    set((s) => ({ openEditorsByTrack: { ...s.openEditorsByTrack, [trackId]: nextSet } }));
                }
                set({ lastError: null });
            } catch (e) {
                set({ lastError: String(e) });
            }
        },

        closeAllPluginEditors: async () => {
            const { openEditorsByTrack } = get();
            for (const [trackId, slots] of Object.entries(openEditorsByTrack)) {
                for (const slotId of slots) {
                    try { await engine.closePluginWindowForSlot(trackId, slotId); } catch { /* no-op */ }
                }
            }
            set({ openEditorsByTrack: {} });
        },
    };
}
