import type React from 'react';
import type * as engineApi from '@/shared/api/engine';
import type { DeviceSlot } from '@/widgets/DeviceRack/model/types';

interface DeviceNodeHeaderProps {
    device: DeviceSlot;
    deviceIndex: number;
    canReorder: boolean;
    onToggle: () => void;
    onSelect: (e: React.MouseEvent<HTMLDivElement>) => void;
}

export function DeviceNodeHeader({
    device,
    deviceIndex: _deviceIndex,
    canReorder,
    onToggle,
    onSelect,
}: DeviceNodeHeaderProps) {
    void _deviceIndex;

    return (
        <div
            data-device-drag-handle="true"
            style={{
                display: 'flex',
                flexDirection: 'column',
                alignItems: 'center',
                gap: 'var(--space-1-5)',
                padding: 'var(--space-2) 0',
                borderRight: 'var(--space-px) solid var(--color-divider)',
                background: 'var(--surface-tab-inactive)',
                cursor: canReorder ? 'grab' : 'default',
                width: 32,
                minWidth: 32,
                flexShrink: 0,
            }}
            onClick={(e) => {
                e.stopPropagation();
                onSelect(e);
            }}
        >
            <button
                data-no-drag
                draggable={false}
                onClick={onToggle}
                title={device.isEnabled ? 'Disable' : 'Enable'}
                style={{
                    width: 14,
                    height: 14,
                    borderRadius: '50%',
                    background: device.isEnabled ? 'var(--color-accent-primary)' : 'transparent',
                    border: device.isEnabled ? 'none' : 'var(--space-px) solid var(--color-overlay-light)',
                    cursor: 'pointer',
                    padding: 0,
                    margin: 0,
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                    flexShrink: 0,
                }}
            />
            <span
                style={{
                    writingMode: 'vertical-lr',
                    transform: 'rotate(180deg)',
                    fontSize: 'var(--font-size-micro)',
                    fontWeight: 'var(--font-weight-bold)',
                    color: 'var(--token-color-hex-808080)',
                    letterSpacing: '0.06em',
                    textTransform: 'uppercase',
                    flex: 1,
                    overflow: 'hidden',
                    textOverflow: 'ellipsis',
                    whiteSpace: 'nowrap',
                    lineHeight: 1,
                }}
            >
                {device.name}
            </span>
            {
                device.rack && (
                    <span
                        style={{
                            fontSize: 7,
                            fontWeight: 800,
                            color: device.rack.rack_type === 'Instrument' ? 'var(--rack-accent-instrument)'
                                : device.rack.rack_type === 'DrumRack' ? 'var(--rack-accent-drum)'
                                    : device.rack.rack_type === 'MidiEffect' ? 'var(--rack-accent-midi)'
                                        : 'var(--rack-accent-audio)',
                            flexShrink: 0,
                            letterSpacing: '0.05em',
                            lineHeight: 1,
                            textAlign: 'center',
                        }}
                    >
                        {device.rack.chains.length}ch
                    </span>
                )
            }
        </div >
    );
}

export type DeviceRuntimeStatus = engineApi.PluginSlotRuntimeStatus;
