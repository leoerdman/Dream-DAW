import { useState, useCallback } from 'react';

/**
 * DeviceRack — Bottom panel: instrument & effects signal chain.
 *
 * Ported from BottomPanelView.swift (1094 lines).
 *
 * Layout: [Title Bar] → [IN meter] → [Instrument?] → [FX1] → [FX2] → ... → [OUT meter] → [+ Add]
 *
 * Each device slot shows:
 *   - Header with name + enable toggle + settings icon
 *   - Colored type stripe (data-effect attribute from plugin-rack.css)
 *   - Knobs for device parameters
 *   - VU fill bar at bottom
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
    effectType: 'eq' | 'compressor' | 'delay' | 'reverb' | 'chorus' | 'utility' | 'vst' | 'instrument';
    isEnabled: boolean;
    params: DeviceParam[];
    vuLevel: number;
}

// ── Demo Data (from BottomPanelView.swift) ──────────────────

const DEMO_CHAIN: DeviceSlot[] = [
    {
        id: 'eq1',
        name: 'EQ EIGHT',
        effectType: 'eq',
        isEnabled: true,
        params: [
            { name: 'LOW', value: -0.1, min: -15, max: 15, suffix: ' dB' },
            { name: '400', value: 1.3, min: -15, max: 15, suffix: ' dB' },
            { name: '1k', value: -0.5, min: -15, max: 15, suffix: ' dB' },
            { name: '4.1', value: 0.8, min: -15, max: 15, suffix: ' dB' },
            { name: '10k', value: -1.41, min: -15, max: 15, suffix: ' dB' },
            { name: 'HIGH', value: 0, min: -15, max: 15, suffix: ' dB' },
        ],
        vuLevel: 0.65,
    },
    {
        id: 'comp1',
        name: 'COMPRESSOR',
        effectType: 'compressor',
        isEnabled: true,
        params: [
            { name: 'THRESH', value: -18, min: -40, max: 0, suffix: ' dB' },
            { name: 'RATIO', value: 3, min: 1, max: 20, suffix: ':1' },
            { name: 'ATTACK', value: 3, min: 0.1, max: 100, suffix: ' ms' },
            { name: 'RELEASE', value: 80, min: 10, max: 1000, suffix: ' ms' },
        ],
        vuLevel: 0.55,
    },
    {
        id: 'reverb1',
        name: 'PLATE REVERB',
        effectType: 'reverb',
        isEnabled: true,
        params: [
            { name: 'SIZE', value: 72, min: 0, max: 100, suffix: '%' },
            { name: 'DECAY', value: 2.4, min: 0.1, max: 10, suffix: ' s' },
            { name: 'DAMP', value: 45, min: 0, max: 100, suffix: '%' },
            { name: 'MIX', value: 22, min: 0, max: 100, suffix: '%' },
        ],
        vuLevel: 0.45,
    },
];

// ── Component ──────────────────────────────────────────

export const DeviceRack = () => {
    const [chain, setChain] = useState(DEMO_CHAIN);
    const [selectedTrackName] = useState('Track 01');

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
                    ⛓ MASTER CHAIN · {chain.length} devices
                </span>
                <span style={{
                    fontSize: 'var(--font-size-2xs)',
                    color: 'var(--color-text-tertiary)',
                }}>
                    {selectedTrackName}
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

                {/* Input meter */}
                <MeterBar label="IN" level={0.5} isInput />

                {chain.map(device => (
                    <DeviceNode
                        key={device.id}
                        device={device}
                        onToggle={() => toggleDevice(device.id)}
                    />
                ))}

                {/* Output meter */}
                <MeterBar label="OUT" level={0.6} />

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
                        color: 'var(--color-text-tertiary)',
                        cursor: 'pointer',
                        fontSize: 20,
                        transition: 'border-color var(--transition-fast), color var(--transition-fast)',
                        flexShrink: 0,
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
                    +
                    <span style={{ fontSize: 'var(--font-size-2xs)' }}>Add Device</span>
                </button>
            </div>
        </div>
    );
};

// ── DeviceNode ──────────────────────────────────────────

