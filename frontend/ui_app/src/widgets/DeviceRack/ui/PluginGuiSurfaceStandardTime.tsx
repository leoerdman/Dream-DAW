import React from 'react';
import { PluginKnob } from '@/widgets/DeviceRack/StandardPluginControls';
import { pluginPanelKnobGrid } from '@/widgets/DeviceRack/ui/styles';
import { normalizeInternalPluginId } from '@/shared/lib/internalPlugins';
import type { DeviceSlot } from '@/widgets/DeviceRack/model/types';
import {
    pluginPanelCardBaseStyle,
    pluginPanelLayoutStyle,
    pluginPanelMetaStyle,
    type SurfaceHandlers,
} from '@/widgets/DeviceRack/ui/PluginGuiSurfaceStandardShared';

export function renderStandardTimeSurface(device: DeviceSlot, handlers: SurfaceHandlers): React.ReactNode {
    const { onParamChange, onParamGestureStart, onParamGestureEnd } = handlers;
    const normalizedInternalId = normalizeInternalPluginId(device.pluginId || (device.guiMode || '').toLowerCase() || device.name.toLowerCase());

    if (device.effectType === 'delay') {
        const delayTitle = normalizedInternalId === 'internal://effect/echo'
            ? 'Echo'
            : normalizedInternalId === 'internal://effect/beat-repeat'
                ? 'Beat Repeat'
                : normalizedInternalId === 'internal://effect/looper'
                    ? 'Looper'
                    : normalizedInternalId === 'internal://effect/spectral-time'
                        ? 'Spectral Time'
                        : normalizedInternalId === 'internal://effect/grain-delay'
                            ? 'Grain Delay'
                            : 'Delay';
        const isBeatRepeat = delayTitle === 'Beat Repeat';
        const isLooper = delayTitle === 'Looper';
        const isSpectralTime = delayTitle === 'Spectral Time';
        const time = device.params.find((p) => p.name.toLowerCase() === 'time')?.value ?? 280;
        const fb = device.params.find((p) => p.name.toLowerCase() === 'fb')?.value ?? 30;
        const mix = device.params.find((p) => p.name.toLowerCase() === 'dry/wet')?.value ?? 35;
        return (
            <div style={pluginPanelLayoutStyle}>
                <div style={{
                    ...pluginPanelCardBaseStyle,
                    background: 'var(--plugin-bg-delay)',
                }}>
                    <svg viewBox="0 0 320 52" preserveAspectRatio="none" style={{ width: '100%', height: '100%' }}>
                        <rect x="0" y="0" width="320" height="52" fill="var(--token-color-rgba-14-20-30-0d6)" />
                        {!isLooper && !isSpectralTime && !isBeatRepeat && Array.from({ length: 8 }).map((_, i) => {
                            const x = 16 + i * 36;
                            const h = 24 * Math.pow((fb / 100), i);
                            return <rect key={i} x={x} y={26 - h / 2} width="10" height={h} fill={i === 0 ? 'var(--token-color-hex-7cc4ff)' : 'var(--token-color-hex-4a9eff)'} opacity={0.95 - i * 0.08} rx="1.5" />;
                        })}
                        {isBeatRepeat && Array.from({ length: 16 }).map((_, i) => {
                            const x = 10 + i * 18;
                            const on = i % 4 === 0 || i % 7 === 0;
                            return <rect key={i} x={x} y={on ? 12 : 18} width="12" height={on ? 28 : 16} fill={on ? 'var(--token-color-hex-78c3ff)' : 'var(--token-color-rgba-120-170-230-0d35)'} rx="2" />;
                        })}
                        {isLooper && (
                            <>
                                <circle cx="160" cy="26" r="16" fill="none" stroke="var(--token-color-rgba-124-196-255-0d45)" strokeWidth="2" />
                                <path d="M 160 10 A 16 16 0 1 1 148 16" fill="none" stroke="var(--token-color-hex-7cc4ff)" strokeWidth="3" strokeLinecap="round" />
                            </>
                        )}
                        {isSpectralTime && Array.from({ length: 24 }).map((_, i) => {
                            const x = 6 + i * 13;
                            const h = 8 + (Math.sin(i * 0.8) + 1) * 14;
                            return <rect key={i} x={x} y={26 - h / 2} width="8" height={h} fill="var(--token-color-rgba-138-205-255-0d85)" rx="1.5" />;
                        })}
                    </svg>
                    <div style={pluginPanelMetaStyle}>
                        <span>{delayTitle}</span>
                        <span>{time.toFixed(0)}ms</span>
                        <span>FB {fb.toFixed(0)}%</span>
                        <span>Mix {mix.toFixed(0)}%</span>
                    </div>
                </div>
                <div style={pluginPanelKnobGrid(`repeat(${Math.min(6, Math.max(3, device.params.length))}, minmax(0, 1fr))`)}>
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

    if (device.effectType === 'reverb') {
        const reverbTitle = normalizedInternalId === 'internal://effect/hybrid-reverb'
            ? 'Hybrid Reverb'
            : normalizedInternalId === 'internal://effect/corpus'
                ? 'Corpus'
                : normalizedInternalId === 'internal://effect/resonators'
                    ? 'Resonators'
                    : normalizedInternalId === 'internal://effect/spectral-resonator'
                        ? 'Spectral Resonator'
                        : 'Reverb';
        const decay = device.params.find((p) => p.name.toLowerCase() === 'decay')?.value ?? 45;
        const tone = device.params.find((p) => p.name.toLowerCase() === 'tone')?.value ?? 0;
        const reverbMix = device.params.find((p) => p.name.toLowerCase() === 'dry/wet')?.value ?? 50;
        const reverbSize = device.params.find((p) => p.name.toLowerCase() === 'size')?.value ?? 40;
        return (
            <div style={pluginPanelLayoutStyle}>
                <div style={{
                    ...pluginPanelCardBaseStyle,
                    background: 'var(--plugin-bg-reverb)',
                }}>
                    <div style={{ position: 'relative', overflow: 'hidden', borderRadius: 'var(--radius-md)', background: 'var(--token-color-rgba-10-10-12-0d45)' }}>
                        {Array.from({ length: 5 }).map((_, i) => (
                            <div
                                key={i}
                                style={{
                                    position: 'absolute',
                                    left: `${15 + i * 14}%`,
                                    top: '50%',
                                    width: `${24 + i * 12}px`,
                                    height: `${24 + i * 12}px`,
                                    marginTop: `${-(12 + i * 6)}px`,
                                    borderRadius: '50%',
                                    border: 'var(--space-px) solid var(--token-color-rgba-192-145-255-0d35)',
                                }}
                            />
                        ))}
                    </div>
                    <div style={pluginPanelMetaStyle}>
                        <span>{reverbTitle}</span>
                        <span>Size {reverbSize.toFixed(0)}%</span>
                        <span>Decay {decay.toFixed(0)}%</span>
                        <span>Tone {tone.toFixed(0)}%</span>
                        <span>Mix {reverbMix.toFixed(0)}%</span>
                    </div>
                </div>
                <div style={pluginPanelKnobGrid(`repeat(${Math.min(6, Math.max(3, device.params.length))}, minmax(0, 1fr))`)}>
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

    if (device.effectType === 'chorus') {
        const rate = device.params.find((p) => p.name.toLowerCase() === 'rate')?.value ?? 1.2;
        const depth = device.params.find((p) => p.name.toLowerCase() === 'depth')?.value ?? 40;
        const chorusMix = device.params.find((p) => p.name.toLowerCase() === 'dry/wet')?.value ?? 50;
        return (
            <div style={pluginPanelLayoutStyle}>
                <div style={{
                    ...pluginPanelCardBaseStyle,
                    background: 'var(--plugin-bg-chorus)',
                }}>
                    <svg viewBox="0 0 320 52" preserveAspectRatio="none" style={{ width: '100%', height: '100%' }}>
                        <rect x="0" y="0" width="320" height="52" fill="var(--token-color-rgba-12-11-18-0d65)" />
                        <path d="M 0 26 C 40 8, 80 44, 120 26 C 160 8, 200 44, 240 26 C 280 8, 320 44, 320 26" fill="none" stroke="var(--token-color-hex-c867ff)" strokeWidth="2.2" />
                        <path d="M 0 26 C 40 44, 80 8, 120 26 C 160 44, 200 8, 240 26 C 280 44, 320 8, 320 26" fill="none" stroke="var(--token-color-hex-4ac0ff)" strokeWidth="2.2" opacity="0.9" />
                    </svg>
                    <div style={pluginPanelMetaStyle}>
                        <span>{rate.toFixed(1)}Hz</span>
                        <span>Depth {depth.toFixed(0)}%</span>
                        <span>Mix {chorusMix.toFixed(0)}%</span>
                    </div>
                </div>
                <div style={pluginPanelKnobGrid(`repeat(${Math.min(5, Math.max(3, device.params.length))}, minmax(0, 1fr))`)}>
                    {device.params.slice(0, 5).map((p) => (
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

    if (device.effectType === 'saturator') {
        const satTitle = normalizedInternalId === 'internal://effect/drum-buss'
            ? 'Drum Buss'
            : normalizedInternalId === 'internal://effect/dynamic-tube'
                ? 'Dynamic Tube'
                : 'Saturator';
        const drive = device.params.find((p) => p.name.toLowerCase() === 'drive')?.value ?? 3;
        const satTone = device.params.find((p) => p.name.toLowerCase() === 'tone')?.value ?? 0;
        const satMix = device.params.find((p) => p.name.toLowerCase() === 'dry/wet')?.value ?? 100;
        const driveClamp = Math.max(0, Math.min(24, drive));
        const knee = Math.max(12, 80 - driveClamp * 2.8);
        return (
            <div style={pluginPanelLayoutStyle}>
                <div style={{
                    ...pluginPanelCardBaseStyle,
                    background: 'var(--plugin-bg-saturator)',
                }}>
                    <svg viewBox="0 0 320 52" preserveAspectRatio="none" style={{ width: '100%', height: '100%' }}>
                        <rect x="0" y="0" width="320" height="52" fill="var(--token-color-rgba-20-13-9-0d7)" />
                        <line x1="12" y1="46" x2="308" y2="6" stroke="var(--token-color-rgba-255-172-89-0d18)" strokeWidth="1" strokeDasharray="3,3" />
                        <path d={`M 12 46 C ${knee} 46, ${160 - knee / 2} 6, 160 6 C ${160 + knee / 2} 6, ${320 - knee} 46, 308 46`} fill="none" stroke="var(--token-color-hex-ffac59)" strokeWidth={Math.max(2, 2 + driveClamp / 8)} strokeLinecap="round" />
                    </svg>
                    <div style={pluginPanelMetaStyle}>
                        <span>{satTitle}</span>
                        <span>Drive {drive.toFixed(1)} dB</span>
                        {satTone !== 0 && <span>Tone {satTone.toFixed(0)}%</span>}
                        <span>Mix {satMix.toFixed(0)}%</span>
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

    return null;
}
