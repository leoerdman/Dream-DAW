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
}: Props): React.ReactNode {
    return (
        <div
            style={{
                width: 100,
                flexShrink: 0,
                display: 'flex',
                flexDirection: 'column',
                gap: 2,
                padding: '6px 4px',
                background: 'var(--color-bg-secondary)',
                borderRadius: 'var(--plugin-card-radius)',
                border: '1px solid var(--plugin-card-border)',
                justifyContent: 'center',
            }}
        >
            {freqParam && (
                <PluginKnob
                    key={`freq-${freqParam.name}`}
                    param={freqParam}
                    label="FREQ"
                    onChange={onParamChange}
                    onGestureStart={onParamGestureStart}
                    onGestureEnd={onParamGestureEnd}
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
                    compact
                />
            )}
            {activeBandIsFilterOnly && qParam && (
                <PluginKnob
                    key={`q-${qParam.name}`}
                    param={qParam}
                    label="RES"
                    onChange={onParamChange}
                    onGestureStart={onParamGestureStart}
                    onGestureEnd={onParamGestureEnd}
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
                    compact
                />
            )}
            <div
                style={{
                    fontSize: 9,
                    color: 'rgba(160,190,220,0.4)',
                    textAlign: 'center',
                    fontFamily: 'Inter, sans-serif',
                    marginTop: 2,
                }}
            >
                {enabledBandsCount}/8
            </div>
        </div>
    );
}
