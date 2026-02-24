// ═══════════════════════════════════════════════════════════════════════════
// Dream DAW — Plugin Surfaces: Time-based Effects
// Handles: delay, reverb, chorus, saturator
// Each effect has unique SVG visualization + Dry/Wet knob on right side.
// ═══════════════════════════════════════════════════════════════════════════
import React from 'react';
import { PluginKnob } from '@/widgets/DeviceRack/StandardPluginControls';
import { pluginPanelKnobGrid } from '@/widgets/DeviceRack/ui/styles';
import { DryWetKnob } from '@/widgets/DeviceRack/ui/DryWetKnob';
import { normalizeInternalPluginId } from '@/shared/lib/internalPlugins';
import type { DeviceSlot } from '@/widgets/DeviceRack/model/types';
import {
    buildSurfaceKnobParams,
    formatSurfaceParam,
    pluginPanelCardBaseStyle,
    pluginPanelLayoutStyle,
    pluginPanelMetaStyle,
    readMixSurfaceParam,
    readSurfaceParam,
    shouldShowDryWet,
    PLUGIN_TITLE_MAP,
    type SurfaceHandlers,
} from '@/widgets/DeviceRack/ui/PluginGuiSurfaceStandardShared';

/* ── Shared layout with DryWet on right ── */
const panelWithDryWet: React.CSSProperties = {
    ...pluginPanelCardBaseStyle,
    display: 'grid',
    gridTemplateColumns: '1fr auto',
    gap: 'var(--space-2-5)',
    alignItems: 'center',
};

const panelWithOptionalDryWet = (showDryWet: boolean): React.CSSProperties => ({
    ...panelWithDryWet,
    gridTemplateColumns: showDryWet ? '1fr auto' : '1fr',
});


