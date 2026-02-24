import React from 'react';
import { PluginKnob } from '@/widgets/DeviceRack/StandardPluginControls';
import { pluginPanelKnobGrid } from '@/widgets/DeviceRack/ui/styles';
import { DryWetKnob } from '@/widgets/DeviceRack/ui/DryWetKnob';
import { normalizeInternalPluginId } from '@/shared/lib/internalPlugins';
import type { DeviceSlot } from '@/widgets/DeviceRack/model/types';
import {
    buildSurfaceKnobParams,
    formatSurfaceParam,
    panelWithOptionalDryWetStyle,
    pluginPanelLayoutStyle,
    pluginPanelMetaStyle,
    pluginPanelTitleStyle,
    readSurfaceParam,
    shouldShowDryWet,
    type SurfaceHandlers,
} from '@/widgets/DeviceRack/ui/PluginGuiSurfaceStandardShared';

function renderAutoPanSurface(device: DeviceSlot, handlers: SurfaceHandlers): React.ReactNode {
    const { onParamChange, onParamGestureStart, onParamGestureEnd } = handlers;
    const showDryWet = shouldShowDryWet(device);
    const knobParams = buildSurfaceKnobParams(device, { omitMixWhenDryWet: showDryWet });
    const modRate = readSurfaceParam(device, 'rate', 1, 'Hz');
    const modDepth = readSurfaceParam(device, 'depth', 50, '%');
    const depthNorm = Math.max(0, Math.min(1, modDepth.value / 100));
    return (
        <div data-no-drag style={pluginPanelLayoutStyle}>
            <div style={{ ...panelWithOptionalDryWetStyle(showDryWet), background: 'var(--plugin-bg-mod)' }}>
                <div style={{ display: 'grid', gap: 6 }}>
                    <div style={{ ...pluginPanelTitleStyle, color: 'var(--token-color-hex-6db3ff)' }}>Auto Pan</div>
                    <svg viewBox="0 0 300 52" preserveAspectRatio="none" style={{ width: '100%', height: 48 }}>
                        <rect x="0" y="0" width="300" height="52" rx="4" fill="var(--token-color-rgba-8-10-14-0d65)" />
                        <line x1="150" y1="4" x2="150" y2="48" stroke="var(--token-color-rgba-109-179-255-0d2)" strokeWidth="1" />
                        <text x="16" y="14" fill="var(--token-color-rgba-109-179-255-0d45)" fontSize="9" fontFamily="var(--font-mono)">L</text>
                        <text x="282" y="14" fill="var(--token-color-rgba-109-179-255-0d45)" fontSize="9" fontFamily="var(--font-mono)">R</text>
                        <path d={`M 10 26 C 60 ${26 - 18 * depthNorm}, 100 ${26 + 18 * depthNorm}, 150 26 C 200 ${26 - 18 * depthNorm}, 240 ${26 + 18 * depthNorm}, 290 26`} fill="none" stroke="var(--token-color-hex-6db3ff)" strokeWidth="2.4" strokeLinecap="round" />
                        <path d={`M 10 26 C 60 ${26 + 18 * depthNorm}, 100 ${26 - 18 * depthNorm}, 150 26 C 200 ${26 + 18 * depthNorm}, 240 ${26 - 18 * depthNorm}, 290 26`} fill="none" stroke="var(--token-color-hex-6db3ff)" strokeWidth="1.6" strokeLinecap="round" opacity="0.35" />
                    </svg>
                    <div style={pluginPanelMetaStyle}>
                        <span>Auto Pan</span>
                        <span>Rate {formatSurfaceParam(modRate)}</span>
                        <span>Depth {formatSurfaceParam(modDepth)}</span>
                    </div>
                </div>
                {showDryWet && (
                    <DryWetKnob device={device} onChange={onParamChange} onGestureStart={onParamGestureStart} onGestureEnd={onParamGestureEnd} accent="var(--token-color-hex-6db3ff)" />
                )}
            </div>
            {knobParams.length > 0 && (
                <div style={pluginPanelKnobGrid(`repeat(${Math.min(8, Math.max(3, knobParams.length || 3))}, minmax(0, 1fr))`)}>
                    {knobParams.map((p) => (
                        <PluginKnob key={p.name} param={p} onChange={onParamChange} onGestureStart={onParamGestureStart} onGestureEnd={onParamGestureEnd} compact />
                    ))}
                </div>
            )}
        </div>
    );
}

