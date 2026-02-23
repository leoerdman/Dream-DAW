import React from 'react';
import { PluginKnob } from '@/widgets/DeviceRack/StandardPluginControls';
import { pluginPanelKnobGrid } from '@/widgets/DeviceRack/ui/styles';
import { normalizeInternalPluginId } from '@/shared/lib/internalPlugins';
import type { DeviceSlot } from '@/widgets/DeviceRack/model/types';
import {
    pluginPanelCardBaseStyle,
    pluginPanelLayoutStyle,
    pluginPanelMetaStyle,
    pluginPanelTitleStyle,
    type SurfaceHandlers,
} from '@/widgets/DeviceRack/ui/PluginGuiSurfaceStandardShared';

export function renderStandardUtilityCompressorSurface(device: DeviceSlot, handlers: SurfaceHandlers): React.ReactNode {
    const { onParamChange, onParamGestureStart, onParamGestureEnd, onApplyUtilityScene } = handlers;
    const normalizedInternalId = normalizeInternalPluginId(device.pluginId || (device.guiMode || '').toLowerCase() || device.name.toLowerCase());

    if (device.effectType === 'utility') {
        const utilityTitle = normalizedInternalId === 'internal://effect/tuner'
            ? 'Tuner'
            : normalizedInternalId === 'internal://effect/external-audio-effect'
                ? 'External Audio Effect'
                : normalizedInternalId === 'internal://effect/auto-shift'
                    ? 'Auto Shift'
                    : normalizedInternalId === 'internal://effect/shifter'
                        ? 'Shifter'
                        : 'Utility';
        const isTuner = normalizedInternalId === 'internal://effect/tuner';
        const isExternalFx = normalizedInternalId === 'internal://effect/external-audio-effect';
        const isAutoShift = normalizedInternalId === 'internal://effect/auto-shift';
        const isShifter = normalizedInternalId === 'internal://effect/shifter';
        const gain = device.params.find((p) => p.name.toLowerCase() === 'gain')?.value ?? 0;
        const pan = device.params.find((p) => p.name.toLowerCase() === 'pan')?.value ?? 0;
        const width = device.params.find((p) => p.name.toLowerCase() === 'width')?.value ?? 100;
        const mono = (device.params.find((p) => p.name.toLowerCase() === 'mono')?.value ?? 0) > 0.5;
        const panPct = Math.max(-1, Math.min(1, pan / 100));
        const widthPct = Math.max(0, Math.min(1, width / 200));
        const shiftAmount = device.params.find((p) => p.name.toLowerCase().includes('shift'))?.value
            ?? device.params.find((p) => p.name.toLowerCase().includes('semitone'))?.value
            ?? 0;
        const hasUtilityCoreParams = device.params.some((p) => ['gain', 'pan', 'width', 'mono'].includes(p.name.toLowerCase()));
        return (
            <div style={pluginPanelLayoutStyle}>
                <div style={{
                    ...pluginPanelCardBaseStyle,
                    background: 'var(--plugin-bg-utility)',
                    display: 'grid',
                    gridTemplateColumns: '1fr 1fr',
                    gap: 10,
                    alignItems: 'center',
                }}>
                    {hasUtilityCoreParams ? (
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
                                {utilityTitle}: <span style={{ color: 'var(--color-text-primary)', fontFamily: 'var(--font-mono)' }}>{gain.toFixed(1)} dB</span>
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
                                </div>
                            )}
                            {(isAutoShift || isShifter) && (
                                <div style={{ gridColumn: '1 / span 2', display: 'grid', gap: 4 }}>
                                    <div style={{ fontSize: 'var(--font-size-xs)', color: 'var(--token-color-hex-a5bed8)', textTransform: 'uppercase', letterSpacing: '0.05em' }}>Shift</div>
                                    <div style={{ fontSize: 'var(--font-size-2xl)', color: 'var(--token-color-hex-dce9ff)', fontFamily: 'var(--font-mono)' }}>{shiftAmount.toFixed(1)} st</div>
                                </div>
                            )}
                            {isExternalFx && (
                                <div style={{ gridColumn: '1 / span 2', fontSize: 'var(--font-size-xs)', color: 'var(--token-color-hex-c2cfdb)', lineHeight: 1.4 }}>
                                    External routing host. Use device params below for send/return balance and compensation.
                                </div>
                            )}
                        </>
                    )}
                </div>
                <div style={pluginPanelKnobGrid('repeat(4, minmax(0, 1fr))')}>
                    {device.params.slice(0, 4).map((p) => (
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
            </div>
        );
    }

    if (device.effectType === 'compressor') {
        const isTransientShaper = normalizedInternalId === 'internal://effect/transient-shaper';
        const thr = device.params.find((p) => p.name.toLowerCase() === 'thr')?.value ?? -18;
        const ratio = device.params.find((p) => p.name.toLowerCase() === 'ratio')?.value ?? 4;
        const pseudoGr = Math.max(0, Math.min(24, ((-thr) / 60) * ratio * 2.4));
        const atkMs = device.params.find((p) => p.name.toLowerCase() === 'atk')?.value
            ?? device.params.find((p) => p.name.toLowerCase().includes('attack'))?.value
            ?? 10;
        const relMs = device.params.find((p) => p.name.toLowerCase() === 'rel')?.value
            ?? device.params.find((p) => p.name.toLowerCase().includes('release'))?.value
            ?? 80;
        const attackNorm = Math.max(0, Math.min(1, Math.log10(Math.max(0.1, atkMs)) / Math.log10(200)));
        const releaseNorm = Math.max(0, Math.min(1, Math.log10(Math.max(1, relMs)) / Math.log10(1000)));
        return (
            <div style={pluginPanelLayoutStyle}>
                <div style={{
                    ...pluginPanelCardBaseStyle,
                    background: 'var(--plugin-bg-compressor)',
                    display: 'grid',
                    gridTemplateColumns: '1fr auto',
                    gap: 10,
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
                                <span>Attack {atkMs.toFixed(1)} ms</span>
                                <span>Release {relMs.toFixed(1)} ms</span>
                            </div>
                        </div>
                    ) : (
                        <svg viewBox="0 0 280 86" preserveAspectRatio="none" style={{ width: '100%', height: '100%' }}>
                            <rect x="0" y="0" width="280" height="86" fill="var(--token-color-rgba-22-24-30-0d65)" />
                            <path d="M 14 70 L 120 70 Q 170 70 235 20 L 260 20" fill="none" stroke="var(--token-color-hex-6ac3ff)" strokeWidth="3" strokeLinecap="round" />
                            <line x1="14" y1="20" x2="14" y2="70" stroke="var(--token-color-rgba-255-255-255-0d2)" />
                            <line x1="14" y1="70" x2="260" y2="70" stroke="var(--token-color-rgba-255-255-255-0d2)" />
                        </svg>
                    )}
                    <div style={{ width: 46, height: 72, borderRadius: 'var(--radius-md)', background: 'var(--color-bg-tertiary)', border: 'var(--space-px) solid var(--color-divider)', padding: 3 }}>
                        <div style={{ width: '100%', height: `${(pseudoGr / 24) * 100}%`, marginTop: `${100 - (pseudoGr / 24) * 100}%`, background: 'var(--color-error)', borderRadius: 2 }} />
                    </div>
                    {!isTransientShaper && (
                        <div style={{ ...pluginPanelMetaStyle, gridColumn: '1 / -1' }}>
                            <span>Thr {thr.toFixed(1)} dB</span>
                            <span>Ratio {ratio.toFixed(1)}:1</span>
                            <span>Atk {atkMs.toFixed(1)} ms</span>
                            <span>Rel {relMs.toFixed(0)} ms</span>
                        </div>
                    )}
                </div>
                <div style={pluginPanelKnobGrid(`repeat(${Math.max(1, Math.min(4, device.params.length))}, minmax(0, 1fr))`)}>
                    {device.params.slice(0, 4).map((p) => (
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
            </div>
        );
    }

    return null;
}
