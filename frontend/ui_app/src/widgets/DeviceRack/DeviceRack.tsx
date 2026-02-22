import { useMemo, useState, useCallback, useEffect, useRef } from 'react';
import { useEngineStore } from '@/shared/stores/useEngineStore';
import { useDragStore } from '@/shared/stores/useDragStore';
import { useStatusStore } from '@/shared/stores/useStatusStore';
import { useAutomationStore } from '@/shared/stores/useAutomationStore';
import * as engineApi from '@/shared/api/engine';
import { useShallow } from 'zustand/react/shallow';
import { MeterStrip } from '@/shared/ui/MeterStrip';
import { linearToMeterNorm, dbToMeterNorm } from '@/shared/lib/meterManifest';
import type { PluginParam } from '@/widgets/DeviceRack/StandardPluginControls';
import type { DeviceSlot, QuickPreset } from '@/widgets/DeviceRack/model/types';
import {
    resolveQuickPresetParams,
    defaultParamForReset,
    clampAndSnapParamValue,
    randomParamValue,
} from '@/widgets/DeviceRack/model/presets';
import {
    INTERNAL_EFFECT_TYPE_BY_PLUGIN_ID,
    RUNTIME_PARAM_INDEX_BY_EFFECT,
    DEVICE_PARAM_PRESETS,
    normalizePickedPath,
    errorMessage,
    internalParamIdForControl,
} from '@/widgets/DeviceRack/model/deviceRackCatalog';
import { DeviceNode } from '@/widgets/DeviceRack/ui/DeviceNode';
import type { BrowserDragItem } from '@/shared/lib/arrangementTypes';
import { canDropInZone } from '@/shared/lib/dndMatrix';
import {
    getInternalPluginById,
    normalizeInternalPluginId,
    waveformIndexFromSamplePath,
} from '@/shared/lib/internalPlugins';

/**
 * DeviceRack — Bottom panel: instrument & effects signal chain.
 *
 * Each track has its own Instrument & Effects chain (currently empty until
 * the user drops devices). IN/OUT meters show real-time signal levels
 * from the engine's MeterBank.
 *
 * Layout: [Title Bar] → [IN meter] → [...devices...] → [OUT meter] → [+ Add]
 */


// ── Styles (module-level for referential stability) ────────────────────

const autoCtxMenuItemStyle: React.CSSProperties = {
    display: 'block',
    width: '100%',
    padding: '5px 8px',
    border: 'none',
    background: 'transparent',
    color: 'var(--color-text-primary)',
    fontSize: 'var(--font-size-sm)',
    fontWeight: 500,
    textAlign: 'left',
    cursor: 'pointer',
    borderRadius: 'var(--radius-sm)',
    transition: 'background var(--transition-fast)',
};

// ── Component ──────────────────────────────────────────

interface DeviceRackProps {
    selectedTrackId: string;
    onDropPluginToTrack?: (item: BrowserDragItem, trackId: string) => Promise<void>;
}

