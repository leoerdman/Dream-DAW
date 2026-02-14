import { useMemo, useState, useCallback, useEffect, useRef } from 'react';
import throttle from 'lodash.throttle';
import { useEngineStore } from '@/shared/stores/useEngineStore';
import { useDragStore } from '@/shared/stores/useDragStore';
import { useStatusStore } from '@/shared/stores/useStatusStore';
import * as engineApi from '@/shared/api/engine';
import { PluginWindow } from '@/widgets/PluginWindow/PluginWindow';

/**
 * DeviceRack — Bottom panel: instrument & effects signal chain.
 *
 * Each track has its own Instrument & Effects chain (currently empty until
 * the user drops devices). IN/OUT meters show real-time signal levels
 * from the engine's MeterBank.
 *
 * Layout: [Title Bar] → [IN meter] → [...devices...] → [OUT meter] → [+ Add]
 */

// ── Types ──────────────────────────────────────────────────

interface DeviceParam {
    name: string;
    value: number;
    min: number;
    max: number;
    suffix: string;
    step?: number;
}

interface DeviceSlot {
    id: string;
    name: string;
    effectType: 'eq' | 'compressor' | 'delay' | 'reverb' | 'chorus' | 'utility' | 'vst' | 'instrument' | 'sampler' | 'saturator';
    isEnabled: boolean;
    params: DeviceParam[];
    vuLevel: number;
    pluginId: string;
    isVst: boolean;
    source: 'internal' | 'vst' | 'unknown';
    samplePath?: string;
}

const DEVICE_PARAM_PRESETS: Record<
    DeviceSlot['effectType'],
    Array<Omit<DeviceParam, 'value'> & { value: number }>
> = {
    eq: [
        { name: 'Low', value: 0, min: -24, max: 24, suffix: 'dB', step: 0.1 },
        { name: 'Mid', value: 0, min: -24, max: 24, suffix: 'dB', step: 0.1 },
        { name: 'High', value: 0, min: -24, max: 24, suffix: 'dB', step: 0.1 },
        { name: 'Freq', value: 1000, min: 20, max: 20000, suffix: 'Hz', step: 1 },
    ],
    compressor: [
        { name: 'Thr', value: -18, min: -60, max: 0, suffix: 'dB', step: 0.1 },
        { name: 'Ratio', value: 4, min: 1, max: 20, suffix: ':1', step: 0.1 },
        { name: 'Atk', value: 10, min: 0.1, max: 200, suffix: 'ms', step: 0.1 },
        { name: 'Rel', value: 80, min: 10, max: 1000, suffix: 'ms', step: 1 },
    ],
    delay: [
        { name: 'Time', value: 1 / 4, min: 1 / 32, max: 1, suffix: 'note', step: 0.01 },
        { name: 'Fb', value: 30, min: 0, max: 95, suffix: '%', step: 1 },
        { name: 'Dry/Wet', value: 35, min: 0, max: 100, suffix: '%', step: 1 },
    ],
    reverb: [
        { name: 'Size', value: 45, min: 0, max: 100, suffix: '%', step: 1 },
        { name: 'Decay', value: 1.8, min: 0.1, max: 12, suffix: 's', step: 0.1 },
        { name: 'Tone', value: 0, min: -100, max: 100, suffix: '%', step: 1 },
        { name: 'Dry/Wet', value: 22, min: 0, max: 100, suffix: '%', step: 1 },
    ],
    chorus: [
        { name: 'Rate', value: 1.2, min: 0.1, max: 10, suffix: 'Hz', step: 0.1 },
        { name: 'Depth', value: 40, min: 0, max: 100, suffix: '%', step: 1 },
        { name: 'Mix', value: 35, min: 0, max: 100, suffix: '%', step: 1 },
    ],
    utility: [
        { name: 'Gain', value: 0, min: -30, max: 30, suffix: 'dB', step: 0.1 },
        { name: 'Pan', value: 0, min: -100, max: 100, suffix: '%', step: 1 },
        { name: 'Width', value: 100, min: 0, max: 200, suffix: '%', step: 1 },
        { name: 'Mono', value: 0, min: 0, max: 1, suffix: '', step: 1 },
    ],
    vst: [],
    instrument: [
        { name: 'Gain', value: 0, min: -24, max: 12, suffix: 'dB', step: 0.1 },
        { name: 'Atk', value: 5, min: 0, max: 2000, suffix: 'ms', step: 1 },
        { name: 'Rel', value: 50, min: 0, max: 4000, suffix: 'ms', step: 1 },
    ],
    sampler: [
        { name: 'Vol', value: 1, min: 0, max: 2, suffix: '', step: 0.01 },
        { name: 'Attack', value: 0.005, min: 0.001, max: 2.0, suffix: 's', step: 0.001 },
        { name: 'Decay', value: 0.1, min: 0.001, max: 4.0, suffix: 's', step: 0.001 },
        { name: 'Sustain', value: 1.0, min: 0, max: 1, suffix: '', step: 0.01 },
        { name: 'Release', value: 0.05, min: 0.001, max: 8.0, suffix: 's', step: 0.001 },
        { name: 'Root', value: 60, min: 0, max: 127, suffix: '', step: 1 },
    ],
    saturator: [
        { name: 'Drive', value: 3, min: 0, max: 24, suffix: 'dB', step: 0.1 },
        { name: 'Tone', value: 0, min: -100, max: 100, suffix: '%', step: 1 },
        { name: 'Mix', value: 100, min: 0, max: 100, suffix: '%', step: 1 },
    ],
};

// ── VU Meter Helpers ──────────────────────────────────────

/** Normalize a peak dB value (-60..0) to 0..1 for display. */
function vuNorm(peakDb: number): number {
    const minDb = -60;
    const maxDb = 0;
    const clamped = Math.max(minDb, Math.min(maxDb, peakDb));
    return (clamped - minDb) / (maxDb - minDb);
}

