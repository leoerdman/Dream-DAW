import React from 'react';
import { PluginKnob, type PluginParam } from '@/widgets/DeviceRack/StandardPluginControls';

type Props = {
    activeBandIsFilterOnly: boolean;
    freqParam?: PluginParam;
    gainParam?: PluginParam;
    qParam?: PluginParam;
    outParam?: PluginParam;
    enabledBandsCount: number;
    onParamChange: (paramName: string, value: number) => void;
    onParamGestureStart?: (paramName: string, gestureGroupId?: string) => void;
    onParamGestureEnd?: (paramName: string) => void;
    onParamContextMenu?: (e: React.MouseEvent, paramName: string) => void;
};

export function PluginGuiSurfaceEqControls({
    activeBandIsFilterOnly,
    freqParam,
    gainParam,
    qParam,
    outParam,
    enabledBandsCount,
    onParamChange,
    onParamGestureStart,
    onParamGestureEnd,
    onParamContextMenu,
}: Props): React.ReactNode {
    return (
        <div
            style={{
                width: 100,
                flexShrink: 0,
                display: 'flex',
                flexDirection: 'column',
                gap: 'var(--space-0-5)',
                padding: 'var(--space-1-5) var(--space-1)',
                background: 'color-mix(in srgb, var(--color-bg-panel) 90%, var(--color-bg-header) 10%)',
                borderRadius: 'var(--plugin-card-radius)',
                border: 'var(--space-px) solid color-mix(in srgb, var(--color-text-primary) 14%, transparent)',
                justifyContent: 'center',
            }}
        >
            {freqParam && (
                <PluginKnob
                    key={`freq-${freqParam.name}`}
                    param={freqParam}
                    label="FREQ"
                    scale="log"
                    onChange={onParamChange}
                    onGestureStart={onParamGestureStart}
                    onGestureEnd={onParamGestureEnd}
                    onContextMenu={onParamContextMenu}
                    compact
                />
            )}
            {!activeBandIsFilterOnly && gainParam && (
                <PluginKnob
                    key={`gain-${gainParam.name}`}
                    param={gainParam}
                    label="GAIN"
                    onChange={onParamChange}
                    onGestureStart={onParamGestureStart}
                    onGestureEnd={onParamGestureEnd}
                    onContextMenu={onParamContextMenu}
                    compact
                />
            )}
            {activeBandIsFilterOnly && qParam && (
                <PluginKnob
                    key={`q-${qParam.name}`}
                    param={qParam}
                    label="RES"
                    scale="log"
                    onChange={onParamChange}
                    onGestureStart={onParamGestureStart}
                    onGestureEnd={onParamGestureEnd}
                    onContextMenu={onParamContextMenu}
                    compact
                />
            )}
            {outParam && (
                <PluginKnob
                    key="out"
                    param={outParam}
                    onChange={onParamChange}
                    onGestureStart={onParamGestureStart}
                    onGestureEnd={onParamGestureEnd}
                    onContextMenu={onParamContextMenu}
                    compact
                />
            )}
            <div
                style={{
                    fontSize: 'var(--font-size-micro)',
                    color: 'color-mix(in srgb, var(--color-text-primary) 78%, transparent)',
                    textAlign: 'center',
                    fontFamily: 'var(--font-role-body)',
                    marginTop: 2,
                }}
            >
                {enabledBandsCount}/8
            </div>
        </div>
    );
}
