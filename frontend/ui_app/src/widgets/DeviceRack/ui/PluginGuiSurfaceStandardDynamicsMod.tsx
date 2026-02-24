// ═══════════════════════════════════════════════════════════════════════════
// Dream DAW — Plugin Surfaces: Dynamics & Modulation
// Handles: limiter, gate, autoFilter, autoPan, phaser, flanger
// Each effect now has a unique SVG visualization + Dry/Wet knob on right.
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
    hasMixParam,
    pluginPanelCardBaseStyle,
    pluginPanelLayoutStyle,
    pluginPanelMetaStyle,
    pluginPanelTitleStyle,
    readSurfaceParam,
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

/* ═══════════════════════════════════════════════════════════════════════ */
/* LIMITER                                                                */
/* ═══════════════════════════════════════════════════════════════════════ */
function renderLimiterSurface(device: DeviceSlot, handlers: SurfaceHandlers): React.ReactNode {
    const { onParamChange, onParamGestureStart, onParamGestureEnd } = handlers;
    const showDryWet = hasMixParam(device);
    const knobParams = buildSurfaceKnobParams(device, { omitMixWhenDryWet: showDryWet });
    const thrParam = readSurfaceParam(device, 'thr', -0.3, 'dB');
    const ceilParam = readSurfaceParam(device, 'ceil', -0.1, 'dB');
    const thr = thrParam.value;
    const ceil = ceilParam.value;
    const safety = Math.max(0, Math.min(1, 1 - Math.abs(thr - ceil) / 30));
    const limGr = Math.max(0, Math.abs(thr) * 0.8);
    const grBarH = Math.max(0, Math.min(100, (limGr / 24) * 100));
    return (
        <div data-no-drag style={pluginPanelLayoutStyle}>
            <div style={{ ...panelWithOptionalDryWet(showDryWet), background: 'var(--plugin-bg-limiter)' }}>
                <div style={{ display: 'grid', gap: 6 }}>
                    <div style={{ ...pluginPanelTitleStyle, color: 'var(--token-color-hex-a4d9d3)' }}>Lookahead Limiter</div>
                    {/* GR meter bar (horizontal) */}
                    <svg viewBox="0 0 280 28" preserveAspectRatio="none" style={{ width: '100%', height: 28 }}>
                        <rect x="0" y="0" width="280" height="28" rx="4" fill="var(--token-color-rgba-8-10-14-0d65)" />
                        {/* Threshold line */}
                        <line x1={14 + (1 + thr / 60) * 240} y1="2" x2={14 + (1 + thr / 60) * 240} y2="26" stroke="var(--token-color-hex-f0a66e)" strokeWidth="1.5" strokeDasharray="3,2" />
                        {/* Ceiling line */}
                        <line x1={14 + (1 + ceil / 60) * 240} y1="2" x2={14 + (1 + ceil / 60) * 240} y2="26" stroke="var(--token-color-hex-ff6b6b)" strokeWidth="1.5" />
                        {/* Safety bar */}
                        <rect x="14" y="8" width={Math.max(2, safety * 240)} height="12" rx="2" fill="var(--color-success)" opacity="0.85" />
                    </svg>
                    {/* GR vertical bar */}
                    <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
                        <div style={{ width: 36, height: 6, borderRadius: 'var(--radius-full)', background: 'var(--color-bg-tertiary)', overflow: 'hidden' }}>
                            <div style={{ width: `${grBarH}%`, height: '100%', background: 'var(--color-error)', transition: 'width 60ms linear' }} />
                        </div>
                        <span style={{ fontSize: 'var(--font-size-2xs)', fontFamily: 'var(--font-mono)', color: 'var(--color-text-tertiary)' }}>
                            GR ~{limGr.toFixed(1)} dB
                        </span>
                    </div>
                    <div style={pluginPanelMetaStyle}>
                        <span>Thr {formatSurfaceParam(thrParam)}</span>
                        <span>Ceil {formatSurfaceParam(ceilParam)}</span>
                    </div>
                </div>
                {showDryWet && (
                    <DryWetKnob
                        device={device}
                        onChange={onParamChange}
                        onGestureStart={onParamGestureStart}
                        onGestureEnd={onParamGestureEnd}
                        accent="var(--token-color-hex-56d4c8)"
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

/* ═══════════════════════════════════════════════════════════════════════ */
/* GATE                                                                   */
/* ═══════════════════════════════════════════════════════════════════════ */
function renderGateSurface(device: DeviceSlot, handlers: SurfaceHandlers): React.ReactNode {
    const { onParamChange, onParamGestureStart, onParamGestureEnd } = handlers;
    const showDryWet = hasMixParam(device);
    const knobParams = buildSurfaceKnobParams(device, { omitMixWhenDryWet: showDryWet });
    const thrParam = readSurfaceParam(device, 'thr', -40, 'dB');
    const rangeParam = readSurfaceParam(device, 'range', -80, 'dB');
    const gateAtkParam = readSurfaceParam(device, ['atk', 'attack'], 0.1, 'ms');
    const gateRelParam = readSurfaceParam(device, ['rel', 'release'], 50, 'ms');
    const thr = thrParam.value;
    const thrNorm = Math.max(0, Math.min(1, (thr + 60) / 60));
    return (
        <div data-no-drag style={pluginPanelLayoutStyle}>
            <div style={{ ...panelWithOptionalDryWet(showDryWet), background: 'var(--plugin-bg-gate)' }}>
                <div style={{ display: 'grid', gap: 6 }}>
                    <div style={{ ...pluginPanelTitleStyle, color: 'var(--token-color-hex-b8dfad)' }}>Noise Gate</div>
                    {/* SVG gate visualization with threshold, attack & release curves */}
                    <svg viewBox="0 0 280 48" preserveAspectRatio="none" style={{ width: '100%', height: 48 }}>
                        <rect x="0" y="0" width="280" height="48" rx="4" fill="var(--token-color-rgba-8-14-8-0d65)" />
                        {/* Signal level bars */}
                        {Array.from({ length: 14 }).map((_, i) => {
                            const x = 10 + i * 19;
                            const h = 6 + Math.abs(Math.sin((i + 1) * 0.95)) * 30;
                            const aboveThreshold = (h / 42) > thrNorm * 0.8;
                            return <rect key={i} x={x} y={42 - h} width="12" height={h} rx="2"
                                fill={aboveThreshold ? 'var(--token-color-hex-8ec77c)' : 'var(--token-color-rgba-140-200-120-0d25)'}
                                stroke={aboveThreshold ? 'none' : 'var(--token-color-rgba-140-200-120-0d15)'}
                                strokeWidth="0.5"
                            />;
                        })}
                        {/* Threshold line */}
                        <line x1="4" y1={42 - thrNorm * 36} x2="276" y2={42 - thrNorm * 36} stroke="var(--token-color-hex-e6c36e)" strokeWidth="1.2" strokeDasharray="4,3" />
                    </svg>
                    <div style={pluginPanelMetaStyle}>
                        <span>Thr {formatSurfaceParam(thrParam)}</span>
                        <span>Range {formatSurfaceParam(rangeParam)}</span>
                        <span>Atk {formatSurfaceParam(gateAtkParam)}</span>
                        <span>Rel {formatSurfaceParam(gateRelParam)}</span>
                    </div>
                </div>
                {showDryWet && (
                    <DryWetKnob
                        device={device}
                        onChange={onParamChange}
                        onGestureStart={onParamGestureStart}
                        onGestureEnd={onParamGestureEnd}
                        accent="var(--token-color-hex-8ec77c)"
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

/* ═══════════════════════════════════════════════════════════════════════ */
/* AUTO FILTER — Unique: Frequency response curve                         */
/* ═══════════════════════════════════════════════════════════════════════ */
function renderAutoFilterSurface(device: DeviceSlot, handlers: SurfaceHandlers): React.ReactNode {
    const { onParamChange, onParamGestureStart, onParamGestureEnd } = handlers;
    const showDryWet = hasMixParam(device);
    const knobParams = buildSurfaceKnobParams(device, { omitMixWhenDryWet: showDryWet });
    const normalizedInternalId = normalizeInternalPluginId(device.pluginId || (device.guiMode || '').toLowerCase() || device.name.toLowerCase());
    const title = PLUGIN_TITLE_MAP[normalizedInternalId] ?? 'Auto Filter';
    const isVocoder = normalizedInternalId === 'internal://effect/vocoder';
    const modRate = readSurfaceParam(device, 'rate', 0, 'Hz');
    const modDepth = readSurfaceParam(device, 'depth', 0, '%');
    const modFreq = readSurfaceParam(device, ['freq', 'frequency', 'cutoff', 'center'], 1000, 'Hz');
    // Normalize cutoff position for SVG (log scale 20Hz – 20kHz)
    const freqNorm = Math.max(0, Math.min(1, (Math.log10(Math.max(20, modFreq.value)) - Math.log10(20)) / (Math.log10(20000) - Math.log10(20))));
    const peakX = 20 + freqNorm * 260;
    return (
        <div data-no-drag style={pluginPanelLayoutStyle}>
            <div style={{ ...panelWithOptionalDryWet(showDryWet), background: 'var(--plugin-bg-mod)' }}>
                <div style={{ display: 'grid', gap: 6 }}>
                    <div style={{ ...pluginPanelTitleStyle, color: 'var(--token-color-hex-4cc9d8)' }}>{title}</div>
                    <svg viewBox="0 0 300 52" preserveAspectRatio="none" style={{ width: '100%', height: 48 }}>
                        <rect x="0" y="0" width="300" height="52" rx="4" fill="var(--token-color-rgba-8-10-14-0d65)" />
                        {isVocoder ? (
                            /* Vocoder: formant bands */
                            <>
                                {Array.from({ length: 20 }).map((_, i) => {
                                    const x = 8 + i * 14.5;
                                    const h = 8 + ((i * 17) % 34);
                                    return <rect key={i} x={x} y={46 - h} width="9" height={h} rx="1.5" fill="var(--token-color-rgba-76-201-216-0d85)" />;
                                })}
                            </>
                        ) : (
                            /* Filter response curve with resonance peak at cutoff */
                            <>
                                {/* Flat baseline */}
                                <line x1="4" y1="42" x2="296" y2="42" stroke="var(--token-color-rgba-76-201-216-0d2)" strokeWidth="0.8" />
                                {/* Response curve: LP-style sweep */}
                                <path
                                    d={`M 4 42 L ${Math.max(4, peakX - 40)} 42 Q ${peakX - 15} 42, ${peakX} 10 Q ${peakX + 15} 42, ${peakX + 30} 46 L 296 46`}
                                    fill="none"
                                    stroke="var(--token-color-hex-4cc9d8)"
                                    strokeWidth="2.4"
                                    strokeLinecap="round"
                                />
                                {/* Cutoff marker */}
                                <line x1={peakX} y1="4" x2={peakX} y2="48" stroke="var(--token-color-rgba-76-201-216-0d35)" strokeWidth="1" strokeDasharray="2,2" />
                            </>
                        )}
                    </svg>
                    <div style={pluginPanelMetaStyle}>
                        <span>{title}</span>
                        {modRate.value > 0 && <span>{formatSurfaceParam(modRate)}</span>}
                        {modDepth.value > 0 && <span>Depth {formatSurfaceParam(modDepth)}</span>}
                        <span>Freq {formatSurfaceParam(modFreq)}</span>
                    </div>
                </div>
                {showDryWet && (
                    <DryWetKnob
                        device={device}
                        onChange={onParamChange}
                        onGestureStart={onParamGestureStart}
                        onGestureEnd={onParamGestureEnd}
                        accent="var(--token-color-hex-4cc9d8)"
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

/* ═══════════════════════════════════════════════════════════════════════ */
/* AUTO PAN — Unique: L/R stereo field indicator                          */
/* ═══════════════════════════════════════════════════════════════════════ */
function renderAutoPanSurface(device: DeviceSlot, handlers: SurfaceHandlers): React.ReactNode {
    const { onParamChange, onParamGestureStart, onParamGestureEnd } = handlers;
    const showDryWet = hasMixParam(device);
    const knobParams = buildSurfaceKnobParams(device, { omitMixWhenDryWet: showDryWet });
    const modRate = readSurfaceParam(device, 'rate', 1, 'Hz');
    const modDepth = readSurfaceParam(device, 'depth', 50, '%');
    const depthNorm = Math.max(0, Math.min(1, modDepth.value / 100));
    return (
        <div data-no-drag style={pluginPanelLayoutStyle}>
            <div style={{ ...panelWithOptionalDryWet(showDryWet), background: 'var(--plugin-bg-mod)' }}>
                <div style={{ display: 'grid', gap: 6 }}>
                    <div style={{ ...pluginPanelTitleStyle, color: 'var(--token-color-hex-6db3ff)' }}>Auto Pan</div>
                    <svg viewBox="0 0 300 52" preserveAspectRatio="none" style={{ width: '100%', height: 48 }}>
                        <rect x="0" y="0" width="300" height="52" rx="4" fill="var(--token-color-rgba-8-10-14-0d65)" />
                        {/* Center line */}
                        <line x1="150" y1="4" x2="150" y2="48" stroke="var(--token-color-rgba-109-179-255-0d2)" strokeWidth="1" />
                        {/* L/R labels */}
                        <text x="16" y="14" fill="var(--token-color-rgba-109-179-255-0d45)" fontSize="9" fontFamily="var(--font-mono)">L</text>
                        <text x="282" y="14" fill="var(--token-color-rgba-109-179-255-0d45)" fontSize="9" fontFamily="var(--font-mono)">R</text>
                        {/* Pan sweep wave — shows amplitude based on depth */}
                        <path
                            d={`M 10 26 C ${60} ${26 - 18 * depthNorm}, ${100} ${26 + 18 * depthNorm}, 150 26 C ${200} ${26 - 18 * depthNorm}, ${240} ${26 + 18 * depthNorm}, 290 26`}
                            fill="none"
                            stroke="var(--token-color-hex-6db3ff)"
                            strokeWidth="2.4"
                            strokeLinecap="round"
                        />
                        {/* Ghost wave (inverted for stereo effect) */}
                        <path
                            d={`M 10 26 C ${60} ${26 + 18 * depthNorm}, ${100} ${26 - 18 * depthNorm}, 150 26 C ${200} ${26 + 18 * depthNorm}, ${240} ${26 - 18 * depthNorm}, 290 26`}
                            fill="none"
                            stroke="var(--token-color-hex-6db3ff)"
                            strokeWidth="1.6"
                            strokeLinecap="round"
                            opacity="0.35"
                        />
                    </svg>
                    <div style={pluginPanelMetaStyle}>
                        <span>Auto Pan</span>
                        <span>Rate {formatSurfaceParam(modRate)}</span>
                        <span>Depth {formatSurfaceParam(modDepth)}</span>
                    </div>
                </div>
                {showDryWet && (
                    <DryWetKnob
                        device={device}
                        onChange={onParamChange}
                        onGestureStart={onParamGestureStart}
                        onGestureEnd={onParamGestureEnd}
                        accent="var(--token-color-hex-6db3ff)"
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

/* ═══════════════════════════════════════════════════════════════════════ */
/* PHASER — Unique: Allpass notch comb visualization                      */
/* ═══════════════════════════════════════════════════════════════════════ */
function renderPhaserSurface(device: DeviceSlot, handlers: SurfaceHandlers): React.ReactNode {
    const { onParamChange, onParamGestureStart, onParamGestureEnd } = handlers;
    const normalizedInternalId = normalizeInternalPluginId(device.pluginId || (device.guiMode || '').toLowerCase() || device.name.toLowerCase());
    const isPhaserFlanger = normalizedInternalId === 'internal://effect/phaser-flanger';
    const showDryWet = hasMixParam(device);
    const knobParams = buildSurfaceKnobParams(device, { omitMixWhenDryWet: showDryWet });
    const modRate = readSurfaceParam(device, 'rate', 0.5, 'Hz');
    const modDepth = readSurfaceParam(device, 'depth', 60, '%');
    const stages = readSurfaceParam(device, 'stages', 6, '');
    const stageCount = Math.max(2, Math.min(12, Math.round(stages.value)));
    return (
        <div data-no-drag style={pluginPanelLayoutStyle}>
            <div style={{ ...panelWithOptionalDryWet(showDryWet), background: 'var(--plugin-bg-mod)' }}>
                <div style={{ display: 'grid', gap: 6 }}>
                    <div style={{ ...pluginPanelTitleStyle, color: 'var(--token-color-hex-998bff)' }}>{isPhaserFlanger ? 'Phaser-Flanger' : 'Phaser'}</div>
                    <svg viewBox="0 0 300 52" preserveAspectRatio="none" style={{ width: '100%', height: 48 }}>
                        <rect x="0" y="0" width="300" height="52" rx="4" fill="var(--token-color-rgba-8-10-14-0d65)" />
                        {/* Allpass notch pattern: evenly-spaced notches in frequency response */}
                        {Array.from({ length: stageCount }).map((_, i) => {
                            const cx = 20 + (i / Math.max(1, stageCount - 1)) * 260;
                            const notchDepth = 14 + (modDepth.value / 100) * 20;
                            return (
                                <React.Fragment key={i}>
                                    {/* Notch "V" shape */}
                                    <path
                                        d={`M ${cx - 10} 16 L ${cx} ${16 + notchDepth} L ${cx + 10} 16`}
                                        fill="none"
                                        stroke="var(--token-color-hex-998bff)"
                                        strokeWidth="1.8"
                                        strokeLinecap="round"
                                        strokeLinejoin="round"
                                    />
                                    {/* Notch marker dot */}
                                    <circle cx={cx} cy={16 + notchDepth} r="2" fill="var(--token-color-hex-998bff)" />
                                </React.Fragment>
                            );
                        })}
                        {/* Flat response reference line */}
                        <line x1="4" y1="16" x2="296" y2="16" stroke="var(--token-color-rgba-153-139-255-0d2)" strokeWidth="0.8" />
                    </svg>
                    <div style={pluginPanelMetaStyle}>
                        <span>{isPhaserFlanger ? 'Phaser-Flanger' : 'Phaser'}</span>
                        <span>{formatSurfaceParam(modRate)}</span>
                        <span>Depth {formatSurfaceParam(modDepth)}</span>
                        <span>{stageCount} stages</span>
                    </div>
                </div>
                {showDryWet && (
                    <DryWetKnob
                        device={device}
                        onChange={onParamChange}
                        onGestureStart={onParamGestureStart}
                        onGestureEnd={onParamGestureEnd}
                        accent="var(--token-color-hex-998bff)"
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

/* ═══════════════════════════════════════════════════════════════════════ */
/* FLANGER — Unique: Comb filter peaks visualization                      */
/* ═══════════════════════════════════════════════════════════════════════ */
function renderFlangerSurface(device: DeviceSlot, handlers: SurfaceHandlers): React.ReactNode {
    const { onParamChange, onParamGestureStart, onParamGestureEnd } = handlers;
    const normalizedInternalId = normalizeInternalPluginId(device.pluginId || (device.guiMode || '').toLowerCase() || device.name.toLowerCase());
    const isPhaserFlanger = normalizedInternalId === 'internal://effect/phaser-flanger';
    const showDryWet = hasMixParam(device);
    const knobParams = buildSurfaceKnobParams(device, { omitMixWhenDryWet: showDryWet });
    const modRate = readSurfaceParam(device, 'rate', 0.3, 'Hz');
    const modDepth = readSurfaceParam(device, 'depth', 50, '%');
    const fb = readSurfaceParam(device, ['fb', 'feedback'], 40, '%');
    const fbNorm = Math.max(0, Math.min(1, Math.abs(fb.value) / 100));
    return (
        <div data-no-drag style={pluginPanelLayoutStyle}>
            <div style={{ ...panelWithOptionalDryWet(showDryWet), background: 'var(--plugin-bg-mod)' }}>
                <div style={{ display: 'grid', gap: 6 }}>
                    <div style={{ ...pluginPanelTitleStyle, color: 'var(--token-color-hex-66b3ff)' }}>{isPhaserFlanger ? 'Phaser-Flanger' : 'Flanger'}</div>
                    <svg viewBox="0 0 300 52" preserveAspectRatio="none" style={{ width: '100%', height: 48 }}>
                        <rect x="0" y="0" width="300" height="52" rx="4" fill="var(--token-color-rgba-8-10-14-0d65)" />
                        {/* Comb filter peaks — evenly spaced tall/narrow bars representing harmonics */}
                        {Array.from({ length: 10 }).map((_, i) => {
                            const x = 16 + i * 28;
                            const peakH = 12 + fbNorm * 26 * Math.pow(0.85, i);
                            return (
                                <React.Fragment key={i}>
                                    <rect x={x} y={44 - peakH} width="8" height={peakH} rx="2"
                                        fill={i % 2 === 0 ? 'var(--token-color-hex-66b3ff)' : 'var(--token-color-rgba-102-179-255-0d6)'}
                                    />
                                    {/* Thin connecting line between peaks */}
                                    {i < 9 && (
                                        <line x1={x + 8} y1={44 - peakH * 0.6} x2={x + 28} y2={44 - (12 + fbNorm * 26 * Math.pow(0.85, i + 1)) * 0.6}
                                            stroke="var(--token-color-rgba-102-179-255-0d25)" strokeWidth="0.8" />
                                    )}
                                </React.Fragment>
                            );
                        })}
                    </svg>
                    <div style={pluginPanelMetaStyle}>
                        <span>{isPhaserFlanger ? 'Phaser-Flanger' : 'Flanger'}</span>
                        <span>{formatSurfaceParam(modRate)}</span>
                        <span>Depth {formatSurfaceParam(modDepth)}</span>
                        <span>FB {formatSurfaceParam(fb)}</span>
                    </div>
                </div>
                {showDryWet && (
                    <DryWetKnob
                        device={device}
                        onChange={onParamChange}
                        onGestureStart={onParamGestureStart}
                        onGestureEnd={onParamGestureEnd}
                        accent="var(--token-color-hex-66b3ff)"
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

/* ═══════════════════════════════════════════════════════════════════════ */
/* MAIN DISPATCHER                                                        */
/* ═══════════════════════════════════════════════════════════════════════ */
export function renderStandardDynamicsModSurface(device: DeviceSlot, handlers: SurfaceHandlers): React.ReactNode {
    if (device.effectType === 'limiter') return renderLimiterSurface(device, handlers);
    if (device.effectType === 'gate') return renderGateSurface(device, handlers);
    if (device.effectType === 'autoFilter') return renderAutoFilterSurface(device, handlers);
    if (device.effectType === 'autoPan') return renderAutoPanSurface(device, handlers);
    if (device.effectType === 'phaser') return renderPhaserSurface(device, handlers);
    if (device.effectType === 'flanger') return renderFlangerSurface(device, handlers);
    return null;
}
