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
import { renderTimeToneSurface } from '@/widgets/DeviceRack/ui/PluginGuiSurfaceStandardTimeTone';

/* Delay/Reverb surface — EQ-style layout with left control panel + right filter EQ visualization */

export function renderStandardTimeSurface(device: DeviceSlot, handlers: SurfaceHandlers): React.ReactNode {

    if (device.effectType === 'delay' || device.effectType === 'filterDelay' || device.effectType === 'grainDelay' || device.effectType === 'spectralTime') {
        const showDryWet = shouldShowDryWet(device);
        const filterParam = readSurfaceParam(device, ['filter', 'cutoff', 'hp freq'], 200, 'Hz');
        const lpParam = readSurfaceParam(device, ['lp', 'lp freq', 'hi cut'], 8000, 'Hz');
        const fb = readSurfaceParam(device, 'fb', 30, '%');
        // Normalize filter positions for SVG (logarithmic scale mock)
        const hpNorm = clamp01(Math.log2(Math.max(20, filterParam.value) / 20) / Math.log2(20000 / 20));
        const lpNorm = clamp01(Math.log2(Math.max(20, lpParam.value) / 20) / Math.log2(20000 / 20));
        const hpX = 10 + hpNorm * 280;
        const lpX = 10 + lpNorm * 280;
        const knobParams = buildSurfaceKnobParams(device, { omitMixWhenDryWet: showDryWet });

        return (
            <div data-no-drag style={{ display: 'flex', gap: 'var(--space-1-5)', height: '100%' }}>
                {/* ── Left control panel (like EQ controls) ──────── */}
                <div style={{
                    width: 130,
                    flexShrink: 0,
                    display: 'flex',
                    flexDirection: 'column',
                    gap: 'var(--space-1)',
                }}>
                    {/* 2×2 knob card */}
                    <div style={{
                        ...pluginPanelCardBaseStyle,
                        padding: 'var(--space-1) var(--space-1)',
                        display: 'block',
                        height: 'fit-content',
                    }}>
                        <KnobParamGrid params={knobParams} handlers={handlers} maxCols={2} minCols={2} />
                    </div>
                </div>

                {/* ── Right: mini filter EQ visualization ─────────── */}
                <div style={{ flex: 1, display: 'flex', flexDirection: 'column', gap: 'var(--space-1)' }}>
                    <div
                        data-no-drag
                        style={{
                            ...pluginPanelCardBaseStyle,
                            background: 'var(--plugin-bg-delay)',
                            overflow: 'hidden',
                            padding: 0,
                            position: 'relative',
                            flex: 1,
                        }}
                    >
                        <svg
                            width="100%"
                            height="100%"
                            viewBox="0 0 300 120"
                            preserveAspectRatio="xMidYMid slice"
                            style={{ display: 'block', willChange: 'transform', transform: 'translateZ(0)' }}
                        >
                            {/* Background */}
                            <rect x="0" y="0" width="300" height="120" fill="var(--token-color-rgba-14-20-30-0d6)" />
                            {/* Grid lines */}
                            {[30, 60, 90].map(y => (
                                <line key={y} x1="10" y1={y} x2="290" y2={y} stroke="var(--token-color-rgba-255-255-255-0d06)" strokeWidth="0.5" />
                            ))}
                            {[60, 120, 180, 240].map(x => (
                                <line key={x} x1={x} y1="6" x2={x} y2="114" stroke="var(--token-color-rgba-255-255-255-0d06)" strokeWidth="0.5" />
                            ))}
                            {/* Center line (0dB) */}
                            <line x1="10" y1="60" x2="290" y2="60" stroke="var(--token-color-rgba-255-255-255-0d12)" strokeWidth="0.8" />

                            {/* HP filter curve (left) */}
                            <path
                                d={`M 10 110 Q ${hpX - 20} 110, ${hpX - 10} 90 Q ${hpX} 60, ${hpX + 10} 60 L 290 60`}
                                fill="none"
                                stroke="var(--token-color-hex-7cc4ff)"
                                strokeWidth="2.2"
                                strokeLinecap="round"
                            />
                            {/* LP filter curve (right) */}
                            <path
                                d={`M 10 60 L ${lpX - 10} 60 Q ${lpX} 60, ${lpX + 10} 90 Q ${lpX + 20} 110, 290 110`}
                                fill="none"
                                stroke="var(--token-color-hex-7cc4ff)"
                                strokeWidth="2.2"
                                strokeLinecap="round"
                            />
                            {/* Fill between curves */}
                            <path
                                d={`M ${hpX + 10} 60 L ${lpX - 10} 60 L ${lpX - 10} 60 L ${hpX + 10} 60 Z`}
                                fill="color-mix(in srgb, var(--token-color-hex-7cc4ff) 10%, transparent)"
                            />
                            {/* HP handle dot */}
                            <circle cx={hpX} cy="60" r="4" fill="var(--token-color-hex-7cc4ff)" stroke="white" strokeWidth="1" />
                            {/* LP handle dot */}
                            <circle cx={lpX} cy="60" r="4" fill="var(--token-color-hex-7cc4ff)" stroke="white" strokeWidth="1" />
                            {/* Frequency labels */}
                            <text x="14" y="116" fill="var(--token-color-rgba-255-255-255-0d45)" fontSize="8" fontFamily="var(--font-role-data)">20Hz</text>
                            <text x="245" y="116" fill="var(--token-color-rgba-255-255-255-0d45)" fontSize="8" fontFamily="var(--font-role-data)">20kHz</text>
                        </svg>
                    </div>
                    {/* Meta readout below visualization */}
                    <div style={{ ...pluginPanelMetaStyle, padding: '0 var(--space-1)' }}>
                        <span>HP {formatSurfaceParam(filterParam)}</span>
                        <span>LP {formatSurfaceParam(lpParam)}</span>
                        <span>FB {formatSurfaceParam(fb)}</span>
                    </div>
                </div>

                {/* ── Dry/Wet on far right ─────────────────────────── */}
                <DryWetSection device={device} handlers={handlers} accent="var(--token-color-hex-7cc4ff)" show={showDryWet} />
            </div>
        );
    }

    if (device.effectType === 'reverb' || device.effectType === 'hybridReverb' || device.effectType === 'corpus') {
        const showDryWet = shouldShowDryWet(device);
        const filterParam = readSurfaceParam(device, ['hi cut', 'cutoff', 'filter', 'damp'], 4000, 'Hz');
        const lpParam = readSurfaceParam(device, ['lo cut', 'lp', 'lp freq'], 80, 'Hz');
        const reverbSize = readSurfaceParam(device, ['size', 'decay'], 50, '%');
        // Normalize filter positions for SVG (logarithmic scale)
        const hpNorm = clamp01(Math.log2(Math.max(20, lpParam.value) / 20) / Math.log2(20000 / 20));
        const lpNorm = clamp01(Math.log2(Math.max(20, filterParam.value) / 20) / Math.log2(20000 / 20));
        const hpX = 10 + hpNorm * 280;
        const lpX = 10 + lpNorm * 280;
        const knobParams = buildSurfaceKnobParams(device, { omitMixWhenDryWet: showDryWet });

        return (
            <div data-no-drag style={{ display: 'flex', gap: 'var(--space-1-5)', height: '100%' }}>
                {/* ── Left control panel ──────────────────────── */}
                <div style={{
                    width: 130,
                    flexShrink: 0,
                    display: 'flex',
                    flexDirection: 'column',
                    gap: 'var(--space-1)',
                }}>
                    <div style={{
                        ...pluginPanelCardBaseStyle,
                        padding: 'var(--space-1) var(--space-1)',
                        display: 'block',
                        height: 'fit-content',
                    }}>
                        <KnobParamGrid params={knobParams} handlers={handlers} maxCols={2} minCols={2} />
                    </div>
                </div>

                {/* ── Right: mini filter EQ visualization ─────── */}
                <div style={{ flex: 1, display: 'flex', flexDirection: 'column', gap: 'var(--space-1)' }}>
                    <div
                        data-no-drag
                        style={{
                            ...pluginPanelCardBaseStyle,
                            background: 'var(--plugin-bg-reverb)',
                            overflow: 'hidden',
                            padding: 0,
                            position: 'relative',
                            flex: 1,
                        }}
                    >
                        <svg
                            width="100%"
                            height="100%"
                            viewBox="0 0 300 120"
                            preserveAspectRatio="xMidYMid slice"
                            style={{ display: 'block', willChange: 'transform', transform: 'translateZ(0)' }}
                        >
                            <rect x="0" y="0" width="300" height="120" fill="var(--token-color-rgba-10-10-12-0d45)" />
                            {[30, 60, 90].map(y => (
                                <line key={y} x1="10" y1={y} x2="290" y2={y} stroke="var(--token-color-rgba-255-255-255-0d06)" strokeWidth="0.5" />
                            ))}
                            {[60, 120, 180, 240].map(x => (
                                <line key={x} x1={x} y1="6" x2={x} y2="114" stroke="var(--token-color-rgba-255-255-255-0d06)" strokeWidth="0.5" />
                            ))}
                            <line x1="10" y1="60" x2="290" y2="60" stroke="var(--token-color-rgba-255-255-255-0d12)" strokeWidth="0.8" />
                            {/* HP filter curve */}
                            <path
                                d={`M 10 110 Q ${hpX - 20} 110, ${hpX - 10} 90 Q ${hpX} 60, ${hpX + 10} 60 L 290 60`}
                                fill="none"
                                stroke="var(--token-color-hex-c891ff)"
                                strokeWidth="2.2"
                                strokeLinecap="round"
                            />
                            {/* LP filter curve */}
                            <path
                                d={`M 10 60 L ${lpX - 10} 60 Q ${lpX} 60, ${lpX + 10} 90 Q ${lpX + 20} 110, 290 110`}
                                fill="none"
                                stroke="var(--token-color-hex-c891ff)"
                                strokeWidth="2.2"
                                strokeLinecap="round"
                            />
                            <path
                                d={`M ${hpX + 10} 60 L ${lpX - 10} 60 L ${lpX - 10} 60 L ${hpX + 10} 60 Z`}
                                fill="color-mix(in srgb, var(--token-color-hex-c891ff) 10%, transparent)"
                            />
                            <circle cx={hpX} cy="60" r="4" fill="var(--token-color-hex-c891ff)" stroke="white" strokeWidth="1" />
                            <circle cx={lpX} cy="60" r="4" fill="var(--token-color-hex-c891ff)" stroke="white" strokeWidth="1" />
                            <text x="14" y="116" fill="var(--token-color-rgba-255-255-255-0d45)" fontSize="8" fontFamily="var(--font-role-data)">20Hz</text>
                            <text x="245" y="116" fill="var(--token-color-rgba-255-255-255-0d45)" fontSize="8" fontFamily="var(--font-role-data)">20kHz</text>
                        </svg>
                    </div>
                    <div style={{ ...pluginPanelMetaStyle, padding: '0 var(--space-1)' }}>
                        <span>HP {formatSurfaceParam(lpParam)}</span>
                        <span>LP {formatSurfaceParam(filterParam)}</span>
                        <span>Size {formatSurfaceParam(reverbSize)}</span>
                    </div>
                </div>

                <DryWetSection device={device} handlers={handlers} accent="var(--token-color-hex-c891ff)" show={showDryWet} />
            </div>
        );
    }

    return renderTimeToneSurface(device, handlers);
}
