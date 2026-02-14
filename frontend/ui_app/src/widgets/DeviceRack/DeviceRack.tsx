import { useMemo, useState, useCallback, useEffect, useRef } from 'react';
import throttle from 'lodash.throttle';
import { useEngineStore } from '@/shared/stores/useEngineStore';
import { useDragStore } from '@/shared/stores/useDragStore';
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
    const [openInternalDevice, setOpenInternalDevice] = useState<DeviceSlot | null>(null);
    const [uiNotice, setUiNotice] = useState<string | null>(null);
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
        if (!openInternalDevice) return;
        const next = chain.find((d) => d.id === openInternalDevice.id);
        if (!next) {
            setOpenInternalDevice(null);
            return;
        }
        setOpenInternalDevice(next);
    }, [chain, openInternalDevice]);

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
                setUiNotice('No target track selected.');
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
                setUiNotice(null);
            } catch (err) {
                console.error('[DeviceRack] addPluginToTrack failed:', err);
                setUiNotice('Failed to add plugin to track.');
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
    }, [isDropActive, isMaster, selectedTrack, fetchProject]);

    return (
        <>
        <div ref={rackRef} style={{
            display: 'flex',
            flexDirection: 'column',
            height: '100%',
            background: 'var(--color-bg-panel)',
            outline: isDropActive ? '2px solid var(--color-accent-primary)' : 'none',
            boxShadow: isDropActive ? 'inset 0 0 0 1px rgba(74, 144, 217, 0.35)' : 'none',
        }}>
            {uiNotice && (
                <div style={{
                    flexShrink: 0,
                    padding: '4px 10px',
                    fontSize: 'var(--font-size-2xs)',
                    background: 'rgba(217, 64, 64, 0.14)',
                    color: 'var(--color-status-error)',
                    borderBottom: '1px solid rgba(217, 64, 64, 0.3)',
                }}>
                    {uiNotice}
                </div>
            )}

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
                    chain.map(device => (
                        <DeviceNode
                            key={device.id}
                            device={device}
                            editorSupported={pluginCapability[device.pluginId]?.supported ?? true}
                            editorReason={pluginCapability[device.pluginId]?.reason}
                            onToggle={() => toggleDevice(device.id)}
                            onParamChange={(paramName, value) => {
                                setDeviceParam(device.id, paramName, value);
                                sendInternalParam(device, paramName, value);
                            }}
                            onOpenGUI={async () => {
                                if (device.source === 'internal') {
                                    setOpenInternalDevice(device);
                                    setUiNotice(null);
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
                                        setUiNotice(reason);
                                        return;
                                    }
                                    await engineApi.openPluginWindow(device.pluginId);
                                    setUiNotice(null);
                                } catch (err) {
                                    console.error('[DeviceRack] Failed to open plugin window:', err);
                                    setUiNotice('Failed to open plugin window.');
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
        {openInternalDevice && (
            <PluginWindow
                pluginId={openInternalDevice.pluginId}
                pluginName={openInternalDevice.name}
                pluginType={openInternalDevice.effectType === 'sampler' || openInternalDevice.effectType === 'instrument' ? 'instrument' : 'effect'}
                isBypassed={!openInternalDevice.isEnabled}
                onToggleBypass={() => toggleDevice(openInternalDevice.id)}
                onClose={() => setOpenInternalDevice(null)}
                width={openInternalDevice.effectType === 'eq' ? 760 : openInternalDevice.effectType === 'sampler' ? 820 : 520}
                height={openInternalDevice.effectType === 'eq' ? 420 : openInternalDevice.effectType === 'sampler' ? 460 : 360}
            >
                <InternalPluginPanel
                    device={openInternalDevice}
                    onParamChange={(name, value) => {
                        setDeviceParam(openInternalDevice.id, name, value);
                        sendInternalParam(openInternalDevice, name, value);
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
                            if (typeof picked === 'string' && picked.length > 0) {
                                await engineApi.setSamplerSample(selectedTrack.id, picked);
                                setUiNotice(null);
                            }
                        } catch (err) {
                            console.error('[DeviceRack] setSamplerSample failed:', err);
                            setUiNotice('Failed to load sampler sample.');
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
    device, onToggle, onOpenGUI,
    onParamChange,
    editorSupported, editorReason,
}: {
    device: DeviceSlot;
    onToggle: () => void;
    onParamChange: (paramName: string, value: number) => void;
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

    return (
        <div
            className="device-node"
            data-effect={device.effectType}
            style={{
                minWidth: device.effectType === 'eq' ? 160 : device.effectType === 'instrument' || device.effectType === 'sampler' ? 140 : 120,
                width: device.effectType === 'eq' ? 160 : device.effectType === 'instrument' || device.effectType === 'sampler' ? 140 : 120,
                display: 'flex',
                flexDirection: 'column',
                background: 'var(--color-bg-node)',
                borderRadius: 'var(--radius-sm)',
                border: '1px solid var(--color-border-subtle)',
                overflow: 'hidden',
                opacity: device.isEnabled ? 1 : 0.5,
                transition: 'opacity var(--transition-fast)',
                flexShrink: 0,
                height: '100%',
                position: 'relative',
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
                background: 'var(--color-bg-header)',
            }}>
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
                <button
                    onClick={(e) => { e.stopPropagation(); onOpenGUI?.(); }}
                    title={device.source === 'internal'
                        ? 'Open Internal Plugin UI'
                        : editorSupported === false
                            ? (editorReason ?? 'Plugin editor is unavailable')
                            : 'Open Plugin GUI'}
                    disabled={device.source !== 'internal' && device.isVst ? editorSupported === false : device.source !== 'internal'}
                    style={{
                        background: 'none',
                        border: 'none',
                        color: editorSupported === false ? 'var(--color-text-tertiary)' : 'var(--color-text-tertiary)',
                        fontSize: 8,
                        cursor: device.source === 'internal'
                            ? 'pointer'
                            : editorSupported === false
                                ? 'not-allowed'
                                : 'pointer',
                        flexShrink: 0,
                        padding: '0 2px',
                        visibility: (device.isVst || device.source === 'internal') ? 'visible' : 'hidden',
                        opacity: device.source === 'internal' ? 1 : (editorSupported === false ? 0.45 : 1),
                    }}
                    onMouseEnter={e => {
                        if (device.source !== 'internal' && editorSupported === false) return;
                        e.currentTarget.style.color = 'var(--color-accent-primary)';
                    }}
                    onMouseLeave={e => { e.currentTarget.style.color = 'var(--color-text-tertiary)'; }}
                >
                    Open UI
                </button>
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

            {/* Knobs area */}
            <div style={{
                display: 'flex',
                flexWrap: 'wrap',
                gap: 4,
                padding: '6px 4px',
                justifyContent: 'center',
                flex: 1,
            }}>
                {device.params.map(param => (
                    <Knob
                        key={param.name}
                        param={param}
                        accentColor={typeColor}
                        onChange={(value) => onParamChange(param.name, value)}
                    />
                ))}
            </div>

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

// ── Knob ──────────────────────────────────────────────────

const Knob = ({
    param,
    accentColor,
    onChange,
}: {
    param: DeviceParam;
    accentColor: string;
    onChange: (value: number) => void;
}) => {
    const normalizedValue = (param.value - param.min) / (param.max - param.min);
    const size = 28;
    const center = size / 2;
    const r = 10;
    const startAngle = 135;
    const endAngle = 405;
    const valueAngle = startAngle + normalizedValue * (endAngle - startAngle);
    const bgArc = describeArc(center, center, r, startAngle, endAngle);
    const toRad = (d: number) => (d * Math.PI) / 180;
    const sx = center + r * Math.cos(toRad(startAngle));
    const sy = center + r * Math.sin(toRad(startAngle));
    const ex = center + r * Math.cos(toRad(valueAngle));
    const ey = center + r * Math.sin(toRad(valueAngle));
    const largeArc = (valueAngle - startAngle) > 180 ? 1 : 0;

    const displayValue = Number.isInteger(param.value) ? param.value.toString() : param.value.toFixed(1);

    return (
        <div style={{
            display: 'flex',
            flexDirection: 'column',
            alignItems: 'center',
            gap: 0,
            width: 36,
        }}>
            <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`}>
                {/* Background arc */}
                <path
                    d={bgArc}
                    fill="none"
                    stroke="var(--color-knob-track)"
                    strokeWidth="2"
                    strokeLinecap="round"
                />
                {/* Active arc */}
                {normalizedValue > 0.01 && (
                    <path
                        d={`M ${sx} ${sy} A ${r} ${r} 0 ${largeArc} 1 ${ex} ${ey}`}
                        fill="none"
                        stroke={accentColor}
                        strokeWidth="2"
                        strokeLinecap="round"
                    />
                )}
                {/* Center dot */}
                <circle cx={center} cy={center} r="3" fill="var(--color-bg-elevated)" stroke={accentColor} strokeWidth="0.5" />
                {/* Indicator dot */}
                <circle cx={ex} cy={ey} r="1.5" fill={accentColor} />
            </svg>
            <span style={{
                fontSize: 8,
                fontFamily: 'var(--font-mono)',
                color: 'var(--color-knob-value-text)',
                textAlign: 'center',
                lineHeight: 1,
            }}>
                {displayValue}
            </span>
            <span style={{
                fontSize: 7,
                color: 'var(--color-text-tertiary)',
                textAlign: 'center',
                lineHeight: 1,
                marginTop: 1,
            }}>
                {param.name}
            </span>
            <input
                type="range"
                min={param.min}
                max={param.max}
                step={param.step ?? (param.max - param.min) / 100}
                value={param.value}
                onChange={(e) => onChange(Number(e.target.value))}
                style={{
                    width: 34,
                    height: 10,
                    marginTop: 2,
                    accentColor,
                    cursor: 'pointer',
                }}
            />
        </div>
    );
};

const InternalPluginPanel = ({
    device,
    onParamChange,
    onLoadSample,
}: {
    device: DeviceSlot;
    onParamChange: (paramName: string, value: number) => void;
    onLoadSample?: () => void;
}) => {
    if (device.effectType === 'sampler' || device.effectType === 'instrument') {
        return (
            <div style={{ display: 'grid', gridTemplateRows: '1fr auto', height: '100%', gap: 10 }}>
                <div style={{
                    border: '1px solid var(--color-divider)',
                    borderRadius: 6,
                    background: 'linear-gradient(180deg, #101822 0%, #0a1018 100%)',
                    position: 'relative',
                    overflow: 'hidden',
                }}>
                    <div style={{
                        position: 'absolute',
                        inset: 0,
                        background: 'repeating-linear-gradient(90deg, rgba(255,255,255,0.06) 0px, rgba(255,255,255,0.06) 1px, transparent 1px, transparent 18px)',
                    }} />
                    <div style={{
                        position: 'absolute',
                        top: 12,
                        left: 12,
                        fontSize: 10,
                        color: 'var(--color-text-secondary)',
                        letterSpacing: '0.05em',
                        textTransform: 'uppercase',
                    }}>
                        Sampler Waveform Area
                    </div>
                    <button
                        type="button"
                        onClick={() => onLoadSample?.()}
                        style={{
                            position: 'absolute',
                            right: 12,
                            top: 10,
                            border: '1px solid var(--color-divider)',
                            borderRadius: 4,
                            background: 'rgba(20,25,35,0.9)',
                            color: 'var(--color-text-secondary)',
                            fontSize: 10,
                            padding: '4px 8px',
                            cursor: 'pointer',
                        }}
                    >
                        Load Sample
                    </button>
                </div>
                <div style={{ display: 'flex', flexWrap: 'wrap', gap: 10 }}>
                    {device.params.map((p) => (
                        <ParamSlider key={p.name} param={p} onChange={onParamChange} />
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
                    background: '#0b0f15',
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
                <div style={{ display: 'flex', flexWrap: 'wrap', gap: 10 }}>
                    {device.params.map((p) => (
                        <ParamSlider key={p.name} param={p} onChange={onParamChange} />
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
                    background: '#111318',
                    display: 'grid',
                    gridTemplateColumns: 'repeat(2, minmax(120px, 1fr))',
                    gap: 10,
                }}>
                    {device.params.map((p) => (
                        <ParamSlider key={p.name} param={p} onChange={onParamChange} />
                    ))}
                </div>
            </div>
        );
    }

    return (
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 10 }}>
            {device.params.map((p) => (
                <ParamSlider key={p.name} param={p} onChange={onParamChange} />
            ))}
        </div>
    );
};

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

// ── SVG Arc Utility ──────────────────────────────────────

function describeArc(cx: number, cy: number, r: number, startDeg: number, endDeg: number) {
    const toRad = (d: number) => (d * Math.PI) / 180;
    const sx = cx + r * Math.cos(toRad(startDeg));
    const sy = cy + r * Math.sin(toRad(startDeg));
    const ex = cx + r * Math.cos(toRad(endDeg));
    const ey = cy + r * Math.sin(toRad(endDeg));
    const largeArc = (endDeg - startDeg) > 180 ? 1 : 0;
    return `M ${sx} ${sy} A ${r} ${r} 0 ${largeArc} 1 ${ex} ${ey}`;
}
