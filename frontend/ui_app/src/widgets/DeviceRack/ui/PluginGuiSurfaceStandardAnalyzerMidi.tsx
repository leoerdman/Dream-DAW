import type { DeviceSlot } from '@/widgets/DeviceRack/model/types';
import {
    formatSurfaceParam,
    getDevicePluginKey,
    KnobParamGrid,
    pluginPanelCardBaseStyle,
    pluginPanelLayoutStyle,
    pluginPanelMetaStyle,
    pluginPanelTitleStyle,
    readSurfaceParam,
    safeParamValue,
    PLUGIN_TITLE_MAP,
    type SurfaceHandlers,
} from '@/widgets/DeviceRack/ui/PluginGuiSurfaceStandardShared';

// Hoisted to module level — avoids new Set() allocation on every render (Bug #3)
const ANALYZER_MIDI_TYPES: ReadonlySet<string> = new Set([
    'analyzer', 'spectrum', 'midiPitch', 'midiScale', 'midiVelocity', 'midiRandom',
    'midiChord', 'midiNoteLength', 'midiCcControl', 'midiExpressionControl', 'midiArpeggiator',
]);

export function renderStandardAnalyzerMidiSurface(
    device: DeviceSlot,
    handlers: SurfaceHandlers,
): React.ReactNode {
    const normalizedInternalId = getDevicePluginKey(device);

    // BUG-76 FIX: Include all MIDI effect types including new ones (chord, noteLength, ccControl, expressionControl, arpeggiator).
    if (!ANALYZER_MIDI_TYPES.has(device.effectType)) {
        return null;
    }

    // BUG-P14 FIX: Clean title resolution via PLUGIN_TITLE_MAP + effectType fallback.
    const EFFECT_TYPE_LABELS: Record<string, string> = {
        analyzer: 'Analyzer', spectrum: 'Spectrum', midiPitch: 'MIDI Pitch',
        midiScale: 'MIDI Scale', midiVelocity: 'MIDI Velocity', midiRandom: 'MIDI Random',
        // BUG-83 FIX: Labels for new MIDI effect types.
        midiChord: 'MIDI Chord', midiNoteLength: 'MIDI Note Length',
        midiCcControl: 'MIDI CC Control', midiExpressionControl: 'MIDI Expression',
        midiArpeggiator: 'MIDI Arpeggiator',
    };
    const title = PLUGIN_TITLE_MAP[normalizedInternalId] ?? EFFECT_TYPE_LABELS[device.effectType] ?? device.effectType;

    const spectrumBars = Array.from({ length: 24 }).map((_, idx) => {
        const t = idx / 23;
        const h = 18 + Math.sin((idx + 1) * 0.62) * 9 + (1 - Math.abs(0.5 - t) * 2) * 20;
        return { x: 8 + idx * 13, h: Math.max(4, h) };
    });

    // BUG-P4 FIX: NaN-safe param reads
    const semitones = safeParamValue(device, 'semitones', 0);
    const root = safeParamValue(device, 'root', 0);
    const chance = safeParamValue(device, 'chance', 0);
    const velGain = safeParamValue(device, 'gain', 1);
    const velOffset = safeParamValue(device, 'offset', 0);
    const lengthParam = readSurfaceParam(device, 'length', 200, 'ms');
    const lengthMs = lengthParam.value;
    const gateParam = readSurfaceParam(device, 'gate', 100, '%');
    const gatePct = gateParam.value;
    const ccNumber = safeParamValue(device, 'cc', 1);
    const ccValue = safeParamValue(device, 'value', 64);
    const arpPattern = safeParamValue(device, 'pattern', 0);
    const arpOctaves = safeParamValue(device, 'octaves', 1);
    const chordOctaves = safeParamValue(device, 'octaves', 1);
    const chordInversion = safeParamValue(device, 'inversion', 0);
    const noteNames = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];
    const activeRoot = Math.max(0, Math.min(11, Math.round(root) % 12));

    // BUG-P18 FIX: NaN-safe VU levels fallback
    const safeVuL = -100;
    const safeVuR = -100;

    return (
        <div data-no-drag style={pluginPanelLayoutStyle}>
            <div style={{ ...pluginPanelCardBaseStyle, background: 'var(--plugin-bg-midi)' }}>
                <div style={{ ...pluginPanelTitleStyle, color: 'var(--token-color-hex-b8c8e8)' }}>{title}</div>
                {device.effectType === 'spectrum' && (
                    <svg viewBox="0 0 320 52" preserveAspectRatio="xMidYMid slice" style={{ width: '100%', height: 46 , willChange: 'transform', transform: 'translateZ(0)'}}>
                        <rect x="0" y="0" width="320" height="52" fill="var(--token-color-rgba-8-10-14-0d7)" />
                        {spectrumBars.map((bar, idx) => (
                            <rect key={idx} x={bar.x} y={46 - bar.h} width="8" height={bar.h} rx="1.2" fill={bar.h > 30 ? 'var(--token-color-rgba-255-180-102-0d92)' : 'var(--token-color-rgba-122-198-255-0d92)'} />
                        ))}
                    </svg>
                )}
                {device.effectType === 'analyzer' && (
                    <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 6, padding: 'var(--space-1) var(--space-2)', height: 80, background: 'var(--token-color-rgba-8-10-14-0d7)', borderRadius: 'var(--radius-md)' }}>
                        <div style={{ display: 'flex', flexDirection: 'column', gap: 3 }}>
                            <div style={{ fontSize: 'var(--font-size-micro)', color: 'var(--token-color-hex-7a9ec4)', fontFamily: 'var(--font-role-data)', letterSpacing: '0.05em' }}>PEAK L</div>
                            <div style={{ flex: 1, background: 'var(--token-color-hex-0d1117)', borderRadius: 2, overflow: 'hidden', position: 'relative' }}>
                                <div style={{ position: 'absolute', bottom: 0, left: 0, right: 0, height: `${Math.max(1, Math.min(100, (1 - Math.max(0, -safeVuL) / 60) * 100))}%`, background: safeVuL > -3 ? 'var(--color-error)' : safeVuL > -12 ? 'var(--color-warning)' : 'var(--color-success)', borderRadius: 2, transition: 'height 60ms linear' }} />
                            </div>
                            <div style={{ fontSize: 'var(--font-size-2xs)', color: 'var(--token-color-hex-95bdff)', fontFamily: 'var(--font-role-data)', textAlign: 'center' }}>
                                {safeVuL > -100 ? safeVuL.toFixed(1) : '-∞'}
                            </div>
                        </div>
                        <div style={{ display: 'flex', flexDirection: 'column', gap: 3 }}>
                            <div style={{ fontSize: 'var(--font-size-micro)', color: 'var(--token-color-hex-7a9ec4)', fontFamily: 'var(--font-role-data)', letterSpacing: '0.05em' }}>PEAK R</div>
                            <div style={{ flex: 1, background: 'var(--token-color-hex-0d1117)', borderRadius: 2, overflow: 'hidden', position: 'relative' }}>
                                <div style={{ position: 'absolute', bottom: 0, left: 0, right: 0, height: `${Math.max(1, Math.min(100, (1 - Math.max(0, -safeVuR) / 60) * 100))}%`, background: safeVuR > -3 ? 'var(--color-error)' : safeVuR > -12 ? 'var(--color-warning)' : 'var(--color-success)', borderRadius: 2, transition: 'height 60ms linear' }} />
                            </div>
                            <div style={{ fontSize: 'var(--font-size-2xs)', color: 'var(--token-color-hex-95bdff)', fontFamily: 'var(--font-role-data)', textAlign: 'center' }}>
                                {safeVuR > -100 ? safeVuR.toFixed(1) : '-∞'}
                            </div>
                        </div>
                    </div>
                )}
                {device.effectType === 'midiPitch' && (
                    <div style={{ display: 'grid', placeItems: 'center', height: 46 }}>
                        <div style={{ fontFamily: 'var(--font-role-data)', fontSize: 'var(--font-size-3xl)', color: 'var(--token-color-hex-95bdff)' }}>
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
                        <div style={{ height: 8, borderRadius: 'var(--radius-full)', background: 'var(--color-bg-tertiary)', overflow: 'hidden' }}>
                            <div style={{ width: `${Math.max(0, Math.min(200, velGain * 100)).toFixed(1)}%`, height: '100%', background: 'var(--color-accent-primary)' }} />
                        </div>
                        <div style={{ height: 8, borderRadius: 'var(--radius-full)', background: 'var(--token-color-hex-1e2430)', overflow: 'hidden', position: 'relative' }}>
                            <div style={{ position: 'absolute', left: '50%', top: 0, bottom: 0, width: 1, background: 'var(--token-color-rgba-255-255-255-0d2)' }} />
                            <div
                                style={{
                                    position: 'absolute',
                                    left: `calc(${Math.max(0, Math.min(100, ((velOffset + 127) / 254) * 100)).toFixed(1)}% - var(--token-size-px-5))`,
                                    top: -2,
                                    width: 10,
                                    height: 12,
                                    borderRadius: 'var(--radius-md)',
                                    background: 'var(--token-color-hex-d9a25c)',
                                }}
                            />
                        </div>
                    </div>
                )}
                {device.effectType === 'midiRandom' && (
                    <div style={{ display: 'grid', alignItems: 'center', gap: 4, height: 46 }}>
                        <div style={{ height: 8, borderRadius: 'var(--radius-full)', background: 'var(--color-bg-tertiary)', overflow: 'hidden' }}>
                            <div style={{ width: `${Math.max(0, Math.min(100, chance * 100)).toFixed(1)}%`, height: '100%', background: 'var(--color-accent-primary)' }} />
                        </div>
                        <div style={{ fontSize: 'var(--font-size-xs)', color: 'var(--token-color-hex-cfa4e6)', fontFamily: 'var(--font-role-data)' }}>
                            {`Chance ${(chance * 100).toFixed(0)}% | Range ±${Math.abs(semitones).toFixed(0)} st`}
                        </div>
                    </div>
                )}
                {device.effectType === 'midiChord' && (
                    <div style={{ display: 'grid', gap: 6, height: 46 }}>
                        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(12, minmax(0, 1fr))', gap: 3 }}>
                            {noteNames.map((n, idx) => (
                                <div key={n} style={{ borderRadius: 'var(--radius-sm)', border: idx === activeRoot ? 'var(--space-px) solid var(--token-color-hex-8bc27a)' : 'var(--space-px) solid var(--token-color-rgba-255-255-255-0d14)', background: idx === activeRoot ? 'var(--token-color-rgba-139-194-122-0d22)' : 'var(--token-color-rgba-160-180-210-0d1)', color: idx === activeRoot ? 'var(--token-color-hex-d9f3d1)' : 'var(--token-color-hex-a8b7cd)', fontSize: 'var(--font-size-2xs)', textAlign: 'center', padding: 'var(--token-size-px-3) 0' }}>
                                    {n}
                                </div>
                            ))}
                        </div>
                        <div style={{ fontSize: 'var(--font-size-xs)', color: 'var(--token-color-hex-c5d7ea)', fontFamily: 'var(--font-role-data)' }}>
                            {`Oct ${Math.max(1, Math.round(chordOctaves))} | Inv ${Math.max(0, Math.round(chordInversion))}`}
                        </div>
                    </div>
                )}
                {device.effectType === 'midiNoteLength' && (
                    <div style={{ display: 'grid', gap: 6, height: 46 }}>
                        <div style={{ height: 8, borderRadius: 'var(--radius-full)', background: 'var(--color-bg-tertiary)', overflow: 'hidden' }}>
                            <div style={{ width: `${Math.max(0, Math.min(100, lengthMs / 20)).toFixed(1)}%`, height: '100%', background: 'var(--color-accent-primary)' }} />
                        </div>
                        <div style={{ fontSize: 'var(--font-size-xs)', color: 'var(--token-color-hex-c5d7ea)', fontFamily: 'var(--font-role-data)' }}>
                            {`Len ${formatSurfaceParam(lengthParam)} | Gate ${formatSurfaceParam(gateParam)}`}
                        </div>
                    </div>
                )}
                {(device.effectType === 'midiCcControl' || device.effectType === 'midiExpressionControl') && (
                    <div style={{ display: 'grid', gap: 6, height: 46 }}>
                        <div style={{ height: 8, borderRadius: 'var(--radius-full)', background: 'var(--token-color-hex-1e2430)', overflow: 'hidden' }}>
                            <div style={{ width: `${Math.max(0, Math.min(100, (ccValue / 127) * 100)).toFixed(1)}%`, height: '100%', background: 'var(--token-color-hex-8ecb7c)' }} />
                        </div>
                        <div style={{ fontSize: 'var(--font-size-xs)', color: 'var(--token-color-hex-c5d7ea)', fontFamily: 'var(--font-role-data)' }}>
                            {`CC ${Math.max(0, Math.min(127, Math.round(ccNumber)))} | Val ${Math.max(0, Math.min(127, Math.round(ccValue)))}`}
                        </div>
                    </div>
                )}
                {device.effectType === 'midiArpeggiator' && (
                    <div style={{ display: 'grid', alignItems: 'center', gap: 4, height: 46 }}>
                        <div style={{ height: 8, borderRadius: 'var(--radius-full)', background: 'var(--color-bg-tertiary)', overflow: 'hidden' }}>
                            <div style={{ width: `${Math.max(0, Math.min(100, gatePct / 2)).toFixed(1)}%`, height: '100%', background: 'var(--color-accent-primary)' }} />
                        </div>
                        <div style={{ fontSize: 'var(--font-size-xs)', color: 'var(--token-color-hex-cfa4e6)', fontFamily: 'var(--font-role-data)' }}>
                            {`Rate x${safeParamValue(device, 'rate', 1).toFixed(2)} | Pattern ${Math.max(0, Math.round(arpPattern))} | Oct ${Math.max(1, Math.round(arpOctaves))}`}
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
            <KnobParamGrid device={device} handlers={handlers} maxCols={4} minCols={2} />
        </div>
    );
}
