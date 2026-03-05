// ═══════════════════════════════════════════════════════════════════════════
// Dream DAW — Plugin Surfaces: Distortion / Noise
// EQ-style layout: left knob panel + right visualization + DryWet far right
// ═══════════════════════════════════════════════════════════════════════════
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
    if (device.effectType === 'distortion' || device.effectType === 'bitcrusher' || device.effectType === 'overdrive' || device.effectType === 'amp' || device.effectType === 'cabinet' || device.effectType === 'pedal' || device.effectType === 'roar' || device.effectType === 'erosion') {
        const showDryWet = shouldShowDryWet(device);
        const title = device.effectType === 'bitcrusher'
            ? 'Bitcrusher'
            : (PLUGIN_TITLE_MAP[normalizedInternalId] ?? 'Distortion');
        const isAmp = title === 'Amp';
        const isCabinet = title === 'Cabinet';
        const isErosion = title === 'Erosion';
        const isOverdrive = title === 'Overdrive';
        const isPedal = title === 'Pedal';
        const isRoar = title === 'Roar';
        const isDrumBuss = title === 'Drum Buss';
        const isDynamicTube = title === 'Dynamic Tube';
        const isBit = title === 'Bitcrusher';
        const knobParams = buildSurfaceKnobParams(device, { omitMixWhenDryWet: showDryWet });

        /* ── Per-plugin meta readouts ── */
        const metaBlock = (() => {
            if (isAmp) {
                const gain = readSurfaceParam(device, 'gain', 0, 'dB');
                const master = readSurfaceParam(device, 'master', 0, 'dB');
                return (<><span>Gain {formatSurfaceParam(gain)}</span><span>Master {formatSurfaceParam(master)}</span></>);
            }
            if (isCabinet) {
                const micPos = readSurfaceParam(device, 'mic pos', 50, '%');
                return (<><span>Mic {formatSurfaceParam(micPos)}</span></>);
            }
            if (isErosion) {
                const freq = readSurfaceParam(device, 'frequency', 2000, 'Hz');
                const amount = readSurfaceParam(device, 'amount', 0, '%');
                return (<><span>Freq {formatSurfaceParam(freq)}</span><span>Amt {formatSurfaceParam(amount)}</span></>);
            }
            if (isOverdrive || isPedal || isRoar) {
                const drive = readSurfaceParam(device, 'drive', 0, 'dB');
                const tone = readSurfaceParam(device, 'tone', 0, '%');
                return (<><span>Drive {formatSurfaceParam(drive)}</span><span>Tone {formatSurfaceParam(tone)}</span></>);
            }
            if (isDrumBuss) {
                const boom = readSurfaceParam(device, 'boom', 40, '%');
                const drive = readSurfaceParam(device, 'drive', 30, '%');
                return (<><span>Boom {formatSurfaceParam(boom)}</span><span>Drive {formatSurfaceParam(drive)}</span></>);
            }
            if (isDynamicTube) {
                const drive = readSurfaceParam(device, 'drive', 40, '%');
                const bias = readSurfaceParam(device, 'bias', 20, '%');
                return (<><span>Drive {formatSurfaceParam(drive)}</span><span>Bias {formatSurfaceParam(bias)}</span></>);
            }
            if (isBit) {
                const bits = readSurfaceParam(device, 'bits', 16, '');
                const downsample = readSurfaceParam(device, 'downsample', 1, 'x');
                return (<><span>Bits {formatSurfaceParam(bits)}</span><span>↓{formatSurfaceParam(downsample)}</span></>);
            }
            const drive = readSurfaceParam(device, 'drive', 0, 'dB');
            const tone = readSurfaceParam(device, 'tone', 0, '%');
            return (<><span>Drive {formatSurfaceParam(drive)}</span><span>Tone {formatSurfaceParam(tone)}</span></>);
        })();

        const driveParam = readSurfaceParam(device, 'drive', 3, 'dB');
        const driveClamp = Math.max(0, Math.min(24, driveParam.value));
        const knee = Math.max(12, Math.min(68, 80 - driveClamp * 2.8));

        return (
            <div data-no-drag style={{ display: 'flex', gap: 'var(--space-1-5)', height: '100%' }}>
                <div style={{ width: 130, flexShrink: 0, display: 'flex', flexDirection: 'column', gap: 'var(--space-1)' }}>
                    <div style={{ ...pluginPanelCardBaseStyle, padding: 'var(--space-1)', display: 'block', height: 'fit-content' }}>
                        <KnobParamGrid params={knobParams} handlers={handlers} maxCols={2} minCols={2} />
                    </div>
                </div>
                <div style={{ flex: 1, display: 'flex', flexDirection: 'column', gap: 'var(--space-1)' }}>
                    <div style={{ ...pluginPanelCardBaseStyle, background: 'var(--plugin-bg-distortion)', overflow: 'hidden', padding: 0, flex: 1 }}>
                        <svg width="100%" height="100%" viewBox="0 0 280 120" preserveAspectRatio="xMidYMid slice" style={{ display: 'block', willChange: 'transform', transform: 'translateZ(0)' }}>
                            <rect x="0" y="0" width="280" height="120" fill="var(--token-color-rgba-20-13-9-0d65)" />
                            <line x1="10" y1="60" x2="270" y2="60" stroke="var(--token-color-rgba-255-255-255-0d12)" strokeWidth="0.8" />
                            {!isAmp && !isCabinet && !isErosion && !isOverdrive && !isPedal && !isRoar && !isDrumBuss && !isDynamicTube && !isBit && (
                                <path d="M 8 106 L 42 26 L 78 106 L 112 26 L 148 106 L 184 26 L 222 106 L 272 34" fill="none" stroke="var(--token-color-hex-ff965e)" strokeWidth="2.2" />
                            )}
                            {isAmp && (
                                <>
                                    {Array.from({ length: 6 }).map((_, i) => (
                                        <line key={i} x1={18 + i * 44} y1={10} x2={18 + i * 44} y2={110} stroke="var(--token-color-rgba-255-170-110-0d35)" />
                                    ))}
                                    <path d="M 6 100 C 50 88, 82 32, 120 36 C 160 40, 200 96, 240 82 C 260 72, 270 58, 276 44" fill="none" stroke="var(--token-color-hex-ffb57a)" strokeWidth="2.4" />
                                </>
                            )}
                            {isCabinet && (
                                <>
                                    {Array.from({ length: 11 }).map((_, i) => (
                                        <rect key={i} x={10 + i * 24} y={34 + Math.sin(i * 0.7) * 8} width="16" height={40 + Math.cos(i * 0.5) * 6} rx="1.5" fill="var(--token-color-rgba-255-188-132-0d72)" />
                                    ))}
                                    <path d="M 8 92 Q 68 44, 138 66 T 272 40" fill="none" stroke="var(--token-color-hex-ffc28d)" strokeWidth="1.8" />
                                </>
                            )}
                            {isErosion && Array.from({ length: 20 }).map((_, i) => {
                                const x = 8 + i * 13.5;
                                const h = 16 + ((i * 19) % 60);
                                return <rect key={i} x={x} y={106 - h} width="8" height={h} rx="1" fill="var(--token-color-rgba-255-156-94-0d82)" />;
                            })}
                            {isOverdrive && (
                                <>
                                    <path d={`M 8 106 C 48 106, 74 18, 112 18 C 150 18, 172 106, 214 106 C 240 106, 258 56, 272 34`} fill="none" stroke="var(--token-color-hex-ff9f6a)" strokeWidth="2.6" strokeLinecap="round" />
                                    <line x1="8" y1="106" x2="272" y2="106" stroke="var(--token-color-rgba-255-160-110-0d24)" strokeWidth="1" />
                                </>
                            )}
                            {isPedal && (
                                <>
                                    {Array.from({ length: 8 }).map((_, i) => (
                                        <circle key={i} cx={24 + i * 32} cy={60 + Math.sin(i * 1.2) * 24} r={5 + (i % 3) * 2} fill="var(--token-color-rgba-255-153-94-0d7)" />
                                    ))}
                                    <path d="M 12 72 Q 84 24, 152 72 T 268 40" fill="none" stroke="var(--token-color-hex-ffad79)" strokeWidth="2" />
                                </>
                            )}
                            {isRoar && (
                                <>
                                    <path d="M 8 94 L 34 28 L 62 88 L 88 20 L 118 82 L 144 24 L 172 78 L 202 20 L 232 72 L 272 28" fill="none" stroke="var(--token-color-hex-ff7d4f)" strokeWidth="2.8" />
                                </>
                            )}
                            {isDrumBuss && Array.from({ length: 12 }).map((_, i) => {
                                const x = 10 + i * 22;
                                const h = 16 + ((i * 13) % 60);
                                return <rect key={i} x={x} y={106 - h} width="14" height={h} rx="2" fill="var(--token-color-rgba-255-179-92-0d88)" />;
                            })}
                            {isDynamicTube && (
                                <>
                                    <ellipse cx="80" cy="60" rx="30" ry="34" fill="none" stroke="var(--token-color-rgba-255-198-120-0d65)" strokeWidth="1.5" />
                                    <ellipse cx="146" cy="60" rx="30" ry="34" fill="none" stroke="var(--token-color-rgba-255-198-120-0d45)" strokeWidth="1.5" />
                                    <ellipse cx="212" cy="60" rx="30" ry="34" fill="none" stroke="var(--token-color-rgba-255-198-120-0d3)" strokeWidth="1.5" />
                                    <path d={`M 14 106 C ${knee + 14} 106, ${140 - knee / 2} 14, 140 14 C ${140 + knee / 2} 14, ${266 - knee} 106, 266 106`} fill="none" stroke="var(--token-color-hex-ffbc74)" strokeWidth="2.1" />
                                </>
                            )}
                            {isBit && Array.from({ length: 14 }).map((_, i) => {
                                const x = 10 + i * 19;
                                const high = i % 2 === 0 || i % 5 === 0;
                                return <rect key={i} x={x} y={high ? 26 : 52} width="12" height={high ? 60 : 30} fill="var(--token-color-rgba-242-222-114-0d9)" rx="1.5" />;
                            })}
                        </svg>
                    </div>
                    <div style={{ ...pluginPanelMetaStyle, padding: '0 var(--space-1)' }}>
                        {metaBlock}
                    </div>
                </div>
                <DryWetSection device={device} handlers={handlers} accent={device.effectType === 'distortion' ? 'var(--token-color-hex-ff965e)' : 'var(--token-color-hex-f2de72)'} show={showDryWet} />
            </div>
        );
    }

    /* ═════════════════════════════════════════════════════════════════ */
    /* NOISE MACHINE — Generator (no Dry/Wet applicable)                */
    /* ═════════════════════════════════════════════════════════════════ */
    if (device.effectType === 'noiseMachine') {
        const type = Math.round(safeParamValue(device, 'type', 0));
        const level = readSurfaceParam(device, 'level', -30, 'dB');
        const NOISE_TYPE_LABELS = ['White', 'Pink', 'Brown', 'Blue', 'Violet', 'Grey'];
        const typeLabel = NOISE_TYPE_LABELS[Math.min(type, 5)] ?? 'White';
        const NOISE_COLORS = ['var(--token-color-hex-c8d6e5)', 'var(--token-color-hex-f5b8c2)', 'var(--token-color-hex-c4a882)', 'var(--token-color-hex-7ab6ff)', 'var(--token-color-hex-b896e8)', 'var(--token-color-hex-a5b8a0)'];
        const noiseColor = NOISE_COLORS[Math.min(type, 5)] ?? 'var(--token-color-hex-72d68a)';
        const knobParams = buildSurfaceKnobParams(device, {});

        return (
            <div data-no-drag style={{ display: 'flex', gap: 'var(--space-1-5)', height: '100%' }}>
                <div style={{ width: 130, flexShrink: 0, display: 'flex', flexDirection: 'column', gap: 'var(--space-1)' }}>
                    <div style={{ ...pluginPanelCardBaseStyle, padding: 'var(--space-1)', display: 'block', height: 'fit-content' }}>
                        <KnobParamGrid params={knobParams} handlers={handlers} maxCols={2} minCols={2} />
                    </div>
                </div>
                <div style={{ flex: 1, display: 'flex', flexDirection: 'column', gap: 'var(--space-1)' }}>
                    <div style={{ ...pluginPanelCardBaseStyle, background: 'var(--plugin-bg-noise)', overflow: 'hidden', padding: 0, flex: 1 }}>
                        <svg width="100%" height="100%" viewBox="0 0 300 120" preserveAspectRatio="xMidYMid slice" style={{ display: 'block', willChange: 'transform', transform: 'translateZ(0)' }}>
                            <rect x="0" y="0" width="300" height="120" fill="var(--token-color-rgba-12-18-12-0d65)" />
                            <path d="M 4 60 L 11 20 L 18 92 L 25 36 L 32 100 L 39 28 L 46 82 L 53 16 L 60 94 L 67 40 L 74 86 L 81 24 L 88 104 L 95 32 L 102 90 L 109 44 L 116 94 L 123 20 L 130 82 L 137 36 L 144 100 L 151 28 L 158 86 L 165 16 L 172 94 L 179 40 L 186 90 L 193 24 L 200 104 L 207 32 L 214 82 L 221 44 L 228 94 L 235 20 L 242 90 L 249 36 L 256 100 L 263 28 L 270 86 L 276 60 L 284 48 L 296 60" fill="none" stroke={noiseColor} strokeWidth="1.6" />
                        </svg>
                    </div>
                    <div style={{ ...pluginPanelMetaStyle, padding: '0 var(--space-1)' }}>
                        <span>{typeLabel}</span>
                        <span>Level {formatSurfaceParam(level)}</span>
                    </div>
                </div>
            </div>
        );
    }

    return null;
}
