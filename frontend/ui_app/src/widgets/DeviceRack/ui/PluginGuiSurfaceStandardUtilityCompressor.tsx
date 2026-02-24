import React from 'react';
import { PluginKnob } from '@/widgets/DeviceRack/StandardPluginControls';
import { pluginPanelKnobGrid } from '@/widgets/DeviceRack/ui/styles';
import { DryWetKnob } from '@/widgets/DeviceRack/ui/DryWetKnob';
import { normalizeInternalPluginId } from '@/shared/lib/internalPlugins';
import type { DeviceSlot } from '@/widgets/DeviceRack/model/types';
import {
    buildSurfaceKnobParams,
    formatSurfaceParam,
    getParamValue,
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
    const { onParamChange, onParamGestureStart, onParamGestureEnd, onApplyUtilityScene } = handlers;
    const normalizedInternalId = normalizeInternalPluginId(device.pluginId || (device.guiMode || '').toLowerCase() || device.name.toLowerCase());

    if (device.effectType === 'utility') {
        const utilityTitle = PLUGIN_TITLE_MAP[normalizedInternalId] ?? 'Utility';
        const isTuner = normalizedInternalId === 'internal://effect/tuner';
        const isExternalFx = normalizedInternalId === 'internal://effect/external-audio-effect';
        const isAutoShift = normalizedInternalId === 'internal://effect/auto-shift';
        const isShifter = normalizedInternalId === 'internal://effect/shifter';
        const isUtilityVariant = isTuner || isExternalFx || isAutoShift || isShifter;
        const pan = getParamValue(device, ['pan'], 0);
        const width = getParamValue(device, ['width', 'stereo'], 100);
        const mono = getParamValue(device, ['mono'], 0) > 0.5;
        const panPct = Math.max(-1, Math.min(1, pan / 100));
        const widthPct = Math.max(0, Math.min(1, width / 200));
        const hasUtilityCoreParams = device.params.some((p) => ['gain', 'pan', 'width', 'mono'].includes(p.name.toLowerCase()));
        const showCoreUtilityPanel = hasUtilityCoreParams && !isUtilityVariant;
        const showDryWet = shouldShowDryWet(device);
        const knobParams = buildSurfaceKnobParams(device, { omitMixWhenDryWet: showDryWet });
        return (
            <div data-no-drag style={pluginPanelLayoutStyle}>
                <div style={{
                    ...pluginPanelCardBaseStyle,
                    background: 'var(--plugin-bg-utility)',
                    display: 'grid',
                    gridTemplateColumns: showDryWet ? '1fr 1fr auto' : '1fr 1fr',
                    gap: 'var(--space-2-5)',
                    alignItems: 'center',
                }}>
                    {showCoreUtilityPanel ? (
                        <>
                            <div>
                                <div style={{ fontSize: 'var(--font-size-2xs)', color: 'var(--token-color-hex-9fa7b5)', marginBottom: 4 }}>Pan</div>
                                <div style={{ position: 'relative', height: 8, borderRadius: 'var(--radius-full)', background: 'var(--color-bg-tertiary)' }}>
                                    <div style={{ position: 'absolute', left: '50%', top: 0, bottom: 0, width: 1, background: 'var(--token-color-rgba-255-255-255-0d2)' }} />
                                    <div style={{
                                        position: 'absolute',
                                        top: -3,
                                        left: `calc(${(panPct * 50 + 50).toFixed(3)}% - var(--token-size-px-5))`,
                                        width: 10,
                                        height: 14,
                                        borderRadius: 'var(--radius-md)',
                                        background: 'var(--token-color-hex-56a7ff)',
                                        boxShadow: '0 0 var(--space-1-5) var(--token-color-rgba-86-167-255-0d45)',
                                    }} />
                                </div>
                            </div>
                            <div>
                                <div style={{ fontSize: 'var(--font-size-2xs)', color: 'var(--token-color-hex-9fa7b5)', marginBottom: 4 }}>Stereo Width</div>
                                <div style={{ height: 8, borderRadius: 'var(--radius-full)', background: 'var(--color-bg-tertiary)', overflow: 'hidden' }}>
                                    <div style={{
                                        width: `${(widthPct * 100).toFixed(2)}%`,
                                        height: '100%',
                                        background: mono ? 'var(--color-bg-muted)' : 'var(--color-accent-primary)',
                                    }} />
                                </div>
                            </div>
                            <div style={{ ...pluginPanelTitleStyle, color: 'var(--color-text-secondary)' }}>
                                {utilityTitle}: <span style={{ color: 'var(--color-text-primary)', fontFamily: 'var(--font-mono)' }}>{formatSurfaceParam(readSurfaceParam(device, ['gain', 'output', 'level'], 0, 'dB'))}</span>
                            </div>
                            <div style={{ ...pluginPanelTitleStyle, color: mono ? 'var(--color-text-primary)' : 'var(--color-text-tertiary)' }}>
                                {mono ? 'Mono Enabled' : 'Stereo'}
                            </div>
                            <div style={{ gridColumn: '1 / span 2', display: 'flex', gap: 6, flexWrap: 'wrap' }}>
                                <button
                                    type="button"
                                    onClick={() => onApplyUtilityScene?.('center')}
                                    style={{ border: 'var(--space-px) solid var(--color-divider)', borderRadius: 'var(--radius-md)', background: 'var(--color-bg-header)', color: 'var(--color-text-secondary)', fontSize: 'var(--font-size-xs)', padding: 'var(--token-size-px-3) var(--space-2)', cursor: 'pointer' }}
                                >Center</button>
                                <button
                                    type="button"
                                    onClick={() => onApplyUtilityScene?.('mono')}
                                    style={{ border: 'var(--space-px) solid var(--color-divider)', borderRadius: 'var(--radius-md)', background: 'var(--color-bg-header)', color: 'var(--color-text-secondary)', fontSize: 'var(--font-size-xs)', padding: 'var(--token-size-px-3) var(--space-2)', cursor: 'pointer' }}
                                >Mono</button>
                                <button
                                    type="button"
                                    onClick={() => onApplyUtilityScene?.('wide')}
                                    style={{ border: 'var(--space-px) solid var(--color-divider)', borderRadius: 'var(--radius-md)', background: 'var(--color-bg-header)', color: 'var(--color-text-secondary)', fontSize: 'var(--font-size-xs)', padding: 'var(--token-size-px-3) var(--space-2)', cursor: 'pointer' }}
                                >Wide</button>
                            </div>
                        </>
                    ) : (
                        <>
                            <div style={{ gridColumn: '1 / span 2', ...pluginPanelTitleStyle, color: 'var(--token-color-hex-d9e3f2)' }}>{utilityTitle}</div>
                            {isTuner && (
                                <div style={{ gridColumn: '1 / span 2', display: 'grid', gap: 4 }}>
                                    <div style={{ fontSize: 'var(--font-size-3xl)', color: 'var(--token-color-hex-a9d2ff)', fontFamily: 'var(--font-mono)', textAlign: 'center' }}>A</div>
                                    <div style={{ height: 8, borderRadius: 'var(--radius-full)', background: 'var(--token-color-hex-1f2a36)', position: 'relative' }}>
                                        <div style={{ position: 'absolute', left: '50%', top: 0, bottom: 0, width: 1, background: 'var(--token-color-hex-7ab6ff)' }} />
                                    </div>
                                    <svg viewBox="0 0 220 26" preserveAspectRatio="none" style={{ width: '100%', height: 20 }}>
                                        <rect x="0" y="0" width="220" height="26" rx="4" fill="var(--token-color-rgba-16-24-34-0d8)" />
                                        <line x1="110" y1="4" x2="110" y2="22" stroke="var(--token-color-rgba-122-182-255-0d55)" strokeWidth="1.3" />
                                        <path d="M 24 14 Q 64 6, 102 14" fill="none" stroke="var(--token-color-rgba-122-182-255-0d65)" strokeWidth="1.8" strokeLinecap="round" />
                                        <path d="M 118 14 Q 156 22, 196 14" fill="none" stroke="var(--token-color-rgba-122-182-255-0d65)" strokeWidth="1.8" strokeLinecap="round" />
                                    </svg>
                                </div>
                            )}
                            {(isAutoShift || isShifter) && (
                                <div style={{ gridColumn: '1 / span 2', display: 'grid', gap: 4 }}>
                                    <div style={{ fontSize: 'var(--font-size-xs)', color: 'var(--token-color-hex-a5bed8)', textTransform: 'uppercase', letterSpacing: '0.05em' }}>Mode</div>
                                    <div style={{ fontSize: 'var(--font-size-xs)', color: 'var(--token-color-hex-dce9ff)', fontFamily: 'var(--font-mono)' }}>
                                        Compatibility alias (Utility DSP)
                                    </div>
                                    <svg viewBox="0 0 220 28" preserveAspectRatio="none" style={{ width: '100%', height: 20 }}>
                                        <rect x="0" y="0" width="220" height="28" rx="4" fill="var(--token-color-rgba-16-24-34-0d8)" />
                                        {isAutoShift ? (
                                            <>
                                                <path d="M 12 20 L 54 8 L 96 20 L 138 8 L 180 20 L 208 12" fill="none" stroke="var(--token-color-rgba-110-205-255-0d92)" strokeWidth="2" strokeLinecap="round" />
                                                <line x1="110" y1="4" x2="110" y2="24" stroke="var(--token-color-rgba-110-205-255-0d3)" strokeWidth="1" strokeDasharray="2,2" />
                                            </>
                                        ) : (
                                            <>
                                                <path d="M 14 20 Q 40 6, 64 20 T 112 20 T 160 20 T 206 20" fill="none" stroke="var(--token-color-rgba-165-190-245-0d92)" strokeWidth="2" strokeLinecap="round" />
                                                <path d="M 14 12 Q 40 26, 64 12 T 112 12 T 160 12 T 206 12" fill="none" stroke="var(--token-color-rgba-165-190-245-0d42)" strokeWidth="1.6" strokeLinecap="round" />
                                            </>
                                        )}
                                    </svg>
                                </div>
                            )}
                            {isExternalFx && (
                                <div style={{ gridColumn: '1 / span 2', display: 'grid', gap: 4 }}>
                                    <div style={{ fontSize: 'var(--font-size-xs)', color: 'var(--token-color-hex-c2cfdb)', lineHeight: 1.4 }}>
                                        External routing host. Use device params below for send/return balance and compensation.
                                    </div>
                                    <svg viewBox="0 0 220 28" preserveAspectRatio="none" style={{ width: '100%', height: 20 }}>
                                        <rect x="0" y="0" width="220" height="28" rx="4" fill="var(--token-color-rgba-16-24-34-0d8)" />
                                        <rect x="14" y="7" width="56" height="14" rx="3" fill="var(--token-color-rgba-122-182-255-0d28)" />
                                        <rect x="150" y="7" width="56" height="14" rx="3" fill="var(--token-color-rgba-122-182-255-0d28)" />
                                        <path d="M 70 14 L 150 14" stroke="var(--token-color-rgba-122-182-255-0d72)" strokeWidth="1.8" />
                                        <path d="M 145 10 L 152 14 L 145 18" fill="none" stroke="var(--token-color-rgba-122-182-255-0d92)" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
                                    </svg>
                                </div>
                            )}
                        </>
                    )}
                    {showDryWet && (
                        <div style={{ gridColumn: '3', gridRow: '1 / -1', justifySelf: 'end', alignSelf: 'center' }}>
                            <DryWetKnob
                                device={device}
                                onChange={onParamChange}
                                onGestureStart={onParamGestureStart}
                                onGestureEnd={onParamGestureEnd}
                                accent="var(--token-color-hex-7ab6ff)"
                            />
                        </div>
                    )}
                </div>
                {knobParams.length > 0 && (
                    <div style={pluginPanelKnobGrid(`repeat(${Math.min(8, Math.max(3, knobParams.length || 3))}, minmax(0, 1fr))`)}>
                        {knobParams.map((p) => (
                            <PluginKnob
                                key={p.name}
                                param={p}
                                onChange={onParamChange}
                                onGestureStart={onParamGestureStart}
                                onGestureEnd={onParamGestureEnd}
                                compact
                            />
                        ))}
                    </div>
                )}
            </div>
        );
    }

    if (device.effectType === 'compressor') {
        const isTransientShaper = normalizedInternalId === 'internal://effect/transient-shaper';
        const isGlueCompressor = normalizedInternalId === 'internal://effect/glue-compressor';
        const isMultibandDynamics = normalizedInternalId === 'internal://effect/multiband-dynamics';
        const compressorTitle = PLUGIN_TITLE_MAP[normalizedInternalId] ?? 'Compressor';
        const showDryWet = shouldShowDryWet(device);
        const thrParam = readSurfaceParam(device, 'thr', -18, 'dB');
        const ratioParam = readSurfaceParam(device, 'ratio', 4, ':1');
        const thr = thrParam.value;
        const ratio = ratioParam.value;
        // BUG-P8 FIX: Use real VU level for GR meter when available, fallback to static formula.
        const rawGr = Number.isFinite(device.vuLevel) ? Math.abs(device.vuLevel) : 0;
        const pseudoGr = rawGr > 0 ? Math.max(0, Math.min(24, rawGr)) : Math.max(0, Math.min(24, ((-thr) / 60) * ratio * 2.4));
        const atkParam = readSurfaceParam(device, ['atk', 'attack'], 10, 'ms');
        const relParam = readSurfaceParam(device, ['rel', 'release'], 80, 'ms');
        const atkMs = atkParam.value;
        const relMs = relParam.value;
        const attackNorm = Math.max(0, Math.min(1, Math.log10(Math.max(0.1, atkMs)) / Math.log10(200)));
        const releaseNorm = Math.max(0, Math.min(1, Math.log10(Math.max(1, relMs)) / Math.log10(1000)));
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
                        <svg viewBox="0 0 280 86" preserveAspectRatio="none" style={{ width: '100%', height: '100%' }}>
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
                    <div style={{ width: 46, height: 72, borderRadius: 'var(--radius-md)', background: 'var(--color-bg-tertiary)', border: 'var(--space-px) solid var(--color-divider)', padding: 3 }}>
                        <div style={{ width: '100%', height: `${(pseudoGr / 24) * 100}%`, marginTop: `${100 - (pseudoGr / 24) * 100}%`, background: 'var(--color-error)', borderRadius: 2 }} />
                    </div>
                    {showDryWet && (
                        <DryWetKnob
                            device={device}
                            onChange={onParamChange}
                            onGestureStart={onParamGestureStart}
                            onGestureEnd={onParamGestureEnd}
                            accent="var(--token-color-hex-6ac3ff)"
                        />
                    )}
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
                {knobParams.length > 0 && (
                    <div style={pluginPanelKnobGrid(`repeat(${Math.min(8, Math.max(3, knobParams.length || 3))}, minmax(0, 1fr))`)}>
                        {knobParams.map((p) => (
                            <PluginKnob
                                key={p.name}
                                param={p}
                                onChange={onParamChange}
                                onGestureStart={onParamGestureStart}
                                onGestureEnd={onParamGestureEnd}
                                compact
                            />
                        ))}
                    </div>
                )}
            </div>
        );
    }

    return null;
}
