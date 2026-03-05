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

function renderChorusSurface(device: DeviceSlot, handlers: SurfaceHandlers): React.ReactNode {
    const showDryWet = shouldShowDryWet(device);
    const rate = readSurfaceParam(device, 'rate', 1.2, 'Hz');
    const depth = readSurfaceParam(device, 'depth', 40, '%');
    const depthNorm = clamp01(depth.value / 100);
    const knobParams = buildSurfaceKnobParams(device, { omitMixWhenDryWet: showDryWet });

    return (
        <div data-no-drag style={{ display: 'flex', gap: 'var(--space-1-5)', height: '100%' }}>
            {/* Left control panel */}
            <div style={{ width: 130, flexShrink: 0, display: 'flex', flexDirection: 'column', gap: 'var(--space-1)' }}>
                <div style={{ ...pluginPanelCardBaseStyle, padding: 'var(--space-1)', display: 'block', height: 'fit-content' }}>
                    <KnobParamGrid params={knobParams} handlers={handlers} maxCols={2} minCols={2} />
                </div>
            </div>
            {/* Right: Chorus wave visualization */}
            <div style={{ flex: 1, display: 'flex', flexDirection: 'column', gap: 'var(--space-1)' }}>
                <div style={{ ...pluginPanelCardBaseStyle, background: 'var(--plugin-bg-chorus)', overflow: 'hidden', padding: 0, flex: 1 }}>
                    <svg width="100%" height="100%" viewBox="0 0 300 120" preserveAspectRatio="xMidYMid slice" style={{ display: 'block', willChange: 'transform', transform: 'translateZ(0)' }}>
                        <rect x="0" y="0" width="300" height="120" rx="0" fill="var(--token-color-rgba-12-11-18-0d65)" />
                        {/* Grid lines */}
                        <line x1="10" y1="60" x2="290" y2="60" stroke="var(--token-color-rgba-255-255-255-0d12)" strokeWidth="0.8" />
                        {[30, 90].map(y => <line key={y} x1="10" y1={y} x2="290" y2={y} stroke="var(--token-color-rgba-255-255-255-0d06)" strokeWidth="0.5" />)}
                        {/* Chorus wave 1 */}
                        <path d={`M 0 60 C 50 ${60 - 36 * depthNorm}, 100 ${60 + 36 * depthNorm}, 150 60 C 200 ${60 - 36 * depthNorm}, 250 ${60 + 36 * depthNorm}, 300 60`} fill="none" stroke="var(--token-color-hex-c867ff)" strokeWidth="2.2" />
                        {/* Chorus wave 2 (offset) */}
                        <path d={`M 0 60 C 50 ${60 + 30 * depthNorm}, 100 ${60 - 30 * depthNorm}, 150 60 C 200 ${60 + 30 * depthNorm}, 250 ${60 - 30 * depthNorm}, 300 60`} fill="none" stroke="var(--token-color-hex-4ac0ff)" strokeWidth="2.2" opacity="0.9" />
                        {/* Ghost wave */}
                        <path d={`M 0 60 C 30 ${60 - 22 * depthNorm}, 70 ${60 + 22 * depthNorm}, 110 60 C 150 ${60 - 22 * depthNorm}, 190 ${60 + 22 * depthNorm}, 230 60 C 270 ${60 - 22 * depthNorm}, 300 ${60 + 22 * depthNorm}, 300 60`} fill="none" stroke="var(--token-color-rgba-200-140-255-0d45)" strokeWidth="1.8" />
                    </svg>
                </div>
                <div style={{ ...pluginPanelMetaStyle, padding: '0 var(--space-1)' }}>
                    <span>{formatSurfaceParam(rate)}</span>
                    <span>Depth {formatSurfaceParam(depth)}</span>
                </div>
            </div>
            <DryWetSection device={device} handlers={handlers} accent="var(--token-color-hex-c867ff)" show={showDryWet} />
        </div>
    );
}

