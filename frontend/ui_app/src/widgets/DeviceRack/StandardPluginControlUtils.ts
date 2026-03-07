import type { PluginParam } from './StandardPluginControlTypes';

const DRAG_SCALE_NORMAL_PX = 220;
/** ENTERPRISE: Shift = 10x finer control (industry-standard DAW convention). */
const DRAG_SCALE_SHIFT_PX = 2000;
/** Alt/Option = coarse/fast adjustment. */
const DRAG_SCALE_ALT_PX = 60;

const resolveParamPrecision = (param: PluginParam): number => {
    const step = param.step;
    if (!step || step <= 0) return 0;
    if (step >= 1) return 0;
    const decimals = Math.ceil(Math.abs(Math.log10(step)));
    return Math.max(0, Math.min(6, decimals));
};

/**
 * ENTERPRISE: Human-readable labels for enum/mode/type params.
 * Key = lowercase param name → array of labels indexed by integer value.
 * Used by formatPluginParamValue to show "Fuzz" instead of "0".
 */
const PARAM_VALUE_LABELS: Record<string, readonly string[]> = {
    // ── Dynamics ──
    // NOTE: 'ratio' only matches Glue Compressor (step=1, range=0-2).
    // Regular Compressor has step=0.1 (continuous) so resolveEnumLabel won't match.
    'ratio': ['2:1', '4:1', '10:1'],               // Glue Compressor (index-based fixed ratios)
    'rms': ['Peak', 'RMS'],                       // Compressor detection mode
    'auto gain': ['Off', 'On'],                         // Compressor auto gain
    'auto rel': ['Off', 'On'],                         // Limiter auto release
    'duck': ['Gate', 'Duck'],                      // Gate duck mode
    // ── Distortion / Saturation ──
    // NOTE: 'mode' REMOVED — collision: Saturator(Tanh/Sine/Cube/Fold/Clip) vs Pedal(Fuzz/Screamer/Rat/Muff)
    // vs Erosion(Noise/Sine/Wide) vs SpectralTime(Freeze/Delay/Spectral). Labels shown in surface meta.
    'cab sim': ['Off', 'On'],                         // Distortion cabinet simulation
    'character': ['Growl', 'Scream', 'Crush', 'Fire'],  // Roar
    // ── Modulation ──
    'lfo shape': ['Sine', 'Tri', 'Saw', 'Square', 'S&H', 'Random'], // Auto Filter, Phaser, Flanger
    'shape': ['Sine', 'Tri', 'Saw', 'Square', 'S&H'],           // Auto Pan
    'voices': ['1', '2', '3'],                       // Chorus voices
    'tz mode': ['Normal', 'Through-Zero'],            // Flanger TZ
    // ── Filter ──
    // NOTE: 'type' REMOVED — collision: AutoFilter(LP/HP/BP/Notch) vs Cabinet(Combo/4x12)
    // vs Corpus(body types) vs NoiseMachine(noise colors). Labels shown in surface meta.
    'filttype': ['LP', 'HP', 'BP', 'Notch'],           // Sampler/WaveSynth filter type
    // ── Reverb ──
    'voicing': ['Room', 'Hall', 'Plate'],             // Reverb voicing
    'freeze': ['Off', 'On'],                         // Reverb freeze
    // ── Delay ──
    'pingpong': ['Normal', 'PingPong'],                // Delay ping-pong mode
    'sync l': ['Free', 'Sync'],                      // Delay sync L
    'sync r': ['Free', 'Sync'],                      // Delay sync R
    // ── Utility ──
    'mono': ['Stereo', 'Mono'],                    // Utility mono
    // NOTE: 'stereo' REMOVED — collision: Bitcrusher(step=1, 0/1) vs NoiseMachine(step=1, 0-100%).
    'dither': ['Off', 'On'],                         // Bitcrusher dither
    'soft clip': ['Off', 'On'],                         // Glue Compressor soft clip (when step=1)
    // ── MIDI ──
    'pattern': ['Up', 'Down', 'Up-Down', 'Down-Up', 'Random', 'Order'], // Arpeggiator
    'lfotarget': ['Pitch', 'Filter', 'Volume'],         // Sampler/WaveSynth LFO target
};

/**
 * Check if a param looks like a boolean/enum (integer step, small range).
 * If so, look up a human-readable label from PARAM_VALUE_LABELS.
 */
function resolveEnumLabel(param: PluginParam): string | null {
    const step = param.step;
    if (!step || step < 1) return null; // Only integer-step params
    const range = param.max - param.min;
    if (range > 10 || range < 1) return null; // Not a small enum
    const key = param.name.toLowerCase().trim();
    const labels = PARAM_VALUE_LABELS[key];
    if (!labels) return null;
    const idx = Math.round(param.value) - Math.round(param.min);
    if (idx >= 0 && idx < labels.length) return labels[idx];
    return null;
}

export const formatPluginParamValue = (param: PluginParam): string => {
    // ENTERPRISE: Show human-readable labels for enum/mode/type params
    const enumLabel = resolveEnumLabel(param);
    if (enumLabel !== null) return enumLabel;
    const v = Number.isFinite(param.value) ? param.value : 0;
    const precision = resolveParamPrecision(param);
    return `${v.toFixed(precision)}${param.suffix ?? ''}`;
};

export const roundPluginParamForDisplay = (param: PluginParam, value: number): number => {
    const precision = resolveParamPrecision(param);
    const factor = 10 ** precision;
    return Math.round(value * factor) / factor;
};

export const formatPluginParamName = (raw: string): string => {
    const withSpaces = raw
        .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
        .replace(/[._-]+/g, ' ')
        .trim();
    return withSpaces.length > 0 ? withSpaces.toUpperCase() : raw.toUpperCase();
};

export const defaultParamValue = (param: PluginParam): number => {
    if (Number.isFinite(param.defaultValue)) {
        return Math.max(param.min, Math.min(param.max, param.defaultValue as number));
    }
    const name = param.name.toLowerCase();
    if (param.min <= 0 && param.max >= 0) return 0;
    if (name.includes('mix') || name.includes('width') || name.includes('amount') || name.includes('depth')) {
        return (param.min + param.max) * 0.5;
    }
    if (name.includes('gain') || name.includes('volume') || name === 'vol') {
        return Math.min(param.max, Math.max(param.min, 0));
    }
    return Math.min(param.max, Math.max(param.min, (param.min + param.max) * 0.5));
};

export const resolveKnobDragScalePx = (shiftKey: boolean, altKey: boolean): number => {
    if (shiftKey) return DRAG_SCALE_SHIFT_PX;
    if (altKey) return DRAG_SCALE_ALT_PX;
    return DRAG_SCALE_NORMAL_PX;
};
