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
import { decodeMetersBinaryPacket } from '@/shared/lib/binaryMeters';
import {
    METER_STATE_UPDATE_EVERY_TICKS,
    patchSandboxInstancesById,
    PROJECT_HISTORY_SYNC_EVERY_TICKS,
} from '@/shared/stores/engine/storeHelpers';
import { enqueuePendingStoreUpdate, payloadToUint8Array } from '@/shared/stores/engine/actionsTelemetryQueue';
import { createPluginEditorActions } from '@/shared/stores/engine/actionsTelemetryEditors';
import type { EngineStore } from '@/shared/stores/useEngineStore';
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
let telemetryMetersBinaryUnlisten: UnlistenFn | null = null;

let bpmPendingUntil = 0;
let meterFrameCounter = 0;
let latestMeters: MeteringSnapshot | null = null;
let smoothedMeters: MeteringSnapshot | null = null;
let lastMeterTickMs = 0;

const METER_FLOOR_DB = -160;
const DEFAULT_METER_DELTA_SEC = 1 / 30;
const PEAK_ATTACK_TAU_SEC = 0.012;
const PEAK_RELEASE_TAU_SEC = 0.22;
const RMS_ATTACK_TAU_SEC = 0.08;
const RMS_RELEASE_TAU_SEC = 0.35;

function alphaFromTau(dtSec: number, tauSec: number): number {
    if (!Number.isFinite(dtSec) || dtSec <= 0) return 1;
    if (!Number.isFinite(tauSec) || tauSec <= 0) return 1;
    return 1 - Math.exp(-dtSec / tauSec);
}

function smoothDb(nextDb: number, prevDb: number, attackAlpha: number, releaseAlpha: number): number {
    if (!Number.isFinite(nextDb)) return prevDb;
    if (!Number.isFinite(prevDb)) return nextDb;
    const alpha = nextDb >= prevDb ? attackAlpha : releaseAlpha;
    const smoothed = prevDb + (nextDb - prevDb) * alpha;
    if (!Number.isFinite(smoothed)) return nextDb;
    return Math.max(METER_FLOOR_DB, smoothed);
}

function smoothMeterReading(
    prev: MeteringSnapshot['master_left'] | undefined,
    next: MeteringSnapshot['master_left'],
    dtSec: number,
): MeteringSnapshot['master_left'] {
    const prevRms = prev?.rms ?? METER_FLOOR_DB;
    const prevPeak = prev?.peak ?? METER_FLOOR_DB;
    const peakAttack = alphaFromTau(dtSec, PEAK_ATTACK_TAU_SEC);
    const peakRelease = alphaFromTau(dtSec, PEAK_RELEASE_TAU_SEC);
    const rmsAttack = alphaFromTau(dtSec, RMS_ATTACK_TAU_SEC);
    const rmsRelease = alphaFromTau(dtSec, RMS_RELEASE_TAU_SEC);

    return {
        rms: smoothDb(next.rms, prevRms, rmsAttack, rmsRelease),
        peak: smoothDb(next.peak, prevPeak, peakAttack, peakRelease),
        // clipping is event-like — keep raw edge responsiveness
        clipping: next.clipping,
    };
}

function smoothMeterSnapshot(
    prev: MeteringSnapshot | null,
    next: MeteringSnapshot,
    dtSec: number,
): MeteringSnapshot {
    const tracks: MeteringSnapshot['tracks'] = next.tracks.map((track, i) => {
        const prevTrack = prev?.tracks[i];
        return [
            smoothMeterReading(prevTrack?.[0], track[0], dtSec),
            smoothMeterReading(prevTrack?.[1], track[1], dtSec),
        ];
    });
    return {
        tracks,
        master_left: smoothMeterReading(prev?.master_left, next.master_left, dtSec),
        master_right: smoothMeterReading(prev?.master_right, next.master_right, dtSec),
    };
}

// BUG-009 FIX: Reset module-level telemetry state on project reload.
// These variables persist across project loads because they live at
// module scope — they must be explicitly cleared when a new project is loaded.
export function resetTelemetryModuleState(): void {
    bpmPendingUntil = 0;
    meterFrameCounter = 0;
    latestMeters = null;
    smoothedMeters = null;
    lastMeterTickMs = 0;
}

export function markBpmPending(ms: number): void {
    // BUG-021 FIX: Use performance.now() — monotonic clock immune to NTP/DST.
    bpmPendingUntil = performance.now() + ms;
}

export function readLatestMeters(fallback: MeteringSnapshot): MeteringSnapshot {
    return latestMeters ?? fallback;
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
            queueMicrotask(() => {
                set({ telemetryRunning: true });
            });
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
                            const effectiveTransport = bpmProtected
                                ? { ...nextTransport, bpm: prev.bpm }
                                : nextTransport;
                            const transportChanged = prev.is_playing !== effectiveTransport.is_playing
                                || prev.position_beats !== effectiveTransport.position_beats
                                || prev.position_frames !== effectiveTransport.position_frames
                                || prev.bpm !== effectiveTransport.bpm
                                || prev.loop_enabled !== effectiveTransport.loop_enabled
                                || prev.loop_start !== effectiveTransport.loop_start
                                || prev.loop_end !== effectiveTransport.loop_end;

                            if (transportChanged) {
                                // BUG-014 FIX: Assign properties directly instead of
                                // spread accumulation. Eliminates 2-3 intermediate objects
                                // per telemetry tick (30Hz = 60-90 garbage objects/sec).
                                telemetryUpdate.transport = effectiveTransport;
                                telemetryUpdate.connected = true;
                                telemetryUpdate.lastError = null;
                            }

                            // Performance metrics (sent every tick — DSP load refreshes at 30fps,
                            // CPU/RAM updates ~1/s but cached values are always included)
                            const perf = event.payload.performance;
                            telemetryUpdate.performance = {
                                cpuUsage: perf.cpu_usage,
                                ramUsedMb: perf.ram_used_mb,
                                ramTotalMb: perf.ram_total_mb,
                                processMemoryMb: perf.process_memory_mb,
                                dspLoad: perf.dsp_load,
                            };

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
                            meterFrameCounter++;
                            if (meterFrameCounter % METER_STATE_UPDATE_EVERY_TICKS !== 0) return;
                            const packet = payloadToUint8Array(event.payload);
                            const decodedMeters = decodeMetersBinaryPacket(packet);
                            const nowMs = performance.now();
                            const dtSec = lastMeterTickMs > 0
                                ? Math.max(1 / 240, Math.min(0.25, (nowMs - lastMeterTickMs) / 1000))
                                : DEFAULT_METER_DELTA_SEC;
                            lastMeterTickMs = nowMs;
                            const nextMeters = smoothMeterSnapshot(smoothedMeters, decodedMeters, dtSec);
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
                            enqueuePendingStoreUpdate(set, { pluginSandbox: nextSandbox, lastError: null });
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
                    telemetryStarted = false;
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
