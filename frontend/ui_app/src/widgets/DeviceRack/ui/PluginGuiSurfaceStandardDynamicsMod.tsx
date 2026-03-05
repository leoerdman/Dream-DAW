import React from 'react';
import { clamp01 } from '@/shared/lib/audioMath';
import type { DeviceSlot } from '@/widgets/DeviceRack/model/types';
import {
    buildSurfaceKnobParams,
    DryWetSection,
    formatSurfaceParam,
    getDevicePluginKey,
    KnobParamGrid,
    pluginPanelCardBaseStyle,
    pluginPanelMetaStyle,
    readSurfaceParam,
    shouldShowDryWet,
    type SurfaceHandlers,
} from '@/widgets/DeviceRack/ui/PluginGuiSurfaceStandardShared';
import { renderModSpatialSurface } from '@/widgets/DeviceRack/ui/PluginGuiSurfaceStandardModSpatial';

function renderLimiterSurface(device: DeviceSlot, handlers: SurfaceHandlers): React.ReactNode {
    const showDryWet = shouldShowDryWet(device);
    const thrParam = readSurfaceParam(device, 'thr', -0.3, 'dB');
    const ceilParam = readSurfaceParam(device, 'ceil', -0.1, 'dB');
    const thr = thrParam.value;
    const ceil = ceilParam.value;
    const safety = clamp01(1 - Math.abs(thr - ceil) / 30);
    const limGr = Math.max(0, Math.abs(thr) * 0.8);
    const grBarH = Math.max(0, Math.min(100, (limGr / 24) * 100));
    const knobParams = buildSurfaceKnobParams(device, { omitMixWhenDryWet: showDryWet });

    return (
        <div data-no-drag style={{ display: 'flex', gap: 'var(--space-1-5)', height: '100%' }}>
            <div style={{ width: 130, flexShrink: 0, display: 'flex', flexDirection: 'column', gap: 'var(--space-1)' }}>
                <div style={{ ...pluginPanelCardBaseStyle, padding: 'var(--space-1)', display: 'block', height: 'fit-content' }}>
                    <KnobParamGrid params={knobParams} handlers={handlers} maxCols={2} minCols={2} />
                </div>
            </div>
            <div style={{ flex: 1, display: 'flex', flexDirection: 'column', gap: 'var(--space-1)' }}>
                <div style={{ ...pluginPanelCardBaseStyle, background: 'var(--plugin-bg-limiter)', overflow: 'hidden', padding: 0, flex: 1, position: 'relative' }}>
                    <svg width="100%" height="100%" viewBox="0 0 300 120" preserveAspectRatio="xMidYMid slice" style={{ display: 'block', willChange: 'transform', transform: 'translateZ(0)' }}>
                        <rect x="0" y="0" width="300" height="120" fill="var(--token-color-rgba-8-10-14-0d65)" />
                        {/* Threshold line */}
                        <line x1={14 + (1 + thr / 60) * 260} y1="6" x2={14 + (1 + thr / 60) * 260} y2="108" stroke="var(--token-color-hex-f0a66e)" strokeWidth="1.5" strokeDasharray="5,3" />
                        {/* Ceiling line */}
                        <line x1={14 + (1 + ceil / 60) * 260} y1="6" x2={14 + (1 + ceil / 60) * 260} y2="108" stroke="var(--token-color-hex-ff6b6b)" strokeWidth="1.5" />
                        {/* Safety bar */}
                        <rect x="14" y="40" width={Math.max(4, safety * 260)} height="40" rx="3" fill="var(--color-success)" opacity="0.7" />
                        {/* GR bar at bottom */}
                        <rect x="14" y="96" width={Math.max(2, (grBarH / 100) * 260)} height="14" rx="2" fill={limGr > 12 ? 'var(--color-error)' : limGr > 4 ? 'var(--color-warning)' : 'var(--color-success)'} opacity="0.85" />
                    </svg>
                </div>
                <div style={{ ...pluginPanelMetaStyle, padding: '0 var(--space-1)' }}>
                    <span>Thr {formatSurfaceParam(thrParam)}</span>
                    <span>Ceil {formatSurfaceParam(ceilParam)}</span>
                    <span>GR ~{limGr.toFixed(1)} dB</span>
                </div>
            </div>
            <DryWetSection device={device} handlers={handlers} accent="var(--token-color-hex-56d4c8)" show={showDryWet} />
        </div>
    );
}

