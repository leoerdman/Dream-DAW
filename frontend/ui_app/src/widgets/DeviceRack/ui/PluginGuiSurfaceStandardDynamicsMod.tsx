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
    safeParamValue,
    PLUGIN_TITLE_MAP,
    type SurfaceHandlers,
} from '@/widgets/DeviceRack/ui/PluginGuiSurfaceStandardShared';

export function renderStandardDynamicsModSurface(device: DeviceSlot, handlers: SurfaceHandlers): React.ReactNode {
    const { onParamChange, onParamGestureStart, onParamGestureEnd } = handlers;
    const normalizedInternalId = normalizeInternalPluginId(device.pluginId || (device.guiMode || '').toLowerCase() || device.name.toLowerCase());

    if (device.effectType === 'limiter') {
        const thr = safeParamValue(device, 'thr', -0.3);
        const ceil = safeParamValue(device, 'ceil', -0.1);
        const safety = Math.max(0, Math.min(1, 1 - Math.abs(thr - ceil) / 30));
        const limGr = Math.max(0, Math.abs(thr) * 0.8);
        return (
            <div data-no-drag style={pluginPanelLayoutStyle}>
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
                <div style={pluginPanelKnobGrid(`repeat(${Math.min(8, Math.max(3, device.params.length))}, minmax(0, 1fr))`)}>
                    {device.params.map((p) => (
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
        const thr = safeParamValue(device, 'thr', -40);
        const range = safeParamValue(device, 'range', -80);
        const gateAtk = safeParamValue(device, ['atk', 'attack'], 0.1);
        const gateRel = safeParamValue(device, ['rel', 'release'], 50);
        const openness = Math.max(0, Math.min(1, (80 + thr) / 80));
        return (
            <div data-no-drag style={pluginPanelLayoutStyle}>
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
                <div style={pluginPanelKnobGrid(`repeat(${Math.min(8, Math.max(3, device.params.length))}, minmax(0, 1fr))`)}>
                    {device.params.map((p) => (
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
        const modRate = safeParamValue(device, 'rate', 0);
        const modDepth = safeParamValue(device, 'depth', 0);
        const modMix = safeParamValue(device, ['dry/wet', 'mix', 'amount'], 50);
        const modFreq = safeParamValue(device, ['freq', 'frequency', 'cutoff', 'center'], 0);
        const isVocoder = normalizedInternalId === 'internal://effect/vocoder';
        const title = PLUGIN_TITLE_MAP[normalizedInternalId]
            ?? (device.effectType === 'autoFilter' ? 'Auto Filter'
                : device.effectType === 'autoPan' ? 'Auto Pan'
                    : device.effectType === 'phaser' ? 'Phaser'
                        : 'Flanger');
        const hue = device.effectType === 'autoFilter'
            ? 'var(--token-color-hex-4cc9d8)'
            : device.effectType === 'autoPan'
                ? 'var(--token-color-hex-6db3ff)'
                : device.effectType === 'phaser'
                    ? 'var(--token-color-hex-998bff)'
                    : 'var(--token-color-hex-66b3ff)';
        return (
            <div data-no-drag style={pluginPanelLayoutStyle}>
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
                <div style={pluginPanelKnobGrid(`repeat(${Math.min(8, Math.max(3, device.params.length))}, minmax(0, 1fr))`)}>
                    {device.params.map((p) => (
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
