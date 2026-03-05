import { clamp01 } from '@/shared/lib/audioMath';
import type { DeviceSlot } from '@/widgets/DeviceRack/model/types';
import {
    buildSurfaceKnobParams,
    DryWetSection,
    formatSurfaceParam,
    getDevicePluginKey,
    getParamValue,
    KnobParamGrid,
    pluginPanelCardBaseStyle,
    pluginPanelMetaStyle,
    readSurfaceParam,
    shouldShowDryWet,
    type SurfaceHandlers,
} from '@/widgets/DeviceRack/ui/PluginGuiSurfaceStandardShared';

export function renderStandardUtilityCompressorSurface(device: DeviceSlot, handlers: SurfaceHandlers): React.ReactNode {
    const { onParamChange: _onParamChange, onParamGestureStart: _onParamGestureStart, onParamGestureEnd: _onParamGestureEnd, onApplyUtilityScene, onParamContextMenu: _onParamContextMenu } = handlers;
    const normalizedInternalId = getDevicePluginKey(device);

    if (device.effectType === 'utility') {
        const mono = getParamValue(device, ['mono'], 0) > 0.5;
        const showDryWet = shouldShowDryWet(device);
        const knobParams = buildSurfaceKnobParams(device, { omitMixWhenDryWet: showDryWet });
        return (
            <div data-no-drag style={{
                display: 'flex',
                flexDirection: 'column',
                gap: 'var(--space-1)',
                height: '100%',
                padding: 'var(--space-1)',
            }}>
                <KnobParamGrid params={knobParams} handlers={handlers} maxCols={2} minCols={2} />
                <div style={{ display: 'flex', gap: 6, justifyContent: 'center' }}>
                    <button
                        type="button"
                        onClick={() => onApplyUtilityScene?.('mono')}
                        className={`utility-scene-btn${mono ? ' active' : ''}`}
                        style={{
                            padding: '3px 14px',
                            borderRadius: 'var(--radius-md)',
                            border: 'var(--space-px) solid var(--color-divider)',
                            background: mono ? 'var(--color-accent-primary)' : 'var(--color-bg-elevated)',
                            color: mono ? 'var(--color-text-on-accent)' : 'var(--color-text-secondary)',
                            fontSize: 'var(--font-size-2xs)',
                            fontWeight: 600,
                            cursor: 'pointer',
                            transition: 'background 0.15s ease, color 0.15s ease',
                        }}
                    >Mono</button>
                </div>
                {showDryWet && (
                    <DryWetSection device={device} handlers={handlers} accent="var(--token-color-hex-7ab6ff)" show={showDryWet} />
                )}
            </div>
        );
    }

    if (device.effectType === 'compressor' || device.effectType === 'glueCompressor' || device.effectType === 'multibandDynamics' || device.effectType === 'transientShaper') {
        const isTransientShaper = normalizedInternalId === 'internal://effect/transient-shaper';
        const isGlueCompressor = normalizedInternalId === 'internal://effect/glue-compressor';
        const isMultibandDynamics = normalizedInternalId === 'internal://effect/multiband-dynamics';
        const showDryWet = shouldShowDryWet(device);
        const thrParam = readSurfaceParam(device, 'thr', -18, 'dB');
        const ratioParam = readSurfaceParam(device, 'ratio', 4, ':1');
        const thr = thrParam.value;
        const ratio = ratioParam.value;
        const rawGr = Number.isFinite(device.vuLevel) ? Math.abs(device.vuLevel!) : 0;
        const pseudoGr = rawGr > 0 ? Math.max(0, Math.min(24, rawGr)) : Math.max(0, Math.min(24, ((-thr) / 60) * ratio * 2.4));
        const knobParams = buildSurfaceKnobParams(device, { omitMixWhenDryWet: showDryWet });

        /* Transient Shaper specific params */
        const tsAtkNorm = isTransientShaper ? clamp01(readSurfaceParam(device, 'attack', 50, '%').value / 100) : 0;
        const tsSusNorm = isTransientShaper ? clamp01((readSurfaceParam(device, 'sustain', 0, '%').value + 100) / 200) : 0;

        /* Meta block */
        const metaBlock = (() => {
            if (isTransientShaper) {
                const atkP = readSurfaceParam(device, 'attack', 50, '%');
                const susP = readSurfaceParam(device, 'sustain', 0, '%');
                return (<><span>Atk {formatSurfaceParam(atkP)}</span><span>Sus {formatSurfaceParam(susP)}</span></>);
            }
            if (isGlueCompressor) {
                const GLUE_COMP_RATIOS = ['2:1', '4:1', '10:1'] as const;
                const ratioIdx = Math.round(ratioParam.value);
                const ratioLabel = GLUE_COMP_RATIOS[Math.max(0, Math.min(2, ratioIdx))] ?? '4:1';
                return (<><span>Thr {formatSurfaceParam(thrParam)}</span><span>{ratioLabel}</span><span>GR {pseudoGr.toFixed(1)}dB</span></>);
            }
            if (isMultibandDynamics) {
                const xoverLo = readSurfaceParam(device, 'xover low', 200, 'Hz');
                const xoverHi = readSurfaceParam(device, 'xover high', 4000, 'Hz');
                return (<><span>Lo {formatSurfaceParam(xoverLo)}</span><span>Hi {formatSurfaceParam(xoverHi)}</span></>);
            }
            return (<><span>Thr {formatSurfaceParam(thrParam)}</span><span>Ratio {formatSurfaceParam(ratioParam)}</span><span>GR {pseudoGr.toFixed(1)}dB</span></>);
        })();

        return (
            <div data-no-drag style={{ display: 'flex', gap: 'var(--space-1-5)', height: '100%' }}>
                <div style={{ width: 130, flexShrink: 0, display: 'flex', flexDirection: 'column', gap: 'var(--space-1)' }}>
                    <div style={{ ...pluginPanelCardBaseStyle, padding: 'var(--space-1)', display: 'block', height: 'fit-content' }}>
                        <KnobParamGrid params={knobParams} handlers={handlers} maxCols={2} minCols={2} />
                    </div>
                </div>
                <div style={{ flex: 1, display: 'flex', flexDirection: 'column', gap: 'var(--space-1)' }}>
                    <div style={{ ...pluginPanelCardBaseStyle, background: 'var(--plugin-bg-compressor)', overflow: 'hidden', padding: 0, flex: 1, position: 'relative' }}>
                        <svg width="100%" height="100%" viewBox="0 0 300 120" preserveAspectRatio="xMidYMid slice" style={{ display: 'block', willChange: 'transform', transform: 'translateZ(0)' }}>
                            <rect x="0" y="0" width="300" height="120" fill="var(--token-color-rgba-22-24-30-0d65)" />
                            {isTransientShaper ? (
                                <>
                                    {/* Attack bar */}
                                    <rect x="20" y="26" width={Math.max(4, tsAtkNorm * 260)} height="24" rx="4" fill="var(--token-color-hex-53b0ff)" opacity="0.85" />
                                    {/* Sustain bar */}
                                    <rect x="20" y="64" width={Math.max(4, tsSusNorm * 260)} height="24" rx="4" fill="var(--token-color-hex-78d6ad)" opacity="0.85" />
                                    <text x="20" y="20" fill="var(--token-color-rgba-255-255-255-0d45)" fontSize="9" fontFamily="var(--font-role-data)">ATTACK</text>
                                    <text x="20" y="58" fill="var(--token-color-rgba-255-255-255-0d45)" fontSize="9" fontFamily="var(--font-role-data)">SUSTAIN</text>
                                </>
                            ) : (
                                <>
                                    <line x1="20" y1="20" x2="20" y2="100" stroke="var(--token-color-rgba-255-255-255-0d2)" />
                                    <line x1="20" y1="100" x2="280" y2="100" stroke="var(--token-color-rgba-255-255-255-0d2)" />
                                    {/* Compression curve */}
                                    {!isGlueCompressor && !isMultibandDynamics && (
                                        <path d="M 20 100 L 160 100 Q 210 100 260 30 L 280 30" fill="none" stroke="var(--token-color-hex-6ac3ff)" strokeWidth="3" strokeLinecap="round" />
                                    )}
                                    {isGlueCompressor && (
                                        <path d="M 20 100 L 120 100 Q 150 100 180 74 Q 210 48 230 48 Q 260 48 280 30" fill="none" stroke="var(--token-color-hex-8ec5ff)" strokeWidth="3" strokeLinecap="round" />
                                    )}
                                    {isMultibandDynamics && (
                                        <>
                                            <line x1="110" y1="20" x2="110" y2="100" stroke="var(--token-color-rgba-142-197-255-0d32)" strokeWidth="1" strokeDasharray="3,3" />
                                            <line x1="200" y1="20" x2="200" y2="100" stroke="var(--token-color-rgba-142-197-255-0d32)" strokeWidth="1" strokeDasharray="3,3" />
                                            <path d="M 20 100 L 90 100 Q 108 100 120 78 Q 136 54 160 54 Q 184 54 194 74 Q 202 90 208 90 Q 234 90 256 56 Q 270 32 280 30" fill="none" stroke="var(--token-color-hex-6ac3ff)" strokeWidth="2.6" strokeLinecap="round" />
                                        </>
                                    )}
                                    {/* GR meter bar */}
                                    <rect x="270" y={100 - (pseudoGr / 24) * 74} width="14" height={(pseudoGr / 24) * 74} rx="2" fill={pseudoGr > 12 ? 'var(--color-error)' : pseudoGr > 4 ? 'var(--color-warning)' : 'var(--color-success)'} opacity="0.85" />
                                </>
                            )}
                        </svg>
                    </div>
                    <div style={{ ...pluginPanelMetaStyle, padding: '0 var(--space-1)' }}>
                        {metaBlock}
                    </div>
                </div>
                <DryWetSection device={device} handlers={handlers} accent="var(--token-color-hex-6ac3ff)" show={showDryWet} />
            </div>
        );
    }

    return null;
}
