import { useState, useCallback } from 'react';
import { useEngineStore } from '@/shared/stores/useEngineStore';
import * as engineApi from '@/shared/api/engine';

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
}

interface DeviceSlot {
    id: string;
    name: string;
    effectType: 'eq' | 'compressor' | 'delay' | 'reverb' | 'chorus' | 'utility' | 'vst' | 'instrument' | 'sampler' | 'saturator';
    isEnabled: boolean;
    params: DeviceParam[];
    vuLevel: number;
}

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
    const [chain, setChain] = useState<DeviceSlot[]>([]);
    const projectTracks = useEngineStore((s) => s.projectTracks);
    const meters = useEngineStore((s) => s.meters);

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

    const toggleDevice = useCallback((id: string) => {
        setChain(prev => prev.map(d =>
            d.id === id ? { ...d, isEnabled: !d.isEnabled } : d
        ));
    }, []);

    return (
        <div style={{
            display: 'flex',
            flexDirection: 'column',
            height: '100%',
            background: 'var(--color-bg-panel)',
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
                    chain.map(device => (
                        <DeviceNode
                            key={device.id}
                            device={device}
                            onToggle={() => toggleDevice(device.id)}
                            onOpenGUI={() => {
                                engineApi.openPluginWindow(device.id).catch(err =>
                                    console.error('[DeviceRack] Failed to open plugin window:', err)
                                );
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
    );
};

// ── DeviceNode ──────────────────────────────────────────

const DeviceNode = ({
    device, onToggle, onOpenGUI,
}: {
    device: DeviceSlot;
    onToggle: () => void;
    onOpenGUI?: () => void;
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
                    title="Open Plugin GUI"
                    style={{
                        background: 'none',
                        border: 'none',
                        color: 'var(--color-text-tertiary)',
                        fontSize: 8,
                        cursor: 'pointer',
                        flexShrink: 0,
                        padding: '0 2px',
                    }}
                    onMouseEnter={e => { e.currentTarget.style.color = 'var(--color-accent-primary)'; }}
                    onMouseLeave={e => { e.currentTarget.style.color = 'var(--color-text-tertiary)'; }}
                >
                    GUI
                </button>
                <span style={{
                    fontSize: 9,
                    color: 'var(--color-text-tertiary)',
                    cursor: 'pointer',
                }}>
                    ⚙
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
                    <Knob key={param.name} param={param} accentColor={typeColor} />
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

const Knob = ({ param, accentColor }: { param: DeviceParam; accentColor: string }) => {
    const normalizedValue = (param.value - param.min) / (param.max - param.min);
    const size = 28;
    const center = size / 2;
    const r = 10;
    const startAngle = 135;
    const endAngle = 405;
    const valueAngle = startAngle + normalizedValue * (endAngle - startAngle);
    const bgArc = describeArc(center, center, r, startAngle, endAngle);
    const valArc = describeArc(center, center, r, startAngle, valueAngle);
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
        </div>
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
