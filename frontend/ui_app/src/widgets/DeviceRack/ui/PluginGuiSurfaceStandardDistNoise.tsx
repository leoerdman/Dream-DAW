import React from 'react';
import { PluginKnob } from '@/widgets/DeviceRack/StandardPluginControls';
import { pluginPanelKnobGrid } from '@/widgets/DeviceRack/ui/styles';
import { normalizeInternalPluginId } from '@/shared/lib/internalPlugins';
import type { DeviceSlot } from '@/widgets/DeviceRack/model/types';

const pluginPanelLayoutStyle: React.CSSProperties = {
    display: 'grid',
    gridTemplateRows: '90px auto',
    gap: 'var(--plugin-grid-gap)',
    height: '100%',
};

const pluginPanelCardBaseStyle: React.CSSProperties = {
    border: '1px solid var(--plugin-card-border)',
    borderRadius: 'var(--plugin-card-radius)',
    padding: 'var(--plugin-card-pad-y) var(--plugin-card-pad-x)',
    display: 'grid',
    gridTemplateRows: '1fr auto',
    gap: 'var(--plugin-card-gap)',
    background: 'var(--plugin-card-bg-main)',
};

const pluginPanelTitleStyle: React.CSSProperties = {
    fontSize: 'var(--font-size-xs)',
    color: 'var(--plugin-title-color)',
    letterSpacing: '0.05em',
    textTransform: 'uppercase',
    fontWeight: 'var(--font-weight-bold)' as unknown as number,
};

const pluginPanelMetaStyle: React.CSSProperties = {
    display: 'flex',
    justifyContent: 'space-between',
    fontSize: 'var(--font-size-xs)',
    color: 'var(--plugin-meta-color)',
    fontFamily: 'var(--font-mono)',
};

interface DistNoiseHandlers {
    onParamChange: (paramName: string, value: number) => void;
    onParamGestureStart?: (paramName: string, gestureGroupId?: string) => void;
    onParamGestureEnd?: (paramName: string) => void;
}