function normalizePickedPath(picked: unknown): string | null {
    const rawValue = Array.isArray(picked) ? picked[0] : picked;
    if (typeof rawValue !== 'string') return null;

    let normalized = rawValue.trim();
    if (!normalized) return null;

    if (normalized.startsWith('file://')) {
        try {
            const url = new URL(normalized);
            normalized = decodeURIComponent(url.pathname);
            if (/^\/[A-Za-z]:/.test(normalized)) {
                normalized = normalized.slice(1);
            }
        } catch {
            normalized = decodeURIComponent(normalized.replace(/^file:\/\//, ''));
        }
    }

    return normalized;
}

function errorMessage(err: unknown): string {
    if (err instanceof Error) return err.message;
    if (typeof err === 'string') return err;
    if (err && typeof err === 'object') {
        const maybeMessage = (err as { message?: unknown }).message;
        if (typeof maybeMessage === 'string') return maybeMessage;
    }
    return 'Unknown error';
}

// ── Component ──────────────────────────────────────────

interface DeviceRackProps {
    selectedTrackId: string;
}

export const DeviceRack = ({ selectedTrackId }: DeviceRackProps) => {
    const [localBypass, setLocalBypass] = useState<Record<string, boolean>>({});
    const [localParams, setLocalParams] = useState<Record<string, number>>({});
    const [pluginCapability, setPluginCapability] = useState<
        Record<string, { supported: boolean; reason?: string }>
    >({});
    const [openGuiDevice, setOpenGuiDevice] = useState<DeviceSlot | null>(null);
    const [openSettingsDevice, setOpenSettingsDevice] = useState<DeviceSlot | null>(null);
    const [selectedDeviceId, setSelectedDeviceId] = useState<string | null>(null);
    const statusError = useStatusStore((s) => s.setError);
    const statusClear = useStatusStore((s) => s.clear);
    const throttledParamSendsRef = useRef<Map<string, (value: number) => void>>(new Map());
    const projectTracks = useEngineStore((s) => s.projectTracks);
    const meters = useEngineStore((s) => s.meters);
    const fetchProject = useEngineStore((s) => s.fetchProject);
    const rackRef = useRef<HTMLDivElement>(null);
    const [isDropActive, setIsDropActive] = useState(false);

    // Find the track index for meter lookup
    const isMaster = selectedTrackId === 'master';
    const trackIndex = projectTracks.findIndex(
        (t) => t.id === selectedTrackId
    );

    // Get real-time meter levels for the selected track
    const inLevel = isMaster
        ? vuNorm(meters.master_left.peak)
        : trackIndex >= 0 && meters.tracks[trackIndex]
            ? vuNorm(meters.tracks[trackIndex][0].peak)
            : 0;

    const outLevel = isMaster
        ? vuNorm(meters.master_right.peak)
        : trackIndex >= 0 && meters.tracks[trackIndex]
            ? vuNorm(meters.tracks[trackIndex][1].peak)
            : 0;

    // Track display name
    const trackName = isMaster
        ? 'Master'
        : trackIndex >= 0
            ? projectTracks[trackIndex].name
            : 'No Track';

    const selectedTrack = trackIndex >= 0 ? projectTracks[trackIndex] : null;
    const chain = useMemo((): DeviceSlot[] => {
        if (!selectedTrack || isMaster) return [];

        const slots = [
            ...(selectedTrack.instrument ? [selectedTrack.instrument] : []),
            ...(selectedTrack.effects ?? []),
        ];
        return slots.map((slot) => {
            const pluginId = slot.plugin_id || slot.id;
            const pluginIdLower = pluginId.toLowerCase();
            const isVst = pluginIdLower.includes('vst3') || pluginIdLower.includes('.vst') || pluginIdLower.includes('vst');
            const isInternal = pluginIdLower.startsWith('internal://');

            const normalized = `${slot.name} ${pluginId}`.toLowerCase();
            let effectType: DeviceSlot['effectType'] =
                selectedTrack.instrument?.id === slot.id ? 'instrument' : isVst ? 'vst' : 'utility';
            if (normalized.includes('sampler')) effectType = 'sampler';
            else if (normalized.includes('eq')) effectType = 'eq';
            else if (normalized.includes('compressor')) effectType = 'compressor';
            else if (normalized.includes('delay')) effectType = 'delay';
            else if (normalized.includes('reverb')) effectType = 'reverb';
            else if (normalized.includes('chorus')) effectType = 'chorus';
            else if (normalized.includes('saturator')) effectType = 'saturator';
            else if (selectedTrack.instrument?.id === slot.id && !isVst) effectType = 'instrument';

            return {
                id: slot.id,
                name: slot.name,
                effectType,
                isEnabled: !(localBypass[slot.id] ?? slot.is_bypassed),
                params: (DEVICE_PARAM_PRESETS[effectType] ?? []).map((template) => {
                    const key = `${slot.id}:${template.name}`;
                    return {
                        ...template,
                        value: localParams[key] ?? template.value,
                    };
                }),
                vuLevel: outLevel,
                pluginId,
                isVst,
                source: isInternal ? 'internal' : isVst ? 'vst' : 'unknown',
                samplePath: effectType === 'sampler' || effectType === 'instrument'
                    ? (selectedTrack.sampler?.sample_path ?? undefined)
                    : undefined,
            };
        });
    }, [selectedTrack, localBypass, localParams, isMaster, outLevel]);

    const toggleDevice = useCallback((id: string) => {
        setLocalBypass((prev) => ({ ...prev, [id]: !(prev[id] ?? false) }));
    }, []);

    const setDeviceParam = useCallback((deviceId: string, paramName: string, value: number) => {
        setLocalParams((prev) => ({ ...prev, [`${deviceId}:${paramName}`]: value }));
    }, []);

    const sendInternalParam = useCallback(
        (device: DeviceSlot, paramName: string, value: number) => {
            if (!selectedTrack || selectedTrackId === 'master') return;
            const normalizedName = paramName.toLowerCase();
            let paramId = `${device.effectType}.${normalizedName}`;
            if (device.effectType === 'utility') {
                if (normalizedName === 'gain') paramId = 'plugin.gain';
                else if (normalizedName === 'pan') paramId = 'plugin.pan';
            } else if (device.effectType === 'sampler' || device.effectType === 'instrument') {
                if (normalizedName === 'vol') paramId = 'sampler.volume';
                else if (normalizedName === 'attack') paramId = 'sampler.attack';
                else if (normalizedName === 'decay') paramId = 'sampler.decay';
                else if (normalizedName === 'sustain') paramId = 'sampler.sustain';
                else if (normalizedName === 'release') paramId = 'sampler.release';
                else if (normalizedName === 'root') paramId = 'sampler.rootNote';
            } else if (device.effectType === 'eq') {
                if (normalizedName === 'low') paramId = 'eq.low';
                else if (normalizedName === 'mid') paramId = 'eq.mid';
                else if (normalizedName === 'high') paramId = 'eq.high';
                else if (normalizedName === 'freq') paramId = 'eq.freq';
            }

            const key = `${selectedTrack.id}:${device.id}:${paramId}`;
            let sender = throttledParamSendsRef.current.get(key);
            if (!sender) {
                sender = throttle((v: number) => {
                    void engineApi.setInternalPluginParam(selectedTrack.id, device.id, paramId, v).catch((err) => {
                        console.error('[DeviceRack] setInternalPluginParam failed:', err);
                    });
                }, 32);
                throttledParamSendsRef.current.set(key, sender);
            }
            sender(value);
        },
        [selectedTrack, selectedTrackId],
    );

    useEffect(() => {
        if (selectedDeviceId && !chain.some((d) => d.id === selectedDeviceId)) {
            setSelectedDeviceId(null);
        }
        if (!selectedDeviceId && chain.length > 0) {
            const preferredInline =
                chain.find((d) => d.source === 'internal' && (d.effectType === 'sampler' || d.effectType === 'instrument')) ??
                chain.find((d) => d.source === 'internal') ??
                null;
            if (preferredInline) {
                setSelectedDeviceId(preferredInline.id);
            }
        }
        if (openGuiDevice) {
            const next = chain.find((d) => d.id === openGuiDevice.id);
            if (!next) setOpenGuiDevice(null);
            else setOpenGuiDevice(next);
        }
        if (openSettingsDevice) {
            const next = chain.find((d) => d.id === openSettingsDevice.id);
            if (!next) setOpenSettingsDevice(null);
            else setOpenSettingsDevice(next);
        }
    }, [chain, selectedDeviceId, openGuiDevice, openSettingsDevice]);

    useEffect(() => {
        const onKeyDown = async (e: KeyboardEvent) => {
            if ((e.key !== 'Delete' && e.key !== 'Backspace') || !selectedDeviceId) return;
            const tag = (e.target as HTMLElement | null)?.tagName?.toLowerCase();
            if (tag === 'input' || tag === 'textarea' || (e.target as HTMLElement | null)?.isContentEditable) return;
            if (!selectedTrack || selectedTrackId === 'master') return;
            e.preventDefault();
            try {
                await engineApi.removePluginFromTrack(selectedTrack.id, selectedDeviceId);
                if (openGuiDevice?.id === selectedDeviceId) setOpenGuiDevice(null);
                if (openSettingsDevice?.id === selectedDeviceId) setOpenSettingsDevice(null);
                setSelectedDeviceId(null);
                await fetchProject();
                statusClear();
            } catch (err) {
                console.error('[DeviceRack] removePluginFromTrack failed:', err);
                statusError('Failed to remove plugin from track.');
            }
        };
        window.addEventListener('keydown', onKeyDown);
        return () => window.removeEventListener('keydown', onKeyDown);
    }, [selectedDeviceId, selectedTrack, selectedTrackId, openGuiDevice, openSettingsDevice, fetchProject, statusClear, statusError]);

    useEffect(() => {
        let cancelled = false;
        const vstDevices = chain.filter((d) => d.isVst);
        const missing = vstDevices.filter((d) => pluginCapability[d.pluginId] == null);
        if (missing.length === 0) {
            return;
        }

        (async () => {
            const results = await Promise.all(
                missing.map(async (device) => {
                    try {
                        const cap = await engineApi.canOpenPluginEditor(device.pluginId);
                        return [device.pluginId, { supported: cap.supported, reason: cap.reason ?? undefined }] as const;
                    } catch (err) {
                        console.error('[DeviceRack] Capability probe failed:', err);
                        return [device.pluginId, { supported: false, reason: 'Capability check failed.' }] as const;
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
    }, [chain, pluginCapability]);

    useEffect(() => {
        const onMouseMove = (e: MouseEvent) => {
            const dragging = useDragStore.getState().draggingItem;
            if (!dragging || dragging.type !== 'plugin' || isMaster) {
                if (isDropActive) {
                    setIsDropActive(false);
                }
                return;
            }
            const rect = rackRef.current?.getBoundingClientRect();
            if (!rect) return;
            const inside =
                e.clientX >= rect.left &&
                e.clientX <= rect.right &&
                e.clientY >= rect.top &&
                e.clientY <= rect.bottom;
            if (inside !== isDropActive) {
                setIsDropActive(inside);
            }
        };

        const onMouseUp = async (e: MouseEvent) => {
            const dragging = useDragStore.getState().draggingItem;
            if (!dragging || dragging.type !== 'plugin' || isMaster) return;
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

            const targetTrack = selectedTrack ?? projectTracks[0] ?? null;
            if (!targetTrack) {
                statusError('No target track selected.');
                useDragStore.getState().endDrag();
                setIsDropActive(false);
                return;
            }

            const hint = dragging.slotHint ?? 'auto';
            const slot: 'instrument' | 'effect' =
                hint === 'instrument'
                    ? 'instrument'
                    : hint === 'effect'
                        ? 'effect'
                        : targetTrack.track_type === 'Midi' && !targetTrack.instrument
                            ? 'instrument'
                            : 'effect';
            try {
                await engineApi.addPluginToTrack(
                    targetTrack.id,
                    dragging.path,
                    dragging.name,
                    slot,
                );
                await fetchProject();
                statusClear();
            } catch (err) {
                console.error('[DeviceRack] addPluginToTrack failed:', err);
                statusError('Failed to add plugin to track.');
            } finally {
                useDragStore.getState().endDrag();
                setIsDropActive(false);
            }
        };

        window.addEventListener('mousemove', onMouseMove);
        window.addEventListener('mouseup', onMouseUp, true);
        return () => {
            window.removeEventListener('mousemove', onMouseMove);
            window.removeEventListener('mouseup', onMouseUp, true);
        };
    }, [isDropActive, isMaster, selectedTrack, projectTracks, fetchProject, statusClear, statusError]);

    return (
        <>
            <div
                ref={rackRef}
                tabIndex={0}
                data-keyboard-scope="device-rack"
                data-selected-device-id={selectedDeviceId ?? ''}
                onMouseDown={() => rackRef.current?.focus()}
                style={{
                display: 'flex',
                flexDirection: 'column',
                height: '100%',
                background: 'var(--color-bg-panel)',
                outline: isDropActive ? '2px solid var(--color-accent-primary)' : 'none',
                boxShadow: isDropActive ? 'inset 0 0 0 1px rgba(74, 144, 217, 0.35)' : 'none',
            }}>


                {/* ── Header Bar ── */}
                <div style={{
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'space-between',
                    padding: '4px 10px',
                    borderBottom: '1px solid var(--color-divider)',
                    background: 'var(--color-bg-header)',
                    height: 24,
                    flexShrink: 0,
                }}>
                    <span style={{
                        fontSize: 'var(--font-size-2xs)',
                        fontWeight: 600,
                        color: 'var(--color-text-secondary)',
                        textTransform: 'uppercase',
                        letterSpacing: '0.05em',
                    }}>
                        ⛓ {trackName} — Instrument & Effects Chain · {chain.length} devices
                    </span>
                    <span style={{
                        fontSize: 'var(--font-size-2xs)',
                        color: 'var(--color-text-tertiary)',
                    }}>
                        {trackName}
                    </span>
                </div>

                {/* ── Device Chain (horizontal scroll) ── */}
                <div className="scrollbar-hide" style={{
                    display: 'flex',
                    alignItems: 'flex-start',
                    gap: 6,
                    padding: '8px 10px',
                    flex: 1,
                    overflowX: 'auto',
                    overflowY: 'hidden',
                }}>

                    {/* Input meter — real data */}
                    <MeterBar label="IN" level={inLevel} isInput />

                    {/* Device slots */}
                    {chain.length > 0 ? (
                        chain.map((device, idx) => (
                            <DeviceNode
                                key={device.id}
                                order={idx + 1}
                                device={device}
                                isSelected={selectedDeviceId === device.id}
                                editorSupported={pluginCapability[device.pluginId]?.supported ?? true}
                                editorReason={pluginCapability[device.pluginId]?.reason}
                                onToggle={() => toggleDevice(device.id)}
                                onSelect={() => {
                                    setSelectedDeviceId(device.id);
                                    rackRef.current?.focus();
                                    statusClear();
                                }}
                                onOpenSettings={() => {
                                    if (device.source !== 'vst') return;
                                    setSelectedDeviceId(device.id);
                                    setOpenSettingsDevice(device);
                                    statusClear();
                                }}
                                onParamChange={(name, value) => {
                                    setDeviceParam(device.id, name, value);
                                    sendInternalParam(device, name, value);
                                }}
                                onDropSample={async (samplePath) => {
                                    if (!selectedTrack || selectedTrackId === 'master') return;
                                    try {
                                        const normalizedPath = normalizePickedPath(samplePath);
                                        if (!normalizedPath) {
                                            statusError('Failed to load sampler sample: invalid file path.');
                                            return;
                                        }
                                        await engineApi.setSamplerSample(selectedTrack.id, normalizedPath);
                                        setSelectedDeviceId(device.id);
                                        statusClear();
                                        await fetchProject();
                                    } catch (err) {
                                        console.error('[DeviceRack] sampler device drop failed:', err);
                                        statusError(`Failed to load sampler sample: ${errorMessage(err)}`);
                                    }
                                }}
                                onLoadSample={async () => {
                                    if (!selectedTrack || selectedTrackId === 'master') return;
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
                                onOpenGUI={async () => {
                                    setSelectedDeviceId(device.id);
                                    if (device.source === 'internal') {
                                        statusClear();
                                        return;
                                    }
                                    try {
                                        const capability = await engineApi.canOpenPluginEditor(device.pluginId);
                                        setPluginCapability((prev) => ({
                                            ...prev,
                                            [device.pluginId]: {
                                                supported: capability.supported,
                                                reason: capability.reason ?? undefined,
                                            },
                                        }));
                                        if (!capability.supported) {
                                            const reason = capability.reason ?? 'Plugin editor is not supported.';
                                            console.warn('[DeviceRack] Plugin editor unavailable:', reason);
                                            statusError(reason);
                                            return;
                                        }
                                        // Try native plugin editor bridge first (host-managed).
                                        // Keep DAW-owned UI fallback available for consistency.
                                        await engineApi.openPluginWindow(device.pluginId);
                                        setOpenGuiDevice(device);
                                        statusClear();
                                    } catch (err) {
                                        console.error('[DeviceRack] Failed to open plugin window:', err);
                                        statusError('Failed to open plugin window.');
                                    }
                                }}
                            />
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
                                fontSize: 20,
                                opacity: 0.3,
                            }}>♪</span>
                            <span style={{
                                fontSize: 10,
                                fontWeight: 500,
                                letterSpacing: '0.03em',
                            }}>
                                Drop Files and Devices Here
                            </span>
                        </div>
                    )}

                    {/* Output meter — real data */}
                    <MeterBar label="OUT" level={outLevel} />

                    {/* Add device button */}
                    <button
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
                            fontSize: 9,
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
                        <span style={{ fontSize: 18, lineHeight: 1 }}>+</span>
                        Add Device
                    </button>
                </div>

            </div>
            {openGuiDevice && openGuiDevice.isVst && (
                <PluginWindow
                    pluginId={openGuiDevice.pluginId}
                    pluginName={openGuiDevice.name}
                    pluginType={openGuiDevice.effectType === 'sampler' || openGuiDevice.effectType === 'instrument' ? 'instrument' : 'effect'}
                    isBypassed={!openGuiDevice.isEnabled}
                    onToggleBypass={() => toggleDevice(openGuiDevice.id)}
                    onClose={() => setOpenGuiDevice(null)}
                    width={openGuiDevice.isVst ? 960 : openGuiDevice.effectType === 'eq' ? 760 : openGuiDevice.effectType === 'sampler' ? 820 : 640}
                    height={openGuiDevice.effectType === 'eq' ? 420 : openGuiDevice.effectType === 'sampler' ? 460 : 380}
                >
                    <PluginGuiSurface
                        device={openGuiDevice}
                        onParamChange={(name, value) => {
                            setDeviceParam(openGuiDevice.id, name, value);
                            sendInternalParam(openGuiDevice, name, value);
                        }}
                        onDropSample={async (samplePath) => {
                            if (!selectedTrack || selectedTrackId === 'master') return;
                            try {
                                const normalizedPath = normalizePickedPath(samplePath);
                                if (!normalizedPath) {
                                    statusError('Failed to load sampler sample: invalid file path.');
                                    return;
                                }
                                await engineApi.setSamplerSample(selectedTrack.id, normalizedPath);
                                statusClear();
                                await fetchProject();
                            } catch (err) {
                                console.error('[DeviceRack] sampler drop failed:', err);
                                statusError(`Failed to load sampler sample: ${errorMessage(err)}`);
                            }
                        }}
                        onLoadSample={async () => {
                            if (!selectedTrack || selectedTrackId === 'master') return;
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
                    />
                </PluginWindow>
            )}
            {openSettingsDevice && openSettingsDevice.isVst && (
                <PluginWindow
                    pluginId={`${openSettingsDevice.pluginId}:settings`}
                    pluginName={`${openSettingsDevice.name} • Settings`}
                    pluginType={openSettingsDevice.effectType === 'sampler' || openSettingsDevice.effectType === 'instrument' ? 'instrument' : 'effect'}
                    isBypassed={!openSettingsDevice.isEnabled}
                    onToggleBypass={() => toggleDevice(openSettingsDevice.id)}
                    onClose={() => setOpenSettingsDevice(null)}
                    width={560}
                    height={400}
                >
                    <PluginSettingsPanel
                        device={openSettingsDevice}
                        onParamChange={(name, value) => {
                            setDeviceParam(openSettingsDevice.id, name, value);
                            sendInternalParam(openSettingsDevice, name, value);
                        }}
                        onLoadSample={async () => {
                            if (!selectedTrack || selectedTrackId === 'master') return;
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
                    />
                </PluginWindow>
            )}
        </>
    );
};

// ── DeviceNode ──────────────────────────────────────────

const DeviceNode = ({
    order,
    device, onToggle, onOpenGUI,
    isSelected,
    onSelect,
    onOpenSettings,
    onParamChange,
    onDropSample,
    onLoadSample,
    editorSupported, editorReason,
}: {
    order: number;
    device: DeviceSlot;
    onToggle: () => void;
    isSelected: boolean;
    onSelect: () => void;
    onOpenSettings: () => void;
    onParamChange: (paramName: string, value: number) => void;
    onDropSample?: (samplePath: string) => void;
    onLoadSample?: () => void;
    onOpenGUI?: () => void;
    editorSupported?: boolean;
    editorReason?: string;
}) => {
    const vuWidthPercent = Math.min(100, Math.max(0, device.vuLevel * 100));
    const vuColor = device.vuLevel > 0.85 ? 'var(--color-meter-clip)' : device.vuLevel > 0.6 ? 'var(--color-meter-hot)' : 'var(--color-meter-normal)';

    // Color per device type (matching Ableton's device categories)
    const typeColorMap: Record<string, string> = {
        instrument: '#4a9eff',
        sampler: '#4a9eff',
        eq: '#d9a625',
        compressor: '#66cc33',
        delay: '#33a6d9',
        reverb: '#8844aa',
        chorus: '#c850a0',
        utility: '#999',
        saturator: '#d97028',
        vst: '#4a9eff',
    };
    const typeColor = typeColorMap[device.effectType] || 'var(--color-accent-primary)';
    const rackWidth = isSelected && device.source === 'internal'
        ? 820
        : device.effectType === 'sampler'
            ? 350
            : device.effectType === 'instrument'
                ? 300
                : device.effectType === 'eq'
                    ? 260
                    : 220;

    return (
        <div
            className="device-node"
            data-effect={device.effectType}
            style={{
                minWidth: rackWidth,
                width: rackWidth,
                display: 'flex',
                flexDirection: 'column',
                background: 'var(--color-bg-node)',
                borderRadius: 'var(--radius-sm)',
                border: '1px solid var(--color-border-subtle)',
                overflow: 'hidden',
                opacity: device.isEnabled ? 1 : 0.5,
                transition: 'opacity var(--transition-fast)',
                flexShrink: 0,
                minHeight: isSelected && device.source === 'internal' ? 248 : 126,
                maxHeight: isSelected && device.source === 'internal' ? 248 : 126,
                position: 'relative',
                boxShadow: isSelected ? '0 0 0 1px var(--color-accent-primary), 0 0 12px rgba(74,144,217,0.35)' : 'none',
            }}
            onMouseUp={() => {
                const dragging = useDragStore.getState().draggingItem;
                const isSamplerDevice =
                    device.source === 'internal' &&
                    (device.effectType === 'sampler' || device.effectType === 'instrument');
                if (!isSamplerDevice) return;
                if (dragging?.type === 'audio' && dragging.path) {
                    onDropSample?.(dragging.path);
                    useDragStore.getState().endDrag();
                }
            }}
        >
            {/* Type color stripe at top (2px) */}
            <div style={{
                height: 2,
                background: typeColor,
                flexShrink: 0,
            }} />

            {/* Header */}
            <div style={{
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'space-between',
                padding: '3px 6px',
                borderBottom: '1px solid var(--color-divider)',
                background: isSelected ? 'color-mix(in srgb, var(--color-bg-header) 70%, var(--color-accent-primary))' : 'var(--color-bg-header)',
                cursor: 'pointer',
            }}
                onClick={(e) => { e.stopPropagation(); onSelect(); }}
            >
                <button
                    onClick={onToggle}
                    title={device.isEnabled ? 'Disable' : 'Enable'}
                    style={{
                        width: 8, height: 8,
                        borderRadius: '50%',
                        background: device.isEnabled ? typeColor : 'var(--color-text-tertiary)',
                        border: 'none',
                        cursor: 'pointer',
                        flexShrink: 0,
                    }}
                />
                <span style={{
                    fontSize: 'var(--font-size-2xs)',
                    fontWeight: 600,
                    color: 'var(--color-text-primary)',
                    flex: 1,
                    textAlign: 'center',
                    overflow: 'hidden',
                    textOverflow: 'ellipsis',
                    whiteSpace: 'nowrap',
                }}>
                    {device.name}
                </span>
                <span style={{
                    fontSize: 9,
                    color: 'var(--color-text-tertiary)',
                    fontFamily: 'var(--font-mono)',
                    marginRight: 4,
                }}>
                    {order}
                </span>
                {device.source === 'vst' ? (
                    <div style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
                        <button
                            onClick={(e) => { e.stopPropagation(); onOpenGUI?.(); }}
                            title={editorSupported === false
                                ? (editorReason ?? 'Plugin editor is unavailable')
                                : 'Open Plugin GUI'}
                            disabled={editorSupported === false}
                            style={headerIconBtnStyle(editorSupported === false)}
                        >
                            UI
                        </button>
                        <button
                            onClick={(e) => { e.stopPropagation(); onOpenSettings(); }}
                            title="Plugin Settings / Automatable Params"
                            style={headerIconBtnStyle(false)}
                        >
                            🔧
                        </button>
                    </div>
                ) : (
                    <span style={{ fontSize: 9, color: 'var(--color-text-tertiary)', fontWeight: 700 }}>
                        INLINE
                    </span>
                )}
                <span style={{
                    fontSize: 8,
                    color: device.source === 'vst' ? '#2ecc71' : 'var(--color-text-tertiary)',
                    fontWeight: 700,
                    minWidth: 28,
                    textAlign: 'right',
                }}>
                    {device.source === 'vst' ? 'VST' : 'INT'}
                </span>
            </div>

            {isSelected && device.source === 'internal' ? (
                <div style={{ padding: 8 }}>
                    <PluginGuiSurface
                        device={device}
                        onParamChange={onParamChange}
                        onDropSample={onDropSample}
                        onLoadSample={onLoadSample}
                    />
                </div>
            ) : (
                <div style={{
                    display: 'flex',
                    alignItems: 'center',
                    gap: 8,
                    padding: '8px',
                    minHeight: 82,
                    overflow: 'hidden',
                }}>
                    {device.source === 'internal' && device.params.length > 0 ? (
                        <div style={{ display: 'flex', alignItems: 'center', gap: 8, overflow: 'hidden' }}>
                            {device.params.slice(0, device.effectType === 'sampler' ? 4 : 3).map((p) => (
                                <ParamKnob key={p.name} param={p} onChange={onParamChange} />
                            ))}
                        </div>
                    ) : (
                        <div style={{ display: 'flex', width: '100%', justifyContent: 'space-between' }}>
                            <span style={{ fontSize: 10, color: 'var(--color-text-secondary)' }}>
                                {device.source === 'vst' ? 'Native GUI' : 'Internal GUI'}
                            </span>
                            <span style={{ fontSize: 9, color: 'var(--color-text-tertiary)' }}>
                                {device.params.length} params
                            </span>
                        </div>
                    )}
                </div>
            )}

            {/* Bottom VU bar */}
            <div style={{
                height: 3,
                background: 'var(--color-meter-bg)',
                position: 'relative',
                flexShrink: 0,
            }}>
                <div style={{
                    position: 'absolute',
                    left: 0,
                    top: 0,
                    height: '100%',
                    width: `${vuWidthPercent}%`,
                    background: vuColor,
                    transition: 'width 0.08s linear',
                }} />
            </div>
        </div>
    );
};

const headerIconBtnStyle = (disabled: boolean) =>
    ({
        minWidth: 24,
        height: 18,
        padding: '0 6px',
        borderRadius: 4,
        border: '1px solid var(--color-divider)',
        background: disabled ? 'rgba(120, 120, 120, 0.25)' : 'var(--color-bg-elevated)',
        color: disabled ? 'var(--color-text-tertiary)' : 'var(--color-text-secondary)',
        fontSize: 9,
        fontWeight: 700,
        cursor: disabled ? 'not-allowed' : 'pointer',
        opacity: disabled ? 0.65 : 1,
        transition: 'all var(--transition-fast)',
    }) as const;

const PluginGuiSurface = ({
    device,
    onParamChange,
    onDropSample,
    onLoadSample,
}: {
    device: DeviceSlot;
    onParamChange: (paramName: string, value: number) => void;
    onDropSample?: (samplePath: string) => void;
    onLoadSample?: () => void;
}) => {
    const [waveformPeaks, setWaveformPeaks] = useState<number[] | null>(null);

    useEffect(() => {
        const samplePath = device.samplePath?.trim();
        if (!samplePath) {
            return;
        }
        let cancelled = false;
        engineApi.getWaveformPeaks(samplePath)
            .then((wf) => {
                if (cancelled) return;
                const level = wf.mip_levels[Math.min(2, Math.max(0, wf.mip_levels.length - 1))] ?? wf.mip_levels[0];
                const peaks = (level?.peaks ?? []).map((p) => Math.max(Math.abs(p.min), Math.abs(p.max)));
                setWaveformPeaks(peaks.length > 0 ? peaks : null);
            })
            .catch((err) => {
                if (!cancelled) {
                    console.warn('[DeviceRack] sampler waveform load failed:', err);
                    setWaveformPeaks(null);
                }
            });
        return () => {
            cancelled = true;
        };
    }, [device.samplePath]);

    if (device.effectType === 'sampler' || device.effectType === 'instrument') {
        const getParam = (name: string, fallback: string) => {
            const p = device.params.find((x) => x.name.toLowerCase() === name.toLowerCase());
            if (!p) return fallback;
            return `${p.value.toFixed(p.step && p.step < 1 ? 2 : 0)}${p.suffix}`;
        };
        return (
            <div style={{
                display: 'grid',
                gridTemplateRows: '130px auto',
                height: '100%',
                gap: 8,
                border: '1px solid #4d4d4d',
                borderRadius: 4,
                background: '#2a2a2a',
                overflow: 'hidden',
            }}>
                <div style={{
                    background: '#333333',
                    position: 'relative',
                    overflow: 'hidden',
                }}
                    onMouseUp={() => {
                        const dragging = useDragStore.getState().draggingItem;
                        if (dragging?.type === 'audio' && dragging.path) {
                            onDropSample?.(dragging.path);
                            useDragStore.getState().endDrag();
                        }
                    }}
                >
                    <div style={{ position: 'absolute', inset: 0, borderBottom: '1px solid rgba(255,255,255,0.09)' }} />
                    <div style={{
                        position: 'absolute',
                        left: 0,
                        right: 0,
                        top: 0,
                        height: 22,
                        borderBottom: '1px solid rgba(255,255,255,0.08)',
                        display: 'flex',
                        alignItems: 'center',
                        justifyContent: 'space-between',
                        padding: '0 8px',
                        fontSize: 9,
                        color: '#d0d0d0',
                        background: 'linear-gradient(180deg, #2c2c2c 0%, #222222 100%)',
                    }}>
                        <span style={{ fontWeight: 700 }}>Sample</span>
                        <span style={{ fontSize: 9, opacity: 0.85 }}>Controls</span>
                    </div>
                    <svg
                        viewBox="0 0 1000 110"
                        preserveAspectRatio="none"
                        style={{ position: 'absolute', left: 6, right: 6, top: 24, height: 68, width: 'calc(100% - 12px)' }}
                    >
                        <rect x="0" y="0" width="1000" height="110" fill="#202020" />
                        {Array.from({ length: 24 }).map((_, i) => (
                            <line
                                key={`g-${i}`}
                                x1={(i / 23) * 1000}
                                y1={0}
                                x2={(i / 23) * 1000}
                                y2={110}
                                stroke="rgba(255,255,255,0.06)"
                                strokeWidth="1"
                            />
                        ))}
                        {waveformPeaks ? (
                            <>
                                {Array.from({ length: 220 }).map((_, i) => {
                                    const idx = Math.floor((i / 219) * (waveformPeaks.length - 1));
                                    const amp = Math.max(0.01, Math.min(1, waveformPeaks[idx] || 0));
                                    const h = amp * 52;
                                    return (
                                        <line
                                            key={`w-${i}`}
                                            x1={(i / 219) * 1000}
                                            y1={55 - h}
                                            x2={(i / 219) * 1000}
                                            y2={55 + h}
                                            stroke="#ffb01a"
                                            strokeWidth="1.2"
                                            strokeOpacity="0.95"
                                        />
                                    );
                                })}
                            </>
                        ) : (
                            <path
                                d="M 0 54 C 30 10, 60 98, 90 54 C 120 10, 150 98, 180 54 C 210 10, 240 98, 270 54 C 300 10, 330 98, 360 54 C 390 10, 420 98, 450 54 C 480 10, 510 98, 540 54 C 570 18, 600 90, 630 54 C 660 24, 690 82, 720 54 C 750 30, 780 74, 810 54 C 840 36, 870 68, 900 54 C 930 46, 960 56, 1000 54"
                                fill="none"
                                stroke="#ffb01a"
                                strokeWidth="3"
                                strokeLinecap="round"
                            />
                        )}
                    </svg>
                    <div style={{
                        position: 'absolute',
                        top: 95,
                        left: 8,
                        fontSize: 9,
                        color: '#bbbbbb',
                    }}>
                        {device.samplePath ? device.samplePath.split('/').pop() : 'Drag sample here or load from disk'}
                    </div>
                    <div style={{
                        position: 'absolute',
                        left: 8,
                        right: 130,
                        bottom: 6,
                        display: 'grid',
                        gridTemplateColumns: 'repeat(6, minmax(0, 1fr))',
                        gap: 8,
                        fontSize: 9,
                    }}>
                        <div style={{ color: '#9a9a9a' }}><div>Start</div><div style={{ color: '#57b4ff', fontFamily: 'var(--font-mono)' }}>0.00%</div></div>
                        <div style={{ color: '#9a9a9a' }}><div>Loop</div><div style={{ color: '#57b4ff', fontFamily: 'var(--font-mono)' }}>100%</div></div>
                        <div style={{ color: '#9a9a9a' }}><div>Length</div><div style={{ color: '#57b4ff', fontFamily: 'var(--font-mono)' }}>100%</div></div>
                        <div style={{ color: '#9a9a9a' }}><div>Attack</div><div style={{ color: '#57b4ff', fontFamily: 'var(--font-mono)' }}>{getParam('Attack', '0.01s')}</div></div>
                        <div style={{ color: '#9a9a9a' }}><div>Decay</div><div style={{ color: '#57b4ff', fontFamily: 'var(--font-mono)' }}>{getParam('Decay', '0.10s')}</div></div>
                        <div style={{ color: '#9a9a9a' }}><div>Release</div><div style={{ color: '#57b4ff', fontFamily: 'var(--font-mono)' }}>{getParam('Release', '0.05s')}</div></div>
                    </div>
                    <button
                        type="button"
                        onClick={() => onLoadSample?.()}
                        style={{
                            position: 'absolute',
                            right: 8,
                            top: 2,
                            border: '1px solid #555555',
                            borderRadius: 3,
                            background: '#2c2c2c',
                            color: '#d0d0d0',
                            fontSize: 9,
                            padding: '3px 7px',
                            cursor: 'pointer',
                        }}
                    >
                        Load Sample
                    </button>
                </div>
                <div style={{
                    display: 'flex',
                    alignItems: 'center',
                    gap: 12,
                    padding: '6px 8px 8px 8px',
                    background: '#272727',
                    borderTop: '1px solid rgba(255,255,255,0.06)',
                }}>
                    {device.params.slice(0, 6).map((p) => (
                        <ParamKnob key={p.name} param={p} onChange={onParamChange} />
                    ))}
                </div>
            </div>
        );
    }

    if (device.effectType === 'eq') {
        return (
            <div style={{ display: 'grid', gridTemplateRows: '1fr auto', height: '100%', gap: 10 }}>
                <div style={{
                    border: '1px solid var(--color-divider)',
                    borderRadius: 6,
                    background: '#0d0d0d',
                    position: 'relative',
                    overflow: 'hidden',
                }}>
                    <svg width="100%" height="100%" viewBox="0 0 100 40" preserveAspectRatio="none">
                        {Array.from({ length: 10 }).map((_, i) => (
                            <line key={`vx-${i}`} x1={i * 10} y1={0} x2={i * 10} y2={40} stroke="rgba(255,255,255,0.08)" strokeWidth="0.2" />
                        ))}
                        {Array.from({ length: 5 }).map((_, i) => (
                            <line key={`hx-${i}`} x1={0} y1={i * 10} x2={100} y2={i * 10} stroke="rgba(255,255,255,0.08)" strokeWidth="0.2" />
                        ))}
                        <path d="M 0 20 C 10 20, 20 16, 30 20 C 40 24, 50 12, 60 20 C 70 28, 80 18, 90 20 L 100 20"
                            fill="none" stroke="#d9a625" strokeWidth="1.2" />
                    </svg>
                </div>
                <div style={{ display: 'flex', flexWrap: 'wrap', gap: 12 }}>
                    {device.params.slice(0, 4).map((p) => (
                        <ParamKnob key={p.name} param={p} onChange={onParamChange} />
                    ))}
                </div>
            </div>
        );
    }

    if (device.effectType === 'utility') {
        return (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
                <div style={{
                    border: '1px solid var(--color-divider)',
                    borderRadius: 6,
                    padding: 10,
                    background: '#121212',
                    display: 'grid',
                    gridTemplateColumns: 'repeat(4, minmax(90px, 1fr))',
                    gap: 12,
                }}>
                    {device.params.slice(0, 4).map((p) => (
                        <ParamKnob key={p.name} param={p} onChange={onParamChange} />
                    ))}
                </div>
            </div>
        );
    }

    return (
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 12 }}>
            {device.params.map((p) => (
                <ParamKnob key={p.name} param={p} onChange={onParamChange} />
            ))}
        </div>
    );
};

const PluginSettingsPanel = ({
    device,
    onParamChange,
    onLoadSample,
}: {
    device: DeviceSlot;
    onParamChange: (paramName: string, value: number) => void;
    onLoadSample?: () => void;
}) => (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
        {device.effectType === 'sampler' && (
            <button
                type="button"
                onClick={() => onLoadSample?.()}
                style={{
                    width: 'fit-content',
                    border: '1px solid var(--color-divider)',
                    borderRadius: 4,
                    background: 'var(--color-bg-header)',
                    color: 'var(--color-text-secondary)',
                    fontSize: 11,
                    padding: '6px 10px',
                    cursor: 'pointer',
                }}
            >
                Load Sample
            </button>
        )}
        <div style={{
            display: 'grid',
            gridTemplateColumns: 'repeat(2, minmax(180px, 1fr))',
            gap: 10,
        }}>
            {device.params.map((p) => (
                <ParamSlider key={p.name} param={p} onChange={onParamChange} />
            ))}
        </div>
    </div>
);

const ParamSlider = ({
    param,
    onChange,
}: {
    param: DeviceParam;
    onChange: (paramName: string, value: number) => void;
}) => (
    <label style={{ display: 'flex', flexDirection: 'column', gap: 4, minWidth: 110 }}>
        <span style={{ fontSize: 10, color: 'var(--color-text-secondary)' }}>
            {param.name} <span style={{ color: 'var(--color-text-tertiary)' }}>{param.value.toFixed(param.step && param.step < 1 ? 2 : 0)}{param.suffix}</span>
        </span>
        <input
            type="range"
            min={param.min}
            max={param.max}
            step={param.step ?? (param.max - param.min) / 100}
            value={param.value}
            onChange={(e) => onChange(param.name, Number(e.target.value))}
            style={{ width: '100%' }}
        />
    </label>
);

const ParamKnob = ({
    param,
    onChange,
}: {
    param: DeviceParam;
    onChange: (paramName: string, value: number) => void;
}) => {
    const pct = Math.max(0, Math.min(1, (param.value - param.min) / Math.max(1e-9, param.max - param.min)));
    const angle = -135 + pct * 270;
    const valueText = param.value.toFixed(param.step && param.step < 1 ? 2 : 0);
    return (
        <label style={{
            display: 'flex',
            flexDirection: 'column',
            alignItems: 'center',
            gap: 5,
            minWidth: 86,
        }}>
            <span style={{ fontSize: 10, color: 'var(--color-text-secondary)', textAlign: 'center', lineHeight: 1.1 }}>
                {param.name}
            </span>
            <div style={{ position: 'relative', width: 42, height: 42 }}>
                <div style={{
                    width: '100%',
                    height: '100%',
                    borderRadius: '50%',
                    background: 'radial-gradient(circle at 35% 30%, #303030 0%, #191919 58%, #0e0e0e 100%)',
                    border: '1px solid rgba(255,255,255,0.2)',
                    boxShadow: 'inset 0 1px 2px rgba(255,255,255,0.08), inset 0 -2px 4px rgba(0,0,0,0.5)',
                    position: 'relative',
                }}>
                    <div style={{
                        position: 'absolute',
                        left: '50%',
                        top: '50%',
                        width: 2,
                        height: 14,
                        background: 'var(--color-accent-primary)',
                        transformOrigin: '50% 90%',
                        transform: `translate(-50%, -88%) rotate(${angle}deg)`,
                        borderRadius: 999,
                        boxShadow: '0 0 3px rgba(74,144,217,0.7)',
                    }} />
                </div>
                <input
                    type="range"
                    min={param.min}
                    max={param.max}
                    step={param.step ?? (param.max - param.min) / 100}
                    value={param.value}
                    onChange={(e) => onChange(param.name, Number(e.target.value))}
                    style={{
                        position: 'absolute',
                        inset: 0,
                        opacity: 0,
                        cursor: 'ns-resize',
                    }}
                />
            </div>
            <span style={{ fontSize: 10, color: 'var(--color-text-primary)', fontFamily: 'var(--font-mono)' }}>
                {valueText}{param.suffix}
            </span>
        </label>
    );
};

// ── MeterBar (small vertical signal meter) ──────────────

const MeterBar = ({ label, level, isInput }: { label: string; level: number; isInput?: boolean }) => {
    const h = Math.max(0, Math.min(100, level * 100));
    const meterColor = level > 0.85 ? 'var(--color-meter-clip)' : level > 0.6 ? 'var(--color-meter-hot)' : 'var(--color-meter-normal)';

    return (
        <div style={{
            display: 'flex',
            flexDirection: 'column',
            alignItems: 'center',
            gap: 2,
            flexShrink: 0,
            alignSelf: 'stretch',
        }}>
            <div style={{
                width: 10,
                flex: 1,
                background: 'var(--color-meter-bg)',
                borderRadius: 1,
                position: 'relative',
                overflow: 'hidden',
            }}>
                <div style={{
                    position: 'absolute',
                    bottom: 0,
                    left: 0,
                    width: '100%',
                    height: `${h}%`,
                    background: isInput ? 'var(--color-midi-indicator)' : meterColor,
                    borderRadius: 1,
                    transition: 'height 0.08s linear',
                }} />
            </div>
            <span style={{
                fontSize: 7,
                color: 'var(--color-text-tertiary)',
                fontWeight: 600,
            }}>
                {label}
            </span>
        </div>
    );
};
