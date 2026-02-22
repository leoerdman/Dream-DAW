import React from 'react';
import { PluginKnob } from '@/widgets/DeviceRack/StandardPluginControls';
import { pluginPanelKnobGrid } from '@/widgets/DeviceRack/ui/styles';
import { normalizeInternalPluginId } from '@/shared/lib/internalPlugins';
import type { DeviceSlot } from '@/widgets/DeviceRack/model/types';

const pluginPanelLayoutStyle: React.CSSProperties = {
    display: 'grid',
    gridTemplateRows: '90px auto',
    gap: 'var(--plugin-grid-gap)',
    height: '100%',
};

const pluginPanelCardBaseStyle: React.CSSProperties = {
    border: '1px solid var(--plugin-card-border)',
    borderRadius: 'var(--plugin-card-radius)',
    padding: 'var(--plugin-card-pad-y) var(--plugin-card-pad-x)',
    display: 'grid',
    gridTemplateRows: '1fr auto',
    gap: 'var(--plugin-card-gap)',
    background: 'var(--plugin-card-bg-main)',
};

const pluginPanelTitleStyle: React.CSSProperties = {
    fontSize: 'var(--font-size-xs)',
    color: 'var(--plugin-title-color)',
    letterSpacing: '0.05em',
    textTransform: 'uppercase',
    fontWeight: 'var(--font-weight-bold)' as unknown as number,
};

const pluginPanelMetaStyle: React.CSSProperties = {
    display: 'flex',
    justifyContent: 'space-between',
    fontSize: 'var(--font-size-xs)',
    color: 'var(--plugin-meta-color)',
    fontFamily: 'var(--font-mono)',
};

type SurfaceHandlers = {
    onParamChange: (paramName: string, value: number) => void;
    onParamGestureStart?: (paramName: string, gestureGroupId?: string) => void;
    onParamGestureEnd?: (paramName: string) => void;
    onApplyUtilityScene?: (scene: 'center' | 'mono' | 'wide') => void;
};

