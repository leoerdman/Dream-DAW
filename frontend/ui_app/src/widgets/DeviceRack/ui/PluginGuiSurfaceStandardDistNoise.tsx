// ═══════════════════════════════════════════════════════════════════════════
// Dream DAW — Plugin Surfaces: Distortion / Noise
// Handles: distortion, bitcrusher, noiseMachine
// Each effect has unique SVG visualization + Dry/Wet knob on right side.
// ═══════════════════════════════════════════════════════════════════════════
import type { DeviceSlot } from '@/widgets/DeviceRack/model/types';
import {
    DryWetSection,
    formatSurfaceParam,
    getDevicePluginKey,
    KnobParamGrid,
    panelWithOptionalDryWetStyle,
    pluginPanelCardBaseStyle,
    pluginPanelLayoutStyle,
    pluginPanelMetaStyle,
    pluginPanelTitleStyle,
    readSurfaceParam,
    safeParamValue,
    shouldShowDryWet,
    PLUGIN_TITLE_MAP,
    type SurfaceHandlers,
} from '@/widgets/DeviceRack/ui/PluginGuiSurfaceStandardShared';



export function renderStandardDistNoiseSurface(
    device: DeviceSlot,
    handlers: SurfaceHandlers,
): React.ReactNode {
    const normalizedInternalId = getDevicePluginKey(device);

    /* ═════════════════════════════════════════════════════════════════ */
    /* DISTORTION / BITCRUSHER                                          */
    /* ═════════════════════════════════════════════════════════════════ */
    if (device.effectType === 'distortion' || device.effectType === 'bitcrusher') {
        const showDryWet = shouldShowDryWet(device);
        const title = device.effectType === 'bitcrusher'
            ? 'Bitcrusher'
            : (PLUGIN_TITLE_MAP[normalizedInternalId] ?? 'Distortion');
        const color = device.effectType === 'distortion' ? 'var(--token-color-hex-ff965e)' : 'var(--token-color-hex-f2de72)';
        const drive = readSurfaceParam(device, 'drive', 0, 'dB');
        const tone = readSurfaceParam(device, 'tone', 0, '%');
        const isAmp = title === 'Amp';
        const isCabinet = title === 'Cabinet';
        const isErosion = title === 'Erosion';
        const isOverdrive = title === 'Overdrive';
        const isPedal = title === 'Pedal';
        const isRoar = title === 'Roar';
        const isDrumBuss = title === 'Drum Buss';
        const isDynamicTube = title === 'Dynamic Tube';
        const isBit = title === 'Bitcrusher';
        return (
            <div data-no-drag style={pluginPanelLayoutStyle}>
                <div style={{ ...panelWithOptionalDryWetStyle(showDryWet), background: 'var(--plugin-bg-distortion)' }}>
                    <div style={{ display: 'grid', gap: 6 }}>
                        <div style={{ ...pluginPanelTitleStyle, color: 'var(--token-color-hex-d6c1a5)' }}>{title}</div>
                        <svg viewBox="0 0 280 52" preserveAspectRatio="none" style={{ width: '100%', height: 44 }}>
                            <rect x="0" y="0" width="280" height="52" rx="4" fill="var(--token-color-rgba-20-13-9-0d65)" />
                            {!isAmp && !isCabinet && !isErosion && !isOverdrive && !isPedal && !isRoar && !isDrumBuss && !isDynamicTube && !isBit && (
                                <path d="M 8 44 L 42 12 L 78 44 L 112 12 L 148 44 L 184 12 L 222 44 L 272 16" fill="none" stroke={color} strokeWidth="2.2" />
                            )}
                            {isAmp && (
                                <>
                                    {Array.from({ length: 6 }).map((_, i) => (
                                        <line key={i} x1={18 + i * 44} y1={8} x2={18 + i * 44} y2={44} stroke="var(--token-color-rgba-255-170-110-0d35)" />
                                    ))}
                                    <path d="M 6 43 C 50 38, 82 16, 120 18 C 160 20, 200 42, 240 36 C 260 33, 270 29, 276 22" fill="none" stroke="var(--token-color-hex-ffb57a)" strokeWidth="2.4" />
                                </>
                            )}
                            {isCabinet && (
                                <>
                                    {Array.from({ length: 11 }).map((_, i) => (
                                        <rect
                                            key={i}
                                            x={10 + i * 24}
                                            y={18 + Math.sin(i * 0.7) * 4}
                                            width="14"
                                            height={18 + Math.cos(i * 0.5) * 3}
                                            rx="1.5"
                                            fill="var(--token-color-rgba-255-188-132-0d72)"
                                        />
                                    ))}
                                    <path d="M 8 40 Q 68 22, 138 32 T 272 20" fill="none" stroke="var(--token-color-hex-ffc28d)" strokeWidth="1.8" />
                                </>
                            )}
                            {isErosion && (
                                <>
                                    {Array.from({ length: 20 }).map((_, i) => {
                                        const x = 8 + i * 13.5;
                                        const h = 8 + ((i * 19) % 30);
                                        return <rect key={i} x={x} y={42 - h} width="6" height={h} rx="1" fill="var(--token-color-rgba-255-156-94-0d82)" />;
                                    })}
                                </>
                            )}
                            {isOverdrive && (
                                <>
                                    <path d="M 8 44 C 48 44, 74 8, 112 8 C 150 8, 172 44, 214 44 C 240 44, 258 26, 272 16" fill="none" stroke="var(--token-color-hex-ff9f6a)" strokeWidth="2.6" strokeLinecap="round" />
                                    <line x1="8" y1="44" x2="272" y2="44" stroke="var(--token-color-rgba-255-160-110-0d24)" strokeWidth="1" />
                                </>
                            )}
                            {isPedal && (
                                <>
                                    {Array.from({ length: 8 }).map((_, i) => (
                                        <circle key={i} cx={24 + i * 32} cy={26 + Math.sin(i * 1.2) * 10} r={3 + (i % 3)} fill="var(--token-color-rgba-255-153-94-0d7)" />
                                    ))}
                                    <path d="M 12 32 Q 84 12, 152 32 T 268 20" fill="none" stroke="var(--token-color-hex-ffad79)" strokeWidth="2" />
                                </>
                            )}
                            {isRoar && (
                                <>
                                    <path d="M 8 40 L 34 14 L 62 38 L 88 10 L 118 36 L 144 12 L 172 34 L 202 10 L 232 32 L 272 14" fill="none" stroke="var(--token-color-hex-ff7d4f)" strokeWidth="2.8" />
                                    <path d="M 8 46 L 272 46" stroke="var(--token-color-rgba-255-125-79-0d22)" strokeWidth="1" />
                                </>
                            )}
                            {isDrumBuss && (
                                <>
                                    {Array.from({ length: 12 }).map((_, i) => {
                                        const x = 10 + i * 22;
                                        const h = 8 + ((i * 13) % 26);
                                        return <rect key={i} x={x} y={44 - h} width="12" height={h} rx="2" fill="var(--token-color-rgba-255-179-92-0d88)" />;
                                    })}
                                    <line x1="8" y1="22" x2="272" y2="22" stroke="var(--token-color-rgba-255-185-105-0d26)" strokeWidth="1" strokeDasharray="3,2" />
                                </>
                            )}
                            {isDynamicTube && (
                                <>
                                    <ellipse cx="80" cy="26" rx="26" ry="16" fill="none" stroke="var(--token-color-rgba-255-198-120-0d65)" strokeWidth="1.5" />
                                    <ellipse cx="146" cy="26" rx="26" ry="16" fill="none" stroke="var(--token-color-rgba-255-198-120-0d45)" strokeWidth="1.5" />
                                    <ellipse cx="212" cy="26" rx="26" ry="16" fill="none" stroke="var(--token-color-rgba-255-198-120-0d3)" strokeWidth="1.5" />
                                    <path d="M 8 40 Q 76 8, 144 40 T 272 16" fill="none" stroke="var(--token-color-hex-ffbc74)" strokeWidth="2.1" />
                                </>
                            )}
                            {isBit && (
                                <>
                                    {Array.from({ length: 14 }).map((_, i) => {
                                        const x = 10 + i * 19;
                                        const high = i % 2 === 0 || i % 5 === 0;
                                        return <rect key={i} x={x} y={high ? 14 : 26} width="12" height={high ? 24 : 12} fill="var(--token-color-rgba-242-222-114-0d9)" rx="1.5" />;
                                    })}
                                </>
                            )}
                        </svg>
                        <div style={pluginPanelMetaStyle}>
                            <span>Drive {formatSurfaceParam(drive)}</span>
                            <span>Tone {formatSurfaceParam(tone)}</span>
                        </div>
                    </div>
                    <DryWetSection device={device} handlers={handlers} accent={device.effectType === 'distortion' ? 'var(--token-color-hex-ff965e)' : 'var(--token-color-hex-f2de72)'} show={showDryWet} />
                </div>
                <KnobParamGrid device={device} handlers={handlers} options={{ omitMixWhenDryWet: showDryWet }} />
            </div>
        );
    }

    /* ═════════════════════════════════════════════════════════════════ */
    /* NOISE MACHINE — Generator (no Dry/Wet applicable)                */
    /* ═════════════════════════════════════════════════════════════════ */
    if (device.effectType === 'noiseMachine') {
        const type = Math.round(safeParamValue(device, 'type', 0));
        const level = readSurfaceParam(device, 'level', -30, 'dB');
        const stereo = readSurfaceParam(device, 'stereo', 0.5, '%');
        const NOISE_TYPE_LABELS = ['White', 'Pink', 'Brown', 'Blue', 'Violet', 'Grey'];
        const typeLabel = NOISE_TYPE_LABELS[Math.min(type, 5)] ?? 'White';
        // Color per noise type
        const NOISE_COLORS = ['var(--token-color-hex-c8d6e5)', 'var(--token-color-hex-f5b8c2)', 'var(--token-color-hex-c4a882)', 'var(--token-color-hex-7ab6ff)', 'var(--token-color-hex-b896e8)', 'var(--token-color-hex-a5b8a0)'];
        const noiseColor = NOISE_COLORS[Math.min(type, 5)] ?? 'var(--token-color-hex-72d68a)';
        return (
            <div data-no-drag style={pluginPanelLayoutStyle}>
                <div style={{ ...pluginPanelCardBaseStyle, background: 'var(--plugin-bg-noise)' }}>
                    <div style={{ ...pluginPanelTitleStyle, color: 'var(--token-color-hex-a5d6b0)' }}>Noise Machine</div>
                    <svg viewBox="0 0 280 52" preserveAspectRatio="none" style={{ width: '100%', height: 44 }}>
                        <rect x="0" y="0" width="280" height="52" rx="4" fill="var(--token-color-rgba-12-18-12-0d65)" />
                        <path d="M 4 26 L 11 10 L 18 38 L 25 18 L 32 42 L 39 14 L 46 34 L 53 8 L 60 40 L 67 20 L 74 36 L 81 12 L 88 44 L 95 16 L 102 38 L 109 22 L 116 40 L 123 10 L 130 34 L 137 18 L 144 42 L 151 14 L 158 36 L 165 8 L 172 40 L 179 20 L 186 38 L 193 12 L 200 44 L 207 16 L 214 34 L 221 22 L 228 40 L 235 10 L 242 38 L 249 18 L 256 42 L 263 14 L 270 36 L 276 26" fill="none" stroke={noiseColor} strokeWidth="1.6" />
                    </svg>
                    <div style={pluginPanelMetaStyle}>
                        <span>{typeLabel}</span>
                        <span>Level {formatSurfaceParam(level)}</span>
                        <span>Stereo {formatSurfaceParam(stereo)}</span>
                    </div>
                </div>
                <KnobParamGrid device={device} handlers={handlers} />
            </div>
        );
    }

    return null;
}
