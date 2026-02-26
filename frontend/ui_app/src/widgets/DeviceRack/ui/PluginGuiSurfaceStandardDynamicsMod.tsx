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
    PLUGIN_TITLE_MAP,
    type SurfaceHandlers,
} from '@/widgets/DeviceRack/ui/PluginGuiSurfaceStandardShared';
import { renderModSpatialSurface } from '@/widgets/DeviceRack/ui/PluginGuiSurfaceStandardModSpatial';

function renderLimiterSurface(device: DeviceSlot, handlers: SurfaceHandlers): React.ReactNode {
    const { onParamChange, onParamGestureStart, onParamGestureEnd, onParamContextMenu } = handlers;
    const showDryWet = shouldShowDryWet(device);
    const knobParams = buildSurfaceKnobParams(device, { omitMixWhenDryWet: showDryWet });
    const thrParam = readSurfaceParam(device, 'thr', -0.3, 'dB');
    const ceilParam = readSurfaceParam(device, 'ceil', -0.1, 'dB');
    const thr = thrParam.value;
    const ceil = ceilParam.value;
    const safety = Math.max(0, Math.min(1, 1 - Math.abs(thr - ceil) / 30));
    const limGr = Math.max(0, Math.abs(thr) * 0.8);
    const grBarH = Math.max(0, Math.min(100, (limGr / 24) * 100));
    return (
        <div data-no-drag style={pluginPanelLayoutStyle}>
            <div style={{ ...panelWithOptionalDryWetStyle(showDryWet), background: 'var(--plugin-bg-limiter)' }}>
                <div style={{ display: 'grid', gap: 6 }}>
                    <div style={{ ...pluginPanelTitleStyle, color: 'var(--token-color-hex-a4d9d3)' }}>Lookahead Limiter</div>
                    <svg viewBox="0 0 280 28" preserveAspectRatio="none" style={{ width: '100%', height: 28 }}>
                        <rect x="0" y="0" width="280" height="28" rx="4" fill="var(--token-color-rgba-8-10-14-0d65)" />
                        <line x1={14 + (1 + thr / 60) * 240} y1="2" x2={14 + (1 + thr / 60) * 240} y2="26" stroke="var(--token-color-hex-f0a66e)" strokeWidth="1.5" strokeDasharray="3,2" />
                        <line x1={14 + (1 + ceil / 60) * 240} y1="2" x2={14 + (1 + ceil / 60) * 240} y2="26" stroke="var(--token-color-hex-ff6b6b)" strokeWidth="1.5" />
                        <rect x="14" y="8" width={Math.max(2, safety * 240)} height="12" rx="2" fill="var(--color-success)" opacity="0.85" />
                    </svg>
                    <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
                        <div style={{ width: 36, height: 6, borderRadius: 'var(--radius-full)', background: 'var(--color-bg-tertiary)', overflow: 'hidden' }}>
                            <div style={{ width: `${grBarH}%`, height: '100%', background: 'var(--color-error)', transition: 'width 60ms linear' }} />
                        </div>
                        <span style={{ fontSize: 'var(--font-size-2xs)', fontFamily: 'var(--font-role-data)', color: 'var(--color-text-tertiary)' }}>GR ~{limGr.toFixed(1)} dB</span>
                    </div>
                    <div style={pluginPanelMetaStyle}>
                        <span>Thr {formatSurfaceParam(thrParam)}</span>
                        <span>Ceil {formatSurfaceParam(ceilParam)}</span>
                    </div>
                </div>
                {showDryWet && <DryWetKnob device={device} onChange={onParamChange} onGestureStart={onParamGestureStart} onGestureEnd={onParamGestureEnd} onContextMenu={onParamContextMenu} accent="var(--token-color-hex-56d4c8)" />}
            </div>
            {knobParams.length > 0 && (
                <div style={pluginPanelKnobGrid(`repeat(${Math.min(8, Math.max(3, knobParams.length || 3))}, minmax(0, 1fr))`)}>
                    {knobParams.map((p) => <PluginKnob key={p.name} param={p} onChange={onParamChange} onGestureStart={onParamGestureStart} onGestureEnd={onParamGestureEnd} onContextMenu={onParamContextMenu} compact />)}
                </div>
            )}
        </div>
    );
}

