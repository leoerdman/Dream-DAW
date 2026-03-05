import React from 'react';
import { clamp01 } from '@/shared/lib/audioMath';
import type { DeviceSlot } from '@/widgets/DeviceRack/model/types';
import {
    buildSurfaceKnobParams,
    DryWetSection,
    formatSurfaceParam,
    KnobParamGrid,
    pluginPanelCardBaseStyle,
    pluginPanelMetaStyle,
    readSurfaceParam,
    shouldShowDryWet,
    type SurfaceHandlers,
} from '@/widgets/DeviceRack/ui/PluginGuiSurfaceStandardShared';

function renderAutoPanSurface(device: DeviceSlot, handlers: SurfaceHandlers): React.ReactNode {
    const showDryWet = shouldShowDryWet(device);
    const modRate = readSurfaceParam(device, 'rate', 1, 'Hz');
    const modDepth = readSurfaceParam(device, 'depth', 50, '%');
    const depthNorm = clamp01(modDepth.value / 100);
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
                        <line x1="150" y1="6" x2="150" y2="114" stroke="var(--token-color-rgba-109-179-255-0d2)" strokeWidth="1" />
                        <line x1="10" y1="60" x2="290" y2="60" stroke="var(--token-color-rgba-255-255-255-0d12)" strokeWidth="0.8" />
                        <text x="16" y="20" fill="var(--token-color-rgba-109-179-255-0d45)" fontSize="10" fontFamily="var(--font-role-data)">L</text>
                        <text x="278" y="20" fill="var(--token-color-rgba-109-179-255-0d45)" fontSize="10" fontFamily="var(--font-role-data)">R</text>
                        <path d={`M 10 60 C 60 ${60 - 40 * depthNorm}, 100 ${60 + 40 * depthNorm}, 150 60 C 200 ${60 - 40 * depthNorm}, 240 ${60 + 40 * depthNorm}, 290 60`} fill="none" stroke="var(--token-color-hex-6db3ff)" strokeWidth="2.4" strokeLinecap="round" />
                        <path d={`M 10 60 C 60 ${60 + 40 * depthNorm}, 100 ${60 - 40 * depthNorm}, 150 60 C 200 ${60 + 40 * depthNorm}, 240 ${60 - 40 * depthNorm}, 290 60`} fill="none" stroke="var(--token-color-hex-6db3ff)" strokeWidth="1.6" strokeLinecap="round" opacity="0.35" />
                    </svg>
                </div>
                <div style={{ ...pluginPanelMetaStyle, padding: '0 var(--space-1)' }}>
                    <span>Rate {formatSurfaceParam(modRate)}</span>
                    <span>Depth {formatSurfaceParam(modDepth)}</span>
                </div>
            </div>
            <DryWetSection device={device} handlers={handlers} accent="var(--token-color-hex-6db3ff)" show={showDryWet} />
        </div>
    );
}

function renderPhaserSurface(device: DeviceSlot, handlers: SurfaceHandlers): React.ReactNode {
    const showDryWet = shouldShowDryWet(device);
    const modRate = readSurfaceParam(device, 'rate', 0.5, 'Hz');
    const modDepth = readSurfaceParam(device, 'depth', 60, '%');
    const stages = readSurfaceParam(device, 'stages', 6, '');
    const stageCount = Math.max(2, Math.min(12, Math.round(stages.value)));
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
                        <line x1="4" y1="30" x2="296" y2="30" stroke="var(--token-color-rgba-153-139-255-0d2)" strokeWidth="0.8" />
                        {Array.from({ length: stageCount }).map((_, i) => {
                            const cx = 20 + (i / Math.max(1, stageCount - 1)) * 260;
                            const notchDepth = 30 + (modDepth.value / 100) * 45;
                            return (
                                <React.Fragment key={i}>
                                    <path d={`M ${cx - 14} 30 L ${cx} ${30 + notchDepth} L ${cx + 14} 30`} fill="none" stroke="var(--token-color-hex-998bff)" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
                                    <circle cx={cx} cy={30 + notchDepth} r="3" fill="var(--token-color-hex-998bff)" />
                                </React.Fragment>
                            );
                        })}
                    </svg>
                </div>
                <div style={{ ...pluginPanelMetaStyle, padding: '0 var(--space-1)' }}>
                    <span>{formatSurfaceParam(modRate)}</span>
                    <span>Depth {formatSurfaceParam(modDepth)}</span>
                    <span>{stageCount} stages</span>
                </div>
            </div>
            <DryWetSection device={device} handlers={handlers} accent="var(--token-color-hex-998bff)" show={showDryWet} />
        </div>
    );
}

function renderFlangerSurface(device: DeviceSlot, handlers: SurfaceHandlers): React.ReactNode {
    const showDryWet = shouldShowDryWet(device);
    const modRate = readSurfaceParam(device, 'rate', 0.3, 'Hz');
    const modDepth = readSurfaceParam(device, 'depth', 50, '%');
    const fb = readSurfaceParam(device, ['fb', 'feedback'], 40, '%');
    const fbNorm = clamp01(Math.abs(fb.value) / 100);
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
                        {Array.from({ length: 10 }).map((_, i) => {
                            const x = 16 + i * 27;
                            const peakH = 24 + fbNorm * 60 * Math.pow(0.85, i);
                            return (
                                <React.Fragment key={i}>
                                    <rect x={x} y={106 - peakH} width="14" height={peakH} rx="2" fill={i % 2 === 0 ? 'var(--token-color-hex-66b3ff)' : 'var(--token-color-rgba-102-179-255-0d6)'} />
                                </React.Fragment>
                            );
                        })}
                    </svg>
                </div>
                <div style={{ ...pluginPanelMetaStyle, padding: '0 var(--space-1)' }}>
                    <span>{formatSurfaceParam(modRate)}</span>
                    <span>Depth {formatSurfaceParam(modDepth)}</span>
                    <span>FB {formatSurfaceParam(fb)}</span>
                </div>
            </div>
            <DryWetSection device={device} handlers={handlers} accent="var(--token-color-hex-66b3ff)" show={showDryWet} />
        </div>
    );
}

export function renderModSpatialSurface(device: DeviceSlot, handlers: SurfaceHandlers): React.ReactNode {
    if (device.effectType === 'autoPan') return renderAutoPanSurface(device, handlers);
    if (device.effectType === 'phaser' || device.effectType === 'phaserFlanger') return renderPhaserSurface(device, handlers);
    if (device.effectType === 'flanger') return renderFlangerSurface(device, handlers);
    return null;
}