function renderPhaserSurface(device: DeviceSlot, handlers: SurfaceHandlers): React.ReactNode {
    const { onParamChange, onParamGestureStart, onParamGestureEnd } = handlers;
    const normalizedInternalId = normalizeInternalPluginId(device.pluginId || (device.guiMode || '').toLowerCase() || device.name.toLowerCase());
    const isPhaserFlanger = normalizedInternalId === 'internal://effect/phaser-flanger';
    const showDryWet = shouldShowDryWet(device);
    const knobParams = buildSurfaceKnobParams(device, { omitMixWhenDryWet: showDryWet });
    const modRate = readSurfaceParam(device, 'rate', 0.5, 'Hz');
    const modDepth = readSurfaceParam(device, 'depth', 60, '%');
    const stages = readSurfaceParam(device, 'stages', 6, '');
    const stageCount = Math.max(2, Math.min(12, Math.round(stages.value)));
    return (
        <div data-no-drag style={pluginPanelLayoutStyle}>
            <div style={{ ...panelWithOptionalDryWetStyle(showDryWet), background: 'var(--plugin-bg-mod)' }}>
                <div style={{ display: 'grid', gap: 6 }}>
                    <div style={{ ...pluginPanelTitleStyle, color: 'var(--token-color-hex-998bff)' }}>{isPhaserFlanger ? 'Phaser-Flanger' : 'Phaser'}</div>
                    <svg viewBox="0 0 300 52" preserveAspectRatio="none" style={{ width: '100%', height: 48 }}>
                        <rect x="0" y="0" width="300" height="52" rx="4" fill="var(--token-color-rgba-8-10-14-0d65)" />
                        {Array.from({ length: stageCount }).map((_, i) => {
                            const cx = 20 + (i / Math.max(1, stageCount - 1)) * 260;
                            const notchDepth = 14 + (modDepth.value / 100) * 20;
                            return (
                                <React.Fragment key={i}>
                                    <path d={`M ${cx - 10} 16 L ${cx} ${16 + notchDepth} L ${cx + 10} 16`} fill="none" stroke="var(--token-color-hex-998bff)" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
                                    <circle cx={cx} cy={16 + notchDepth} r="2" fill="var(--token-color-hex-998bff)" />
                                </React.Fragment>
                            );
                        })}
                        <line x1="4" y1="16" x2="296" y2="16" stroke="var(--token-color-rgba-153-139-255-0d2)" strokeWidth="0.8" />
                    </svg>
                    <div style={pluginPanelMetaStyle}>
                        <span>{isPhaserFlanger ? 'Phaser-Flanger' : 'Phaser'}</span>
                        <span>{formatSurfaceParam(modRate)}</span>
                        <span>Depth {formatSurfaceParam(modDepth)}</span>
                        <span>{stageCount} stages</span>
                    </div>
                </div>
                {showDryWet && (
                    <DryWetKnob device={device} onChange={onParamChange} onGestureStart={onParamGestureStart} onGestureEnd={onParamGestureEnd} accent="var(--token-color-hex-998bff)" />
                )}
            </div>
            {knobParams.length > 0 && (
                <div style={pluginPanelKnobGrid(`repeat(${Math.min(8, Math.max(3, knobParams.length || 3))}, minmax(0, 1fr))`)}>
                    {knobParams.map((p) => (
                        <PluginKnob key={p.name} param={p} onChange={onParamChange} onGestureStart={onParamGestureStart} onGestureEnd={onParamGestureEnd} compact />
                    ))}
                </div>
            )}
        </div>
    );
}

