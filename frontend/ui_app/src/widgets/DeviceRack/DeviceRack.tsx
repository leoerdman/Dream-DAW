import { useState } from 'react';

/**
 * DeviceRack — Horizontal chain of VST audio plugins.
 * 
 * ⚡ GENIUS REUSE: Visual language from UDS .flow-node (AI image generation blocks)
 * is transplanted to represent audio effect processors. The node metaphor is identical:
 * 
 *   UDS:  [Input Port] → [Node Header + Body] → [Output Port]
 *   DAW:  [Audio In]   → [Plugin Header + Knobs] → [Audio Out]
 * 
 * Each device uses CSS classes from plugin-rack.css:
 *   .device-node, .device-node-header, .device-node-body,
 *   .device-port, .device-knob, .device-meter, etc.
 */

interface DevicePlugin {
    id: string;
    name: string;
    category: string;
    bypassed: boolean;
    knobs: { label: string; value: string; position: number }[];
    meters: { value: number; hot?: boolean }[];
}

const MOCK_DEVICES: DevicePlugin[] = [
    {
        id: 'eq-1',
        name: 'EQ Eight',
        category: 'Equalizer',
        bypassed: false,
        knobs: [
            { label: 'Low', value: '+2.1', position: 60 },
            { label: 'Mid', value: '-1.5', position: 40 },
            { label: 'High', value: '+0.8', position: 55 },
            { label: 'Q', value: '1.41', position: 50 },
        ],
        meters: [
            { value: 45 },
            { value: 62 },
        ],
    },
    {
        id: 'comp-1',
        name: 'Compressor',
        category: 'Dynamics',
        bypassed: false,
        knobs: [
            { label: 'Thresh', value: '-18', position: 35 },
            { label: 'Ratio', value: '4:1', position: 40 },
            { label: 'Attack', value: '10ms', position: 25 },
            { label: 'Release', value: '80ms', position: 55 },
        ],
        meters: [
            { value: 30 },
            { value: 78, hot: true },
        ],
    },
    {
        id: 'reverb-1',
        name: 'Plate Reverb',
        category: 'Reverb',
        bypassed: true,
        knobs: [
            { label: 'Size', value: '72%', position: 72 },
            { label: 'Decay', value: '2.4s', position: 60 },
            { label: 'Damp', value: '45%', position: 45 },
            { label: 'Mix', value: '22%', position: 22 },
        ],
        meters: [
            { value: 15 },
        ],
    },
];

export const DeviceRack = () => {
    const [devices, setDevices] = useState(MOCK_DEVICES);
    const [selectedId, setSelectedId] = useState<string | null>(null);

    const toggleBypass = (id: string) => {
        setDevices(prev => prev.map(d =>
            d.id === id ? { ...d, bypassed: !d.bypassed } : d
        ));
    };

    return (
        <div className="h-full w-full flex flex-col">

            {/* ── Rack Header ── */}
            <div className="h-10 flex items-center justify-between px-4 border-b border-border-subtle shrink-0">
                <div className="flex items-center gap-2">
                    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="text-accent">
                        <line x1="4" y1="21" x2="4" y2="14" /><line x1="4" y1="10" x2="4" y2="3" />
                        <line x1="12" y1="21" x2="12" y2="12" /><line x1="12" y1="8" x2="12" y2="3" />
                        <line x1="20" y1="21" x2="20" y2="16" /><line x1="20" y1="12" x2="20" y2="3" />
                        <line x1="1" y1="14" x2="7" y2="14" /><line x1="9" y1="8" x2="15" y2="8" />
                        <line x1="17" y1="16" x2="23" y2="16" />
                    </svg>
                    <span className="text-xs font-semibold text-text-secondary uppercase tracking-[0.08em]">
                        Master Chain
                    </span>
                    <span className="text-[10px] text-text-tertiary font-mono ml-2">
                        {devices.length} devices
                    </span>
                </div>
                <button className="btn-ghost" title="Add Device">
                    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                        <line x1="12" y1="5" x2="12" y2="19" /><line x1="5" y1="12" x2="19" y2="12" />
                    </svg>
                </button>
            </div>

            {/* ── Device Chain (horizontal scroll) ── */}
            <div className="flex-1 overflow-x-auto overflow-y-hidden flex items-center gap-0 px-4 py-3">

                {/* Input Port */}
                <div className="flex flex-col items-center gap-1 shrink-0 mr-2">
                    <div className="w-3 h-3 rounded-full bg-port-audio border-2 border-border-default" />
                    <span className="text-[9px] text-text-tertiary font-mono">IN</span>
                </div>

                {devices.map((device, index) => (
                    <div key={device.id} className="flex items-center gap-0 shrink-0">

                        {/* Signal Wire */}
                        {index > 0 && <div className="device-wire w-6" />}

                        {/* Device Node */}
                        <div
                            className={`device-node ${device.bypassed ? 'bypassed' : ''} ${selectedId === device.id ? 'selected' : ''}`}
                            onClick={() => setSelectedId(device.id === selectedId ? null : device.id)}
                        >
                            {/* Input Port */}
                            <div className={`device-port input ${device.category === 'Reverb' ? 'sidechain' : ''}`} />

                            {/* Header */}
                            <div className="device-node-header">
                                <span className="device-node-title">{device.name}</span>
                                <div className="device-node-actions">
                                    <span className="text-[9px] text-text-tertiary font-mono">{device.category}</span>
                                    <div
                                        className={`device-bypass-led ${device.bypassed ? 'bypassed' : ''}`}
                                        onClick={(e) => { e.stopPropagation(); toggleBypass(device.id); }}
                                        title={device.bypassed ? 'Enable' : 'Bypass'}
                                    />
                                </div>
                            </div>

                            {/* Body */}
                            <div className="device-node-body">
                                {/* Knob Row */}
                                <div className="device-knob-row">
                                    {device.knobs.map(knob => (
                                        <div key={knob.label} className="device-knob">
                                            <div
                                                className="device-knob-dial"
                                                style={{ '--tw-rotate': `${(knob.position / 100) * 270 - 135}deg` } as React.CSSProperties}
                                            />
                                            <span className="device-knob-value">{knob.value}</span>
                                            <span className="device-knob-label">{knob.label}</span>
                                        </div>
                                    ))}
                                </div>

                                {/* Meters */}
                                <div className="flex flex-col gap-1.5 mt-auto">
                                    {device.meters.map((meter, j) => (
                                        <div key={j} className="device-meter">
                                            <div
                                                className={`device-meter-fill ${meter.hot ? 'hot' : ''}`}
                                                style={{ width: `${meter.value}%` }}
                                            />
                                        </div>
                                    ))}
                                </div>
                            </div>

                            {/* Output Port */}
                            <div className="device-port output" />
                        </div>

                        {/* Post-device wire */}
                        {index < devices.length - 1 && <div className="device-wire w-6" />}
                    </div>
                ))}

                {/* Final Wire */}
                <div className="device-wire w-6 shrink-0" />

                {/* Output Port */}
                <div className="flex flex-col items-center gap-1 shrink-0 mx-2">
                    <div className="w-3 h-3 rounded-full bg-port-audio border-2 border-border-default" />
                    <span className="text-[9px] text-text-tertiary font-mono">OUT</span>
                </div>

                {/* Add Device Slot */}
                <div className="device-add-slot ml-2">
                    <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
                        <line x1="12" y1="5" x2="12" y2="19" /><line x1="5" y1="12" x2="19" y2="12" />
                    </svg>
                    <span className="device-add-slot-text">Add Device</span>
                </div>
            </div>
        </div>
    );
};