function renderGateSurface(device: DeviceSlot, handlers: SurfaceHandlers): React.ReactNode {
    const showDryWet = shouldShowDryWet(device);
    const thrParam = readSurfaceParam(device, 'thr', -40, 'dB');
    const thrNorm = clamp01((thrParam.value + 60) / 60);
    const knobParams = buildSurfaceKnobParams(device, { omitMixWhenDryWet: showDryWet });

    return (
        <div data-no-drag style={{ display: 'flex', gap: 'var(--space-1-5)', height: '100%' }}>
            <div style={{ width: 130, flexShrink: 0, display: 'flex', flexDirection: 'column', gap: 'var(--space-1)' }}>
                <div style={{ ...pluginPanelCardBaseStyle, padding: 'var(--space-1)', display: 'block', height: 'fit-content' }}>
                    <KnobParamGrid params={knobParams} handlers={handlers} maxCols={2} minCols={2} />
                </div>
            </div>
            <div style={{ flex: 1, display: 'flex', flexDirection: 'column', gap: 'var(--space-1)' }}>
                <div style={{ ...pluginPanelCardBaseStyle, background: 'var(--plugin-bg-gate)', overflow: 'hidden', padding: 0, flex: 1 }}>
                    <svg width="100%" height="100%" viewBox="0 0 300 120" preserveAspectRatio="xMidYMid slice" style={{ display: 'block', willChange: 'transform', transform: 'translateZ(0)' }}>
                        <rect x="0" y="0" width="300" height="120" fill="var(--token-color-rgba-8-14-8-0d65)" />
                        {Array.from({ length: 14 }).map((_, i) => {
                            const x = 12 + i * 19;
                            const h = 12 + Math.abs(Math.sin((i + 1) * 0.95)) * 70;
                            const aboveThreshold = (h / 100) > thrNorm * 0.8;
                            return <rect key={i} x={x} y={106 - h} width="14" height={h} rx="2" fill={aboveThreshold ? 'var(--token-color-hex-8ec77c)' : 'var(--token-color-rgba-140-200-120-0d25)'} stroke={aboveThreshold ? 'none' : 'var(--token-color-rgba-140-200-120-0d15)'} strokeWidth="0.5" />;
                        })}
                        {/* Threshold line */}
                        <line x1="4" y1={106 - thrNorm * 90} x2="296" y2={106 - thrNorm * 90} stroke="var(--token-color-hex-ffcc58)" strokeWidth="1.8" strokeDasharray="5,3" />
                    </svg>
                </div>
                <div style={{ ...pluginPanelMetaStyle, padding: '0 var(--space-1)' }}>
                    <span>Thr {formatSurfaceParam(thrParam)}</span>
                </div>
            </div>
            <DryWetSection device={device} handlers={handlers} accent="var(--token-color-hex-8ec77c)" show={showDryWet} />
        </div>
    );
}

function renderAutoFilterSurface(device: DeviceSlot, handlers: SurfaceHandlers): React.ReactNode {
    const showDryWet = shouldShowDryWet(device);
    const normalizedInternalId = getDevicePluginKey(device);
    const isVocoder = normalizedInternalId === 'internal://effect/vocoder';
    const modFreq = readSurfaceParam(device, ['freq', 'frequency', 'cutoff', 'center'], 1000, 'Hz');
    const freqNorm = clamp01((Math.log10(Math.max(20, modFreq.value)) - Math.log10(20)) / (Math.log10(20000) - Math.log10(20)));
    const peakX = 20 + freqNorm * 260;
    const knobParams = buildSurfaceKnobParams(device, { omitMixWhenDryWet: showDryWet });

    return (
        <div data-no-drag style={{ display: 'flex', gap: 'var(--space-1-5)', height: '100%' }}>
            <div style={{ width: 130, flexShrink: 0, display: 'flex', flexDirection: 'column', gap: 'var(--space-1)' }}>
                <div style={{ ...pluginPanelCardBaseStyle, padding: 'var(--space-1)', display: 'block', height: 'fit-content' }}>
                    <KnobParamGrid params={knobParams} handlers={handlers} maxCols={2} minCols={2} />
                </div>
            </div>
            <div style={{ flex: 1, display: 'flex', flexDirection: 'column', gap: 'var(--space-1)' }}>
                <div style={{ ...pluginPanelCardBaseStyle, background: 'var(--plugin-bg-mod)', overflow: 'hidden', padding: 0, flex: 1 }}>
                    <svg width="100%" height="100%" viewBox="0 0 300 120" preserveAspectRatio="xMidYMid slice" style={{ display: 'block', willChange: 'transform', transform: 'translateZ(0)' }}>
                        <rect x="0" y="0" width="300" height="120" fill="var(--token-color-rgba-8-10-14-0d65)" />
                        <line x1="10" y1="60" x2="290" y2="60" stroke="var(--token-color-rgba-255-255-255-0d12)" strokeWidth="0.8" />
                        {isVocoder ? (
                            <>
                                {Array.from({ length: 20 }).map((_, i) => {
                                    const x = 10 + i * 14.5;
                                    const h = 16 + ((i * 17) % 70);
                                    return <rect key={i} x={x} y={106 - h} width="9" height={h} rx="1.5" fill="var(--token-color-rgba-76-201-216-0d85)" />;
                                })}
                            </>
                        ) : (
                            <>
                                <line x1="4" y1="100" x2="296" y2="100" stroke="var(--token-color-rgba-76-201-216-0d2)" strokeWidth="0.8" />
                                <path d={`M 4 100 L ${Math.max(4, peakX - 50)} 100 Q ${peakX - 20} 100, ${peakX} 20 Q ${peakX + 20} 100, ${peakX + 40} 106 L 296 106`} fill="none" stroke="var(--token-color-hex-4cc9d8)" strokeWidth="2.4" strokeLinecap="round" />
                                <line x1={peakX} y1="6" x2={peakX} y2="114" stroke="var(--token-color-rgba-76-201-216-0d35)" strokeWidth="1" strokeDasharray="3,3" />
                                <circle cx={peakX} cy="20" r="4" fill="var(--token-color-hex-4cc9d8)" stroke="white" strokeWidth="1" />
                            </>
                        )}
                    </svg>
                </div>
                <div style={{ ...pluginPanelMetaStyle, padding: '0 var(--space-1)' }}>
                    <span>Freq {formatSurfaceParam(modFreq)}</span>
                </div>
            </div>
            <DryWetSection device={device} handlers={handlers} accent="var(--token-color-hex-4cc9d8)" show={showDryWet} />
        </div>
    );
}

export function renderStandardDynamicsModSurface(device: DeviceSlot, handlers: SurfaceHandlers): React.ReactNode {
    if (device.effectType === 'limiter') return renderLimiterSurface(device, handlers);
    if (device.effectType === 'gate') return renderGateSurface(device, handlers);
    if (device.effectType === 'autoFilter') return renderAutoFilterSurface(device, handlers);
    return renderModSpatialSurface(device, handlers);
}