function renderGateSurface(device: DeviceSlot, handlers: SurfaceHandlers): React.ReactNode {
    const { onParamChange, onParamGestureStart, onParamGestureEnd, onParamContextMenu } = handlers;
    const showDryWet = shouldShowDryWet(device);
    const knobParams = buildSurfaceKnobParams(device, { omitMixWhenDryWet: showDryWet });
    const thrParam = readSurfaceParam(device, 'thr', -40, 'dB');
    const rangeParam = readSurfaceParam(device, 'range', -80, 'dB');
    const gateAtkParam = readSurfaceParam(device, ['atk', 'attack'], 0.1, 'ms');
    const gateRelParam = readSurfaceParam(device, ['rel', 'release'], 50, 'ms');
    const thrNorm = Math.max(0, Math.min(1, (thrParam.value + 60) / 60));
    return (
        <div data-no-drag style={pluginPanelLayoutStyle}>
            <div style={{ ...panelWithOptionalDryWetStyle(showDryWet), background: 'var(--plugin-bg-gate)' }}>
                <div style={{ display: 'grid', gap: 6 }}>
                    <div style={{ ...pluginPanelTitleStyle, color: 'var(--token-color-hex-b8dfad)' }}>Noise Gate</div>
                    <svg viewBox="0 0 280 48" preserveAspectRatio="none" style={{ width: '100%', height: 48 }}>
                        <rect x="0" y="0" width="280" height="48" rx="4" fill="var(--token-color-rgba-8-14-8-0d65)" />
                        {Array.from({ length: 14 }).map((_, i) => {
                            const x = 10 + i * 19;
                            const h = 6 + Math.abs(Math.sin((i + 1) * 0.95)) * 30;
                            const aboveThreshold = (h / 42) > thrNorm * 0.8;
                            return <rect key={i} x={x} y={42 - h} width="12" height={h} rx="2" fill={aboveThreshold ? 'var(--token-color-hex-8ec77c)' : 'var(--token-color-rgba-140-200-120-0d25)'} stroke={aboveThreshold ? 'none' : 'var(--token-color-rgba-140-200-120-0d15)'} strokeWidth="0.5" />;
                        })}
                        <line x1="4" y1={42 - thrNorm * 36} x2="276" y2={42 - thrNorm * 36} stroke="var(--token-color-hex-e6c36e)" strokeWidth="1.2" strokeDasharray="4,3" />
                    </svg>
                    <div style={pluginPanelMetaStyle}>
                        <span>Thr {formatSurfaceParam(thrParam)}</span>
                        <span>Range {formatSurfaceParam(rangeParam)}</span>
                        <span>Atk {formatSurfaceParam(gateAtkParam)}</span>
                        <span>Rel {formatSurfaceParam(gateRelParam)}</span>
                    </div>
                </div>
                {showDryWet && <DryWetKnob device={device} onChange={onParamChange} onGestureStart={onParamGestureStart} onGestureEnd={onParamGestureEnd} onContextMenu={onParamContextMenu} accent="var(--token-color-hex-8ec77c)" />}
            </div>
            {knobParams.length > 0 && (
                <div style={pluginPanelKnobGrid(`repeat(${Math.min(8, Math.max(3, knobParams.length || 3))}, minmax(0, 1fr))`)}>
                    {knobParams.map((p) => <PluginKnob key={p.name} param={p} onChange={onParamChange} onGestureStart={onParamGestureStart} onGestureEnd={onParamGestureEnd} onContextMenu={onParamContextMenu} compact />)}
                </div>
            )}
        </div>
    );
}