export function renderStandardTimeSurface(device: DeviceSlot, handlers: SurfaceHandlers): React.ReactNode {
    const { onParamChange, onParamGestureStart, onParamGestureEnd } = handlers;
    const normalizedInternalId = normalizeInternalPluginId(device.pluginId || (device.guiMode || '').toLowerCase() || device.name.toLowerCase());

    /* ═════════════════════════════════════════════════════════════════ */
    /* DELAY                                                           */
    /* ═════════════════════════════════════════════════════════════════ */
    if (device.effectType === 'delay') {
        const showDryWet = shouldShowDryWet(device);
        const knobParams = buildSurfaceKnobParams(device, { omitMixWhenDryWet: showDryWet });
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
                <div style={{ ...panelWithOptionalDryWet(showDryWet), background: 'var(--plugin-bg-delay)' }}>
                    <div style={{ display: 'grid', gap: 6 }}>
                        <svg viewBox="0 0 280 52" preserveAspectRatio="none" style={{ width: '100%', height: '100%' }}>
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
                            {isLooper && (
                                <>
                                    <circle cx="140" cy="26" r="16" fill="none" stroke="var(--token-color-rgba-124-196-255-0d45)" strokeWidth="2" />
                                    <path d="M 140 10 A 16 16 0 1 1 128 16" fill="none" stroke="var(--token-color-hex-7cc4ff)" strokeWidth="3" strokeLinecap="round" />
                                </>
                            )}
                            {isSpectralTime && Array.from({ length: 20 }).map((_, i) => {
                                const x = 6 + i * 13.5;
                                const h = 8 + (Math.sin(i * 0.8) + 1) * 14;
                                return <rect key={i} x={x} y={26 - h / 2} width="8" height={h} fill="var(--token-color-rgba-138-205-255-0d85)" rx="1.5" />;
                            })}
                            {isEcho && (
                                <>
                                    <path d="M 12 28 C 36 10, 56 10, 80 28" fill="none" stroke="var(--token-color-hex-7cc4ff)" strokeWidth="2.2" strokeLinecap="round" />
                                    <path d="M 92 28 C 112 14, 130 14, 150 28" fill="none" stroke="var(--token-color-rgba-124-196-255-0d7)" strokeWidth="2" strokeLinecap="round" />
                                    <path d="M 160 28 C 176 18, 192 18, 208 28" fill="none" stroke="var(--token-color-rgba-124-196-255-0d55)" strokeWidth="1.8" strokeLinecap="round" />
                                    <path d="M 216 28 C 228 21, 242 21, 254 28" fill="none" stroke="var(--token-color-rgba-124-196-255-0d35)" strokeWidth="1.6" strokeLinecap="round" />
                                </>
                            )}
                            {isSimpleDelay && (
                                <>
                                    <line x1="16" y1="12" x2="16" y2="40" stroke="var(--token-color-hex-7cc4ff)" strokeWidth="2" />
                                    <line x1="88" y1="12" x2="88" y2="40" stroke="var(--token-color-rgba-124-196-255-0d8)" strokeWidth="2" />
                                    <line x1="160" y1="12" x2="160" y2="40" stroke="var(--token-color-rgba-124-196-255-0d6)" strokeWidth="2" />
                                    <line x1="232" y1="12" x2="232" y2="40" stroke="var(--token-color-rgba-124-196-255-0d4)" strokeWidth="2" />
                                </>
                            )}
                            {isFilterDelay && (
                                <>
                                    <path d="M 8 40 L 110 40 Q 140 40 158 16 Q 174 6 206 6 L 272 6" fill="none" stroke="var(--token-color-hex-7cc4ff)" strokeWidth="2.1" strokeLinecap="round" />
                                    <path d="M 8 12 L 116 12 Q 148 12 168 34 Q 188 46 224 46 L 272 46" fill="none" stroke="var(--token-color-rgba-124-196-255-0d55)" strokeWidth="1.8" strokeLinecap="round" />
                                </>
                            )}
                            {isGrainDelay && Array.from({ length: 18 }).map((_, i) => {
                                const x = 8 + i * 14.8;
                                const y = 10 + ((i * 11) % 28);
                                const size = 3 + ((i * 7) % 4);
                                return <rect key={i} x={x} y={y} width={size} height={size} rx="1" fill="var(--token-color-rgba-138-205-255-0d9)" />;
                            })}
                        </svg>
                        <div style={pluginPanelMetaStyle}>
                            <span>{delayTitle}</span>
                            <span>L {formatSurfaceParam(timeL)}</span>
                            <span>R {formatSurfaceParam(timeR)}</span>
                            <span>FB {formatSurfaceParam(fb)}</span>
                            <span>Mix {formatSurfaceParam(mix)}</span>
                        </div>
                    </div>
                    {showDryWet && (
                        <DryWetKnob
                            device={device}
                            onChange={onParamChange}
                            onGestureStart={onParamGestureStart}
                            onGestureEnd={onParamGestureEnd}
                            accent="var(--token-color-hex-7cc4ff)"
                        />
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

    /* ═════════════════════════════════════════════════════════════════ */
    /* REVERB — Enhanced: decay tail waveform + diffusion circles       */
    /* ═════════════════════════════════════════════════════════════════ */
    if (device.effectType === 'reverb') {
        const showDryWet = shouldShowDryWet(device);
        const knobParams = buildSurfaceKnobParams(device, { omitMixWhenDryWet: showDryWet });
        const reverbTitle = PLUGIN_TITLE_MAP[normalizedInternalId] ?? 'Reverb';
        const isHybridReverb = normalizedInternalId === 'internal://effect/hybrid-reverb';
        const isCorpus = normalizedInternalId === 'internal://effect/corpus';
        const isResonators = normalizedInternalId === 'internal://effect/resonators';
        const isSpectralResonator = normalizedInternalId === 'internal://effect/spectral-resonator';
        const reverbSize = readSurfaceParam(device, ['size', 'decay'], 50, '%');
        const reverbDamp = readSurfaceParam(device, ['damp', 'tone'], 40, '%');
        const mix = readMixSurfaceParam(device, 28);
        const sizeNorm = Math.max(0, Math.min(1, reverbSize.value / 100));
        // Decay tail length based on size
        const tailEnd = 60 + sizeNorm * 200;
        return (
            <div data-no-drag style={pluginPanelLayoutStyle}>
                <div style={{ ...panelWithOptionalDryWet(showDryWet), background: 'var(--plugin-bg-reverb)' }}>
                    <div style={{ display: 'grid', gap: 6 }}>
                        <svg viewBox="0 0 280 52" preserveAspectRatio="none" style={{ width: '100%', height: '100%' }}>
                            <rect x="0" y="0" width="280" height="52" rx="4" fill="var(--token-color-rgba-10-10-12-0d45)" />
                            {isHybridReverb ? (
                                <>
                                    <path
                                        d="M 8 26 C 28 10, 48 42, 68 18 C 88 8, 110 40, 130 22 C 150 12, 174 36, 198 24 C 222 18, 246 30, 270 26"
                                        fill="none"
                                        stroke="var(--token-color-hex-c891ff)"
                                        strokeWidth="2.1"
                                        strokeLinecap="round"
                                    />
                                    {Array.from({ length: 6 }).map((_, i) => (
                                        <line
                                            key={i}
                                            x1={20 + i * 40}
                                            y1={6}
                                            x2={20 + i * 40}
                                            y2={46}
                                            stroke="var(--token-color-rgba-192-145-255-0d2)"
                                            strokeWidth="0.8"
                                            strokeDasharray="2,3"
                                        />
                                    ))}
                                </>
                            ) : isCorpus || isResonators ? (
                                <>
                                    {Array.from({ length: 8 }).map((_, i) => (
                                        <circle
                                            key={i}
                                            cx={18 + i * 33}
                                            cy={26 + Math.sin(i * 0.7) * 6}
                                            r={4 + (i % 3)}
                                            fill="none"
                                            stroke="var(--token-color-rgba-192-145-255-0d45)"
                                            strokeWidth="1"
                                        />
                                    ))}
                                    <path d="M 8 26 L 272 26" fill="none" stroke="var(--token-color-rgba-192-145-255-0d28)" strokeWidth="1" />
                                </>
                            ) : isSpectralResonator ? (
                                <>
                                    {Array.from({ length: 22 }).map((_, i) => {
                                        const x = 8 + i * 12.3;
                                        const h = 8 + ((i * 11) % 30);
                                        return <rect key={i} x={x} y={44 - h} width="7" height={h} rx="1.2" fill="var(--token-color-rgba-200-155-255-0d9)" />;
                                    })}
                                </>
                            ) : (
                                <>
                                    <path
                                        d={`M 12 26 L 18 8 C 30 10, ${tailEnd * 0.3} ${14 + (1 - sizeNorm) * 12}, ${tailEnd * 0.6} ${22 + (1 - sizeNorm) * 4} C ${tailEnd * 0.8} ${24 + (1 - sizeNorm) * 2}, ${tailEnd} 26, ${Math.min(270, tailEnd + 20)} 26`}
                                        fill="none"
                                        stroke="var(--token-color-hex-c891ff)"
                                        strokeWidth="2.4"
                                        strokeLinecap="round"
                                    />
                                    <path
                                        d={`M 12 26 L 18 44 C 30 42, ${tailEnd * 0.3} ${38 - (1 - sizeNorm) * 12}, ${tailEnd * 0.6} ${30 - (1 - sizeNorm) * 4} C ${tailEnd * 0.8} ${28 - (1 - sizeNorm) * 2}, ${tailEnd} 26, ${Math.min(270, tailEnd + 20)} 26`}
                                        fill="none"
                                        stroke="var(--token-color-hex-c891ff)"
                                        strokeWidth="2.4"
                                        strokeLinecap="round"
                                        opacity="0.5"
                                    />
                                    {Array.from({ length: 4 }).map((_, i) => (
                                        <circle
                                            key={i}
                                            cx={40 + sizeNorm * 30 + i * (35 + sizeNorm * 15)}
                                            cy="26"
                                            r={6 + i * 4}
                                            fill="none"
                                            stroke="var(--token-color-rgba-192-145-255-0d25)"
                                            strokeWidth="0.8"
                                        />
                                    ))}
                                </>
                            )}
                        </svg>
                        <div style={pluginPanelMetaStyle}>
                            <span>{reverbTitle}</span>
                            <span>Size {formatSurfaceParam(reverbSize)}</span>
                            <span>Damp {formatSurfaceParam(reverbDamp)}</span>
                            <span>Mix {formatSurfaceParam(mix)}</span>
                        </div>
                    </div>
                    {showDryWet && (
                        <DryWetKnob
                            device={device}
                            onChange={onParamChange}
                            onGestureStart={onParamGestureStart}
                            onGestureEnd={onParamGestureEnd}
                            accent="var(--token-color-hex-c891ff)"
                        />
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

    /* ═════════════════════════════════════════════════════════════════ */
    /* CHORUS                                                           */
    /* ═════════════════════════════════════════════════════════════════ */
    if (device.effectType === 'chorus') {
        const showDryWet = shouldShowDryWet(device);
        const knobParams = buildSurfaceKnobParams(device, { omitMixWhenDryWet: showDryWet });
        const rate = readSurfaceParam(device, 'rate', 1.2, 'Hz');
        const depth = readSurfaceParam(device, 'depth', 40, '%');
        const mix = readMixSurfaceParam(device, 35);
        const depthNorm = Math.max(0, Math.min(1, depth.value / 100));
        return (
            <div data-no-drag style={pluginPanelLayoutStyle}>
                <div style={{ ...panelWithOptionalDryWet(showDryWet), background: 'var(--plugin-bg-chorus)' }}>
                    <div style={{ display: 'grid', gap: 6 }}>
                        <svg viewBox="0 0 280 52" preserveAspectRatio="none" style={{ width: '100%', height: '100%' }}>
                            <rect x="0" y="0" width="280" height="52" rx="4" fill="var(--token-color-rgba-12-11-18-0d65)" />
                            {/* 3 voice waves — each with slightly different phase */}
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
                    {showDryWet && (
                        <DryWetKnob
                            device={device}
                            onChange={onParamChange}
                            onGestureStart={onParamGestureStart}
                            onGestureEnd={onParamGestureEnd}
                            accent="var(--token-color-hex-c867ff)"
                        />
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

    /* ═════════════════════════════════════════════════════════════════ */
    /* SATURATOR                                                        */
    /* ═════════════════════════════════════════════════════════════════ */
    if (device.effectType === 'saturator') {
        const showDryWet = shouldShowDryWet(device);
        const knobParams = buildSurfaceKnobParams(device, { omitMixWhenDryWet: showDryWet });
        const satTitle = PLUGIN_TITLE_MAP[normalizedInternalId] ?? 'Saturator';
        const isDrumBuss = normalizedInternalId === 'internal://effect/drum-buss';
        const isDynamicTube = normalizedInternalId === 'internal://effect/dynamic-tube';
        const driveParam = readSurfaceParam(device, 'drive', 3, 'dB');
        const satToneParam = readSurfaceParam(device, 'tone', 0, '%');
        const mix = readMixSurfaceParam(device, 86);
        const drive = driveParam.value;
        const satTone = satToneParam.value;
        const driveClamp = Math.max(0, Math.min(24, drive));
        // BUG-P6 FIX: Clamp knee to [12, 68] to prevent SVG control points from crossing.
        const knee = Math.max(12, Math.min(68, 80 - driveClamp * 2.8));
        return (
            <div data-no-drag style={pluginPanelLayoutStyle}>
                <div style={{ ...panelWithOptionalDryWet(showDryWet), background: 'var(--plugin-bg-saturator)' }}>
                    <div style={{ display: 'grid', gap: 6 }}>
                        <svg viewBox="0 0 280 52" preserveAspectRatio="none" style={{ width: '100%', height: '100%' }}>
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
                            {satTone !== 0 && <span>Tone {formatSurfaceParam(satToneParam)}</span>}
                            <span>Mix {formatSurfaceParam(mix)}</span>
                        </div>
                    </div>
                    {showDryWet && (
                        <DryWetKnob
                            device={device}
                            onChange={onParamChange}
                            onGestureStart={onParamGestureStart}
                            onGestureEnd={onParamGestureEnd}
                            accent="var(--token-color-hex-ffac59)"
                        />
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

    return null;
}