const DeviceNode = ({
    device, onToggle,
}: {
    device: DeviceSlot;
    onToggle: () => void;
}) => {
    const vuWidthPercent = Math.min(100, Math.max(0, device.vuLevel * 100));
    const vuColor = device.vuLevel > 0.85 ? 'var(--color-meter-clip)' : device.vuLevel > 0.6 ? 'var(--color-meter-hot)' : 'var(--color-meter-normal)';

    return (
        <div
            className="device-node"
            data-effect={device.effectType}
            style={{
                minWidth: device.effectType === 'eq' ? 160 : 120,
                width: device.effectType === 'eq' ? 160 : 120,
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
                        background: device.isEnabled ? 'var(--color-status-success)' : 'var(--color-text-tertiary)',
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
                    cursor: 'pointer',
                }}>
                    ⚙
                </span>
            </div>

            {/* Knobs area */}
            <div style={{
                display: 'flex',
                flexWrap: 'wrap',
                gap: 2,
                padding: '4px',
                flex: 1,
                alignContent: 'flex-start',
                justifyContent: 'center',
            }}>
                {device.params.map((param, i) => (
                    <KnobDisplay key={i} param={param} />
                ))}
            </div>

            {/* VU bar at bottom */}
            <div style={{
                height: 3,
                background: 'var(--color-meter-bg)',
                position: 'relative',
                overflow: 'hidden',
            }}>
                <div style={{
                    position: 'absolute',
                    left: 0,
                    top: 0,
                    height: '100%',
                    width: `${vuWidthPercent}%`,
                    background: vuColor,
                    transition: 'width 0.1s linear',
                }} />
            </div>
        </div>
    );
};

// ── KnobDisplay ──────────────────────────────────────────

const KnobDisplay = ({ param }: { param: DeviceParam }) => {
    const range = param.max - param.min;
    const normalizedValue = range > 0 ? (param.value - param.min) / range : 0;
    const arcAngle = 135 + (normalizedValue * 270);
    const size = 28;
    const center = size / 2;
    const r = 10;

    // Arc SVG for the knob
    const startAngle = 135;
    const endAngle = arcAngle;

    const toRad = (deg: number) => (deg * Math.PI) / 180;
    const sx = center + r * Math.cos(toRad(startAngle));
    const sy = center + r * Math.sin(toRad(startAngle));
    const ex = center + r * Math.cos(toRad(endAngle));
    const ey = center + r * Math.sin(toRad(endAngle));
    const largeArc = (endAngle - startAngle) > 180 ? 1 : 0;

    // Format value
    let displayValue = '';
    if (Math.abs(param.value) >= 100) {
        displayValue = Math.round(param.value).toString();
    } else if (Math.abs(param.value) >= 10) {
        displayValue = param.value.toFixed(1);
    } else {
        displayValue = param.value.toFixed(param.value % 1 === 0 ? 0 : 1);
    }

    return (
        <div style={{
            display: 'flex',
            flexDirection: 'column',
            alignItems: 'center',
            gap: 0,
            width: 36,
        }}>
            <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`}>
                {/* Inactive arc (full 270°) */}
                <path
                    d={describeArc(center, center, r, 135, 405)}
                    fill="none"
                    stroke="var(--color-knob-arc-inactive)"
                    strokeWidth="2"
                    strokeLinecap="round"
                />
                {/* Active arc */}
                {normalizedValue > 0.01 && (
                    <path
                        d={`M ${sx} ${sy} A ${r} ${r} 0 ${largeArc} 1 ${ex} ${ey}`}
                        fill="none"
                        stroke="var(--color-knob-fill)"
                        strokeWidth="2"
                        strokeLinecap="round"
                    />
                )}
                {/* Center dot */}
                <circle cx={center} cy={center} r="3" fill="var(--color-bg-elevated)" stroke="var(--color-knob-fill)" strokeWidth="0.5" />
                {/* Indicator dot */}
                <circle
                    cx={ex}
                    cy={ey}
                    r="1.5"
                    fill="var(--color-knob-fill)"
                />
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