export function renderStandardPluginGuiSurface(device: DeviceSlot, handlers: SurfaceHandlers): React.ReactNode {
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
                                <div style={{ fontSize: 'var(--font-size-2xs)', color: '#9fa7b5', marginBottom: 4 }}>Pan</div>
                                <div style={{ position: 'relative', height: 8, borderRadius: 'var(--radius-full)', background: 'var(--color-bg-tertiary)' }}>
                                    <div style={{ position: 'absolute', left: '50%', top: 0, bottom: 0, width: 1, background: 'rgba(255,255,255,0.2)' }} />
                                    <div style={{
                                        position: 'absolute',
                                        top: -3,
                                        left: `calc(${(panPct * 50 + 50).toFixed(3)}% - 5px)`,
                                        width: 10,
                                        height: 14,
                                        borderRadius: 'var(--radius-md)',
                                        background: '#56a7ff',
                                        boxShadow: '0 0 6px rgba(86,167,255,0.45)',
                                    }} />
                                </div>
                            </div>
                            <div>
                                <div style={{ fontSize: 'var(--font-size-2xs)', color: '#9fa7b5', marginBottom: 4 }}>Stereo Width</div>
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
                                    style={{ border: '1px solid var(--color-divider)', borderRadius: 'var(--radius-md)', background: 'var(--color-bg-header)', color: 'var(--color-text-secondary)', fontSize: 'var(--font-size-xs)', padding: '3px 8px', cursor: 'pointer' }}
                                >Center</button>
                                <button
                                    type="button"
                                    onClick={() => onApplyUtilityScene?.('mono')}
                                    style={{ border: '1px solid var(--color-divider)', borderRadius: 'var(--radius-md)', background: 'var(--color-bg-header)', color: 'var(--color-text-secondary)', fontSize: 'var(--font-size-xs)', padding: '3px 8px', cursor: 'pointer' }}
                                >Mono</button>
                                <button
                                    type="button"
                                    onClick={() => onApplyUtilityScene?.('wide')}
                                    style={{ border: '1px solid var(--color-divider)', borderRadius: 'var(--radius-md)', background: 'var(--color-bg-header)', color: 'var(--color-text-secondary)', fontSize: 'var(--font-size-xs)', padding: '3px 8px', cursor: 'pointer' }}
                                >Wide</button>
                            </div>
                        </>
                    ) : (
                        <>
                            <div style={{ gridColumn: '1 / span 2', ...pluginPanelTitleStyle, color: '#d9e3f2' }}>{utilityTitle}</div>
                            {isTuner && (
                                <div style={{ gridColumn: '1 / span 2', display: 'grid', gap: 4 }}>
                                    <div style={{ fontSize: 'var(--font-size-3xl)', color: '#a9d2ff', fontFamily: 'var(--font-mono)', textAlign: 'center' }}>A</div>
                                    <div style={{ height: 8, borderRadius: 'var(--radius-full)', background: '#1f2a36', position: 'relative' }}>
                                        <div style={{ position: 'absolute', left: '50%', top: 0, bottom: 0, width: 1, background: '#7ab6ff' }} />
                                    </div>
                                </div>
                            )}
                            {(isAutoShift || isShifter) && (
                                <div style={{ gridColumn: '1 / span 2', display: 'grid', gap: 4 }}>
                                    <div style={{ fontSize: 'var(--font-size-xs)', color: '#a5bed8', textTransform: 'uppercase', letterSpacing: '0.05em' }}>Shift</div>
                                    <div style={{ fontSize: 'var(--font-size-2xl)', color: '#dce9ff', fontFamily: 'var(--font-mono)' }}>{shiftAmount.toFixed(1)} st</div>
                                </div>
                            )}
                            {isExternalFx && (
                                <div style={{ gridColumn: '1 / span 2', fontSize: 'var(--font-size-xs)', color: '#c2cfdb', lineHeight: 1.4 }}>
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

    if (
        device.effectType === 'compressor'
    ) {
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
                            <div style={{ ...pluginPanelTitleStyle, color: '#b9d7ff' }}>Transient Shaper</div>
                            <div style={{ height: 8, borderRadius: 'var(--radius-full)', background: 'var(--color-bg-tertiary)', overflow: 'hidden' }}>
                                <div style={{ width: `${(attackNorm * 100).toFixed(1)}%`, height: '100%', background: '#53b0ff' }} />
                            </div>
                            <div style={{ height: 8, borderRadius: 'var(--radius-full)', background: 'var(--color-bg-tertiary)', overflow: 'hidden' }}>
                                <div style={{ width: `${(releaseNorm * 100).toFixed(1)}%`, height: '100%', background: '#78d6ad' }} />
                            </div>
                            <div style={pluginPanelMetaStyle}>
                                <span>Attack {atkMs.toFixed(1)} ms</span>
                                <span>Release {relMs.toFixed(1)} ms</span>
                            </div>
                        </div>
                    ) : (
                        <svg viewBox="0 0 280 86" preserveAspectRatio="none" style={{ width: '100%', height: '100%' }}>
                            <rect x="0" y="0" width="280" height="86" fill="rgba(22,24,30,0.65)" />
                            <path d="M 14 70 L 120 70 Q 170 70 235 20 L 260 20" fill="none" stroke="#6ac3ff" strokeWidth="3" strokeLinecap="round" />
                            <line x1="14" y1="20" x2="14" y2="70" stroke="rgba(255,255,255,0.2)" />
                            <line x1="14" y1="70" x2="260" y2="70" stroke="rgba(255,255,255,0.2)" />
                        </svg>
                    )}
                    <div style={{ width: 46, height: 72, borderRadius: 'var(--radius-md)', background: 'var(--color-bg-tertiary)', border: '1px solid var(--color-divider)', padding: 3 }}>
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

    if (device.effectType === 'delay') {
        const delayTitle = normalizedInternalId === 'internal://effect/echo'
            ? 'Echo'
            : normalizedInternalId === 'internal://effect/beat-repeat'
                ? 'Beat Repeat'
                : normalizedInternalId === 'internal://effect/looper'
                    ? 'Looper'
                    : normalizedInternalId === 'internal://effect/spectral-time'
                        ? 'Spectral Time'
                        : normalizedInternalId === 'internal://effect/grain-delay'
                            ? 'Grain Delay'
                            : 'Delay';
        const isBeatRepeat = delayTitle === 'Beat Repeat';
        const isLooper = delayTitle === 'Looper';
        const isSpectralTime = delayTitle === 'Spectral Time';
        const time = device.params.find((p) => p.name.toLowerCase() === 'time')?.value ?? 280;
        const fb = device.params.find((p) => p.name.toLowerCase() === 'fb')?.value ?? 30;
        const mix = device.params.find((p) => p.name.toLowerCase() === 'dry/wet')?.value ?? 35;
        return (
            <div style={pluginPanelLayoutStyle}>
                <div style={{
                    ...pluginPanelCardBaseStyle,
                    background: 'var(--plugin-bg-delay)',
                }}>
                    <svg viewBox="0 0 320 52" preserveAspectRatio="none" style={{ width: '100%', height: '100%' }}>
                        <rect x="0" y="0" width="320" height="52" fill="rgba(14,20,30,0.6)" />
                        {!isLooper && !isSpectralTime && !isBeatRepeat && Array.from({ length: 8 }).map((_, i) => {
                            const x = 16 + i * 36;
                            const h = 24 * Math.pow((fb / 100), i);
                            return <rect key={i} x={x} y={26 - h / 2} width="10" height={h} fill={i === 0 ? '#7cc4ff' : '#4a9eff'} opacity={0.95 - i * 0.08} rx="1.5" />;
                        })}
                        {isBeatRepeat && Array.from({ length: 16 }).map((_, i) => {
                            const x = 10 + i * 18;
                            const on = i % 4 === 0 || i % 7 === 0;
                            return <rect key={i} x={x} y={on ? 12 : 18} width="12" height={on ? 28 : 16} fill={on ? '#78c3ff' : 'rgba(120,170,230,0.35)'} rx="2" />;
                        })}
                        {isLooper && (
                            <>
                                <circle cx="160" cy="26" r="16" fill="none" stroke="rgba(124,196,255,0.45)" strokeWidth="2" />
                                <path d="M 160 10 A 16 16 0 1 1 148 16" fill="none" stroke="#7cc4ff" strokeWidth="3" strokeLinecap="round" />
                            </>
                        )}
                        {isSpectralTime && Array.from({ length: 24 }).map((_, i) => {
                            const x = 6 + i * 13;
                            const h = 8 + (Math.sin(i * 0.8) + 1) * 14;
                            return <rect key={i} x={x} y={26 - h / 2} width="8" height={h} fill="rgba(138,205,255,0.85)" rx="1.5" />;
                        })}
                    </svg>
                    <div style={pluginPanelMetaStyle}>
                        <span>{delayTitle}</span>
                        <span>{time.toFixed(0)}ms</span>
                        <span>FB {fb.toFixed(0)}%</span>
                        <span>Mix {mix.toFixed(0)}%</span>
                    </div>
                </div>
                <div style={pluginPanelKnobGrid(`repeat(${Math.min(6, Math.max(3, device.params.length))}, minmax(0, 1fr))`)}>
                    {device.params.slice(0, 6).map((p) => (
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

    if (device.effectType === 'reverb') {
        const reverbTitle = normalizedInternalId === 'internal://effect/hybrid-reverb'
            ? 'Hybrid Reverb'
            : normalizedInternalId === 'internal://effect/corpus'
                ? 'Corpus'
                : normalizedInternalId === 'internal://effect/resonators'
                    ? 'Resonators'
                    : normalizedInternalId === 'internal://effect/spectral-resonator'
                        ? 'Spectral Resonator'
                        : 'Reverb';
        const decay = device.params.find((p) => p.name.toLowerCase() === 'decay')?.value ?? 45;
        const tone = device.params.find((p) => p.name.toLowerCase() === 'tone')?.value ?? 0;
        const reverbMix = device.params.find((p) => p.name.toLowerCase() === 'dry/wet')?.value ?? 50;
        const reverbSize = device.params.find((p) => p.name.toLowerCase() === 'size')?.value ?? 40;
        return (
            <div style={pluginPanelLayoutStyle}>
                <div style={{
                    ...pluginPanelCardBaseStyle,
                    background: 'var(--plugin-bg-reverb)',
                }}>
                    <div style={{ position: 'relative', overflow: 'hidden', borderRadius: 'var(--radius-md)', background: 'rgba(10,10,12,0.45)' }}>
                        {Array.from({ length: 5 }).map((_, i) => (
                            <div
                                key={i}
                                style={{
                                    position: 'absolute',
                                    left: `${15 + i * 14}%`,
                                    top: '50%',
                                    width: `${24 + i * 12}px`,
                                    height: `${24 + i * 12}px`,
                                    marginTop: `${-(12 + i * 6)}px`,
                                    borderRadius: '50%',
                                    border: '1px solid rgba(192, 145, 255, 0.35)',
                                }}
                            />
                        ))}
                    </div>
                    <div style={pluginPanelMetaStyle}>
                        <span>{reverbTitle}</span>
                        <span>Size {reverbSize.toFixed(0)}%</span>
                        <span>Decay {decay.toFixed(0)}%</span>
                        <span>Tone {tone.toFixed(0)}%</span>
                        <span>Mix {reverbMix.toFixed(0)}%</span>
                    </div>
                </div>
                <div style={pluginPanelKnobGrid(`repeat(${Math.min(6, Math.max(3, device.params.length))}, minmax(0, 1fr))`)}>
                    {device.params.slice(0, 6).map((p) => (
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

    if (device.effectType === 'chorus') {
        const rate = device.params.find((p) => p.name.toLowerCase() === 'rate')?.value ?? 1.2;
        const depth = device.params.find((p) => p.name.toLowerCase() === 'depth')?.value ?? 40;
        const chorusMix = device.params.find((p) => p.name.toLowerCase() === 'dry/wet')?.value ?? 50;
        return (
            <div style={pluginPanelLayoutStyle}>
                <div style={{
                    ...pluginPanelCardBaseStyle,
                    background: 'var(--plugin-bg-chorus)',
                }}>
                    <svg viewBox="0 0 320 52" preserveAspectRatio="none" style={{ width: '100%', height: '100%' }}>
                        <rect x="0" y="0" width="320" height="52" fill="rgba(12, 11, 18, 0.65)" />
                        <path d="M 0 26 C 40 8, 80 44, 120 26 C 160 8, 200 44, 240 26 C 280 8, 320 44, 320 26" fill="none" stroke="#c867ff" strokeWidth="2.2" />
                        <path d="M 0 26 C 40 44, 80 8, 120 26 C 160 44, 200 8, 240 26 C 280 44, 320 8, 320 26" fill="none" stroke="#4ac0ff" strokeWidth="2.2" opacity="0.9" />
                    </svg>
                    <div style={pluginPanelMetaStyle}>
                        <span>{rate.toFixed(1)}Hz</span>
                        <span>Depth {depth.toFixed(0)}%</span>
                        <span>Mix {chorusMix.toFixed(0)}%</span>
                    </div>
                </div>
                <div style={pluginPanelKnobGrid(`repeat(${Math.min(5, Math.max(3, device.params.length))}, minmax(0, 1fr))`)}>
                    {device.params.slice(0, 5).map((p) => (
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

    if (device.effectType === 'saturator') {
        const satTitle = normalizedInternalId === 'internal://effect/drum-buss'
            ? 'Drum Buss'
            : normalizedInternalId === 'internal://effect/dynamic-tube'
                ? 'Dynamic Tube'
                : 'Saturator';
        const drive = device.params.find((p) => p.name.toLowerCase() === 'drive')?.value ?? 3;
        const satTone = device.params.find((p) => p.name.toLowerCase() === 'tone')?.value ?? 0;
        const satMix = device.params.find((p) => p.name.toLowerCase() === 'dry/wet')?.value ?? 100;
        const driveClamp = Math.max(0, Math.min(24, drive));
        const knee = Math.max(12, 80 - driveClamp * 2.8);
        return (
            <div style={pluginPanelLayoutStyle}>
                <div style={{
                    ...pluginPanelCardBaseStyle,
                    background: 'var(--plugin-bg-saturator)',
                }}>
                    <svg viewBox="0 0 320 52" preserveAspectRatio="none" style={{ width: '100%', height: '100%' }}>
                        <rect x="0" y="0" width="320" height="52" fill="rgba(20, 13, 9, 0.7)" />
                        <line x1="12" y1="46" x2="308" y2="6" stroke="rgba(255,172,89,0.18)" strokeWidth="1" strokeDasharray="3,3" />
                        <path d={`M 12 46 C ${knee} 46, ${160 - knee / 2} 6, 160 6 C ${160 + knee / 2} 6, ${320 - knee} 46, 308 46`} fill="none" stroke="#ffac59" strokeWidth={Math.max(2, 2 + driveClamp / 8)} strokeLinecap="round" />
                    </svg>
                    <div style={pluginPanelMetaStyle}>
                        <span>{satTitle}</span>
                        <span>Drive {drive.toFixed(1)} dB</span>
                        {satTone !== 0 && <span>Tone {satTone.toFixed(0)}%</span>}
                        <span>Mix {satMix.toFixed(0)}%</span>
                    </div>
                </div>
                <div style={pluginPanelKnobGrid(`repeat(${Math.min(4, Math.max(3, device.params.length))}, minmax(0, 1fr))`)}>
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

    if (device.effectType === 'limiter') {
        const thr = device.params.find((p) => p.name.toLowerCase() === 'thr')?.value ?? -0.3;
        const ceil = device.params.find((p) => p.name.toLowerCase() === 'ceil')?.value ?? -0.1;
        const safety = Math.max(0, Math.min(1, 1 - Math.abs(thr - ceil) / 30));
        const limGr = Math.max(0, Math.abs(thr) * 0.8);
        return (
            <div style={pluginPanelLayoutStyle}>
                <div style={{ ...pluginPanelCardBaseStyle, background: 'var(--plugin-bg-limiter)' }}>
                    <div style={{ ...pluginPanelTitleStyle, color: '#a4d9d3' }}>Lookahead Limiter</div>
                    <div style={{ height: 10, borderRadius: 'var(--radius-full)', background: 'var(--color-bg-tertiary)', overflow: 'hidden' }}>
                        <div style={{ width: `${(safety * 100).toFixed(1)}%`, height: '100%', background: 'var(--color-success)' }} />
                    </div>
                    <div style={pluginPanelMetaStyle}>
                        <span>Thr {thr.toFixed(1)} dB</span>
                        <span>Ceil {ceil.toFixed(1)} dB</span>
                        <span>GR ~{limGr.toFixed(1)} dB</span>
                    </div>
                </div>
                <div style={pluginPanelKnobGrid('repeat(3, minmax(0, 1fr))')}>
                    {device.params.slice(0, 3).map((p) => (
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

    if (device.effectType === 'gate') {
        const thr = device.params.find((p) => p.name.toLowerCase() === 'thr')?.value ?? -40;
        const range = device.params.find((p) => p.name.toLowerCase() === 'range')?.value ?? -80;
        const gateAtk = device.params.find((p) => p.name.toLowerCase() === 'atk')?.value ?? device.params.find((p) => p.name.toLowerCase().includes('attack'))?.value ?? 0.1;
        const gateRel = device.params.find((p) => p.name.toLowerCase() === 'rel')?.value ?? device.params.find((p) => p.name.toLowerCase().includes('release'))?.value ?? 50;
        const openness = Math.max(0, Math.min(1, (80 + thr) / 80));
        return (
            <div style={pluginPanelLayoutStyle}>
                <div style={{ ...pluginPanelCardBaseStyle, background: 'var(--plugin-bg-gate)' }}>
                    <div style={{ ...pluginPanelTitleStyle, color: '#b8dfad' }}>Noise Gate</div>
                    <div style={{ height: 34, borderRadius: 'var(--radius-md)', background: 'var(--color-bg-tertiary)', position: 'relative' }}>
                        <div style={{ position: 'absolute', left: 0, top: 0, bottom: 0, width: `${(openness * 100).toFixed(1)}%`, background: 'var(--color-success)' }} />
                    </div>
                    <div style={pluginPanelMetaStyle}>
                        <span>Thr {thr.toFixed(1)} dB</span>
                        <span>Range {range.toFixed(1)} dB</span>
                        <span>Atk {gateAtk.toFixed(1)} ms</span>
                        <span>Rel {gateRel.toFixed(0)} ms</span>
                    </div>
                </div>
                <div style={pluginPanelKnobGrid('repeat(5, minmax(0, 1fr))')}>
                    {device.params.slice(0, 5).map((p) => (
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

    if (device.effectType === 'autoFilter' || device.effectType === 'autoPan' || device.effectType === 'phaser' || device.effectType === 'flanger') {
        const params = device.params;
        const isVocoder = normalizedInternalId === 'internal://effect/vocoder';
        const modRate = params.find((p) => p.name.toLowerCase() === 'rate')?.value ?? 0;
        const modDepth = params.find((p) => p.name.toLowerCase() === 'depth')?.value ?? 0;
        const modMix = params.find((p) => p.name.toLowerCase() === 'dry/wet')?.value ?? params.find((p) => p.name.toLowerCase() === 'amount')?.value ?? 50;
        const modFreq = params.find((p) => p.name.toLowerCase() === 'freq' || p.name.toLowerCase() === 'frequency')?.value ?? 0;
        const title = isVocoder
            ? 'Vocoder'
            : device.effectType === 'autoFilter'
                ? 'Auto Filter'
                : device.effectType === 'autoPan'
                    ? 'Auto Pan'
                    : device.effectType === 'phaser'
                        ? 'Phaser'
                        : 'Flanger';
        const hue = device.effectType === 'autoFilter'
            ? '#4cc9d8'
            : device.effectType === 'autoPan'
                ? '#6db3ff'
                : device.effectType === 'phaser'
                    ? '#998bff'
                    : '#66b3ff';
        return (
            <div style={pluginPanelLayoutStyle}>
                <div style={{
                    ...pluginPanelCardBaseStyle,
                    background: 'var(--plugin-bg-mod)',
                }}>
                    <svg viewBox="0 0 320 52" preserveAspectRatio="none" style={{ width: '100%', height: '100%' }}>
                        <rect x="0" y="0" width="320" height="52" fill="rgba(8, 10, 14, 0.65)" />
                        {!isVocoder && (
                            <path d="M 0 30 C 32 10, 64 46, 96 26 C 128 6, 160 44, 192 24 C 224 8, 256 42, 288 22 C 304 12, 320 26, 320 26" fill="none" stroke={hue} strokeWidth="2.4" />
                        )}
                        {isVocoder && Array.from({ length: 20 }).map((_, i) => {
                            const x = 8 + i * 15;
                            const h = 8 + ((i * 17) % 34);
                            return <rect key={i} x={x} y={42 - h} width="9" height={h} rx="1.5" fill="rgba(120,200,255,0.9)" />;
                        })}
                    </svg>
                    <div style={pluginPanelMetaStyle}>
                        <span>{title}</span>
                        {modRate > 0 && <span>{modRate.toFixed(2)} Hz</span>}
                        {modDepth > 0 && <span>Depth {modDepth.toFixed(0)}%</span>}
                        {modFreq > 0 && <span>Freq {modFreq.toFixed(0)} Hz</span>}
                        <span>Mix {modMix.toFixed(0)}%</span>
                    </div>
                </div>
                <div style={pluginPanelKnobGrid(`repeat(${Math.min(6, Math.max(3, params.length))}, minmax(0, 1fr))`)}>
                    {params.slice(0, 6).map((p) => (
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

    if (device.effectType === 'distortion' || device.effectType === 'bitcrusher') {
        const title = device.effectType === 'bitcrusher'
            ? 'Bitcrusher'
            : normalizedInternalId === 'internal://effect/amp'
                ? 'Amp'
                : normalizedInternalId === 'internal://effect/cabinet'
                    ? 'Cabinet'
                    : normalizedInternalId === 'internal://effect/erosion'
                        ? 'Erosion'
                        : normalizedInternalId === 'internal://effect/overdrive'
                            ? 'Overdrive'
                            : normalizedInternalId === 'internal://effect/pedal'
                                ? 'Pedal'
                                : normalizedInternalId === 'internal://effect/roar'
                                    ? 'Roar'
                                    : 'Distortion';
        const color = device.effectType === 'distortion' ? '#ff965e' : '#f2de72';
        const drive = device.params.find((p) => p.name.toLowerCase() === 'drive')?.value ?? 0;
        const mix = device.params.find((p) => p.name.toLowerCase() === 'mix')?.value ?? 0;
        const tone = device.params.find((p) => p.name.toLowerCase() === 'tone')?.value ?? 0;
        const isAmp = title === 'Amp' || title === 'Cabinet';
        const isErosion = title === 'Erosion';
        const isBit = title === 'Bitcrusher';
        return (
            <div style={pluginPanelLayoutStyle}>
                <div style={{
                    ...pluginPanelCardBaseStyle,
                    background: 'var(--plugin-bg-distortion)',
                }}>
                    <div style={{ ...pluginPanelTitleStyle, color: '#d6c1a5' }}>{title}</div>
                    <svg viewBox="0 0 320 52" preserveAspectRatio="none" style={{ width: '100%', height: 44 }}>
                        <rect x="0" y="0" width="320" height="52" fill="rgba(20, 13, 9, 0.65)" />
                        {!isAmp && !isErosion && !isBit && (
                            <path d="M 8 44 L 48 12 L 88 44 L 128 12 L 168 44 L 208 12 L 248 44 L 312 16" fill="none" stroke={color} strokeWidth="2.2" />
                        )}
                        {isAmp && (
                            <>
                                {Array.from({ length: 7 }).map((_, i) => (
                                    <line key={i} x1={18 + i * 45} y1={8} x2={18 + i * 45} y2={44} stroke="rgba(255,170,110,0.35)" />
                                ))}
                                <path d="M 6 43 C 52 38, 86 16, 126 18 C 166 20, 210 42, 260 36 C 282 33, 302 29, 316 22" fill="none" stroke="#ffb57a" strokeWidth="2.4" />
                            </>
                        )}
                        {isErosion && (
                            <>
                                {Array.from({ length: 24 }).map((_, i) => {
                                    const x = 8 + i * 13;
                                    const h = 8 + ((i * 19) % 30);
                                    return <rect key={i} x={x} y={42 - h} width="6" height={h} rx="1" fill="rgba(255,156,94,0.82)" />;
                                })}
                            </>
                        )}
                        {isBit && (
                            <>
                                {Array.from({ length: 16 }).map((_, i) => {
                                    const x = 12 + i * 18;
                                    const high = i % 2 === 0 || i % 5 === 0;
                                    return <rect key={i} x={x} y={high ? 14 : 26} width="12" height={high ? 24 : 12} fill="rgba(242,222,114,0.9)" rx="1.5" />;
                                })}
                            </>
                        )}
                    </svg>
                    <div style={pluginPanelMetaStyle}>
                        <span>Drive {drive.toFixed(1)}</span>
                        <span>Tone {tone.toFixed(2)}</span>
                        <span>Mix {mix.toFixed(2)}</span>
                    </div>
                </div>
                <div style={pluginPanelKnobGrid(`repeat(${Math.min(4, Math.max(3, device.params.length))}, minmax(0, 1fr))`)}>
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

    if (device.effectType === 'noiseMachine') {
        const type = Math.round(device.params.find((p) => p.name.toLowerCase() === 'type')?.value ?? 0);
        const level = device.params.find((p) => p.name.toLowerCase() === 'level')?.value ?? -30;
        const stereo = device.params.find((p) => p.name.toLowerCase() === 'stereo')?.value ?? 0.5;
        const typeLabel = type <= 0 ? 'Vinyl' : type === 1 ? 'Air' : 'Storm';
        return (
            <div style={pluginPanelLayoutStyle}>
                <div style={{
                    ...pluginPanelCardBaseStyle,
                    background: 'var(--plugin-bg-noise)',
                }}>
                    <div style={{ ...pluginPanelTitleStyle, color: '#a5d6b0' }}>Noise Machine</div>
                    <svg viewBox="0 0 320 52" preserveAspectRatio="none" style={{ width: '100%', height: 44 }}>
                        <rect x="0" y="0" width="320" height="52" fill="rgba(12, 18, 12, 0.65)" />
                        <path d="M 4 26 L 12 10 L 20 38 L 28 18 L 36 42 L 44 14 L 52 34 L 60 8 L 68 40 L 76 20 L 84 36 L 92 12 L 100 44 L 108 16 L 116 38 L 124 22 L 132 40 L 140 10 L 148 34 L 156 18 L 164 42 L 172 14 L 180 36 L 188 8 L 196 40 L 204 20 L 212 38 L 220 12 L 228 44 L 236 16 L 244 34 L 252 22 L 260 40 L 268 10 L 276 38 L 284 18 L 292 42 L 300 14 L 308 36 L 316 26" fill="none" stroke="#72d68a" strokeWidth="1.6" />
                    </svg>
                    <div style={pluginPanelMetaStyle}>
                        <span>{typeLabel}</span>
                        <span>Level {level.toFixed(1)} dB</span>
                        <span>Stereo {(stereo * 100).toFixed(0)}%</span>
                    </div>
                </div>
                <div style={pluginPanelKnobGrid(`repeat(${Math.min(6, device.params.length)}, minmax(0, 1fr))`)}>
                    {device.params.slice(0, 6).map((p) => (
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

    if (device.effectType === 'analyzer' || device.effectType === 'spectrum' || device.effectType === 'midiPitch' || device.effectType === 'midiScale' || device.effectType === 'midiVelocity' || device.effectType === 'midiRandom') {
        const title = device.effectType === 'analyzer' || device.effectType === 'spectrum'
            ? 'Analyzer'
            : device.effectType === 'midiPitch'
                ? 'MIDI Pitch'
                : device.effectType === 'midiScale'
                    ? (normalizedInternalId === 'internal://midi-fx/chord' ? 'Chord' : 'MIDI Scale')
                    : device.effectType === 'midiVelocity'
                        ? (normalizedInternalId === 'internal://midi-fx/note-length' ? 'Note Length' : normalizedInternalId === 'internal://midi-fx/cc-control' ? 'CC Control' : normalizedInternalId === 'internal://midi-fx/expression-control' ? 'Expression Control' : 'MIDI Velocity')
                        : (normalizedInternalId === 'internal://midi-fx/arpeggiator' ? 'Arpeggiator' : 'MIDI Random');
        const spectrumBars = Array.from({ length: 24 }).map((_, idx) => {
            const t = idx / 23;
            const h = 18 + Math.sin((idx + 1) * 0.62) * 9 + (1 - Math.abs(0.5 - t) * 2) * 20;
            return { x: 8 + idx * 13, h: Math.max(4, h) };
        });
        const semitones = device.params.find((p) => p.name.toLowerCase() === 'semitones')?.value ?? 0;
        const root = device.params.find((p) => p.name.toLowerCase() === 'root')?.value ?? 0;
        const chance = device.params.find((p) => p.name.toLowerCase() === 'chance')?.value ?? 0;
        const velGain = device.params.find((p) => p.name.toLowerCase() === 'gain')?.value ?? 1;
        const velOffset = device.params.find((p) => p.name.toLowerCase() === 'offset')?.value ?? 0;
        const isNoteLength = normalizedInternalId === 'internal://midi-fx/note-length';
        const isCcControl = normalizedInternalId === 'internal://midi-fx/cc-control';
        const isExpressionControl = normalizedInternalId === 'internal://midi-fx/expression-control';
        const isArp = normalizedInternalId === 'internal://midi-fx/arpeggiator';
        const noteNames = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];
        const activeRoot = Math.max(0, Math.min(11, Math.round(root) % 12));
        return (
            <div style={pluginPanelLayoutStyle}>
                <div style={{ ...pluginPanelCardBaseStyle, background: 'var(--plugin-bg-midi)' }}>
                    <div style={{ ...pluginPanelTitleStyle, color: '#b8c8e8' }}>{title}</div>
                    {device.effectType === 'spectrum' && (
                        <svg viewBox="0 0 320 52" preserveAspectRatio="none" style={{ width: '100%', height: 46 }}>
                            <rect x="0" y="0" width="320" height="52" fill="rgba(8, 10, 14, 0.7)" />
                            {spectrumBars.map((bar, idx) => (
                                <rect
                                    key={idx}
                                    x={bar.x}
                                    y={46 - bar.h}
                                    width="8"
                                    height={bar.h}
                                    rx="1.2"
                                    fill={bar.h > 30 ? 'rgba(255,180,102,0.92)' : 'rgba(122,198,255,0.92)'}
                                />
                            ))}
                        </svg>
                    )}
                    {device.effectType === 'analyzer' && (
                        <div style={{
                            display: 'grid',
                            gridTemplateColumns: '1fr 1fr',
                            gap: 6,
                            padding: '4px 8px',
                            height: 80,
                            background: 'rgba(8, 10, 14, 0.7)',
                            borderRadius: 'var(--radius-md)',
                        }}>
                            {/* Left channel meter */}
                            <div style={{ display: 'flex', flexDirection: 'column', gap: 3 }}>
                                <div style={{ fontSize: 9, color: '#7a9ec4', fontFamily: 'var(--font-mono)', letterSpacing: '0.05em' }}>PEAK L</div>
                                <div style={{ flex: 1, background: '#0d1117', borderRadius: 2, overflow: 'hidden', position: 'relative' }}>
                                    <div style={{
                                        position: 'absolute', bottom: 0, left: 0, right: 0,
                                        height: `${Math.max(1, Math.min(100, (1 - Math.max(0, -device.vuLevelL) / 60) * 100))}%`,
                                        background: device.vuLevelL > -3 ? 'var(--color-error)' : device.vuLevelL > -12 ? 'var(--color-warning)' : 'var(--color-success)',
                                        borderRadius: 2,
                                        transition: 'height 60ms linear',
                                    }} />
                                </div>
                                <div style={{ fontSize: 10, color: '#95bdff', fontFamily: 'var(--font-mono)', textAlign: 'center' }}>
                                    {device.vuLevelL > -100 ? device.vuLevelL.toFixed(1) : '-∞'}
                                </div>
                            </div>
                            {/* Right channel meter */}
                            <div style={{ display: 'flex', flexDirection: 'column', gap: 3 }}>
                                <div style={{ fontSize: 9, color: '#7a9ec4', fontFamily: 'var(--font-mono)', letterSpacing: '0.05em' }}>PEAK R</div>
                                <div style={{ flex: 1, background: '#0d1117', borderRadius: 2, overflow: 'hidden', position: 'relative' }}>
                                    <div style={{
                                        position: 'absolute', bottom: 0, left: 0, right: 0,
                                        height: `${Math.max(1, Math.min(100, (1 - Math.max(0, -device.vuLevelR) / 60) * 100))}%`,
                                        background: device.vuLevelR > -3 ? 'var(--color-error)' : device.vuLevelR > -12 ? 'var(--color-warning)' : 'var(--color-success)',
                                        borderRadius: 2,
                                        transition: 'height 60ms linear',
                                    }} />
                                </div>
                                <div style={{ fontSize: 10, color: '#95bdff', fontFamily: 'var(--font-mono)', textAlign: 'center' }}>
                                    {device.vuLevelR > -100 ? device.vuLevelR.toFixed(1) : '-∞'}
                                </div>
                            </div>
                        </div>
                    )}
                    {device.effectType === 'midiPitch' && (
                        <div style={{ display: 'grid', placeItems: 'center', height: 46 }}>
                            <div style={{ fontFamily: 'var(--font-mono)', fontSize: 'var(--font-size-3xl)', color: '#95bdff' }}>
                                {semitones >= 0 ? '+' : ''}{semitones.toFixed(0)} st
                            </div>
                        </div>
                    )}
                    {device.effectType === 'midiScale' && (
                        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(12, minmax(0, 1fr))', gap: 3, height: 46, alignItems: 'center' }}>
                            {noteNames.map((n, idx) => (
                                <div
                                    key={n}
                                    style={{
                                        borderRadius: 'var(--radius-sm)',
                                        border: idx === activeRoot ? '1px solid #8bc27a' : '1px solid rgba(255,255,255,0.14)',
                                        background: idx === activeRoot ? 'rgba(139,194,122,0.22)' : 'rgba(160,180,210,0.1)',
                                        color: idx === activeRoot ? '#d9f3d1' : '#a8b7cd',
                                        fontSize: 'var(--font-size-2xs)',
                                        textAlign: 'center',
                                        padding: '3px 0',
                                    }}
                                >
                                    {n}
                                </div>
                            ))}
                        </div>
                    )}
                    {device.effectType === 'midiVelocity' && (
                        <div style={{ display: 'grid', gap: 6, height: 46 }}>
                            {isNoteLength ? (
                                <>
                                    <div style={{ height: 8, borderRadius: 'var(--radius-full)', background: 'var(--color-bg-tertiary)', overflow: 'hidden' }}>
                                        <div style={{ width: `${Math.max(0, Math.min(100, velGain * 50)).toFixed(1)}%`, height: '100%', background: 'var(--color-accent-primary)' }} />
                                    </div>
                                    <div style={{ fontSize: 'var(--font-size-xs)', color: '#c5d7ea', fontFamily: 'var(--font-mono)' }}>Gate {(velGain * 100).toFixed(0)}%</div>
                                </>
                            ) : (
                                <>
                                    <div style={{ height: 8, borderRadius: 'var(--radius-full)', background: 'var(--color-bg-tertiary)', overflow: 'hidden' }}>
                                        <div style={{ width: `${Math.max(0, Math.min(200, velGain * 100)).toFixed(1)}%`, height: '100%', background: 'var(--color-accent-primary)' }} />
                                    </div>
                                    <div style={{ height: 8, borderRadius: 'var(--radius-full)', background: '#1e2430', overflow: 'hidden', position: 'relative' }}>
                                        <div style={{ position: 'absolute', left: '50%', top: 0, bottom: 0, width: 1, background: 'rgba(255,255,255,0.2)' }} />
                                        <div style={{
                                            position: 'absolute',
                                            left: `calc(${Math.max(0, Math.min(100, (velOffset + 64) / 128 * 100)).toFixed(1)}% - 5px)`,
                                            top: -2,
                                            width: 10,
                                            height: 12,
                                            borderRadius: 'var(--radius-md)',
                                            background: isCcControl || isExpressionControl ? '#8ecb7c' : '#d9a25c',
                                        }} />
                                    </div>
                                </>
                            )}
                        </div>
                    )}
                    {device.effectType === 'midiRandom' && (
                        <div style={{ display: 'grid', alignItems: 'center', gap: 4, height: 46 }}>
                            <div style={{ height: 8, borderRadius: 'var(--radius-full)', background: 'var(--color-bg-tertiary)', overflow: 'hidden' }}>
                                <div style={{ width: `${Math.max(0, Math.min(100, chance * 100)).toFixed(1)}%`, height: '100%', background: 'var(--color-accent-primary)' }} />
                            </div>
                            <div style={{ fontSize: 'var(--font-size-xs)', color: '#cfa4e6', fontFamily: 'var(--font-mono)' }}>
                                {isArp
                                    ? `Arp Gate ${(chance * 100).toFixed(0)}% | Steps ${Math.max(1, Math.round(Math.abs(semitones) || 8))}`
                                    : `Chance ${(chance * 100).toFixed(0)}% | Range ±${Math.abs(semitones).toFixed(0)} st`}
                            </div>
                        </div>
                    )}
                    <div style={pluginPanelMetaStyle}>
                        <span>{device.effectType === 'analyzer' || device.effectType === 'spectrum' ? 'Analyzer (native)' : 'MIDI FX (import-compatible)'}</span>
                    </div>
                </div>
                {device.params.length > 0 && (
                    <div style={pluginPanelKnobGrid(`repeat(${Math.min(4, Math.max(2, device.params.length))}, minmax(0, 1fr))`)}>
                        {device.params.map((p) => (
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