export function renderStandardDistNoiseSurface(
    device: DeviceSlot,
    handlers: DistNoiseHandlers,
): React.ReactNode {
    const { onParamChange, onParamGestureStart, onParamGestureEnd } = handlers;
    const normalizedInternalId = normalizeInternalPluginId(device.pluginId || (device.guiMode || '').toLowerCase() || device.name.toLowerCase());

    if (device.effectType === 'distortion' || device.effectType === 'bitcrusher') {
        const title = device.effectType === 'bitcrusher'
            ? 'Bitcrusher'
            : normalizedInternalId === 'internal://effect/amp'
                ? 'Amp'
                : normalizedInternalId === 'internal://effect/cabinet'
                    ? 'Cabinet'
                    : normalizedInternalId === 'internal://effect/erosion'
                        ? 'Erosion'
                        : normalizedInternalId === 'internal://effect/overdrive'
                            ? 'Overdrive'
                            : normalizedInternalId === 'internal://effect/pedal'
                                ? 'Pedal'
                                : normalizedInternalId === 'internal://effect/roar'
                                    ? 'Roar'
                                    : 'Distortion';
        const color = device.effectType === 'distortion' ? 'var(--token-color-hex-ff965e)' : 'var(--token-color-hex-f2de72)';
        const drive = device.params.find((p) => p.name.toLowerCase() === 'drive')?.value ?? 0;
        const mix = device.params.find((p) => p.name.toLowerCase() === 'mix')?.value ?? 0;
        const tone = device.params.find((p) => p.name.toLowerCase() === 'tone')?.value ?? 0;
        const isAmp = title === 'Amp' || title === 'Cabinet';
        const isErosion = title === 'Erosion';
        const isBit = title === 'Bitcrusher';
        return (
            <div style={pluginPanelLayoutStyle}>
                <div style={{ ...pluginPanelCardBaseStyle, background: 'var(--plugin-bg-distortion)' }}>
                    <div style={{ ...pluginPanelTitleStyle, color: 'var(--token-color-hex-d6c1a5)' }}>{title}</div>
                    <svg viewBox="0 0 320 52" preserveAspectRatio="none" style={{ width: '100%', height: 44 }}>
                        <rect x="0" y="0" width="320" height="52" fill="var(--token-color-rgba-20-13-9-0d65)" />
                        {!isAmp && !isErosion && !isBit && (
                            <path d="M 8 44 L 48 12 L 88 44 L 128 12 L 168 44 L 208 12 L 248 44 L 312 16" fill="none" stroke={color} strokeWidth="2.2" />
                        )}
                        {isAmp && (
                            <>
                                {Array.from({ length: 7 }).map((_, i) => (
                                    <line key={i} x1={18 + i * 45} y1={8} x2={18 + i * 45} y2={44} stroke="var(--token-color-rgba-255-170-110-0d35)" />
                                ))}
                                <path d="M 6 43 C 52 38, 86 16, 126 18 C 166 20, 210 42, 260 36 C 282 33, 302 29, 316 22" fill="none" stroke="var(--token-color-hex-ffb57a)" strokeWidth="2.4" />
                            </>
                        )}
                        {isErosion && (
                            <>
                                {Array.from({ length: 24 }).map((_, i) => {
                                    const x = 8 + i * 13;
                                    const h = 8 + ((i * 19) % 30);
                                    return <rect key={i} x={x} y={42 - h} width="6" height={h} rx="1" fill="var(--token-color-rgba-255-156-94-0d82)" />;
                                })}
                            </>
                        )}
                        {isBit && (
                            <>
                                {Array.from({ length: 16 }).map((_, i) => {
                                    const x = 12 + i * 18;
                                    const high = i % 2 === 0 || i % 5 === 0;
                                    return <rect key={i} x={x} y={high ? 14 : 26} width="12" height={high ? 24 : 12} fill="var(--token-color-rgba-242-222-114-0d9)" rx="1.5" />;
                                })}
                            </>
                        )}
                    </svg>
                    <div style={pluginPanelMetaStyle}>
                        <span>Drive {drive.toFixed(1)}</span>
                        <span>Tone {tone.toFixed(2)}</span>
                        <span>Mix {mix.toFixed(2)}</span>
                    </div>
                </div>
                <div style={pluginPanelKnobGrid(`repeat(${Math.min(4, Math.max(3, device.params.length))}, minmax(0, 1fr))`)}>
                    {device.params.slice(0, 4).map((p) => (
                        <PluginKnob
                            key={p.name}
                            param={p}
                            onChange={onParamChange}
                            onGestureStart={onParamGestureStart}
                            onGestureEnd={onParamGestureEnd}
                            compact
                        />
                    ))}
                </div>
            </div>
        );
    }

    if (device.effectType === 'noiseMachine') {
        const type = Math.round(device.params.find((p) => p.name.toLowerCase() === 'type')?.value ?? 0);
        const level = device.params.find((p) => p.name.toLowerCase() === 'level')?.value ?? -30;
        const stereo = device.params.find((p) => p.name.toLowerCase() === 'stereo')?.value ?? 0.5;
        const typeLabel = type <= 0 ? 'Vinyl' : type === 1 ? 'Air' : 'Storm';
        return (
            <div style={pluginPanelLayoutStyle}>
                <div style={{ ...pluginPanelCardBaseStyle, background: 'var(--plugin-bg-noise)' }}>
                    <div style={{ ...pluginPanelTitleStyle, color: 'var(--token-color-hex-a5d6b0)' }}>Noise Machine</div>
                    <svg viewBox="0 0 320 52" preserveAspectRatio="none" style={{ width: '100%', height: 44 }}>
                        <rect x="0" y="0" width="320" height="52" fill="var(--token-color-rgba-12-18-12-0d65)" />
                        <path d="M 4 26 L 12 10 L 20 38 L 28 18 L 36 42 L 44 14 L 52 34 L 60 8 L 68 40 L 76 20 L 84 36 L 92 12 L 100 44 L 108 16 L 116 38 L 124 22 L 132 40 L 140 10 L 148 34 L 156 18 L 164 42 L 172 14 L 180 36 L 188 8 L 196 40 L 204 20 L 212 38 L 220 12 L 228 44 L 236 16 L 244 34 L 252 22 L 260 40 L 268 10 L 276 38 L 284 18 L 292 42 L 300 14 L 308 36 L 316 26" fill="none" stroke="var(--token-color-hex-72d68a)" strokeWidth="1.6" />
                    </svg>
                    <div style={pluginPanelMetaStyle}>
                        <span>{typeLabel}</span>
                        <span>Level {level.toFixed(1)} dB</span>
                        <span>Stereo {(stereo * 100).toFixed(0)}%</span>
                    </div>
                </div>
                <div style={pluginPanelKnobGrid(`repeat(${Math.min(6, device.params.length)}, minmax(0, 1fr))`)}>
                    {device.params.slice(0, 6).map((p) => (
                        <PluginKnob
                            key={p.name}
                            param={p}
                            onChange={onParamChange}
                            onGestureStart={onParamGestureStart}
                            onGestureEnd={onParamGestureEnd}
                            compact
                        />
                    ))}
                </div>
            </div>
        );
    }

    return null;
}
