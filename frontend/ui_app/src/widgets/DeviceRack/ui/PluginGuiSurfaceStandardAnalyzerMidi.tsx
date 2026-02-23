import React from 'react';
import { PluginKnob } from '@/widgets/DeviceRack/StandardPluginControls';
import { pluginPanelKnobGrid } from '@/widgets/DeviceRack/ui/styles';
import { normalizeInternalPluginId } from '@/shared/lib/internalPlugins';
import type { DeviceSlot } from '@/widgets/DeviceRack/model/types';

const pluginPanelLayoutStyle: React.CSSProperties = {
    display: 'grid',
    gridTemplateRows: 'var(--token-size-px-90) auto',
    gap: 'var(--plugin-grid-gap)',
    height: '100%',
};

const pluginPanelCardBaseStyle: React.CSSProperties = {
    border: 'var(--space-px) solid var(--plugin-card-border)',
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

interface AnalyzerMidiHandlers {
    onParamChange: (paramName: string, value: number) => void;
    onParamGestureStart?: (paramName: string, gestureGroupId?: string) => void;
    onParamGestureEnd?: (paramName: string) => void;
}

export function renderStandardAnalyzerMidiSurface(
    device: DeviceSlot,
    handlers: AnalyzerMidiHandlers,
): React.ReactNode {
    const { onParamChange, onParamGestureStart, onParamGestureEnd } = handlers;
    const normalizedInternalId = normalizeInternalPluginId(device.pluginId || (device.guiMode || '').toLowerCase() || device.name.toLowerCase());

    if (!(device.effectType === 'analyzer' || device.effectType === 'spectrum' || device.effectType === 'midiPitch' || device.effectType === 'midiScale' || device.effectType === 'midiVelocity' || device.effectType === 'midiRandom')) {
        return null;
    }

    const title = device.effectType === 'analyzer' || device.effectType === 'spectrum'
        ? (normalizedInternalId === 'internal://effect/spectrum' ? 'Spectrum' : 'Analyzer')
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
        <div data-no-drag style={pluginPanelLayoutStyle}>
            <div style={{ ...pluginPanelCardBaseStyle, background: 'var(--plugin-bg-midi)' }}>
                <div style={{ ...pluginPanelTitleStyle, color: 'var(--token-color-hex-b8c8e8)' }}>{title}</div>
                {device.effectType === 'spectrum' && (
                    <svg viewBox="0 0 320 52" preserveAspectRatio="none" style={{ width: '100%', height: 46 }}>
                        <rect x="0" y="0" width="320" height="52" fill="var(--token-color-rgba-8-10-14-0d7)" />
                        {spectrumBars.map((bar, idx) => (
                            <rect key={idx} x={bar.x} y={46 - bar.h} width="8" height={bar.h} rx="1.2" fill={bar.h > 30 ? 'var(--token-color-rgba-255-180-102-0d92)' : 'var(--token-color-rgba-122-198-255-0d92)'} />
                        ))}
                    </svg>
                )}
                {device.effectType === 'analyzer' && (
                    <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 6, padding: 'var(--space-1) var(--space-2)', height: 80, background: 'var(--token-color-rgba-8-10-14-0d7)', borderRadius: 'var(--radius-md)' }}>
                        <div style={{ display: 'flex', flexDirection: 'column', gap: 3 }}>
                            <div style={{ fontSize: 9, color: 'var(--token-color-hex-7a9ec4)', fontFamily: 'var(--font-mono)', letterSpacing: '0.05em' }}>PEAK L</div>
                            <div style={{ flex: 1, background: 'var(--token-color-hex-0d1117)', borderRadius: 2, overflow: 'hidden', position: 'relative' }}>
                                <div style={{ position: 'absolute', bottom: 0, left: 0, right: 0, height: `${Math.max(1, Math.min(100, (1 - Math.max(0, -device.vuLevelL) / 60) * 100))}%`, background: device.vuLevelL > -3 ? 'var(--color-error)' : device.vuLevelL > -12 ? 'var(--color-warning)' : 'var(--color-success)', borderRadius: 2, transition: 'height 60ms linear' }} />
                            </div>
                            <div style={{ fontSize: 10, color: 'var(--token-color-hex-95bdff)', fontFamily: 'var(--font-mono)', textAlign: 'center' }}>
                                {device.vuLevelL > -100 ? device.vuLevelL.toFixed(1) : '-∞'}
                            </div>
                        </div>
                        <div style={{ display: 'flex', flexDirection: 'column', gap: 3 }}>
                            <div style={{ fontSize: 9, color: 'var(--token-color-hex-7a9ec4)', fontFamily: 'var(--font-mono)', letterSpacing: '0.05em' }}>PEAK R</div>
                            <div style={{ flex: 1, background: 'var(--token-color-hex-0d1117)', borderRadius: 2, overflow: 'hidden', position: 'relative' }}>
                                <div style={{ position: 'absolute', bottom: 0, left: 0, right: 0, height: `${Math.max(1, Math.min(100, (1 - Math.max(0, -device.vuLevelR) / 60) * 100))}%`, background: device.vuLevelR > -3 ? 'var(--color-error)' : device.vuLevelR > -12 ? 'var(--color-warning)' : 'var(--color-success)', borderRadius: 2, transition: 'height 60ms linear' }} />
                            </div>
                            <div style={{ fontSize: 10, color: 'var(--token-color-hex-95bdff)', fontFamily: 'var(--font-mono)', textAlign: 'center' }}>
                                {device.vuLevelR > -100 ? device.vuLevelR.toFixed(1) : '-∞'}
                            </div>
                        </div>
                    </div>
                )}
                {device.effectType === 'midiPitch' && (
                    <div style={{ display: 'grid', placeItems: 'center', height: 46 }}>
                        <div style={{ fontFamily: 'var(--font-mono)', fontSize: 'var(--font-size-3xl)', color: 'var(--token-color-hex-95bdff)' }}>
                            {semitones >= 0 ? '+' : ''}{semitones.toFixed(0)} st
                        </div>
                    </div>
                )}
                {device.effectType === 'midiScale' && (
                    <div style={{ display: 'grid', gridTemplateColumns: 'repeat(12, minmax(0, 1fr))', gap: 3, height: 46, alignItems: 'center' }}>
                        {noteNames.map((n, idx) => (
                            <div key={n} style={{ borderRadius: 'var(--radius-sm)', border: idx === activeRoot ? 'var(--space-px) solid var(--token-color-hex-8bc27a)' : 'var(--space-px) solid var(--token-color-rgba-255-255-255-0d14)', background: idx === activeRoot ? 'var(--token-color-rgba-139-194-122-0d22)' : 'var(--token-color-rgba-160-180-210-0d1)', color: idx === activeRoot ? 'var(--token-color-hex-d9f3d1)' : 'var(--token-color-hex-a8b7cd)', fontSize: 'var(--font-size-2xs)', textAlign: 'center', padding: 'var(--token-size-px-3) 0' }}>
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
                                <div style={{ fontSize: 'var(--font-size-xs)', color: 'var(--token-color-hex-c5d7ea)', fontFamily: 'var(--font-mono)' }}>Gate {(velGain * 100).toFixed(0)}%</div>
                            </>
                        ) : (
                            <>
                                <div style={{ height: 8, borderRadius: 'var(--radius-full)', background: 'var(--color-bg-tertiary)', overflow: 'hidden' }}>
                                    <div style={{ width: `${Math.max(0, Math.min(200, velGain * 100)).toFixed(1)}%`, height: '100%', background: 'var(--color-accent-primary)' }} />
                                </div>
                                <div style={{ height: 8, borderRadius: 'var(--radius-full)', background: 'var(--token-color-hex-1e2430)', overflow: 'hidden', position: 'relative' }}>
                                    <div style={{ position: 'absolute', left: '50%', top: 0, bottom: 0, width: 1, background: 'var(--token-color-rgba-255-255-255-0d2)' }} />
                                    <div style={{ position: 'absolute', left: `calc(${Math.max(0, Math.min(100, (velOffset + 64) / 128 * 100)).toFixed(1)}% - var(--token-size-px-5))`, top: -2, width: 10, height: 12, borderRadius: 'var(--radius-md)', background: isCcControl || isExpressionControl ? 'var(--token-color-hex-8ecb7c)' : 'var(--token-color-hex-d9a25c)' }} />
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
                        <div style={{ fontSize: 'var(--font-size-xs)', color: 'var(--token-color-hex-cfa4e6)', fontFamily: 'var(--font-mono)' }}>
                            {isArp
                                ? `Arp Gate ${(chance * 100).toFixed(0)}% | Steps ${Math.max(1, Math.round(Math.abs(semitones) || 8))}`
                                : `Chance ${(chance * 100).toFixed(0)}% | Range ±${Math.abs(semitones).toFixed(0)} st`}
                        </div>
                    </div>
                )}
                <div style={pluginPanelMetaStyle}>
                    <span>
                        {device.effectType === 'spectrum'
                            ? 'Spectrum (native)'
                            : device.effectType === 'analyzer'
                                ? 'Analyzer (native)'
                                : 'MIDI FX (import-compatible)'}
                    </span>
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