function renderFlangerSurface(device: DeviceSlot, handlers: SurfaceHandlers): React.ReactNode {
    const { onParamChange, onParamGestureStart, onParamGestureEnd } = handlers;
    const normalizedInternalId = normalizeInternalPluginId(device.pluginId || (device.guiMode || '').toLowerCase() || device.name.toLowerCase());
    const isPhaserFlanger = normalizedInternalId === 'internal://effect/phaser-flanger';
    const showDryWet = shouldShowDryWet(device);
    const knobParams = buildSurfaceKnobParams(device, { omitMixWhenDryWet: showDryWet });
    const modRate = readSurfaceParam(device, 'rate', 0.3, 'Hz');
    const modDepth = readSurfaceParam(device, 'depth', 50, '%');
    const fb = readSurfaceParam(device, ['fb', 'feedback'], 40, '%');
    const fbNorm = Math.max(0, Math.min(1, Math.abs(fb.value) / 100));
    return (
        <div data-no-drag style={pluginPanelLayoutStyle}>
            <div style={{ ...panelWithOptionalDryWetStyle(showDryWet), background: 'var(--plugin-bg-mod)' }}>
                <div style={{ display: 'grid', gap: 6 }}>
                    <div style={{ ...pluginPanelTitleStyle, color: 'var(--token-color-hex-66b3ff)' }}>{isPhaserFlanger ? 'Phaser-Flanger' : 'Flanger'}</div>
                    <svg viewBox="0 0 300 52" preserveAspectRatio="none" style={{ width: '100%', height: 48 }}>
                        <rect x="0" y="0" width="300" height="52" rx="4" fill="var(--token-color-rgba-8-10-14-0d65)" />
                        {Array.from({ length: 10 }).map((_, i) => {
                            const x = 16 + i * 28;
                            const peakH = 12 + fbNorm * 26 * Math.pow(0.85, i);
                            return (
                                <React.Fragment key={i}>
                                    <rect x={x} y={44 - peakH} width="8" height={peakH} rx="2" fill={i % 2 === 0 ? 'var(--token-color-hex-66b3ff)' : 'var(--token-color-rgba-102-179-255-0d6)'} />
                                    {i < 9 && <line x1={x + 8} y1={44 - peakH * 0.6} x2={x + 28} y2={44 - (12 + fbNorm * 26 * Math.pow(0.85, i + 1)) * 0.6} stroke="var(--token-color-rgba-102-179-255-0d25)" strokeWidth="0.8" />}
                                </React.Fragment>
                            );
                        })}
                    </svg>
                    <div style={pluginPanelMetaStyle}>
                        <span>{isPhaserFlanger ? 'Phaser-Flanger' : 'Flanger'}</span>
                        <span>{formatSurfaceParam(modRate)}</span>
                        <span>Depth {formatSurfaceParam(modDepth)}</span>
                        <span>FB {formatSurfaceParam(fb)}</span>
                    </div>
                </div>
                {showDryWet && (
                    <DryWetKnob device={device} onChange={onParamChange} onGestureStart={onParamGestureStart} onGestureEnd={onParamGestureEnd} accent="var(--token-color-hex-66b3ff)" />
                )}
            </div>
            {knobParams.length > 0 && (
                <div style={pluginPanelKnobGrid(`repeat(${Math.min(8, Math.max(3, knobParams.length || 3))}, minmax(0, 1fr))`)}>
                    {knobParams.map((p) => (
                        <PluginKnob key={p.name} param={p} onChange={onParamChange} onGestureStart={onParamGestureStart} onGestureEnd={onParamGestureEnd} compact />
                    ))}
                </div>
            )}
        </div>
    );
}

export function renderModSpatialSurface(device: DeviceSlot, handlers: SurfaceHandlers): React.ReactNode {
    if (device.effectType === 'autoPan') return renderAutoPanSurface(device, handlers);
    if (device.effectType === 'phaser') return renderPhaserSurface(device, handlers);
    if (device.effectType === 'flanger') return renderFlangerSurface(device, handlers);
    return null;
}