function renderAutoFilterSurface(device: DeviceSlot, handlers: SurfaceHandlers): React.ReactNode {
    const { onParamChange, onParamGestureStart, onParamGestureEnd, onParamContextMenu } = handlers;
    const showDryWet = shouldShowDryWet(device);
    const knobParams = buildSurfaceKnobParams(device, { omitMixWhenDryWet: showDryWet });
    const normalizedInternalId = normalizeInternalPluginId(device.pluginId || (device.guiMode || '').toLowerCase() || device.name.toLowerCase());
    const title = PLUGIN_TITLE_MAP[normalizedInternalId] ?? 'Auto Filter';
    const isVocoder = normalizedInternalId === 'internal://effect/vocoder';
    const modRate = readSurfaceParam(device, 'rate', 0, 'Hz');
    const modDepth = readSurfaceParam(device, 'depth', 0, '%');
    const modFreq = readSurfaceParam(device, ['freq', 'frequency', 'cutoff', 'center'], 1000, 'Hz');
    const freqNorm = Math.max(0, Math.min(1, (Math.log10(Math.max(20, modFreq.value)) - Math.log10(20)) / (Math.log10(20000) - Math.log10(20))));
    const peakX = 20 + freqNorm * 260;
    return (
        <div data-no-drag style={pluginPanelLayoutStyle}>
            <div style={{ ...panelWithOptionalDryWetStyle(showDryWet), background: 'var(--plugin-bg-mod)' }}>
                <div style={{ display: 'grid', gap: 6 }}>
                    <div style={{ ...pluginPanelTitleStyle, color: 'var(--token-color-hex-4cc9d8)' }}>{title}</div>
                    <svg viewBox="0 0 300 52" preserveAspectRatio="none" style={{ width: '100%', height: 48 }}>
                        <rect x="0" y="0" width="300" height="52" rx="4" fill="var(--token-color-rgba-8-10-14-0d65)" />
                        {isVocoder ? (
                            <>
                                {Array.from({ length: 20 }).map((_, i) => {
                                    const x = 8 + i * 14.5;
                                    const h = 8 + ((i * 17) % 34);
                                    return <rect key={i} x={x} y={46 - h} width="9" height={h} rx="1.5" fill="var(--token-color-rgba-76-201-216-0d85)" />;
                                })}
                            </>
                        ) : (
                            <>
                                <line x1="4" y1="42" x2="296" y2="42" stroke="var(--token-color-rgba-76-201-216-0d2)" strokeWidth="0.8" />
                                <path d={`M 4 42 L ${Math.max(4, peakX - 40)} 42 Q ${peakX - 15} 42, ${peakX} 10 Q ${peakX + 15} 42, ${peakX + 30} 46 L 296 46`} fill="none" stroke="var(--token-color-hex-4cc9d8)" strokeWidth="2.4" strokeLinecap="round" />
                                <line x1={peakX} y1="4" x2={peakX} y2="48" stroke="var(--token-color-rgba-76-201-216-0d35)" strokeWidth="1" strokeDasharray="2,2" />
                            </>
                        )}
                    </svg>
                    <div style={pluginPanelMetaStyle}>
                        <span>{title}</span>
                        {modRate.value > 0 && <span>{formatSurfaceParam(modRate)}</span>}
                        {modDepth.value > 0 && <span>Depth {formatSurfaceParam(modDepth)}</span>}
                        <span>Freq {formatSurfaceParam(modFreq)}</span>
                    </div>
                </div>
                {showDryWet && <DryWetKnob device={device} onChange={onParamChange} onGestureStart={onParamGestureStart} onGestureEnd={onParamGestureEnd} onContextMenu={onParamContextMenu} accent="var(--token-color-hex-4cc9d8)" />}
            </div>
            {knobParams.length > 0 && (
                <div style={pluginPanelKnobGrid(`repeat(${Math.min(8, Math.max(3, knobParams.length || 3))}, minmax(0, 1fr))`)}>
                    {knobParams.map((p) => <PluginKnob key={p.name} param={p} onChange={onParamChange} onGestureStart={onParamGestureStart} onGestureEnd={onParamGestureEnd} onContextMenu={onParamContextMenu} compact />)}
                </div>
            )}
        </div>
    );
}

export function renderStandardDynamicsModSurface(device: DeviceSlot, handlers: SurfaceHandlers): React.ReactNode {
    if (device.effectType === 'limiter') return renderLimiterSurface(device, handlers);
    if (device.effectType === 'gate') return renderGateSurface(device, handlers);
    if (device.effectType === 'autoFilter') return renderAutoFilterSurface(device, handlers);
    return renderModSpatialSurface(device, handlers);
}