function renderSaturatorSurface(device: DeviceSlot, handlers: SurfaceHandlers): React.ReactNode {
    const normalizedInternalId = getDevicePluginKey(device);
    const showDryWet = shouldShowDryWet(device);
    const isDrumBuss = normalizedInternalId === 'internal://effect/drum-buss';
    const isDynamicTube = normalizedInternalId === 'internal://effect/dynamic-tube';
    const driveParam = readSurfaceParam(device, 'drive', 3, 'dB');
    const driveClamp = Math.max(0, Math.min(24, driveParam.value));
    const knee = Math.max(12, Math.min(68, 80 - driveClamp * 2.8));
    const knobParams = buildSurfaceKnobParams(device, { omitMixWhenDryWet: showDryWet });

    return (
        <div data-no-drag style={{ display: 'flex', gap: 'var(--space-1-5)', height: '100%' }}>
            <div style={{ width: 130, flexShrink: 0, display: 'flex', flexDirection: 'column', gap: 'var(--space-1)' }}>
                <div style={{ ...pluginPanelCardBaseStyle, padding: 'var(--space-1)', display: 'block', height: 'fit-content' }}>
                    <KnobParamGrid params={knobParams} handlers={handlers} maxCols={2} minCols={2} />
                </div>
            </div>
            <div style={{ flex: 1, display: 'flex', flexDirection: 'column', gap: 'var(--space-1)' }}>
                <div style={{ ...pluginPanelCardBaseStyle, background: 'var(--plugin-bg-saturator)', overflow: 'hidden', padding: 0, flex: 1 }}>
                    <svg width="100%" height="100%" viewBox="0 0 280 120" preserveAspectRatio="xMidYMid slice" style={{ display: 'block', willChange: 'transform', transform: 'translateZ(0)' }}>
                        <rect x="0" y="0" width="280" height="120" fill="var(--token-color-rgba-20-13-9-0d7)" />
                        <line x1="10" y1="60" x2="270" y2="60" stroke="var(--token-color-rgba-255-255-255-0d12)" strokeWidth="0.8" />
                        {!isDrumBuss && !isDynamicTube && (
                            <>
                                <line x1="14" y1="106" x2="266" y2="14" stroke="var(--token-color-rgba-255-172-89-0d18)" strokeWidth="1" strokeDasharray="3,3" />
                                <path d={`M 14 106 C ${knee + 14} 106, ${140 - knee / 2} 14, 140 14 C ${140 + knee / 2} 14, ${266 - knee} 106, 266 106`} fill="none" stroke="var(--token-color-hex-ffac59)" strokeWidth={Math.max(2, 2 + driveClamp / 8)} strokeLinecap="round" />
                            </>
                        )}
                        {isDrumBuss && Array.from({ length: 12 }).map((_, i) => {
                            const x = 12 + i * 21;
                            const h = 16 + ((i * 7) % 52);
                            return <rect key={i} x={x} y={106 - h} width="14" height={h} rx="2" fill="var(--token-color-rgba-255-172-89-0d82)" />;
                        })}
                        {isDynamicTube && (
                            <>
                                <ellipse cx="80" cy="60" rx="36" ry="28" fill="none" stroke="var(--token-color-rgba-255-198-120-0d6)" strokeWidth="1.5" />
                                <ellipse cx="200" cy="60" rx="36" ry="28" fill="none" stroke="var(--token-color-rgba-255-198-120-0d45)" strokeWidth="1.5" />
                                <path d="M 44 60 L 116 60 M 164 60 L 236 60" stroke="var(--token-color-rgba-255-198-120-0d55)" strokeWidth="1.2" />
                            </>
                        )}
                    </svg>
                </div>
                <div style={{ ...pluginPanelMetaStyle, padding: '0 var(--space-1)' }}>
                    <span>Drive {formatSurfaceParam(driveParam)}</span>
                </div>
            </div>
            <DryWetSection device={device} handlers={handlers} accent="var(--token-color-hex-ffac59)" show={showDryWet} />
        </div>
    );
}

export function renderTimeToneSurface(device: DeviceSlot, handlers: SurfaceHandlers): React.ReactNode {
    if (device.effectType === 'chorus') return renderChorusSurface(device, handlers);
    if (device.effectType === 'saturator' || device.effectType === 'drumBuss' || device.effectType === 'dynamicTube') return renderSaturatorSurface(device, handlers);
    return null;
}
