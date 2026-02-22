import type React from 'react';
import { PluginKnob } from '@/widgets/DeviceRack/StandardPluginControls';
import type { DeviceSlot } from '@/widgets/DeviceRack/model/types';

interface PluginGuiSurfaceFallbackProps {
    device: DeviceSlot;
    onParamChange: (paramName: string, value: number) => void;
    onParamGestureStart?: (paramName: string, gestureGroupId?: string) => void;
    onParamGestureEnd?: (paramName: string) => void;
    onParamContextMenu?: (e: React.MouseEvent, paramName: string) => void;
}

export function PluginGuiSurfaceFallback({
    device,
    onParamChange,
    onParamGestureStart,
    onParamGestureEnd,
    onParamContextMenu,
}: PluginGuiSurfaceFallbackProps) {
    return (
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 12 }}>
            {device.params.map((p) => (
                <PluginKnob
                    key={p.name}
                    param={p}
                    onChange={onParamChange}
                    onGestureStart={onParamGestureStart}
                    onGestureEnd={onParamGestureEnd}
                    onContextMenu={onParamContextMenu}
                />
            ))}
        </div>
    );
}
