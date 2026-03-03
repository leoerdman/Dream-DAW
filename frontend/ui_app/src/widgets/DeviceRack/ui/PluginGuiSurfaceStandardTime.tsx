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
import { renderTimeToneSurface } from '@/widgets/DeviceRack/ui/PluginGuiSurfaceStandardTimeTone';

export function renderStandardTimeSurface(device: DeviceSlot, handlers: SurfaceHandlers): React.ReactNode {

    const normalizedInternalId = getDevicePluginKey(device);

    if (device.effectType === 'delay') {
        const showDryWet = shouldShowDryWet(device);
        const delayTitle = PLUGIN_TITLE_MAP[normalizedInternalId] ?? 'Delay';
        const isBeatRepeat = delayTitle === 'Beat Repeat';
        const isLooper = delayTitle === 'Looper';
        const isSpectralTime = delayTitle === 'Spectral Time';
        const isEcho = normalizedInternalId === 'internal://effect/echo';
        const isSimpleDelay = normalizedInternalId === 'internal://effect/simple-delay';
        const isFilterDelay = normalizedInternalId === 'internal://effect/filter-delay';
        const isGrainDelay = normalizedInternalId === 'internal://effect/grain-delay';
        const timeL = readSurfaceParam(device, ['time l', 'time'], 250, 'ms');
        const timeR = readSurfaceParam(device, 'time r', 375, 'ms');
        const fb = readSurfaceParam(device, 'fb', 30, '%');
        const mix = readMixSurfaceParam(device, 30);
        return (
            <div data-no-drag style={pluginPanelLayoutStyle}>
                <div style={{ ...panelWithOptionalDryWetStyle(showDryWet), background: 'var(--plugin-bg-delay)' }}>
                    <div style={{ display: 'grid', gap: 6 }}>
                        <svg viewBox="0 0 280 52" preserveAspectRatio="xMidYMid slice" style={{ width: '100%', height: '100%' , willChange: 'transform', transform: 'translateZ(0)'}}>
                            <rect x="0" y="0" width="280" height="52" fill="var(--token-color-rgba-14-20-30-0d6)" rx="4" />
                            {!isLooper && !isSpectralTime && !isBeatRepeat && !isEcho && !isSimpleDelay && !isFilterDelay && !isGrainDelay && Array.from({ length: 8 }).map((_, i) => {
                                const x = 12 + i * 32;
                                const h = 24 * Math.pow((fb.value / 100), i);
                                return <rect key={i} x={x} y={26 - h / 2} width="10" height={Math.max(2, h)} fill={i === 0 ? 'var(--token-color-hex-7cc4ff)' : 'var(--token-color-hex-4a9eff)'} opacity={0.95 - i * 0.08} rx="1.5" />;
                            })}
                            {isBeatRepeat && Array.from({ length: 16 }).map((_, i) => {
                                const x = 8 + i * 16;
                                const on = i % 4 === 0 || i % 7 === 0;
                                return <rect key={i} x={x} y={on ? 12 : 18} width="10" height={on ? 28 : 16} fill={on ? 'var(--token-color-hex-78c3ff)' : 'var(--token-color-rgba-120-170-230-0d35)'} rx="2" />;
                            })}
                            {isLooper && (<><circle cx="140" cy="26" r="16" fill="none" stroke="var(--token-color-rgba-124-196-255-0d45)" strokeWidth="2" /><path d="M 140 10 A 16 16 0 1 1 128 16" fill="none" stroke="var(--token-color-hex-7cc4ff)" strokeWidth="3" strokeLinecap="round" /></>)}
                            {isSpectralTime && Array.from({ length: 20 }).map((_, i) => {
                                const x = 6 + i * 13.5;
                                const h = 8 + (Math.sin(i * 0.8) + 1) * 14;
                                return <rect key={i} x={x} y={26 - h / 2} width="8" height={h} fill="var(--token-color-rgba-138-205-255-0d85)" rx="1.5" />;
                            })}
                            {isEcho && (<><path d="M 12 28 C 36 10, 56 10, 80 28" fill="none" stroke="var(--token-color-hex-7cc4ff)" strokeWidth="2.2" strokeLinecap="round" /><path d="M 92 28 C 112 14, 130 14, 150 28" fill="none" stroke="var(--token-color-rgba-124-196-255-0d7)" strokeWidth="2" strokeLinecap="round" /><path d="M 160 28 C 176 18, 192 18, 208 28" fill="none" stroke="var(--token-color-rgba-124-196-255-0d55)" strokeWidth="1.8" strokeLinecap="round" /><path d="M 216 28 C 228 21, 242 21, 254 28" fill="none" stroke="var(--token-color-rgba-124-196-255-0d35)" strokeWidth="1.6" strokeLinecap="round" /></>)}
                            {isSimpleDelay && (<><line x1="16" y1="12" x2="16" y2="40" stroke="var(--token-color-hex-7cc4ff)" strokeWidth="2" /><line x1="88" y1="12" x2="88" y2="40" stroke="var(--token-color-rgba-124-196-255-0d8)" strokeWidth="2" /><line x1="160" y1="12" x2="160" y2="40" stroke="var(--token-color-rgba-124-196-255-0d6)" strokeWidth="2" /><line x1="232" y1="12" x2="232" y2="40" stroke="var(--token-color-rgba-124-196-255-0d4)" strokeWidth="2" /></>)}
                            {isFilterDelay && (<><path d="M 8 40 L 110 40 Q 140 40 158 16 Q 174 6 206 6 L 272 6" fill="none" stroke="var(--token-color-hex-7cc4ff)" strokeWidth="2.1" strokeLinecap="round" /><path d="M 8 12 L 116 12 Q 148 12 168 34 Q 188 46 224 46 L 272 46" fill="none" stroke="var(--token-color-rgba-124-196-255-0d55)" strokeWidth="1.8" strokeLinecap="round" /></>)}
                            {isGrainDelay && Array.from({ length: 18 }).map((_, i) => {
                                const x = 8 + i * 14.8;
                                const y = 10 + ((i * 11) % 28);
                                const size = 3 + ((i * 7) % 4);
                                return <rect key={i} x={x} y={y} width={size} height={size} rx="1" fill="var(--token-color-rgba-138-205-255-0d9)" />;
                            })}
                        </svg>
                        <div style={pluginPanelMetaStyle}>
                            <span>{delayTitle}</span><span>L {formatSurfaceParam(timeL)}</span><span>R {formatSurfaceParam(timeR)}</span><span>FB {formatSurfaceParam(fb)}</span><span>Mix {formatSurfaceParam(mix)}</span>
                        </div>
                    </div>
                    <DryWetSection device={device} handlers={handlers} accent="var(--token-color-hex-7cc4ff)" show={showDryWet} />
                </div>
                <KnobParamGridMemo device={device} handlers={handlers} options={{ omitMixWhenDryWet: showDryWet }} />
            </div>
        );
    }

    if (device.effectType === 'reverb') {
        const showDryWet = shouldShowDryWet(device);
        const reverbTitle = PLUGIN_TITLE_MAP[normalizedInternalId] ?? 'Reverb';
        const isHybridReverb = normalizedInternalId === 'internal://effect/hybrid-reverb';
        const isCorpus = normalizedInternalId === 'internal://effect/corpus';
        const isResonators = normalizedInternalId === 'internal://effect/resonators';
        const isSpectralResonator = normalizedInternalId === 'internal://effect/spectral-resonator';
        const reverbSize = readSurfaceParam(device, ['size', 'decay'], 50, '%');
        const reverbDamp = readSurfaceParam(device, ['damp', 'tone'], 40, '%');
        const mix = readMixSurfaceParam(device, 28);
        const sizeNorm = clamp01(reverbSize.value / 100);
        const tailEnd = 60 + sizeNorm * 200;
        return (
            <div data-no-drag style={pluginPanelLayoutStyle}>
                <div style={{ ...panelWithOptionalDryWetStyle(showDryWet), background: 'var(--plugin-bg-reverb)' }}>
                    <div style={{ display: 'grid', gap: 6 }}>
                        <svg viewBox="0 0 280 52" preserveAspectRatio="xMidYMid slice" style={{ width: '100%', height: '100%' , willChange: 'transform', transform: 'translateZ(0)'}}>
                            <rect x="0" y="0" width="280" height="52" rx="4" fill="var(--token-color-rgba-10-10-12-0d45)" />
                            {isHybridReverb ? (<><path d="M 8 26 C 28 10, 48 42, 68 18 C 88 8, 110 40, 130 22 C 150 12, 174 36, 198 24 C 222 18, 246 30, 270 26" fill="none" stroke="var(--token-color-hex-c891ff)" strokeWidth="2.1" strokeLinecap="round" />{Array.from({ length: 6 }).map((_, i) => <line key={i} x1={20 + i * 40} y1={6} x2={20 + i * 40} y2={46} stroke="var(--token-color-rgba-192-145-255-0d2)" strokeWidth="0.8" strokeDasharray="2,3" />)}</>) : isCorpus || isResonators ? (<>{Array.from({ length: 8 }).map((_, i) => <circle key={i} cx={18 + i * 33} cy={26 + Math.sin(i * 0.7) * 6} r={4 + (i % 3)} fill="none" stroke="var(--token-color-rgba-192-145-255-0d45)" strokeWidth="1" />)}<path d="M 8 26 L 272 26" fill="none" stroke="var(--token-color-rgba-192-145-255-0d28)" strokeWidth="1" /></>) : isSpectralResonator ? (<>{Array.from({ length: 22 }).map((_, i) => { const x = 8 + i * 12.3; const h = 8 + ((i * 11) % 30); return <rect key={i} x={x} y={44 - h} width="7" height={h} rx="1.2" fill="var(--token-color-rgba-200-155-255-0d9)" />; })}</>) : (<><path d={`M 12 26 L 18 8 C 30 10, ${tailEnd * 0.3} ${14 + (1 - sizeNorm) * 12}, ${tailEnd * 0.6} ${22 + (1 - sizeNorm) * 4} C ${tailEnd * 0.8} ${24 + (1 - sizeNorm) * 2}, ${tailEnd} 26, ${Math.min(270, tailEnd + 20)} 26`} fill="none" stroke="var(--token-color-hex-c891ff)" strokeWidth="2.4" strokeLinecap="round" /><path d={`M 12 26 L 18 44 C 30 42, ${tailEnd * 0.3} ${38 - (1 - sizeNorm) * 12}, ${tailEnd * 0.6} ${30 - (1 - sizeNorm) * 4} C ${tailEnd * 0.8} ${28 - (1 - sizeNorm) * 2}, ${tailEnd} 26, ${Math.min(270, tailEnd + 20)} 26`} fill="none" stroke="var(--token-color-hex-c891ff)" strokeWidth="2.4" strokeLinecap="round" opacity="0.5" />{Array.from({ length: 4 }).map((_, i) => <circle key={i} cx={40 + sizeNorm * 30 + i * (35 + sizeNorm * 15)} cy="26" r={6 + i * 4} fill="none" stroke="var(--token-color-rgba-192-145-255-0d25)" strokeWidth="0.8" />)}</>)}
                        </svg>
                        <div style={pluginPanelMetaStyle}>
                            <span>{reverbTitle}</span><span>Size {formatSurfaceParam(reverbSize)}</span><span>Damp {formatSurfaceParam(reverbDamp)}</span><span>Mix {formatSurfaceParam(mix)}</span>
                        </div>
                    </div>
                    <DryWetSection device={device} handlers={handlers} accent="var(--token-color-hex-c891ff)" show={showDryWet} />
                </div>
                <KnobParamGridMemo device={device} handlers={handlers} options={{ omitMixWhenDryWet: showDryWet }} />
            </div>
        );
    }

    return renderTimeToneSurface(device, handlers);
}
