import { clamp01 } from '@/shared/lib/audioMath';
import type { DeviceSlot } from '@/widgets/DeviceRack/model/types';
import {
    DryWetSection,
    formatSurfaceParam,
    getDevicePluginKey,
    KnobParamGridMemo,
    panelWithOptionalDryWetStyle,
    pluginPanelLayoutStyle,
    pluginPanelMetaStyle,
    readMixSurfaceParam,
    readSurfaceParam,
    shouldShowDryWet,
    PLUGIN_TITLE_MAP,
    type SurfaceHandlers,
} from '@/widgets/DeviceRack/ui/PluginGuiSurfaceStandardShared';

function renderChorusSurface(device: DeviceSlot, handlers: SurfaceHandlers): React.ReactNode {
    const showDryWet = shouldShowDryWet(device);
    const rate = readSurfaceParam(device, 'rate', 1.2, 'Hz');
    const depth = readSurfaceParam(device, 'depth', 40, '%');
    const mix = readMixSurfaceParam(device, 35);
    const depthNorm = clamp01(depth.value / 100);
    return (
        <div data-no-drag style={pluginPanelLayoutStyle}>
            <div style={{ ...panelWithOptionalDryWetStyle(showDryWet), background: 'var(--plugin-bg-chorus)' }}>
                <div style={{ display: 'grid', gap: 6 }}>
                    <svg viewBox="0 0 280 52" preserveAspectRatio="xMidYMid meet" style={{ width: '100%', height: '100%', willChange: 'transform', transform: 'translateZ(0)' }}>
                        <rect x="0" y="0" width="280" height="52" rx="4" fill="var(--token-color-rgba-12-11-18-0d65)" />
                        <path d={`M 0 26 C 35 ${26 - 16 * depthNorm}, 70 ${26 + 16 * depthNorm}, 105 26 C 140 ${26 - 16 * depthNorm}, 175 ${26 + 16 * depthNorm}, 210 26 C 245 ${26 - 16 * depthNorm}, 280 ${26 + 16 * depthNorm}, 280 26`} fill="none" stroke="var(--token-color-hex-c867ff)" strokeWidth="2.2" />
                        <path d={`M 0 26 C 35 ${26 + 14 * depthNorm}, 70 ${26 - 14 * depthNorm}, 105 26 C 140 ${26 + 14 * depthNorm}, 175 ${26 - 14 * depthNorm}, 210 26 C 245 ${26 + 14 * depthNorm}, 280 ${26 - 14 * depthNorm}, 280 26`} fill="none" stroke="var(--token-color-hex-4ac0ff)" strokeWidth="2.2" opacity="0.9" />
                        <path d={`M 0 26 C 20 ${26 - 10 * depthNorm}, 50 ${26 + 10 * depthNorm}, 80 26 C 110 ${26 - 10 * depthNorm}, 140 ${26 + 10 * depthNorm}, 170 26 C 200 ${26 - 10 * depthNorm}, 230 ${26 + 10 * depthNorm}, 260 26`} fill="none" stroke="var(--token-color-rgba-200-140-255-0d45)" strokeWidth="1.8" />
                    </svg>
                    <div style={pluginPanelMetaStyle}>
                        <span>Chorus</span>
                        <span>{formatSurfaceParam(rate)}</span>
                        <span>Depth {formatSurfaceParam(depth)}</span>
                        <span>Mix {formatSurfaceParam(mix)}</span>
                    </div>
                </div>
                <DryWetSection device={device} handlers={handlers} accent="var(--token-color-hex-c867ff)" show={showDryWet} />
            </div>
            <KnobParamGridMemo device={device} handlers={handlers} options={{ omitMixWhenDryWet: showDryWet }} />
        </div>
    );
}

