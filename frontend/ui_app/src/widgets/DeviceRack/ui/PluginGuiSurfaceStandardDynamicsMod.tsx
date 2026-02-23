import React from 'react';
import { PluginKnob } from '@/widgets/DeviceRack/StandardPluginControls';
import { pluginPanelKnobGrid } from '@/widgets/DeviceRack/ui/styles';
import { normalizeInternalPluginId } from '@/shared/lib/internalPlugins';
import type { DeviceSlot } from '@/widgets/DeviceRack/model/types';
import {
    pluginPanelCardBaseStyle,
    pluginPanelLayoutStyle,
    pluginPanelMetaStyle,
    pluginPanelTitleStyle,
    type SurfaceHandlers,
} from '@/widgets/DeviceRack/ui/PluginGuiSurfaceStandardShared';

export function renderStandardDynamicsModSurface(device: DeviceSlot, handlers: SurfaceHandlers): React.ReactNode {
    const { onParamChange, onParamGestureStart, onParamGestureEnd } = handlers;
    const normalizedInternalId = normalizeInternalPluginId(device.pluginId || (device.guiMode || '').toLowerCase() || device.name.toLowerCase());

    if (device.effectType === 'limiter') {
        const thr = device.params.find((p) => p.name.toLowerCase() === 'thr')?.value ?? -0.3;
        const ceil = device.params.find((p) => p.name.toLowerCase() === 'ceil')?.value ?? -0.1;
        const safety = Math.max(0, Math.min(1, 1 - Math.abs(thr - ceil) / 30));
        const limGr = Math.max(0, Math.abs(thr) * 0.8);
        return (
            <div style={pluginPanelLayoutStyle}>
                <div style={{ ...pluginPanelCardBaseStyle, background: 'var(--plugin-bg-limiter)' }}>
                    <div style={{ ...pluginPanelTitleStyle, color: 'var(--token-color-hex-a4d9d3)' }}>Lookahead Limiter</div>
                    <div style={{ height: 10, borderRadius: 'var(--radius-full)', background: 'var(--color-bg-tertiary)', overflow: 'hidden' }}>
                        <div style={{ width: `${(safety * 100).toFixed(1)}%`, height: '100%', background: 'var(--color-success)' }} />
                    </div>
                    <div style={pluginPanelMetaStyle}>
                        <span>Thr {thr.toFixed(1)} dB</span>
                        <span>Ceil {ceil.toFixed(1)} dB</span>
                        <span>GR ~{limGr.toFixed(1)} dB</span>
                    </div>
                </div>
                <div style={pluginPanelKnobGrid('repeat(3, minmax(0, 1fr))')}>
                    {device.params.slice(0, 3).map((p) => (
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

    if (device.effectType === 'gate') {
        const thr = device.params.find((p) => p.name.toLowerCase() === 'thr')?.value ?? -40;
        const range = device.params.find((p) => p.name.toLowerCase() === 'range')?.value ?? -80;
        const gateAtk = device.params.find((p) => p.name.toLowerCase() === 'atk')?.value ?? device.params.find((p) => p.name.toLowerCase().includes('attack'))?.value ?? 0.1;
        const gateRel = device.params.find((p) => p.name.toLowerCase() === 'rel')?.value ?? device.params.find((p) => p.name.toLowerCase().includes('release'))?.value ?? 50;
        const openness = Math.max(0, Math.min(1, (80 + thr) / 80));
        return (
            <div style={pluginPanelLayoutStyle}>
                <div style={{ ...pluginPanelCardBaseStyle, background: 'var(--plugin-bg-gate)' }}>
                    <div style={{ ...pluginPanelTitleStyle, color: 'var(--token-color-hex-b8dfad)' }}>Noise Gate</div>
                    <div style={{ height: 34, borderRadius: 'var(--radius-md)', background: 'var(--color-bg-tertiary)', position: 'relative' }}>
                        <div style={{ position: 'absolute', left: 0, top: 0, bottom: 0, width: `${(openness * 100).toFixed(1)}%`, background: 'var(--color-success)' }} />
                    </div>
                    <div style={pluginPanelMetaStyle}>
                        <span>Thr {thr.toFixed(1)} dB</span>
                        <span>Range {range.toFixed(1)} dB</span>
                        <span>Atk {gateAtk.toFixed(1)} ms</span>
                        <span>Rel {gateRel.toFixed(0)} ms</span>
                    </div>
                </div>
                <div style={pluginPanelKnobGrid('repeat(5, minmax(0, 1fr))')}>
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

    if (device.effectType === 'autoFilter' || device.effectType === 'autoPan' || device.effectType === 'phaser' || device.effectType === 'flanger') {
        const params = device.params;
        const isVocoder = normalizedInternalId === 'internal://effect/vocoder';
        const modRate = params.find((p) => p.name.toLowerCase() === 'rate')?.value ?? 0;
        const modDepth = params.find((p) => p.name.toLowerCase() === 'depth')?.value ?? 0;
        const modMix = params.find((p) => p.name.toLowerCase() === 'dry/wet')?.value ?? params.find((p) => p.name.toLowerCase() === 'amount')?.value ?? 50;
        const modFreq = params.find((p) => p.name.toLowerCase() === 'freq' || p.name.toLowerCase() === 'frequency')?.value ?? 0;
        const title = isVocoder
            ? 'Vocoder'
            : device.effectType === 'autoFilter'
                ? 'Auto Filter'
                : device.effectType === 'autoPan'
                    ? 'Auto Pan'
                    : device.effectType === 'phaser'
                        ? 'Phaser'
                        : 'Flanger';
        const hue = device.effectType === 'autoFilter'
            ? 'var(--token-color-hex-4cc9d8)'
            : device.effectType === 'autoPan'
                ? 'var(--token-color-hex-6db3ff)'
                : device.effectType === 'phaser'
                    ? 'var(--token-color-hex-998bff)'
                    : 'var(--token-color-hex-66b3ff)';
        return (
            <div style={pluginPanelLayoutStyle}>
                <div style={{
                    ...pluginPanelCardBaseStyle,
                    background: 'var(--plugin-bg-mod)',
                }}>
                    <svg viewBox="0 0 320 52" preserveAspectRatio="none" style={{ width: '100%', height: '100%' }}>
                        <rect x="0" y="0" width="320" height="52" fill="var(--token-color-rgba-8-10-14-0d65)" />
                        {!isVocoder && (
                            <path d="M 0 30 C 32 10, 64 46, 96 26 C 128 6, 160 44, 192 24 C 224 8, 256 42, 288 22 C 304 12, 320 26, 320 26" fill="none" stroke={hue} strokeWidth="2.4" />
                        )}
                        {isVocoder && Array.from({ length: 20 }).map((_, i) => {
                            const x = 8 + i * 15;
                            const h = 8 + ((i * 17) % 34);
                            return <rect key={i} x={x} y={42 - h} width="9" height={h} rx="1.5" fill="var(--token-color-rgba-120-200-255-0d9)" />;
                        })}
                    </svg>
                    <div style={pluginPanelMetaStyle}>
                        <span>{title}</span>
                        {modRate > 0 && <span>{modRate.toFixed(2)} Hz</span>}
                        {modDepth > 0 && <span>Depth {modDepth.toFixed(0)}%</span>}
                        {modFreq > 0 && <span>Freq {modFreq.toFixed(0)} Hz</span>}
                        <span>Mix {modMix.toFixed(0)}%</span>
                    </div>
                </div>
                <div style={pluginPanelKnobGrid(`repeat(${Math.min(6, Math.max(3, params.length))}, minmax(0, 1fr))`)}>
                    {params.slice(0, 6).map((p) => (
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
