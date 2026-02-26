import { listen, type UnlistenFn } from '@tauri-apps/api/event';
import type { StoreApi } from 'zustand';
import * as engine from '@/shared/api/engine';
import type { MeteringSnapshot, PluginCrashEvent, PluginRecoveryEvent, PluginSandboxSnapshot, TransportState } from '@/shared/api/engine';
import { decodeMetersBinaryPacket } from '@/shared/lib/binaryMeters';
import { METER_STATE_UPDATE_EVERY_TICKS, patchSandboxInstancesById, PROJECT_HISTORY_SYNC_EVERY_TICKS } from '@/shared/stores/engine/storeHelpers';
import { smoothMeterSnapshot } from '@/shared/stores/engine/actionsTelemetrySmoothing';
import { enqueuePendingStoreUpdate, payloadToUint8Array } from '@/shared/stores/engine/actionsTelemetryQueue';
import { createPluginEditorActions } from '@/shared/stores/engine/actionsTelemetryEditors';
import type { EngineStore } from '@/shared/stores/useEngineStore';
let telemetryStarted = false;
let telemetryUnlisten: UnlistenFn | null = null;
let pluginSandboxUnlisten: UnlistenFn | null = null;
let pluginSandboxCrashUnlisten: UnlistenFn | null = null;
let pluginSandboxRecoveredUnlisten: UnlistenFn | null = null;
let pluginSandboxAutoBypassUnlisten: UnlistenFn | null = null;
let pluginSandboxAutoRecoveredUnlisten: UnlistenFn | null = null;
let pluginSandboxReloadedUnlisten: UnlistenFn | null = null;
let telemetryMetersBinaryUnlisten: UnlistenFn | null = null;

let bpmPendingUntil = 0;
let meterFrameCounter = 0;
let latestMeters: MeteringSnapshot | null = null;
let smoothedMeters: MeteringSnapshot | null = null;
let lastMeterTickMs = 0;

export function resetTelemetryModuleState(): void {
    bpmPendingUntil = 0;
    meterFrameCounter = 0;
    latestMeters = null;
    smoothedMeters = null;
    lastMeterTickMs = 0;
}

interface SandboxSlotUpdateEvent {
    instanceId?: string;
    instanceIds?: string[];
}

