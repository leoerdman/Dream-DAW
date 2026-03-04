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
    pluginPanelLayoutStyle,
    pluginPanelMetaStyle,
    pluginPanelTitleStyle,
    readSurfaceParam,
    shouldShowDryWet,
    PLUGIN_TITLE_MAP,
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
            <div data-no-drag style={pluginPanelLayoutStyle}>
                <div style={{
                    ...pluginPanelCardBaseStyle,
                    background: 'var(--plugin-bg-utility)',
                    display: 'flex',
                    flexDirection: 'column',
                    gap: 'var(--space-2)',
                    alignItems: 'stretch',
                }}>
                    <KnobParamGrid params={knobParams} handlers={handlers} />
                    <div style={{ display: 'flex', gap: 6, justifyContent: 'center', paddingTop: 'var(--space-1)' }}>
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
            </div>
        );
    }

    if (device.effectType === 'compressor' || device.effectType === 'glueCompressor' || device.effectType === 'multibandDynamics' || device.effectType === 'transientShaper') {
        const isTransientShaper = normalizedInternalId === 'internal://effect/transient-shaper';
        const isGlueCompressor = normalizedInternalId === 'internal://effect/glue-compressor';
        const isMultibandDynamics = normalizedInternalId === 'internal://effect/multiband-dynamics';
        const compressorTitle = PLUGIN_TITLE_MAP[normalizedInternalId] ?? 'Compressor';
        const showDryWet = shouldShowDryWet(device);
        const thrParam = readSurfaceParam(device, 'thr', -18, 'dB');
        const ratioParam = readSurfaceParam(device, 'ratio', 4, ':1');
        const thr = thrParam.value;
        const ratio = ratioParam.value;
        const rawGr = Number.isFinite(device.vuLevel) ? Math.abs(device.vuLevel!) : 0;
        const pseudoGr = rawGr > 0 ? Math.max(0, Math.min(24, rawGr)) : Math.max(0, Math.min(24, ((-thr) / 60) * ratio * 2.4));
        const atkParam = readSurfaceParam(device, ['atk', 'attack'], 10, 'ms');
        const relParam = readSurfaceParam(device, ['rel', 'release'], 80, 'ms');
        const atkMs = atkParam.value;
        const relMs = relParam.value;
        const attackNorm = clamp01(Math.log10(Math.max(0.1, atkMs)) / Math.log10(200));
        const releaseNorm = clamp01(Math.log10(Math.max(1, relMs)) / Math.log10(1000));
        const knobParams = buildSurfaceKnobParams(device, { omitMixWhenDryWet: showDryWet });
        return (
            <div data-no-drag style={pluginPanelLayoutStyle}>
                <div style={{
                    ...pluginPanelCardBaseStyle,
                    background: 'var(--plugin-bg-compressor)',
                    display: 'grid',
                    gridTemplateColumns: showDryWet ? '1fr auto auto' : '1fr auto',
                    gap: 'var(--space-2-5)',
                    alignItems: 'center',
                }}>
                    {isTransientShaper ? (
                        <div style={{ display: 'grid', gap: 6 }}>
                            <div style={{ ...pluginPanelTitleStyle, color: 'var(--token-color-hex-b9d7ff)' }}>Transient Shaper</div>
                            <div style={{ height: 8, borderRadius: 'var(--radius-full)', background: 'var(--color-bg-tertiary)', overflow: 'hidden' }}>
                                <div style={{ width: `${(attackNorm * 100).toFixed(1)}%`, height: '100%', background: 'var(--token-color-hex-53b0ff)' }} />
                            </div>
                            <div style={{ height: 8, borderRadius: 'var(--radius-full)', background: 'var(--color-bg-tertiary)', overflow: 'hidden' }}>
                                <div style={{ width: `${(releaseNorm * 100).toFixed(1)}%`, height: '100%', background: 'var(--token-color-hex-78d6ad)' }} />
                            </div>
                            <div style={pluginPanelMetaStyle}>
                                <span>Attack {formatSurfaceParam(atkParam)}</span>
                                <span>Release {formatSurfaceParam(relParam)}</span>
                            </div>
                        </div>
                    ) : (
                        <svg viewBox="0 0 280 86" preserveAspectRatio="xMidYMid slice" style={{ width: '100%', height: '100%', willChange: 'transform', transform: 'translateZ(0)' }}>
                            <rect x="0" y="0" width="280" height="86" fill="var(--token-color-rgba-22-24-30-0d65)" rx="4" />
                            {!isGlueCompressor && !isMultibandDynamics && (
                                <path d="M 14 70 L 120 70 Q 170 70 235 20 L 260 20" fill="none" stroke="var(--token-color-hex-6ac3ff)" strokeWidth="3" strokeLinecap="round" />
                            )}
                            {isGlueCompressor && (
                                <path d="M 14 70 L 96 70 Q 124 70 146 54 Q 168 38 186 38 Q 214 38 236 20 L 260 20" fill="none" stroke="var(--token-color-hex-8ec5ff)" strokeWidth="3" strokeLinecap="round" />
                            )}
                            {isMultibandDynamics && (
                                <>
                                    <line x1="94" y1="20" x2="94" y2="70" stroke="var(--token-color-rgba-142-197-255-0d32)" strokeWidth="1" strokeDasharray="3,3" />
                                    <line x1="176" y1="20" x2="176" y2="70" stroke="var(--token-color-rgba-142-197-255-0d32)" strokeWidth="1" strokeDasharray="3,3" />
                                    <path d="M 14 70 L 76 70 Q 92 70 100 56 Q 112 40 132 40 Q 152 40 162 54 Q 170 66 176 66 Q 198 66 214 42 Q 228 22 260 20" fill="none" stroke="var(--token-color-hex-6ac3ff)" strokeWidth="2.6" strokeLinecap="round" />
                                </>
                            )}
                            <line x1="14" y1="20" x2="14" y2="70" stroke="var(--token-color-rgba-255-255-255-0d2)" />
                            <line x1="14" y1="70" x2="260" y2="70" stroke="var(--token-color-rgba-255-255-255-0d2)" />
                        </svg>
                    )}
                    <div style={{ width: 46, height: 72, borderRadius: 'var(--radius-md)', background: 'var(--color-bg-tertiary)', border: 'var(--space-px) solid var(--color-divider)', padding: 3, display: 'flex', flexDirection: 'column', justifyContent: 'flex-end' }}>
                        <div style={{
                            width: '100%',
                            height: `${(pseudoGr / 24) * 100}%`,
                            background: pseudoGr > 12 ? 'linear-gradient(to top, var(--color-error), var(--color-warning))'
                                : pseudoGr > 4 ? 'linear-gradient(to top, var(--color-warning), var(--color-success))'
                                    : 'var(--color-success)',
                            borderRadius: 2,
                            transition: 'height 60ms linear',
                        }} />
                    </div>
                    <DryWetSection device={device} handlers={handlers} accent="var(--token-color-hex-6ac3ff)" show={showDryWet} />
                    {!isTransientShaper && (
                        <div style={{ ...pluginPanelMetaStyle, gridColumn: '1 / -1' }}>
                            <span>{compressorTitle}</span>
                            <span>Thr {formatSurfaceParam(thrParam)}</span>
                            <span>Ratio {formatSurfaceParam(ratioParam)}</span>
                            <span>Atk {formatSurfaceParam(atkParam)}</span>
                            <span>Rel {formatSurfaceParam(relParam)}</span>
                        </div>
                    )}
                </div>
                <KnobParamGrid params={knobParams} handlers={handlers} />
            </div>
        );
    }

    return null;
}