function renderSaturatorSurface(device: DeviceSlot, handlers: SurfaceHandlers): React.ReactNode {
    const normalizedInternalId = getDevicePluginKey(device);
    const showDryWet = shouldShowDryWet(device);
    const satTitle = PLUGIN_TITLE_MAP[normalizedInternalId] ?? 'Saturator';
    const isDrumBuss = normalizedInternalId === 'internal://effect/drum-buss';
    const isDynamicTube = normalizedInternalId === 'internal://effect/dynamic-tube';
    const driveParam = readSurfaceParam(device, 'drive', 3, 'dB');
    const satToneParam = readSurfaceParam(device, 'tone', 0, '%');
    const mix = readMixSurfaceParam(device, 86);
    const driveClamp = Math.max(0, Math.min(24, driveParam.value));
    const knee = Math.max(12, Math.min(68, 80 - driveClamp * 2.8));
    return (
        <div data-no-drag style={pluginPanelLayoutStyle}>
            <div style={{ ...panelWithOptionalDryWetStyle(showDryWet), background: 'var(--plugin-bg-saturator)' }}>
                <div style={{ display: 'grid', gap: 6 }}>
                    <svg viewBox="0 0 280 52" preserveAspectRatio="xMidYMid meet" style={{ width: '100%', height: '100%', willChange: 'transform', transform: 'translateZ(0)' }}>
                        <rect x="0" y="0" width="280" height="52" rx="4" fill="var(--token-color-rgba-20-13-9-0d7)" />
                        {!isDrumBuss && !isDynamicTube && (
                            <>
                                <line x1="12" y1="46" x2="268" y2="6" stroke="var(--token-color-rgba-255-172-89-0d18)" strokeWidth="1" strokeDasharray="3,3" />
                                <path d={`M 12 46 C ${knee} 46, ${140 - knee / 2} 6, 140 6 C ${140 + knee / 2} 6, ${280 - knee} 46, 268 46`} fill="none" stroke="var(--token-color-hex-ffac59)" strokeWidth={Math.max(2, 2 + driveClamp / 8)} strokeLinecap="round" />
                            </>
                        )}
                        {isDrumBuss && Array.from({ length: 12 }).map((_, i) => {
                            const x = 10 + i * 21.5;
                            const h = 8 + ((i * 7) % 26);
                            return <rect key={i} x={x} y={44 - h} width="12" height={h} rx="2" fill="var(--token-color-rgba-255-172-89-0d82)" />;
                        })}
                        {isDynamicTube && (
                            <>
                                <ellipse cx="90" cy="26" rx="36" ry="18" fill="none" stroke="var(--token-color-rgba-255-172-89-0d6)" strokeWidth="1.5" />
                                <ellipse cx="190" cy="26" rx="36" ry="18" fill="none" stroke="var(--token-color-rgba-255-172-89-0d6)" strokeWidth="1.5" />
                                <path d="M 54 26 L 126 26 M 154 26 L 226 26" stroke="var(--token-color-rgba-255-172-89-0d55)" strokeWidth="1.2" />
                            </>
                        )}
                    </svg>
                    <div style={pluginPanelMetaStyle}>
                        <span>{satTitle}</span>
                        <span>Drive {formatSurfaceParam(driveParam)}</span>
                        {satToneParam.value !== 0 && <span>Tone {formatSurfaceParam(satToneParam)}</span>}
                        <span>Mix {formatSurfaceParam(mix)}</span>
                    </div>
                </div>
                <DryWetSection device={device} handlers={handlers} accent="var(--token-color-hex-ffac59)" show={showDryWet} />
            </div>
            <KnobParamGridMemo device={device} handlers={handlers} options={{ omitMixWhenDryWet: showDryWet }} />
        </div>
    );
}

export function renderTimeToneSurface(device: DeviceSlot, handlers: SurfaceHandlers): React.ReactNode {
    if (device.effectType === 'chorus') return renderChorusSurface(device, handlers);
    if (device.effectType === 'saturator' || device.effectType === 'drumBuss' || device.effectType === 'dynamicTube') return renderSaturatorSurface(device, handlers);
    return null;
}
