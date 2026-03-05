import React from 'react';
import type { DeviceSlot } from '@/widgets/DeviceRack/model/types';
import {
    DryWetSection,
    KnobParamGridMemo,
    pluginPanelCardBaseStyle,
    pluginPanelLayoutStyle,
    shouldShowDryWet,
} from '@/widgets/DeviceRack/ui/PluginGuiSurfaceStandardShared';

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
    const signature = `${device.pluginId || device.id || device.name}:${device.effectType}`;
    let hash = 0;
    for (let i = 0; i < signature.length; i++) {
        hash = ((hash << 5) - hash + signature.charCodeAt(i)) | 0;
    }
    const palette = [
        'var(--token-color-hex-6ac3ff)',
        'var(--token-color-hex-c891ff)',
        'var(--token-color-hex-ffac59)',
        'var(--token-color-hex-8ec77c)',
        'var(--token-color-hex-66b3ff)',
        'var(--token-color-hex-a4d9d3)',
    ] as const;
    const accent = palette[Math.abs(hash) % palette.length];
    const showDryWet = shouldShowDryWet(device);
    const bars = Array.from({ length: 24 }, (_, i) => {
        const phase = (Math.abs(hash) % 17) * 0.12;
        const h = 8 + Math.abs(Math.sin(i * 0.55 + phase)) * 30;
        return { x: 8 + i * 12.6, h };
    });

    return (
        <div data-no-drag style={pluginPanelLayoutStyle}>
            <div
                style={{
                    ...pluginPanelCardBaseStyle,
                    display: 'grid',
                    gridTemplateColumns: showDryWet ? '1fr auto' : '1fr',
                    gap: 'var(--space-2-5)',
                    alignItems: 'center',
                    background: `linear-gradient(145deg, color-mix(in srgb, ${accent} 20%, var(--color-bg-surface)) 0%, var(--color-bg-surface) 65%)`,
                }}
            >
                <div style={{ display: 'grid', gap: 6 }}>
                    <svg viewBox="0 0 320 54" preserveAspectRatio="xMidYMid slice" style={{ width: '100%', height: 50, willChange: 'transform', transform: 'translateZ(0)' }}>
                        <rect x="0" y="0" width="320" height="54" rx="4" fill="color-mix(in srgb, var(--color-bg-app) 70%, transparent)" />
                        {bars.map((bar, idx) => (
                            <rect
                                key={idx}
                                x={bar.x}
                                y={48 - bar.h}
                                width="8.2"
                                height={bar.h}
                                rx="1.5"
                                fill={idx % 3 === 0 ? accent : 'color-mix(in srgb, var(--color-text-secondary) 55%, transparent)'}
                            />
                        ))}
                    </svg>
                </div>
                <DryWetSection device={device} handlers={{ onParamChange, onParamGestureStart, onParamGestureEnd, onParamContextMenu }} accent={accent} show={showDryWet} />
            </div>
            <KnobParamGridMemo device={device} handlers={{ onParamChange, onParamGestureStart, onParamGestureEnd, onParamContextMenu }} options={{ omitMixWhenDryWet: showDryWet }} maxCols={4} minCols={2} />
        </div>
    );
}