export function createTelemetryActions(
    set: StoreApi<EngineStore>['setState'],
    get: StoreApi<EngineStore>['getState'],
): Pick<EngineStore, 'startTelemetryLoop' | 'stopTelemetryLoop' | 'reloadCrashedSandboxPlugins' | 'togglePluginEditor' | 'closeAllPluginEditors'> {
    const pluginEditorActions = createPluginEditorActions(set, get);

    return {
        startTelemetryLoop: () => {
            if (telemetryStarted) return;
            telemetryStarted = true;
            set({ telemetryRunning: true });
            let tickCounter = 0;
            void (async () => {
                try {
                    telemetryUnlisten = await listen<{
                        transport: TransportState;
                        performance: {
                            cpu_usage: number;
                            ram_used_mb: number;
                            ram_total_mb: number;
                            process_memory_mb: number;
                            dsp_load: number;
                        };
                    }>(
                        'telemetry_tick',
                        (event) => {
                            tickCounter++;
                            const telemetryUpdate: Partial<EngineStore> = {};
                            if (tickCounter % PROJECT_HISTORY_SYNC_EVERY_TICKS === 0) {
                                void get().syncProjectHistory();
                            }
                            const nextTransport = event.payload.transport;
                            const prev = get().transport;
                            const bpmProtected = performance.now() < bpmPendingUntil;
                            // BUG-B005 FIX: Only create a new object when the BPM
                            // actually needs to be overridden. Previously spread
                            // created a new object on every tick (~30Hz), triggering
                            // unnecessary re-renders in all transport subscribers.
                            const effectiveTransport = (bpmProtected && nextTransport.bpm !== prev.bpm)
                                ? { ...nextTransport, bpm: prev.bpm }
                                : nextTransport;
                            const transportChanged = prev.is_playing !== effectiveTransport.is_playing
                                || prev.position_beats !== effectiveTransport.position_beats
                                || prev.position_frames !== effectiveTransport.position_frames
                                || prev.bpm !== effectiveTransport.bpm
                                || prev.loop_enabled !== effectiveTransport.loop_enabled
                                || prev.loop_start !== effectiveTransport.loop_start
                                || prev.loop_end !== effectiveTransport.loop_end
                                || prev.time_sig_numerator !== effectiveTransport.time_sig_numerator
                                || prev.time_sig_denominator !== effectiveTransport.time_sig_denominator;
                            if (transportChanged) {
                                telemetryUpdate.transport = effectiveTransport;
                                telemetryUpdate.timeSigNumerator = effectiveTransport.time_sig_numerator;
                                telemetryUpdate.timeSigDenominator = effectiveTransport.time_sig_denominator;
                                telemetryUpdate.connected = true;
                                telemetryUpdate.lastError = null;
                            }
                            const perf = event.payload.performance;
                            // BUG-023 FIX: Only create new performance object when values change.
                            // Previously allocated on every tick (~30Hz) triggering needless re-renders.
                            const prev_perf = get().performance;
                            if (
                                perf.cpu_usage !== prev_perf.cpuUsage ||
                                perf.ram_used_mb !== prev_perf.ramUsedMb ||
                                perf.ram_total_mb !== prev_perf.ramTotalMb ||
                                perf.process_memory_mb !== prev_perf.processMemoryMb ||
                                perf.dsp_load !== prev_perf.dspLoad
                            ) {
                                telemetryUpdate.performance = {
                                    cpuUsage: perf.cpu_usage,
                                    ramUsedMb: perf.ram_used_mb,
                                    ramTotalMb: perf.ram_total_mb,
                                    processMemoryMb: perf.process_memory_mb,
                                    dspLoad: perf.dsp_load,
                                };
                            }
                            if (!get().connected && !telemetryUpdate.connected) {
                                telemetryUpdate.connected = true;
                                telemetryUpdate.lastError = null;
                            }
                            enqueuePendingStoreUpdate(set, telemetryUpdate);
                        },
                    );
                    telemetryMetersBinaryUnlisten = await listen<number[] | Uint8Array | ArrayBuffer>(
                        'telemetry_meters_binary',
                        (event) => {
                            // BUG-055 FIX: Modular wrap to prevent precision loss at 2^53.
                            // At ~30Hz tick rate, 0x7FFFFFFF gives ~2.3 billion cycles (~2.4 years).
                            meterFrameCounter = (meterFrameCounter + 1) & 0x7FFFFFFF;
                            if (meterFrameCounter % METER_STATE_UPDATE_EVERY_TICKS !== 0) return;
                            const packet = payloadToUint8Array(event.payload);
                            const decodedMeters = decodeMetersBinaryPacket(packet);
                            const nowMs = performance.now();
                            const { snapshot: nextMeters, nextTickMs } = smoothMeterSnapshot(
                                smoothedMeters,
                                decodedMeters,
                                nowMs,
                                lastMeterTickMs,
                            );
                            lastMeterTickMs = nextTickMs;
                            smoothedMeters = nextMeters;
                            latestMeters = nextMeters;
                            enqueuePendingStoreUpdate(set, {
                                meters: nextMeters,
                                connected: true,
                                lastError: null,
                            });
                        },
                    );
                    pluginSandboxUnlisten = await listen<PluginSandboxSnapshot>(
                        'plugin_sandbox_tick',
                        (event) => {
                            enqueuePendingStoreUpdate(set, { pluginSandbox: event.payload });
                        },
                    );
                    pluginSandboxCrashUnlisten = await listen<PluginCrashEvent>(
                        'plugin_sandbox_crashed',
                        (event) => {
                            const crash = event.payload;
                            const state = get();
                            const nextSandbox = state.pluginSandbox
                                ? {
                                    ...state.pluginSandbox,
                                    instances: state.pluginSandbox.instances.map((inst) => (
                                        inst.plugin_instance_id === crash.instance_id
                                            ? {
                                                ...inst,
                                                status: 'crashed' as const,
                                                bypass_requested: true,
                                                crash_count: Math.max(inst.crash_count, crash.crash_count),
                                                last_error: crash.reason,
                                            }
                                            : inst
                                    )),
                                }
                                : state.pluginSandbox;
                            enqueuePendingStoreUpdate(set, {
                                pluginSandbox: nextSandbox,
                                lastError: `Plugin crashed: ${crash.plugin_name} (${crash.reason})`,
                            });
                        },
                    );
                    pluginSandboxRecoveredUnlisten = await listen<PluginRecoveryEvent>(
                        'plugin_sandbox_recovered',
                        (event) => {
                            const recovery = event.payload;
                            const nextSandbox = patchSandboxInstancesById(
                                get().pluginSandbox,
                                new Set([recovery.instance_id]),
                                (inst) => ({
                                    ...inst,
                                    status: 'running' as const,
                                    bypass_requested: false,
                                    crash_count: Math.max(inst.crash_count, recovery.crash_count),
                                    restart_count: Math.max(inst.restart_count, recovery.restart_count),
                                    last_error: null,
                                }),
                            );
                            // BUG-097 FIX: Only clear lastError if it was set by a plugin crash.
                            // Previously cleared errors from unrelated subsystems.
                            const currentError = get().lastError;
                            const clearError = currentError?.startsWith('Plugin crashed:') ? null : currentError;
                            enqueuePendingStoreUpdate(set, { pluginSandbox: nextSandbox, lastError: clearError });
                        },
                    );
                    pluginSandboxAutoBypassUnlisten = await listen<SandboxSlotUpdateEvent>(
                        'plugin_sandbox_auto_bypass',
                        (event) => {
                            const nextSandbox = patchSandboxInstancesById(
                                get().pluginSandbox,
                                new Set(event.payload.instanceIds ?? []),
                                (inst) => ({
                                    ...inst,
                                    bypass_requested: true,
                                    status: (inst.status === 'running' ? 'crashed' : inst.status) as typeof inst.status,
                                }),
                            );
                            enqueuePendingStoreUpdate(set, { pluginSandbox: nextSandbox });
                        },
                    );
                    pluginSandboxAutoRecoveredUnlisten = await listen<SandboxSlotUpdateEvent>(
                        'plugin_sandbox_auto_recovered',
                        (event) => {
                            const nextSandbox = patchSandboxInstancesById(
                                get().pluginSandbox,
                                new Set(event.payload.instanceIds ?? []),
                                (inst) => ({
                                    ...inst,
                                    bypass_requested: false,
                                    status: 'running' as const,
                                    last_error: null,
                                }),
                            );
                            enqueuePendingStoreUpdate(set, { pluginSandbox: nextSandbox, lastError: null });
                        },
                    );
                    pluginSandboxReloadedUnlisten = await listen<SandboxSlotUpdateEvent>(
                        'plugin_sandbox_reloaded',
                        (event) => {
                            const instanceIds = new Set([
                                ...(event.payload.instanceIds ?? []),
                                ...(event.payload.instanceId ? [event.payload.instanceId] : []),
                            ]);
                            const nextSandbox = patchSandboxInstancesById(
                                get().pluginSandbox,
                                instanceIds,
                                (inst) => ({ ...inst, status: 'spawning' as const }),
                            );
                            enqueuePendingStoreUpdate(set, { pluginSandbox: nextSandbox });
                        },
                    );
                } catch (e) {
                    // BUG-010 FIX: Clean up any partially-registered listeners.
                    // Previously only reset flag, leaking listeners registered
                    // before the error. Next startTelemetryLoop() would add duplicates.
                    telemetryStarted = false;
                    telemetryUnlisten?.(); telemetryUnlisten = null;
                    telemetryMetersBinaryUnlisten?.(); telemetryMetersBinaryUnlisten = null;
                    pluginSandboxUnlisten?.(); pluginSandboxUnlisten = null;
                    pluginSandboxCrashUnlisten?.(); pluginSandboxCrashUnlisten = null;
                    pluginSandboxRecoveredUnlisten?.(); pluginSandboxRecoveredUnlisten = null;
                    pluginSandboxAutoBypassUnlisten?.(); pluginSandboxAutoBypassUnlisten = null;
                    pluginSandboxAutoRecoveredUnlisten?.(); pluginSandboxAutoRecoveredUnlisten = null;
                    pluginSandboxReloadedUnlisten?.(); pluginSandboxReloadedUnlisten = null;
                    const msg = String(e);
                    if (get().lastError !== msg) {
                        set({ lastError: msg, connected: false, telemetryRunning: false });
                    }
                }
            })();
        },
        stopTelemetryLoop: () => {
            telemetryStarted = false;
            set({ telemetryRunning: false });
            telemetryUnlisten?.();
            telemetryUnlisten = null;
            pluginSandboxUnlisten?.();
            pluginSandboxUnlisten = null;
            pluginSandboxCrashUnlisten?.();
            pluginSandboxCrashUnlisten = null;
            pluginSandboxRecoveredUnlisten?.();
            pluginSandboxRecoveredUnlisten = null;
            pluginSandboxAutoBypassUnlisten?.();
            pluginSandboxAutoBypassUnlisten = null;
            pluginSandboxAutoRecoveredUnlisten?.();
            pluginSandboxAutoRecoveredUnlisten = null;
            pluginSandboxReloadedUnlisten?.();
            pluginSandboxReloadedUnlisten = null;
            telemetryMetersBinaryUnlisten?.();
            telemetryMetersBinaryUnlisten = null;
        },
        reloadCrashedSandboxPlugins: async () => {
            const snapshot = get().pluginSandbox;
            if (!snapshot || !snapshot.enabled) return;
            const hasUnhealthy = snapshot.instances.some((inst) =>
                inst.status === 'crashed' || inst.status === 'timed_out' || inst.bypass_requested,
            );
            if (!hasUnhealthy) return;
            try {
                const response = await engine.reloadUnhealthyPluginSandboxes();
                set({
                    pluginSandbox: response.snapshot,
                    lastError: response.errors.length > 0
                        ? `Sandbox reload failed: ${response.errors.join('; ')}`
                        : null,
                });
            } catch (e) {
                set({ lastError: `Sandbox reload failed: ${String(e)}` });
            }
        },
        ...pluginEditorActions,
    };
}

export function getLatestMetersSnapshot(): MeteringSnapshot | null {
    return latestMeters;
}

export function setBpmPendingUntil(ms: number): void {
    bpmPendingUntil = performance.now() + ms;
}