export const DeviceRack = ({
    selectedTrackId,
    onDropPluginToTrack,
}: DeviceRackProps) => {
    type AdaptiveSender = {
        send: (value: number, pushUndoStep: boolean) => void;
        cancel: () => void;
    };
    type PendingGestureCommit = {
        source: 'internal' | 'vst';
        trackId: string;
        deviceId: string;
        paramName: string;
        value: number;
        paramIndex?: number;
    };
    const [localBypass, setLocalBypass] = useState<Record<string, boolean>>({});
    const [localParams, setLocalParams] = useState<Record<string, number>>({});
    const [pluginCapability, setPluginCapability] = useState<
        Record<string, { supported: boolean; reason?: string }>
    >({});
    const [pluginRuntimeBySlot, setPluginRuntimeBySlot] = useState<Record<string, engineApi.PluginSlotRuntimeStatus>>({});
    const [externalParamsBySlotId, setExternalParamsBySlotId] = useState<Record<string, PluginParam[]>>({});
    const [inlineSettingsOpen, setInlineSettingsOpen] = useState<Record<string, boolean>>({});
    const [selectedDeviceIds, setSelectedDeviceIds] = useState<string[]>([]);
    // ── Plugin editor window persistence per track ──
    const {
        openEditorsByTrack,
        togglePluginEditor,
        projectTracks,
        meters,
        fetchProject,
    } = useEngineStore(useShallow((s) => ({
        openEditorsByTrack: s.openEditorsByTrack,
        togglePluginEditor: s.togglePluginEditor,
        projectTracks: s.projectTracks,
        meters: s.meters,
        fetchProject: s.fetchProject,
    })));
    // closeAllPluginEditors removed — see cleanup notes at former BUG-012 block
    const prevTrackIdRef = useRef<string>(selectedTrackId);
    const [paramSnapshotsByDevice, setParamSnapshotsByDevice] = useState<
        Record<string, { A?: Record<string, number>; B?: Record<string, number>; active?: 'A' | 'B' }>
    >({});
    const statusError = useStatusStore((s) => s.setError);
    const statusClear = useStatusStore((s) => s.clear);
    const throttledParamSendsRef = useRef<Map<string, AdaptiveSender>>(new Map());
    const throttledExternalParamSendsRef = useRef<Map<string, AdaptiveSender>>(new Map());
    const adaptiveParamIntervalMsRef = useRef<number>(24);
    const pendingGestureCommitsRef = useRef<Map<string, Map<string, PendingGestureCommit>>>(new Map());
    const activeParamGesturesRef = useRef<Set<string>>(new Set());
    const pushedUndoForGestureRef = useRef<Set<string>>(new Set());
    const gestureGroupByParamKeyRef = useRef<Map<string, string>>(new Map());
    const rackRef = useRef<HTMLDivElement>(null);
    const [isDropActive, setIsDropActive] = useState(false);
    const draggingItem = useDragStore((s) => s.draggingItem);

    // ── Automation context menu state ──
    const [autoCtxMenu, setAutoCtxMenu] = useState<{
        x: number;
        y: number;
        paramName: string;
        deviceId: string;
    } | null>(null);
    const addAutomationLane = useAutomationStore((s) => s.addLane);
    const removeAutomationLane = useAutomationStore((s) => s.removeLane);
    const automationLanes = useAutomationStore((s) => s.lanes);
    const toggleGlobalAutomation = useAutomationStore((s) => s.toggleGlobalVisible);

    const handleParamContextMenu = useCallback(
        (e: React.MouseEvent, paramName: string, deviceId: string) => {
            e.preventDefault();
            e.stopPropagation();
            setAutoCtxMenu({ x: e.clientX, y: e.clientY, paramName, deviceId });
        },
        [],
    );

    // Close context menu on click outside
    useEffect(() => {
        if (!autoCtxMenu) return;
        const close = () => setAutoCtxMenu(null);
        window.addEventListener('mousedown', close);
        return () => window.removeEventListener('mousedown', close);
    }, [autoCtxMenu]);

    // Find the track index for meter lookup
    const isMaster = selectedTrackId === 'master';
    const trackIndex = projectTracks.findIndex(
        (t) => t.id === selectedTrackId
    );

    // Get real-time stereo meter levels for the selected track
    const meterPair = isMaster ? null : (trackIndex >= 0 ? meters.tracks[trackIndex] : null);
    const inLevelL = isMaster
        ? dbToMeterNorm(meters.master_left.peak)
        : meterPair ? dbToMeterNorm(meterPair[0].peak) : 0;
    const inLevelR = isMaster
        ? dbToMeterNorm(meters.master_right.peak)
        : meterPair ? dbToMeterNorm(meterPair[1].peak) : 0;
    const outLevelL = inLevelL;
    const outLevelR = inLevelR;
    const outLevel = Math.max(outLevelL, outLevelR);

    const masterProjectTrack = useMemo(
        () => projectTracks.find((t) => t.track_type === 'Master') ?? null,
        [projectTracks],
    );
    const selectedTrack = isMaster
        ? masterProjectTrack
        : (trackIndex >= 0 ? projectTracks[trackIndex] : null);
    const dropTargetTrack = selectedTrack;
    const dropTargetTrackRef = useRef<typeof dropTargetTrack>(dropTargetTrack);
    const onDropPluginToTrackRef = useRef(onDropPluginToTrack);
    const fetchProjectRef = useRef(fetchProject);
    const statusClearRef = useRef(statusClear);
    const statusErrorRef = useRef(statusError);
    const sidechainOptions = useMemo(
        () => projectTracks
            .filter((t) => t.id !== (selectedTrack?.id ?? ''))
            .map((t) => ({ id: t.id, name: t.name })),
        [projectTracks, selectedTrack?.id],
    );
    const staticLaneValueByParamId = useMemo(() => {
        const map = new Map<string, number>();
        const lanes = selectedTrack?.automation_lanes ?? [];
        for (const lane of lanes) {
            const paramId = (lane.param_id ?? '').trim();
            if (!paramId) continue;
            const points = lane.points ?? [];
            if (points.length === 0) continue;
            const last = points[points.length - 1];
            const value = Number(last?.value ?? 0);
            if (Number.isFinite(value)) map.set(paramId.toLowerCase(), value);
        }
        return map;
    }, [selectedTrack]);

    useEffect(() => {
        dropTargetTrackRef.current = dropTargetTrack;
    }, [dropTargetTrack]);

    useEffect(() => {
        onDropPluginToTrackRef.current = onDropPluginToTrack;
    }, [onDropPluginToTrack]);

    useEffect(() => {
        fetchProjectRef.current = fetchProject;
        statusClearRef.current = statusClear;
        statusErrorRef.current = statusError;
    }, [fetchProject, statusClear, statusError]);

    // ── Close native editors on track leave, reopen on track return ──
    useEffect(() => {
        const prevId = prevTrackIdRef.current;
        prevTrackIdRef.current = selectedTrackId;
        if (prevId === selectedTrackId) return;

        // Close editors for the track we are leaving and clear their state.
        // BUG-4 FIX: Do NOT auto-reopen editors on track return, because the
        // macOS red close button can silently close the native window without
        // notifying the frontend. Clearing the state here means the user must
        // toggle the UI button to reopen — the correct UX.
        const prevSlots = openEditorsByTrack[prevId];
        if (prevSlots && prevSlots.size > 0 && prevId) {
            for (const slotId of prevSlots) {
                engineApi.closePluginWindowForSlot(prevId, slotId).catch((err) =>
                    console.warn('[DeviceRack] close editor on track leave failed:', err),
                );
            }
            // Clear the state so editors don't auto-reopen on re-entry.
            useEngineStore.setState((s) => ({
                openEditorsByTrack: { ...s.openEditorsByTrack, [prevId]: new Set<string>() },
            }));
        }
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [selectedTrackId]);

    // ── SSOT: Clear ephemeral UI state on track switch ──────────────
    // `localParams` and `localBypass` are short-lived caches for in-flight
    // gestures.  They must NOT survive a track switch, because the backend
    // automation_lanes are the Single Source of Truth for persisted values.
    // Keeping stale localParams would override any backend changes made
    // while the user was on another track (automation, undo, fetchProject).
    useEffect(() => {
        setLocalParams({});
        setLocalBypass({});
        // Cancel in-flight throttled sends — they target the OLD track.
        for (const sender of throttledParamSendsRef.current.values()) sender.cancel();
        throttledParamSendsRef.current.clear();
        for (const sender of throttledExternalParamSendsRef.current.values()) sender.cancel();
        throttledExternalParamSendsRef.current.clear();
        pendingGestureCommitsRef.current.clear();
        activeParamGesturesRef.current.clear();
        pushedUndoForGestureRef.current.clear();
        gestureGroupByParamKeyRef.current.clear();
    }, [selectedTrackId]);

    // NOTE: We intentionally do NOT close all plugin editors on DeviceRack
    // unmount. The panel switch (Shift+Tab: rack ↔ clip) unmounts/remounts
    // DeviceRack, and closing editors here would crash because the audio
    // thread is simultaneously calling process() on those plugin instances.
    // Editors are cleaned up by:
    //   - Track switch (useEffect above at line 558)
    //   - Project close (handled by PluginHostState::unload_all_instances)
    const chain = useMemo((): DeviceSlot[] => {
        if (!selectedTrack) return [];

        const nodes = [
            ...(selectedTrack.sample_rack ? [{
                id: `sample-rack-${selectedTrack.id}`,
                name: 'Sample Rack',
                type: 'SampleRack',
                plugin_id: 'internal://instrument/sample-rack',
                is_bypassed: false,
                source: 'internal',
                sampleRackConfig: selectedTrack.sample_rack,
            } as {
                id: string;
                name: string;
                type: string;
                plugin_id: string;
                is_bypassed: boolean;
                source: 'internal';
                sampleRackConfig: unknown;
            }] : []),
            ...(!selectedTrack.sample_rack && selectedTrack.instrument ? [selectedTrack.instrument] : []),
            ...(selectedTrack.effects ?? []),
        ];

        type DeviceNodeShape = {
            id?: string;
            name?: string;
            plugin_id?: string;
            is_bypassed?: boolean;
            external_parameter_count?: number;
            sidechain_source_track_id?: string | null;
            supports_sidechain_input?: boolean | null;
            type?: string;
            rack_type?: string;
            sampleRackConfig?: unknown;
        };

        // Helper: convert a single DeviceNode to a DeviceSlot.
        const nodeToSlot = (node: (typeof nodes)[number]): DeviceSlot | null => {
            // Extract common fields based on node type (tagged union from Rust serde).
            const nodeShape = node as unknown as DeviceNodeShape;
            const nodeType = nodeShape.type;
            const isRack = nodeType === 'Rack';

            // For rack nodes, show as a rack container device.
            if (isRack) {
                const rackNode = nodeShape;
                const rackId = rackNode.id ?? '';
                return {
                    id: rackId,
                    name: rackNode.name ?? 'Device Rack',
                    effectType: 'rack' as DeviceSlot['effectType'],
                    isEnabled: !(localBypass[rackId] ?? rackNode.is_bypassed),
                    params: [],
                    vuLevel: outLevel,
                    vuLevelL: outLevelL,
                    vuLevelR: outLevelR,
                    pluginId: `rack://${rackNode.rack_type}/${rackId}`,
                    isVst: false,
                    source: 'internal',
                };
            }

            // Single plugin node — the PluginSlot fields are at the top level.
            const slot = nodeShape;
            const pluginId: string = slot.plugin_id || slot.id || '';
            const name: string = slot.name || '';
            const id: string = slot.id || '';
            const isBypassed: boolean = slot.is_bypassed ?? false;

            const pluginIdLower = normalizeInternalPluginId(pluginId.toLowerCase());
            const pluginTypeHint = String(slot.type ?? '').toLowerCase();
            const isVst = pluginIdLower.includes('vst3')
                || pluginIdLower.includes('.vst')
                || pluginIdLower.includes('vst')
                || pluginTypeHint.includes('vst3')
                || pluginTypeHint.includes('vst');
            const isInternal = pluginIdLower.startsWith('internal://');
            const rawExternalParamCount = Math.max(0, Number(slot.external_parameter_count ?? 0) || 0);
            const externalParamCount = isVst
                ? (rawExternalParamCount > 0 ? rawExternalParamCount : 16)
                : 0;

            const normalized = `${name} ${pluginId}`.toLowerCase();
            let effectType: DeviceSlot['effectType'] =
                selectedTrack.instrument?.id === id ? 'instrument' : isVst ? 'vst' : 'utility';
            const internalDef = getInternalPluginById(pluginIdLower);
            const mappedInternalType = internalDef?.id ? INTERNAL_EFFECT_TYPE_BY_PLUGIN_ID[internalDef.id] : undefined;
            if (mappedInternalType) {
                effectType = mappedInternalType;
            } else if (pluginIdLower === 'internal://instrument/sample-rack') {
                effectType = 'sample_rack' as DeviceSlot['effectType'];
            } else if (!isVst) {
                if (normalized.includes('sampler')) effectType = 'sampler';
                else if (
                    normalized.includes('eq')
                    || normalized.includes('channel eq')
                    || normalized.includes('band eq')
                ) effectType = 'eq';
                else if (
                    normalized.includes('compressor')
                    || normalized.includes('transient shaper')
                    || normalized.includes('multiband dynamics')
                ) effectType = 'compressor';
                else if (
                    normalized.includes('delay')
                    || normalized.includes('echo')
                    || normalized.includes('beat repeat')
                    || normalized.includes('looper')
                    || normalized.includes('spectral time')
                ) effectType = 'delay';
                else if (
                    normalized.includes('reverb')
                    || normalized.includes('corpus')
                    || normalized.includes('resonators')
                    || normalized.includes('spectral resonator')
                ) effectType = 'reverb';
                else if (normalized.includes('chorus')) effectType = 'chorus';
                else if (normalized.includes('saturator') || normalized.includes('drum buss') || normalized.includes('dynamic tube')) effectType = 'saturator';
                else if (normalized.includes('limiter')) effectType = 'limiter';
                else if (normalized.includes('gate')) effectType = 'gate';
                else if (normalized.includes('auto pan') || normalized.includes('auto-pan') || normalized.includes('autopan')) effectType = 'autoPan';
                else if (normalized.includes('auto filter') || normalized.includes('auto-filter') || normalized.includes('autofilter') || normalized.includes('vocoder')) effectType = 'autoFilter';
                else if (normalized.includes('phaser') || normalized.includes('phaser-flanger')) effectType = 'phaser';
                else if (normalized.includes('flanger')) effectType = 'flanger';
                else if (
                    normalized.includes('distortion')
                    || normalized.includes('amp')
                    || normalized.includes('cabinet')
                    || normalized.includes('overdrive')
                    || normalized.includes('pedal')
                    || normalized.includes('roar')
                ) effectType = 'distortion';
                else if (normalized.includes('bitcrusher') || normalized.includes('bit-crusher')) effectType = 'bitcrusher';
                else if (normalized.includes('noise-machine') || normalized.includes('noise machine') || normalized.includes('noisemachine')) effectType = 'noiseMachine';
                else if (normalized.includes('spectrum')) effectType = 'spectrum';
                else if (normalized.includes('internal://midi-fx/pitch') || normalized.includes('midipitch')) effectType = 'midiPitch';
                else if (normalized.includes('internal://midi-fx/scale') || normalized.includes('midiscale')) effectType = 'midiScale';
                else if (normalized.includes('internal://midi-fx/velocity') || normalized.includes('midivelocity')) effectType = 'midiVelocity';
                else if (normalized.includes('internal://midi-fx/random') || normalized.includes('midirandom')) effectType = 'midiRandom';
                else if (normalized.includes('arpeggiator')) effectType = 'midiRandom';
                else if (normalized.includes('chord')) effectType = 'midiScale';
                else if (normalized.includes('note length') || normalized.includes('cc control') || normalized.includes('expression control')) effectType = 'midiVelocity';
                else if (selectedTrack.instrument?.id === id) effectType = 'instrument';
            }

            const guiMode = internalDef?.id || effectType;

            const defaultParams = (DEVICE_PARAM_PRESETS[effectType] ?? []).map((template) => {
                const key = `${id}:${template.name}`;
                let backendValue = template.value;
                if ((effectType === 'sampler' || effectType === 'instrument' || effectType === 'waveSynth') && selectedTrack.sampler) {
                    const n = template.name.toLowerCase();
                    if (n === 'wave' || n === 'osc1wave') backendValue = waveformIndexFromSamplePath(selectedTrack.sampler.sample_path);
                    else if (n === 'osc2wave') backendValue = Math.max(0, Math.min(3, selectedTrack.sampler.osc2_waveform ?? 0));
                    else if (n === 'mix') backendValue = Math.max(0, Math.min(1, selectedTrack.sampler.osc_mix ?? 0.35));
                    else if (n === 'detune') backendValue = Math.max(-50, Math.min(50, selectedTrack.sampler.detune_cents ?? 0));
                    else if (n === 'sub') backendValue = Math.max(0, Math.min(1, selectedTrack.sampler.sub_level ?? 0));
                    else if (n === 'vol') backendValue = selectedTrack.sampler.volume;
                    else if (n === 'attack') backendValue = selectedTrack.sampler.attack;
                    else if (n === 'decay') backendValue = selectedTrack.sampler.decay;
                    else if (n === 'sustain') backendValue = selectedTrack.sampler.sustain;
                    else if (n === 'release') backendValue = selectedTrack.sampler.release;
                    else if (n === 'root') backendValue = selectedTrack.sampler.root_note;
                }
                if (!(effectType === 'sampler' || effectType === 'instrument' || effectType === 'waveSynth')) {
                    const baseParamId = internalParamIdForControl(effectType, template.name);
                    const scoped = `slot:${id}:${baseParamId}`.toLowerCase();
                    const unscoped = baseParamId.toLowerCase();
                    const fromLane = staticLaneValueByParamId.get(scoped) ?? staticLaneValueByParamId.get(unscoped);
                    if (fromLane != null) backendValue = fromLane;
                }
                return {
                    ...template,
                    defaultValue: template.value,
                    value: localParams[key] ?? backendValue,
                };
            });
            const cachedExternalParams = isVst ? (externalParamsBySlotId[id] ?? []) : [];
            const vstParamsFromHost = cachedExternalParams.length > 0
                ? cachedExternalParams.map((p) => {
                    const key = `${id}:${p.name}`;
                    return {
                        ...p,
                        value: localParams[key] ?? p.value,
                    };
                })
                : [];
            const vstParamsFallback = isVst && externalParamCount > 0
                ? Array.from({ length: Math.min(32, externalParamCount) }, (_, idx) => {
                    const name = `Param ${idx + 1}`;
                    const key = `${id}:${name}`;
                    return {
                        name,
                        min: 0,
                        max: 1,
                        step: 0.001,
                        suffix: '',
                        value: localParams[key] ?? 0.5,
                        defaultValue: 0.5,
                    } as PluginParam;
                })
                : [];
            const vstParams = vstParamsFromHost.length > 0 ? vstParamsFromHost : vstParamsFallback;

            return {
                id,
                name,
                effectType,
                isEnabled: !(localBypass[id] ?? isBypassed),
                params: vstParams.length > 0 ? vstParams : defaultParams,
                vuLevel: outLevel,
                vuLevelL: outLevelL,
                vuLevelR: outLevelR,
                pluginId,
                isVst,
                source: isInternal ? 'internal' : (isVst || pluginTypeHint.includes('vst')) ? 'vst' : 'unknown',
                supportsSidechain: slot.supports_sidechain_input ?? (effectType === 'compressor' || effectType === 'gate'),
                sidechainSourceTrackId: slot.sidechain_source_track_id ?? null,
                guiMode,
                samplePath: effectType === 'sampler' || effectType === 'instrument' || effectType === 'waveSynth'
                    ? (selectedTrack.sampler?.sample_path ?? undefined)
                    : undefined,
                sampleRackConfig: slot.sampleRackConfig,
            };
        };

        return nodes.map(nodeToSlot).filter((s): s is DeviceSlot => s !== null);
    }, [selectedTrack, localBypass, localParams, outLevel, outLevelL, outLevelR, externalParamsBySlotId, staticLaneValueByParamId]);

    const setPluginSidechainSource = useCallback(async (slotId: string, sourceTrackId: string) => {
        if (!selectedTrack) return;
        try {
            console.log('[DeviceRack] setPluginSidechainSource:', {
                trackId: selectedTrack.id,
                slotId,
                sourceTrackId: sourceTrackId || 'none',
            });
            await engineApi.setPluginSidechainSource(selectedTrack.id, slotId, sourceTrackId || 'none');
            await fetchProject();
            statusClear();
        } catch (err) {
            console.error('[DeviceRack] setPluginSidechainSource failed:', err);
            const msg = err instanceof Error ? err.message : String(err);
            statusError(`Failed to set plugin sidechain source: ${msg}`);
        }
    }, [selectedTrack, fetchProject, statusClear, statusError]);

    const createAdaptiveParamSender = useCallback(
        (emit: (value: number, pushUndoStep: boolean) => Promise<void> | void): AdaptiveSender => {
            let timer: number | null = null;
            let pending: { value: number; pushUndoStep: boolean } | null = null;
            let lastSentAt = 0;

            const schedule = () => {
                if (timer != null || !pending) return;
                const now = performance.now();
                const delay = Math.max(0, adaptiveParamIntervalMsRef.current - (now - lastSentAt));
                timer = window.setTimeout(() => {
                    timer = null;
                    const payload = pending;
                    pending = null;
                    if (!payload) return;

                    const startedAt = performance.now();
                    lastSentAt = startedAt;
                    void Promise.resolve(emit(payload.value, payload.pushUndoStep))
                        .catch(() => {
                            // Errors are handled by caller.
                        })
                        .finally(() => {
                            const elapsed = Math.max(1, performance.now() - startedAt);
                            const target = Math.max(16, Math.min(48, elapsed * 1.25));
                            adaptiveParamIntervalMsRef.current =
                                adaptiveParamIntervalMsRef.current * 0.7 + target * 0.3;
                            if (pending) schedule();
                        });
                }, delay);
            };

            return {
                send: (value: number, pushUndoStep: boolean) => {
                    if (pushUndoStep) {
                        if (timer != null) {
                            window.clearTimeout(timer);
                            timer = null;
                        }
                        pending = null;
                        const startedAt = performance.now();
                        lastSentAt = startedAt;
                        void Promise.resolve(emit(value, true))
                            .catch(() => {
                                // Errors are handled by caller.
                            })
                            .finally(() => {
                                const elapsed = Math.max(1, performance.now() - startedAt);
                                const target = Math.max(16, Math.min(48, elapsed * 1.25));
                                adaptiveParamIntervalMsRef.current =
                                    adaptiveParamIntervalMsRef.current * 0.7 + target * 0.3;
                            });
                        return;
                    }

                    pending = {
                        value,
                        pushUndoStep: pending?.pushUndoStep === true ? true : false,
                    };
                    schedule();
                },
                cancel: () => {
                    if (timer != null) {
                        window.clearTimeout(timer);
                        timer = null;
                    }
                    pending = null;
                },
            };
        },
        [],
    );

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
                    console.error('[DeviceRack] ensureSlotRuntimeActive retry failed:', retryErr);
                    statusError(`Plugin activation failed: ${errorMessage(retryErr)}`);
                    return null;
                }
            }

            console.error('[DeviceRack] ensureSlotRuntimeActive failed:', err);
            statusError(`Plugin activation failed: ${errorMessage(err)}`);
            return null;
        }
    }, [selectedTrack, pluginRuntimeBySlot, statusError, statusClear]);

    const toggleDevice = useCallback((device: DeviceSlot) => {
        const currentBypassed = localBypass[device.id] ?? !device.isEnabled;
        const nextBypassed = !currentBypassed;
        setLocalBypass((prev) => ({ ...prev, [device.id]: nextBypassed }));

        if (!selectedTrack) return;

        // Always update the project model bypass state for every plugin type.
        // This ensures rebuild_external_fx_snapshot respects bypass for external
        // plugins (VSTs), instruments, and internal effects alike.
        void engineApi.setSlotBypass(
            selectedTrack.id.toString(),
            device.id,
            nextBypassed,
        ).catch((err) => {
            console.error('[DeviceRack] setSlotBypass failed:', err);
        });

        // Internal effects also need the runtime device chain bypass sync.
        if (device.source === 'internal') {
            const trackIdx = projectTracks.findIndex((t) => t.id === selectedTrack.id);
            const slotIdx = selectedTrack.effects.findIndex((fx) => fx.id === device.id);
            if (trackIdx >= 0 && slotIdx >= 0) {
                void engineApi.bypassDevice(trackIdx, slotIdx, nextBypassed).catch((err) => {
                    console.error('[DeviceRack] bypassDevice failed:', err);
                });
            }
        }
    }, [localBypass, selectedTrack, projectTracks]);

    const setPluginParam = useCallback((deviceId: string, paramName: string, value: number) => {
        setLocalParams((prev) => ({ ...prev, [`${deviceId}:${paramName}`]: value }));
    }, []);

    const sendInternalParam = useCallback(
        (
            device: DeviceSlot,
            paramName: string,
            value: number,
            options?: { gestureKey?: string; forcePushUndo?: boolean },
        ) => {
            if (!selectedTrack) return;

            const effectiveGestureKey = options?.gestureKey
                ? (gestureGroupByParamKeyRef.current.get(options.gestureKey) ?? options.gestureKey)
                : undefined;
            const pushUndoStep = options?.forcePushUndo ?? (!effectiveGestureKey);

            if (device.source === 'vst') {
                const idxFromList = device.params.findIndex((p) => p.name === paramName);
                const idxFromName = (() => {
                    const m = paramName.match(/(\d+)/);
                    return m ? Number.parseInt(m[1], 10) : -1;
                })();
                const paramIndex = idxFromList >= 0 ? idxFromList : idxFromName;
                if (paramIndex < 0 || !Number.isFinite(paramIndex)) return;

                const paramDef = idxFromList >= 0 ? device.params[idxFromList] : null;
                const normalized = paramDef
                    ? (value - paramDef.min) / Math.max(1e-9, paramDef.max - paramDef.min)
                    : value;
                const clamped = Math.min(1, Math.max(0, normalized));

                const key = `${selectedTrack.id}:${device.id}:${paramIndex}`;
                let sender = throttledExternalParamSendsRef.current.get(key);
                if (!sender) {
                    sender = createAdaptiveParamSender(async (v: number, pushUndo: boolean) => {
                        await engineApi.setExternalPluginParamForSlot(selectedTrack.id, device.id, paramIndex, v, {
                            pushUndoStep: pushUndo,
                        });
                    });
                    throttledExternalParamSendsRef.current.set(key, sender);
                }

                sender.send(clamped, pushUndoStep);
                if (effectiveGestureKey) {
                    const bucket = pendingGestureCommitsRef.current.get(effectiveGestureKey) ?? new Map();
                    bucket.set(`${device.id}:${paramIndex}`, {
                        source: 'vst',
                        trackId: selectedTrack.id,
                        deviceId: device.id,
                        paramName,
                        value: clamped,
                        paramIndex,
                    });
                    pendingGestureCommitsRef.current.set(effectiveGestureKey, bucket);
                }
                return;
            }

            // BUG-R1 FIX: Master track is NOT in projectTracks — findIndex returns -1,
            // causing ALL master EQ param updates to be silently dropped.
            // Use MASTER_TRACK_INDEX (65535) sentinel matching driver.rs MASTER_TRACK_INDEX.
            const MASTER_TRACK_INDEX = 65535;
            const trackIdx = isMaster
                ? MASTER_TRACK_INDEX
                : projectTracks.findIndex((t) => t.id === selectedTrack.id);
            const effectSlotIdx = selectedTrack.effects.findIndex((fx) => fx.id === device.id);
            const pushPluginParam = (paramIndex: number, paramValue: number) => {
                if ((!isMaster && trackIdx < 0) || effectSlotIdx < 0) return;
                void engineApi.setDeviceParam(trackIdx, effectSlotIdx, paramIndex, paramValue).catch((err) => {
                    console.error('[DeviceRack] setDeviceParam failed:', err);
                });
            };

            // Runtime DSP path for built-in effects — this is the audible path.
            if (device.source === 'internal') {
                const effectMap = RUNTIME_PARAM_INDEX_BY_EFFECT[device.effectType];
                if (effectMap) {
                    const key = paramName.toLowerCase();
                    const index = effectMap[key];
                    if (index != null) {
                        pushPluginParam(index, value);
                    }
                }
            }

            const paramId = internalParamIdForControl(device.effectType, paramName);

            const scopedParamId = `slot:${device.id}:${paramId}`;
            const key = `${selectedTrack.id}:${device.id}:${scopedParamId}`;

            let sender = throttledParamSendsRef.current.get(key);
            if (!sender) {
                sender = createAdaptiveParamSender(async (v: number, pushUndo: boolean) => {
                    await engineApi.setInternalPluginParam(
                        selectedTrack.id,
                        device.id,
                        scopedParamId,
                        v,
                        { pushUndoStep: pushUndo },
                    );
                });
                throttledParamSendsRef.current.set(key, sender);
            }
            sender.send(value, pushUndoStep);
            if (effectiveGestureKey) {
                const bucket = pendingGestureCommitsRef.current.get(effectiveGestureKey) ?? new Map();
                bucket.set(`${device.id}:${scopedParamId}`, {
                    source: 'internal',
                    trackId: selectedTrack.id,
                    deviceId: device.id,
                    paramName,
                    value,
                });
                pendingGestureCommitsRef.current.set(effectiveGestureKey, bucket);
            }
        },
        [selectedTrack, projectTracks, isMaster, createAdaptiveParamSender],
    );

    const beginParamGesture = useCallback((deviceId: string, paramName: string, gestureGroupId?: string) => {
        if (!selectedTrack) return;
        const gestureKey = `${selectedTrack.id}:${deviceId}:${paramName.toLowerCase()}`;
        activeParamGesturesRef.current.add(gestureKey);
        pushedUndoForGestureRef.current.delete(gestureKey);
        if (gestureGroupId) {
            gestureGroupByParamKeyRef.current.set(gestureKey, gestureGroupId);
            pushedUndoForGestureRef.current.delete(gestureGroupId);
        }
    }, [selectedTrack]);

    const endParamGesture = useCallback((deviceId: string, paramName: string) => {
        if (!selectedTrack) return;
        const gestureKey = `${selectedTrack.id}:${deviceId}:${paramName.toLowerCase()}`;
        const gestureGroupId = gestureGroupByParamKeyRef.current.get(gestureKey);
        const commitKey = gestureGroupId ?? gestureKey;

        const pending = pendingGestureCommitsRef.current.get(commitKey);
        if (pending && pending.size > 0) {
            const entries = Array.from(pending.values());
            pendingGestureCommitsRef.current.delete(commitKey);
            // Final commit at gesture end: one undo/snapshot step per gesture.
            entries.forEach((entry, index) => {
                if (entry.source === 'vst') {
                    if (entry.paramIndex == null) return;
                    void engineApi.setExternalPluginParamForSlot(
                        entry.trackId,
                        entry.deviceId,
                        entry.paramIndex,
                        entry.value,
                        { pushUndoStep: index === 0 },
                    ).catch((err) => {
                        console.error('[DeviceRack] setExternalPluginParam(commit) failed:', err);
                    });
                    return;
                }

                const effectType = chain.find((d) => d.id === entry.deviceId)?.effectType;
                if (!effectType) return;
                const scopedParamId = `slot:${entry.deviceId}:${internalParamIdForControl(effectType, entry.paramName)}`;
                void engineApi.setInternalPluginParam(
                    entry.trackId,
                    entry.deviceId,
                    scopedParamId,
                    entry.value,
                    { pushUndoStep: index === 0 },
                ).catch((err) => {
                    console.error('[DeviceRack] setInternalPluginParam(commit) failed:', err);
                });
            });
        }

        activeParamGesturesRef.current.delete(gestureKey);
        pushedUndoForGestureRef.current.delete(gestureKey);
        if (gestureGroupId) {
            pushedUndoForGestureRef.current.delete(gestureGroupId);
            gestureGroupByParamKeyRef.current.delete(gestureKey);
        }
    }, [selectedTrack, chain]);

    const applyParamBatch = useCallback((
        device: DeviceSlot,
        entries: Array<{ paramName: string; value: number }>,
    ) => {
        if (!selectedTrack || entries.length === 0) return;
        const byName = new Map(device.params.map((p) => [p.name.toLowerCase(), p]));
        const normalizedEntries = entries.map((entry) => {
            const def = byName.get(entry.paramName.toLowerCase());
            return {
                paramName: def?.name ?? entry.paramName,
                value: def ? clampAndSnapParamValue(def, entry.value) : entry.value,
            };
        });
        setLocalParams((prev) => {
            const next = { ...prev };
            for (const entry of normalizedEntries) {
                next[`${device.id}:${entry.paramName}`] = entry.value;
            }
            return next;
        });
        normalizedEntries.forEach((entry, idx) => {
            sendInternalParam(device, entry.paramName, entry.value, { forcePushUndo: idx === 0 });
        });
    }, [selectedTrack, sendInternalParam]);

    const storeParamSnapshot = useCallback((device: DeviceSlot, slot: 'A' | 'B') => {
        const snapshot: Record<string, number> = {};
        for (const p of device.params) snapshot[p.name] = p.value;
        setParamSnapshotsByDevice((prev) => ({
            ...prev,
            [device.id]: {
                ...(prev[device.id] ?? {}),
                [slot]: snapshot,
                active: slot,
            },
        }));
    }, []);

    const recallParamSnapshot = useCallback((device: DeviceSlot, slot: 'A' | 'B') => {
        const snapshot = paramSnapshotsByDevice[device.id]?.[slot];
        if (!snapshot) return;
        const entries = Object.entries(snapshot).map(([paramName, value]) => ({ paramName, value }));
        applyParamBatch(device, entries);
        setParamSnapshotsByDevice((prev) => ({
            ...prev,
            [device.id]: {
                ...(prev[device.id] ?? {}),
                active: slot,
            },
        }));
    }, [applyParamBatch, paramSnapshotsByDevice]);

    const toggleParamSnapshot = useCallback((device: DeviceSlot) => {
        const state = paramSnapshotsByDevice[device.id];
        if (!state?.A || !state?.B) return;
        const next: 'A' | 'B' = state.active === 'A' ? 'B' : 'A';
        recallParamSnapshot(device, next);
    }, [paramSnapshotsByDevice, recallParamSnapshot]);

    const applyQuickPreset = useCallback((device: DeviceSlot, preset: QuickPreset) => {
        const entries = resolveQuickPresetParams(device, preset);
        applyParamBatch(device, entries);
    }, [applyParamBatch]);

    const randomizeInternalPluginParams = useCallback((device: DeviceSlot) => {
        const entries = device.params.map((param) => ({ paramName: param.name, value: randomParamValue(param) }));
        applyParamBatch(device, entries);
    }, [applyParamBatch]);

    const resetInternalPluginParams = useCallback((device: DeviceSlot) => {
        const entries = device.params.map((param) => ({ paramName: param.name, value: defaultParamForReset(param) }));
        applyParamBatch(device, entries);
    }, [applyParamBatch]);

    const applyQuickUtilityScene = useCallback((device: DeviceSlot, scene: 'center' | 'mono' | 'wide') => {
        if (device.effectType !== 'utility') return;
        const values = scene === 'mono'
            ? [
                { paramName: 'Pan', value: 0 },
                { paramName: 'Width', value: 0 },
                { paramName: 'Mono', value: 1 },
            ]
            : scene === 'wide'
                ? [
                    { paramName: 'Pan', value: 0 },
                    { paramName: 'Width', value: 150 },
                    { paramName: 'Mono', value: 0 },
                ]
                : [
                    { paramName: 'Pan', value: 0 },
                    { paramName: 'Width', value: 100 },
                    { paramName: 'Mono', value: 0 },
                ];
        applyParamBatch(device, values);
    }, [applyParamBatch]);

    useEffect(() => {
        setSelectedDeviceIds((prev) => prev.filter((id) => chain.some((d) => d.id === id)));
        setInlineSettingsOpen((prev) => {
            const next: Record<string, boolean> = {};
            const ids = new Set(chain.map((d) => d.id));
            for (const [id, isOpen] of Object.entries(prev)) {
                if (ids.has(id) && isOpen) next[id] = true;
            }
            return next;
        });
    }, [chain]);

    useEffect(() => {
        activeParamGesturesRef.current.clear();
        pushedUndoForGestureRef.current.clear();
        gestureGroupByParamKeyRef.current.clear();
        pendingGestureCommitsRef.current.clear();
        throttledParamSendsRef.current.forEach((s) => s.cancel());
        throttledExternalParamSendsRef.current.forEach((s) => s.cancel());
        throttledParamSendsRef.current.clear();
        throttledExternalParamSendsRef.current.clear();
    }, [selectedTrackId]);

    useEffect(() => {
        setSelectedDeviceIds([]);
    }, [selectedTrackId]);

    useEffect(() => {
        const onKeyDown = async (e: KeyboardEvent) => {
            const tag = (e.target as HTMLElement | null)?.tagName?.toLowerCase();
            if (tag === 'input' || tag === 'textarea' || (e.target as HTMLElement | null)?.isContentEditable) return;
            if (!selectedTrack) return;

            // ── Cmd+C: Copy selected device to clipboard ──
            if ((e.metaKey || e.ctrlKey) && e.key === 'c' && selectedDeviceIds.length > 0) {
                e.preventDefault();
                e.stopImmediatePropagation();
                try {
                    const deviceName = await engineApi.copyDeviceFromTrack(
                        selectedTrack.id,
                        selectedDeviceIds[0],
                    );
                    statusClear();
                    console.log(`[DeviceRack] Copied device: ${deviceName}`);
                } catch (err) {
                    console.error('[DeviceRack] copyDeviceFromTrack failed:', err);
                    statusError('Failed to copy device.');
                }
                return;
            }

            // ── Cmd+V: Paste device to current track ──
            if ((e.metaKey || e.ctrlKey) && e.key === 'v') {
                e.preventDefault();
                e.stopImmediatePropagation();
                try {
                    await engineApi.pasteDeviceToTrack(selectedTrack.id, 'auto');
                    await fetchProject();
                    statusClear();
                    console.log('[DeviceRack] Pasted device to track:', selectedTrack.id);
                } catch (err) {
                    console.error('[DeviceRack] pasteDeviceToTrack failed:', err);
                    statusError(String(err));
                }
                return;
            }

            // ── Delete / Backspace: Remove selected devices ──
            if ((e.key !== 'Delete' && e.key !== 'Backspace') || selectedDeviceIds.length === 0) return;
            e.preventDefault();
            e.stopImmediatePropagation();
            try {
                for (const deviceId of selectedDeviceIds) {
                    await engineApi.removePluginFromTrack(selectedTrack.id, deviceId);
                }
                setInlineSettingsOpen((prev) => {
                    const next = { ...prev };
                    for (const deviceId of selectedDeviceIds) {
                        delete next[deviceId];
                    }
                    return next;
                });
                setSelectedDeviceIds([]);
                await fetchProject();
                statusClear();
            } catch (err) {
                console.error('[DeviceRack] removePluginFromTrack failed:', err);
                statusError('Failed to remove plugin from track.');
            }
        };
        window.addEventListener('keydown', onKeyDown);
        return () => window.removeEventListener('keydown', onKeyDown);
    }, [selectedDeviceIds, selectedTrack, fetchProject, statusClear, statusError]);

    useEffect(() => {
        let cancelled = false;
        const vstDevices = chain.filter((d) => d.isVst);
        if (!selectedTrack) {
            return;
        }
        const missing = vstDevices.filter((d) => pluginCapability[d.id] == null);
        if (missing.length === 0) {
            return;
        }

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
                })
            );

            if (cancelled) {
                return;
            }
            setPluginCapability((prev) => {
                const next = { ...prev };
                for (const [id, cap] of results) {
                    next[id] = cap;
                }
                return next;
            });
        })();

        return () => {
            cancelled = true;
        };
    }, [chain, pluginCapability, selectedTrack]);

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
                            loaded: false,
                            editorSupported: true,
                            runtime: 'unknown',
                            sidechainReady: false,
                            message: 'Runtime status unavailable',
                        } as engineApi.PluginSlotRuntimeStatus] as const;
                    }
                }),
            );

            if (cancelled) return;
            setPluginRuntimeBySlot((prev) => {
                const next = { ...prev };
                for (const [slotId, status] of entries) {
                    next[slotId] = status;
                }
                return next;
            });
        })();

        return () => {
            cancelled = true;
        };
    }, [chain, selectedTrack]);

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
                            name: p.name,
                            min: p.min,
                            max: p.max,
                            step: p.step,
                            suffix: '',
                            value: p.value,
                            defaultValue: (p.min + p.max) * 0.5,
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
                for (const [slotId, params] of results) {
                    next[slotId] = params;
                }
                return next;
            });
        })();

        return () => {
            cancelled = true;
        };
    }, [chain, selectedTrack, externalParamsBySlotId]);

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

    useEffect(() => {
        const onMouseMove = (e: MouseEvent) => {
            const dragging = useDragStore.getState().draggingItem;
            const targetTrack = dropTargetTrackRef.current;
            if (!dragging || !targetTrack || !canDropInZone(dragging, 'device-rack').allowed) {
                setIsDropActive(false);
                return;
            }
            const rect = rackRef.current?.getBoundingClientRect();
            if (!rect) return;
            const inside =
                e.clientX >= rect.left &&
                e.clientX <= rect.right &&
                e.clientY >= rect.top &&
                e.clientY <= rect.bottom;
            setIsDropActive(inside);
        };

        const onMouseUp = async (e: MouseEvent) => {
            const dragging = useDragStore.getState().draggingItem;
            const targetTrack = dropTargetTrackRef.current;
            if (!dragging || !targetTrack || !canDropInZone(dragging, 'device-rack').allowed) return;
            const rect = rackRef.current?.getBoundingClientRect();
            if (!rect) return;
            const inside =
                e.clientX >= rect.left &&
                e.clientX <= rect.right &&
                e.clientY >= rect.top &&
                e.clientY <= rect.bottom;
            if (!inside) {
                setIsDropActive(false);
                return;
            }

            try {
                const dropHandler = onDropPluginToTrackRef.current;
                if (dropHandler) {
                    await dropHandler(dragging, targetTrack.id);
                } else {
                    const hint = dragging.slotHint ?? 'auto';
                    const slot: 'instrument' | 'effect' =
                        hint === 'instrument'
                            ? 'instrument'
                            : hint === 'effect'
                                ? 'effect'
                                : targetTrack.track_type === 'Midi' && !targetTrack.instrument
                                    ? 'instrument'
                                    : 'effect';
                    await engineApi.addPluginToTrack(
                        targetTrack.id,
                        dragging.path,
                        dragging.name,
                        slot,
                    );
                    await fetchProjectRef.current();
                }
                statusClearRef.current();
            } catch (err) {
                console.error('[DeviceRack] addPluginToTrack failed:', err);
                statusErrorRef.current('Failed to add plugin to track.');
            } finally {
                useDragStore.getState().endDrag();
                setIsDropActive(false);
            }
        };

        window.addEventListener('mousemove', onMouseMove, true);
        window.addEventListener('mouseup', onMouseUp, true);
        return () => {
            window.removeEventListener('mousemove', onMouseMove, true);
            window.removeEventListener('mouseup', onMouseUp, true);
        };
    }, []);

    const selectDevice = useCallback((deviceId: string, additive: boolean) => {
        setSelectedDeviceIds((prev) => {
            if (!additive) return [deviceId];
            return prev.includes(deviceId)
                ? prev.filter((id) => id !== deviceId)
                : [...prev, deviceId];
        });
    }, []);

    const visibleChain = chain;

    const rackContent = (
        <>
            <div
                ref={rackRef}
                tabIndex={0}
                data-keyboard-scope="device-rack"
                data-selected-device-id={selectedDeviceIds[0] ?? ''}
                onMouseDown={() => rackRef.current?.focus()}
                style={{
                    display: 'flex',
                    flexDirection: 'column',
                    height: '100%',
                    background: 'var(--color-bg-panel)',
                    position: 'relative',
                    outline: isDropActive ? '2px solid var(--color-accent-primary)' : 'none',
                    boxShadow: isDropActive ? 'inset 0 0 0 1px color-mix(in srgb, var(--color-accent-primary) 35%, transparent)' : 'none',
                }}>

                {/* ── Device Chain (horizontal scroll) ── */}
                <div className="scrollbar-hide" onClick={(e) => {
                    if (e.target === e.currentTarget) setSelectedDeviceIds([]);
                }} style={{
                    display: 'flex',
                    alignItems: 'stretch',
                    gap: 6,
                    padding: '10px',
                    flex: 1,
                    minHeight: 0,
                    overflowX: 'auto',
                    overflowY: 'hidden',
                }}>

                    {/* Input meter — real data */}
                    <MeterStrip levelL={inLevelL} levelR={inLevelR} isMidi={selectedTrack?.track_type === 'Midi'} />

                    {/* Device slots — drag to reorder */}
                    {visibleChain.length > 0 ? (
                        visibleChain.map((device, deviceIndex) => (
                            <div
                                key={device.id}
                                onDragOver={(e) => {
                                    e.preventDefault();
                                    e.dataTransfer.dropEffect = 'move';
                                    // Show drop indicator
                                    const rect = e.currentTarget.getBoundingClientRect();
                                    const midX = rect.left + rect.width / 2;
                                    const isLeftHalf = e.clientX < midX;
                                    (e.currentTarget as HTMLElement).style.borderLeft = isLeftHalf ? '3px solid #5ab2ff' : '';
                                    (e.currentTarget as HTMLElement).style.borderRight = !isLeftHalf ? '3px solid #5ab2ff' : '';
                                }}
                                onDragLeave={(e) => {
                                    (e.currentTarget as HTMLElement).style.borderLeft = '';
                                    (e.currentTarget as HTMLElement).style.borderRight = '';
                                }}
                                onDrop={(e) => {
                                    e.preventDefault();
                                    (e.currentTarget as HTMLElement).style.borderLeft = '';
                                    (e.currentTarget as HTMLElement).style.borderRight = '';
                                    const draggedId = e.dataTransfer.getData('application/x-dream-device-id');
                                    const fromIndex = parseInt(e.dataTransfer.getData('application/x-dream-device-index'), 10);
                                    if (!draggedId || isNaN(fromIndex) || fromIndex === deviceIndex) return;
                                    const rect = e.currentTarget.getBoundingClientRect();
                                    const midX = rect.left + rect.width / 2;
                                    const isLeftHalf = e.clientX < midX;
                                    let targetIdx = isLeftHalf ? deviceIndex : deviceIndex + 1;
                                    // Compensate for removal of source element
                                    if (fromIndex < targetIdx) targetIdx = Math.max(0, targetIdx - 1);
                                    if (selectedTrack) {
                                        void engineApi.moveEffectSlot(selectedTrack.id, draggedId, targetIdx)
                                            .then(() => fetchProject())
                                            .catch((err) => console.error('[DeviceRack] moveEffectSlot failed:', err));
                                    }
                                }}
                                className="dream-device-drop-indicator"
                                style={{ display: 'flex', flexShrink: 0, height: '100%', transition: 'border 0.1s ease', position: 'relative' }}
                            >
                                <DeviceNode
                                    device={device}
                                    deviceIndex={deviceIndex}
                                    isSelected={selectedDeviceIds.includes(device.id)}
                                    editorSupported={pluginCapability[device.id]?.supported ?? true}
                                    editorReason={pluginCapability[device.id]?.reason}
                                    runtimeStatus={pluginRuntimeBySlot[device.id]}
                                    onToggle={() => toggleDevice(device)}
                                    onSelect={(e) => {
                                        selectDevice(device.id, e.shiftKey);
                                        rackRef.current?.focus();
                                        statusClear();
                                    }}
                                    onOpenSettings={() => {
                                        if (device.source === 'internal' && device.effectType === 'utility') {
                                            selectDevice(device.id, false);
                                            statusClear();
                                            return;
                                        }
                                        selectDevice(device.id, false);
                                        setInlineSettingsOpen((prev) => ({
                                            ...prev,
                                            [device.id]: !prev[device.id],
                                        }));
                                        statusClear();
                                    }}
                                    onParamChange={(name, value) => {
                                        setPluginParam(device.id, name, value);
                                        const gestureKey = selectedTrack
                                            ? `${selectedTrack.id}:${device.id}:${name.toLowerCase()}`
                                            : null;
                                        sendInternalParam(device, name, value, {
                                            gestureKey: gestureKey && activeParamGesturesRef.current.has(gestureKey)
                                                ? gestureKey
                                                : undefined,
                                        });
                                    }}
                                    onParamGestureStart={(paramName) => beginParamGesture(device.id, paramName)}
                                    onParamGestureEnd={(paramName) => endParamGesture(device.id, paramName)}
                                    onApplyQuickPreset={(preset) => applyQuickPreset(device, preset)}
                                    onRandomize={() => randomizeInternalPluginParams(device)}
                                    onReset={() => resetInternalPluginParams(device)}
                                    onStoreSnapshot={(slot) => storeParamSnapshot(device, slot)}
                                    onRecallSnapshot={(slot) => recallParamSnapshot(device, slot)}
                                    onToggleSnapshot={() => toggleParamSnapshot(device)}
                                    snapshotState={paramSnapshotsByDevice[device.id]}
                                    onApplyUtilityScene={(scene) => applyQuickUtilityScene(device, scene)}
                                    onParamContextMenu={(e, paramName) => handleParamContextMenu(e, paramName, device.id)}
                                    showSettings={device.effectType === 'utility' ? false : !!inlineSettingsOpen[device.id]}
                                    sidechainSourceTrackId={device.sidechainSourceTrackId ?? 'none'}
                                    sidechainOptions={sidechainOptions}
                                    onSidechainSourceChange={(sourceTrackId) => {
                                        void setPluginSidechainSource(device.id, sourceTrackId);
                                    }}
                                    onEnsureActive={async () => {
                                        await ensureSlotRuntimeActive(device.id);
                                    }}
                                    onDropSample={async (samplePath) => {
                                        if (!selectedTrack) return;
                                        try {
                                            const normalizedPath = normalizePickedPath(samplePath);
                                            if (!normalizedPath) {
                                                statusError('Failed to load sampler sample: invalid file path.');
                                                return;
                                            }
                                            await engineApi.setSamplerSample(selectedTrack.id, normalizedPath);
                                            selectDevice(device.id, false);
                                            statusClear();
                                            await fetchProject();
                                        } catch (err) {
                                            console.error('[DeviceRack] sampler device drop failed:', err);
                                            statusError(`Failed to load sampler sample: ${errorMessage(err)}`);
                                        }
                                    }}
                                    onLoadSample={async () => {
                                        if (!selectedTrack) return;
                                        try {
                                            const { open } = await import('@tauri-apps/plugin-dialog');
                                            const picked = await open({
                                                multiple: false,
                                                title: 'Load Sampler Sample',
                                                filters: [{ name: 'Audio', extensions: ['wav', 'aif', 'aiff', 'flac', 'mp3', 'ogg', 'm4a', 'aac'] }],
                                            });
                                            const normalizedPath = normalizePickedPath(picked);
                                            if (normalizedPath) {
                                                await engineApi.setSamplerSample(selectedTrack.id, normalizedPath);
                                                statusClear();
                                                await fetchProject();
                                            }
                                        } catch (err) {
                                            console.error('[DeviceRack] setSamplerSample failed:', err);
                                            statusError(`Failed to load sampler sample: ${errorMessage(err)}`);
                                        }
                                    }}
                                    isNativeEditorOpen={!!(selectedTrack && openEditorsByTrack[selectedTrack.id]?.has(device.id))}
                                    onOpenGUI={async () => {
                                        console.log('[DeviceRack] onOpenGUI clicked device:', device.id, 'name:', device.name, 'source:', device.source, 'pluginId:', device.pluginId);
                                        selectDevice(device.id, false);
                                        if (!selectedTrack) {
                                            console.warn('[DeviceRack] onOpenGUI: no selectedTrack, aborting');
                                            return;
                                        }
                                        const trackId = selectedTrack.id;

                                        // BUG-012: Centralize editor toggling in useEngineStore to maintain 
                                        // Single Source of Truth (SSOT) and prevent double-terminate race conditions.
                                        try {
                                            if (device.source !== 'internal') {
                                                await ensureSlotRuntimeActive(device.id);
                                                await togglePluginEditor(trackId, device.id);
                                            } else {
                                                setInlineSettingsOpen((prev) => ({
                                                    ...prev,
                                                    [device.id]: !prev[device.id],
                                                }));
                                            }
                                            statusClear();
                                        } catch (err) {
                                            console.error('[DeviceRack] togglePluginEditor failed:', err);
                                            statusError(`Failed to open native plugin UI: ${errorMessage(err)}`);
                                        }
                                    }}
                                />
                                <MeterStrip levelL={linearToMeterNorm(device.vuLevelL ?? device.vuLevel)} levelR={linearToMeterNorm(device.vuLevelR ?? device.vuLevel)} />
                            </div>
                        ))
                    ) : (
                        /* ── Empty State ── */
                        <div style={{
                            flex: 1,
                            display: 'flex',
                            flexDirection: 'column',
                            alignItems: 'center',
                            justifyContent: 'center',
                            gap: 8,
                            minHeight: 80,
                            color: 'var(--color-text-tertiary)',
                        }}>
                            <span style={{
                                fontSize: 'var(--font-size-2xl)',
                                opacity: 0.3,
                            }}>♪</span>
                            <span style={{
                                fontSize: 'var(--font-size-xs)',
                                fontWeight: 500,
                                letterSpacing: '0.03em',
                            }}>
                                Drop Files and Devices Here
                            </span>
                        </div>
                    )}

                    {/* Add device button */}
                    <button
                        onClick={() => {
                            window.dispatchEvent(new CustomEvent('dream:browser-set-search', {
                                detail: { categoryId: 'plugins', query: '' },
                            }));
                            statusClear();
                        }}
                        style={{
                            width: 64,
                            minWidth: 64,
                            height: '100%',
                            minHeight: 100,
                            display: 'flex',
                            flexDirection: 'column',
                            alignItems: 'center',
                            justifyContent: 'center',
                            gap: 6,
                            background: 'transparent',
                            border: '1px dashed var(--color-border-subtle)',
                            borderRadius: 'var(--radius-sm)',
                            cursor: 'pointer',
                            color: 'var(--color-text-tertiary)',
                            fontSize: 'var(--font-size-2xs)',
                            fontWeight: 500,
                            flexShrink: 0,
                            transition: 'all var(--transition-fast)',
                        }}
                        onMouseEnter={e => {
                            e.currentTarget.style.borderColor = 'var(--color-accent-primary)';
                            e.currentTarget.style.color = 'var(--color-accent-primary)';
                        }}
                        onMouseLeave={e => {
                            e.currentTarget.style.borderColor = 'var(--color-border-subtle)';
                            e.currentTarget.style.color = 'var(--color-text-tertiary)';
                        }}
                    >
                        <span style={{ fontSize: 'var(--font-size-2xl)', lineHeight: 1 }}>+</span>
                        Add Device
                    </button>
                </div>

                {isDropActive && draggingItem?.type === 'plugin' && (
                    <div
                        style={{
                            position: 'absolute',
                            right: 10,
                            top: 10,
                            zIndex: 'var(--z-header)' as unknown as number,
                            border: '1px solid color-mix(in srgb, var(--color-accent-primary) 65%, #ffffff22)',
                            borderRadius: 'var(--radius-lg)',
                            padding: '5px 8px',
                            background: 'color-mix(in srgb, var(--color-bg-panel) 72%, var(--color-accent-primary) 28%)',
                            color: 'var(--color-text-primary)',
                            fontSize: 'var(--font-size-xs)',
                            fontWeight: 'var(--font-weight-bold)' as unknown as number,
                            letterSpacing: '0.03em',
                            pointerEvents: 'none',
                            textTransform: 'uppercase',
                        }}
                    >
                        Drop Plugin: {draggingItem.name}
                    </div>
                )}

            </div>
        </>
    );

    // ── Automation context menu popup ──
    const renderCtxMenuPopup = () => {
        if (!autoCtxMenu) return null;
        const existingLane = Object.values(automationLanes).find(
            (l) =>
                l.trackId === selectedTrackId &&
                l.paramKey === `${autoCtxMenu.deviceId}:${autoCtxMenu.paramName}`,
        );

        return (
            <div
                onMouseDown={(e) => e.stopPropagation()}
                style={{
                    position: 'fixed',
                    left: autoCtxMenu.x,
                    top: autoCtxMenu.y,
                    zIndex: 'var(--z-menu)' as unknown as number,
                    background: 'var(--color-bg-elevated)',
                    border: '1px solid var(--color-divider)',
                    borderRadius: 'var(--radius-sm)',
                    padding: 4,
                    minWidth: 200,
                    boxShadow: '0 8px 24px var(--color-overlay-dark)',
                }}
            >
                <div
                    style={{
                        fontSize: 'var(--font-size-xs)',
                        color: 'var(--color-text-tertiary)',
                        padding: '4px 8px',
                        fontWeight: 'var(--font-weight-semibold)' as unknown as number,
                        textTransform: 'uppercase',
                        letterSpacing: '0.05em',
                    }}
                >
                    Automation: {autoCtxMenu.paramName}
                </div>
                {existingLane ? (
                    <button
                        onClick={() => {
                            removeAutomationLane(existingLane.id);
                            setAutoCtxMenu(null);
                        }}
                        style={autoCtxMenuItemStyle}
                        onMouseEnter={(e) => {
                            e.currentTarget.style.background = 'var(--color-bg-hover)';
                        }}
                        onMouseLeave={(e) => {
                            e.currentTarget.style.background = 'transparent';
                        }}
                    >
                        ✕ Remove Automation Lane
                    </button>
                ) : (
                    <button
                        onClick={() => {
                            addAutomationLane(
                                selectedTrackId,
                                autoCtxMenu.paramName,
                                `${autoCtxMenu.deviceId}:${autoCtxMenu.paramName}`,
                            );
                            // Ensure automation is visible
                            if (!useAutomationStore.getState().globalVisible) {
                                toggleGlobalAutomation();
                            }
                            setAutoCtxMenu(null);
                        }}
                        style={autoCtxMenuItemStyle}
                        onMouseEnter={(e) => {
                            e.currentTarget.style.background = 'var(--color-bg-hover)';
                        }}
                        onMouseLeave={(e) => {
                            e.currentTarget.style.background = 'transparent';
                        }}
                    >
                        ⊕ Add Automation Lane
                    </button>
                )}
            </div>
        );
    };

    return (
        <>
            {rackContent}
            {renderCtxMenuPopup()}
        </>
    );
};


