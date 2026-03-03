import type { PluginParam } from '@/widgets/DeviceRack/StandardPluginControls';
import type { DeviceSlot } from '@/widgets/DeviceRack/model/types';
export const DEVICE_PARAM_PRESETS: Record<
    DeviceSlot['effectType'],
    Array<Omit<PluginParam, 'value'> & { value: number }>
> = {
    eq: [
        // Band 0: Low Cut (Highpass) — disabled by default
        { name: 'B0Freq', value: 30, min: 20, max: 20000, suffix: 'Hz', step: 1 },
        { name: 'B0Gain', value: 0, min: -24, max: 24, suffix: 'dB', step: 0.1 },
        { name: 'B0Q', value: 0.71, min: 0.1, max: 18, suffix: '', step: 0.01 },
        { name: 'B0En', value: 0, min: 0, max: 1, suffix: '', step: 1 },
        // Band 1: Low Shelf
        { name: 'B1Freq', value: 100, min: 20, max: 20000, suffix: 'Hz', step: 1 },
        { name: 'B1Gain', value: 0, min: -24, max: 24, suffix: 'dB', step: 0.1 },
        { name: 'B1Q', value: 0.71, min: 0.1, max: 18, suffix: '', step: 0.01 },
        { name: 'B1En', value: 0, min: 0, max: 1, suffix: '', step: 1 },
        // Band 2: Peaking
        { name: 'B2Freq', value: 250, min: 20, max: 20000, suffix: 'Hz', step: 1 },
        { name: 'B2Gain', value: 0, min: -24, max: 24, suffix: 'dB', step: 0.1 },
        { name: 'B2Q', value: 0.71, min: 0.1, max: 18, suffix: '', step: 0.01 },
        { name: 'B2En', value: 0, min: 0, max: 1, suffix: '', step: 1 },
        // Band 3: Peaking — enabled by default (centered flat line)
        { name: 'B3Freq', value: 1000, min: 20, max: 20000, suffix: 'Hz', step: 1 },
        { name: 'B3Gain', value: 0, min: -24, max: 24, suffix: 'dB', step: 0.1 },
        { name: 'B3Q', value: 0.71, min: 0.1, max: 18, suffix: '', step: 0.01 },
        { name: 'B3En', value: 1, min: 0, max: 1, suffix: '', step: 1 },
        // Band 4: Peaking
        { name: 'B4Freq', value: 2500, min: 20, max: 20000, suffix: 'Hz', step: 1 },
        { name: 'B4Gain', value: 0, min: -24, max: 24, suffix: 'dB', step: 0.1 },
        { name: 'B4Q', value: 0.71, min: 0.1, max: 18, suffix: '', step: 0.01 },
        { name: 'B4En', value: 0, min: 0, max: 1, suffix: '', step: 1 },
        // Band 5: Peaking
        { name: 'B5Freq', value: 6000, min: 20, max: 20000, suffix: 'Hz', step: 1 },
        { name: 'B5Gain', value: 0, min: -24, max: 24, suffix: 'dB', step: 0.1 },
        { name: 'B5Q', value: 0.71, min: 0.1, max: 18, suffix: '', step: 0.01 },
        { name: 'B5En', value: 0, min: 0, max: 1, suffix: '', step: 1 },
        // Band 6: High Shelf
        { name: 'B6Freq', value: 12000, min: 20, max: 20000, suffix: 'Hz', step: 1 },
        { name: 'B6Gain', value: 0, min: -24, max: 24, suffix: 'dB', step: 0.1 },
        { name: 'B6Q', value: 0.71, min: 0.1, max: 18, suffix: '', step: 0.01 },
        { name: 'B6En', value: 0, min: 0, max: 1, suffix: '', step: 1 },
        // Band 7: High Cut (Lowpass) — disabled by default
        { name: 'B7Freq', value: 18000, min: 20, max: 20000, suffix: 'Hz', step: 1 },
        { name: 'B7Gain', value: 0, min: -24, max: 24, suffix: 'dB', step: 0.1 },
        { name: 'B7Q', value: 0.71, min: 0.1, max: 18, suffix: '', step: 0.01 },
        { name: 'B7En', value: 0, min: 0, max: 1, suffix: '', step: 1 },
        // Output gain
        { name: 'Out', value: 0, min: -24, max: 24, suffix: 'dB', step: 0.1 },
        // Filter type per band (0=HP, 1=LP, 2=LowShelf, 3=HighShelf, 4=Peaking, 5=Notch)
        // CRITICAL: these MUST exist for filter types to persist through project save/load
        { name: 'B0Type', value: 0, min: 0, max: 5, suffix: '', step: 1 },  // HP
        { name: 'B1Type', value: 2, min: 0, max: 5, suffix: '', step: 1 },  // LowShelf
        { name: 'B2Type', value: 4, min: 0, max: 5, suffix: '', step: 1 },  // Peaking
        { name: 'B3Type', value: 4, min: 0, max: 5, suffix: '', step: 1 },  // Peaking
        { name: 'B4Type', value: 4, min: 0, max: 5, suffix: '', step: 1 },  // Peaking
        { name: 'B5Type', value: 4, min: 0, max: 5, suffix: '', step: 1 },  // Peaking
        { name: 'B6Type', value: 3, min: 0, max: 5, suffix: '', step: 1 },  // HighShelf
        { name: 'B7Type', value: 1, min: 0, max: 5, suffix: '', step: 1 },  // LP
        // Legacy aliases (for backward compat)
        { name: 'LowFreq', value: 120, min: 20, max: 1200, suffix: 'Hz', step: 1 },
        { name: 'Low', value: 0, min: -24, max: 24, suffix: 'dB', step: 0.1 },
        { name: 'LowQ', value: 0.71, min: 0.1, max: 18, suffix: '', step: 0.01 },
        { name: 'MidFreq', value: 1800, min: 120, max: 9000, suffix: 'Hz', step: 1 },
        { name: 'Mid', value: 0, min: -24, max: 24, suffix: 'dB', step: 0.1 },
        { name: 'MidQ', value: 1.0, min: 0.1, max: 18, suffix: '', step: 0.01 },
        { name: 'HighFreq', value: 9500, min: 1200, max: 20000, suffix: 'Hz', step: 1 },
        { name: 'High', value: 0, min: -24, max: 24, suffix: 'dB', step: 0.1 },
        { name: 'HighQ', value: 0.71, min: 0.1, max: 18, suffix: '', step: 0.01 },
    ],
    bandEq: [
        // ChannelEqProcessor: 3-band EQ with LR4 crossovers
        { name: 'Low', value: 0, min: -60, max: 6, suffix: 'dB', step: 0.1 },       // 0
        { name: 'Mid', value: 0, min: -60, max: 6, suffix: 'dB', step: 0.1 },       // 1
        { name: 'High', value: 0, min: -60, max: 6, suffix: 'dB', step: 0.1 },      // 2
        { name: 'LowFreq', value: 250, min: 60, max: 500, suffix: 'Hz', step: 1 },  // 3
        { name: 'HighFreq', value: 4000, min: 2000, max: 16000, suffix: 'Hz', step: 1 }, // 4
        { name: 'LowKill', value: 0, min: 0, max: 1, suffix: '', step: 1 },         // 5
        { name: 'MidKill', value: 0, min: 0, max: 1, suffix: '', step: 1 },         // 6
        { name: 'HighKill', value: 0, min: 0, max: 1, suffix: '', step: 1 },        // 7
        { name: 'Out', value: 0, min: -24, max: 12, suffix: 'dB', step: 0.1 },      // 8
    ],
    compressor: [
        { name: 'Thr', value: -18, min: -60, max: 0, suffix: 'dB', step: 0.1 },       // 0
        { name: 'Ratio', value: 4, min: 1, max: 20, suffix: ':1', step: 0.1 },        // 1
        { name: 'Atk', value: 10, min: 0.1, max: 100, suffix: 'ms', step: 0.1 },      // 2  BUG-P06 FIX: max 200→100
        { name: 'Rel', value: 100, min: 10, max: 1000, suffix: 'ms', step: 1 },       // 3
        { name: 'Knee', value: 6, min: 0, max: 24, suffix: 'dB', step: 0.1 },         // 4
        { name: 'Makeup', value: 0, min: -12, max: 24, suffix: 'dB', step: 0.1 },     // 5
        { name: 'Mix', value: 100, min: 0, max: 100, suffix: '%', step: 1 },          // 6
        { name: 'SC HPF', value: 20, min: 20, max: 500, suffix: 'Hz', step: 1 },      // 7
        { name: 'Auto Gain', value: 1, min: 0, max: 1, suffix: '', step: 1 },         // 8
        { name: 'RMS', value: 0, min: 0, max: 1, suffix: '', step: 1 },               // 9
    ],
    delay: [
        { name: 'Time L', value: 250, min: 1, max: 2000, suffix: 'ms', step: 1 },       // 0  BUG-P02 FIX: was 'Time' at index 0
        { name: 'Time R', value: 375, min: 1, max: 2000, suffix: 'ms', step: 1 },       // 1  BUG-P02 FIX: added — was missing, Fb sent here
        { name: 'Fb', value: 30, min: 0, max: 95, suffix: '%', step: 1 },               // 2  BUG-P02 FIX: now correct index
        { name: 'Dry/Wet', value: 30, min: 0, max: 100, suffix: '%', step: 1 },         // 3  BUG-P02 FIX: now correct index
        { name: 'Filter', value: 5000, min: 200, max: 15000, suffix: 'Hz', step: 1 },   // 4
        { name: 'PingPong', value: 0, min: 0, max: 1, suffix: '', step: 1 },            // 5
        { name: 'Mod Rate', value: 0.5, min: 0, max: 5, suffix: 'Hz', step: 0.01 },     // 6
        { name: 'Mod Depth', value: 10, min: 0, max: 100, suffix: '%', step: 1 },       // 7
    ],
    reverb: [
        { name: 'Size', value: 50, min: 0, max: 100, suffix: '%', step: 1 },            // 0  room_size
        { name: 'Damp', value: 40, min: 0, max: 100, suffix: '%', step: 1 },            // 1  damping
        { name: 'Dry/Wet', value: 30, min: 0, max: 100, suffix: '%', step: 1 },         // 2  mix
        { name: 'Predelay', value: 10, min: 0, max: 200, suffix: 'ms', step: 1 },       // 3
        { name: 'Width', value: 100, min: 0, max: 100, suffix: '%', step: 1 },          // 4
        { name: 'Low Damp', value: 20, min: 0, max: 100, suffix: '%', step: 1 },        // 5
        { name: 'Mod Rate', value: 0.3, min: 0, max: 3, suffix: 'Hz', step: 0.01 },     // 6
        { name: 'Mod Depth', value: 15, min: 0, max: 100, suffix: '%', step: 1 },       // 7
        { name: 'Freeze', value: 0, min: 0, max: 1, suffix: '', step: 1 },              // 8
        { name: 'Lo Cut', value: 20, min: 20, max: 12000, suffix: 'Hz', step: 1 },      // 9
        { name: 'Hi Cut', value: 16000, min: 1200, max: 20000, suffix: 'Hz', step: 1 }, // 10
        { name: 'Diffusion', value: 75, min: 0, max: 100, suffix: '%', step: 1 },       // 11
        { name: 'Density', value: 80, min: 0, max: 100, suffix: '%', step: 1 },         // 12
        { name: 'Chorus', value: 20, min: 0, max: 100, suffix: '%', step: 1 },          // 13
        { name: 'Voicing', value: 1, min: 0, max: 2, suffix: '', step: 1 },             // 14 (0=Room,1=Hall,2=Plate)
    ],
    chorus: [
        { name: 'Rate', value: 1.0, min: 0.05, max: 10, suffix: 'Hz', step: 0.01 },     // 0  BUG-P16 FIX: min 0.1→0.05
        { name: 'Depth', value: 50, min: 0, max: 100, suffix: '%', step: 1 },           // 1
        { name: 'Mix', value: 50, min: 0, max: 100, suffix: '%', step: 1 },             // 2
        { name: 'Fb', value: 0, min: -95, max: 95, suffix: '%', step: 1 },              // 3
        { name: 'Voices', value: 3, min: 1, max: 3, suffix: '', step: 1 },              // 4
        { name: 'Spread', value: 80, min: 0, max: 100, suffix: '%', step: 1 },          // 5
        { name: 'HP Freq', value: 80, min: 20, max: 500, suffix: 'Hz', step: 1 },       // 6
    ],
    utility: [
        { name: 'Gain', value: 0, min: -60, max: 24, suffix: 'dB', step: 0.1 },         // 0  BUG-P05 FIX: range -30..30→-60..24
        { name: 'Pan', value: 0, min: -100, max: 100, suffix: '%', step: 1 },           // 1
        { name: 'Width', value: 100, min: 0, max: 200, suffix: '%', step: 1 },          // 2
        { name: 'Mono', value: 0, min: 0, max: 1, suffix: '', step: 1 },                // 3
    ],
    vst: [],
    instrument: [
        { name: 'Gain', value: 0, min: -24, max: 12, suffix: 'dB', step: 0.1 },
        { name: 'Atk', value: 5, min: 0, max: 2000, suffix: 'ms', step: 1 },
        { name: 'Rel', value: 50, min: 0, max: 4000, suffix: 'ms', step: 1 },
    ],
    sampler: [
        { name: 'Vol', value: 1, min: 0, max: 2, suffix: '', step: 0.01 },
        { name: 'Attack', value: 0.005, min: 0.001, max: 2.0, suffix: 's', step: 0.001 },
        { name: 'Decay', value: 0.1, min: 0.001, max: 4.0, suffix: 's', step: 0.001 },
        { name: 'Sustain', value: 1.0, min: 0, max: 1, suffix: '', step: 0.01 },
        { name: 'Release', value: 0.05, min: 0.001, max: 8.0, suffix: 's', step: 0.001 },
        { name: 'Root', value: 60, min: 0, max: 127, suffix: '', step: 1 },
        { name: 'Cutoff', value: 20000, min: 20, max: 20000, suffix: 'Hz', step: 1 },
        { name: 'Res', value: 0, min: 0, max: 0.99, suffix: '', step: 0.01 },
        { name: 'FiltType', value: 0, min: 0, max: 3, suffix: '', step: 1 },
        { name: 'LfoRate', value: 1, min: 0.01, max: 20, suffix: 'Hz', step: 0.01 },
        { name: 'LfoDepth', value: 0, min: 0, max: 1, suffix: '', step: 0.01 },
        { name: 'LfoTarget', value: 0, min: 0, max: 2, suffix: '', step: 1 },
    ],
    waveSynth: [
        { name: 'Osc1Enabled', value: 1, min: 0, max: 1, suffix: '', step: 1 },
        { name: 'Osc2Enabled', value: 1, min: 0, max: 1, suffix: '', step: 1 },
        { name: 'Osc1Wave', value: 0, min: 0, max: 3, suffix: '', step: 1 },
        { name: 'Osc2Wave', value: 0, min: 0, max: 3, suffix: '', step: 1 },
        { name: 'Osc1Vol', value: 1.0, min: 0, max: 1, suffix: '', step: 0.01 },
        { name: 'Osc2Vol', value: 0.7, min: 0, max: 1, suffix: '', step: 0.01 },
        { name: 'Detune', value: 0, min: -50, max: 50, suffix: 'ct', step: 0.1 },
        { name: 'Sub', value: 0, min: 0, max: 1, suffix: '', step: 0.01 },
        { name: 'Cutoff', value: 20000, min: 20, max: 20000, suffix: 'Hz', step: 1 },
        { name: 'Res', value: 0, min: 0, max: 0.99, suffix: '', step: 0.01 },
        { name: 'FiltType', value: 0, min: 0, max: 3, suffix: '', step: 1 },
        { name: 'LfoRate', value: 1, min: 0.01, max: 20, suffix: 'Hz', step: 0.01 },
        { name: 'LfoDepth', value: 0, min: 0, max: 1, suffix: '', step: 0.01 },
        { name: 'LfoTarget', value: 0, min: 0, max: 2, suffix: '', step: 1 },
        { name: 'PulseWidth', value: 0.5, min: 0.05, max: 0.95, suffix: '', step: 0.01 },
        { name: 'Vol', value: 1, min: 0, max: 2, suffix: '', step: 0.01 },
        { name: 'Attack', value: 0.005, min: 0.001, max: 2.0, suffix: 's', step: 0.001 },
        { name: 'Decay', value: 0.1, min: 0.001, max: 4.0, suffix: 's', step: 0.001 },
        { name: 'Sustain', value: 1.0, min: 0, max: 1, suffix: '', step: 0.01 },
        { name: 'Release', value: 0.05, min: 0.001, max: 8.0, suffix: 's', step: 0.001 },
    ],
    saturator: [
        { name: 'Drive', value: 6, min: 0, max: 36, suffix: 'dB', step: 0.1 },          // 0  BUG-P17 FIX: max 24→36
        { name: 'Tone', value: 50, min: 0, max: 100, suffix: '%', step: 1 },            // 1
        { name: 'Mix', value: 50, min: 0, max: 100, suffix: '%', step: 1 },             // 2
        { name: 'Mode', value: 0, min: 0, max: 4, suffix: '', step: 1 },                // 3
        { name: 'Output', value: 0, min: -24, max: 6, suffix: 'dB', step: 0.1 },        // 4
        { name: 'Color', value: 50, min: 0, max: 100, suffix: '%', step: 1 },           // 5
    ],
    limiter: [
        { name: 'Thr', value: -0.3, min: -30, max: 0, suffix: 'dB', step: 0.1 },        // 0
        { name: 'Rel', value: 100, min: 10, max: 1000, suffix: 'ms', step: 1 },         // 1  BUG-P12 FIX: min 1→10
        { name: 'Ceil', value: -0.1, min: -6, max: 0, suffix: 'dB', step: 0.1 },        // 2  BUG-P13 FIX: min -30→-6
        { name: 'Lookahead', value: 1, min: 0.1, max: 5, suffix: 'ms', step: 0.1 },     // 3
        { name: 'Auto Rel', value: 1, min: 0, max: 1, suffix: '', step: 1 },            // 4
        { name: 'Link', value: 100, min: 0, max: 100, suffix: '%', step: 1 },           // 5
    ],
    gate: [
        { name: 'Thr', value: -30, min: -60, max: 0, suffix: 'dB', step: 0.1 },         // 0  BUG-P08 FIX: min -80→-60
        { name: 'Atk', value: 0.5, min: 0.01, max: 50, suffix: 'ms', step: 0.01 },     // 1  BUG-P09 FIX: max 100→50
        { name: 'Hold', value: 50, min: 0, max: 500, suffix: 'ms', step: 1 },           // 2
        { name: 'Rel', value: 100, min: 5, max: 2000, suffix: 'ms', step: 1 },          // 3
        { name: 'Range', value: -96, min: -96, max: 0, suffix: 'dB', step: 0.1 },       // 4  BUG-P10 FIX: min -80→-96
        { name: 'SC HPF', value: 20, min: 20, max: 500, suffix: 'Hz', step: 1 },        // 5
        { name: 'Hysteresis', value: 3, min: 0, max: 12, suffix: 'dB', step: 0.1 },     // 6
        { name: 'Duck', value: 0, min: 0, max: 1, suffix: '', step: 1 },                // 7
    ],
    autoFilter: [
        { name: 'Cutoff', value: 1000, min: 20, max: 20000, suffix: 'Hz', step: 1 },    // 0
        { name: 'Res', value: 30, min: 0, max: 100, suffix: '%', step: 1 },             // 1
        { name: 'Rate', value: 1, min: 0.01, max: 20, suffix: 'Hz', step: 0.01 },       // 2
        { name: 'Depth', value: 50, min: 0, max: 100, suffix: '%', step: 1 },           // 3
        { name: 'Env', value: 0, min: -100, max: 100, suffix: '%', step: 1 },           // 4
        { name: 'Type', value: 0, min: 0, max: 3, suffix: '', step: 1 },                // 5
        { name: 'Mix', value: 100, min: 0, max: 100, suffix: '%', step: 1 },            // 6
        { name: 'LFO Shape', value: 0, min: 0, max: 5, suffix: '', step: 1 },           // 7
        { name: 'Drive', value: 0, min: 0, max: 24, suffix: 'dB', step: 0.1 },          // 8
        { name: 'Env Speed', value: 20, min: 1, max: 200, suffix: 'ms', step: 1 },      // 9
    ],
    autoPan: [
        { name: 'Rate', value: 1, min: 0.01, max: 20, suffix: 'Hz', step: 0.01 },
        { name: 'Depth', value: 70, min: 0, max: 100, suffix: '%', step: 1 },
        { name: 'Phase', value: 180, min: 0, max: 360, suffix: '°', step: 1 },
        { name: 'Shape', value: 0, min: 0, max: 4, suffix: '', step: 1 },
        { name: 'Mix', value: 100, min: 0, max: 100, suffix: '%', step: 1 },
    ],
    phaser: [
        { name: 'Rate', value: 0.5, min: 0.01, max: 10, suffix: 'Hz', step: 0.01 },     // 0
        { name: 'Depth', value: 60, min: 0, max: 100, suffix: '%', step: 1 },           // 1
        { name: 'Fb', value: 50, min: -95, max: 95, suffix: '%', step: 1 },             // 2
        { name: 'Stages', value: 4, min: 2, max: 12, suffix: '', step: 2 },             // 3  max 8→12 (MAX_STAGES)
        { name: 'Center', value: 1000, min: 100, max: 8000, suffix: 'Hz', step: 1 },    // 4  BUG-P14 FIX: max 5000→8000
        { name: 'Mix', value: 50, min: 0, max: 100, suffix: '%', step: 1 },             // 5
        { name: 'Spread', value: 50, min: 0, max: 100, suffix: '%', step: 1 },          // 6
        { name: 'LFO Shape', value: 0, min: 0, max: 3, suffix: '', step: 1 },           // 7
        { name: 'Range', value: 4000, min: 200, max: 10000, suffix: 'Hz', step: 1 },    // 8
    ],
    flanger: [
        { name: 'Rate', value: 0.3, min: 0.01, max: 10, suffix: 'Hz', step: 0.01 },     // 0
        { name: 'Depth', value: 70, min: 0, max: 100, suffix: '%', step: 1 },           // 1
        { name: 'Fb', value: 50, min: -95, max: 95, suffix: '%', step: 1 },             // 2
        { name: 'Delay', value: 2, min: 0.1, max: 10, suffix: 'ms', step: 0.1 },        // 3
        { name: 'Mix', value: 50, min: 0, max: 100, suffix: '%', step: 1 },             // 4
        { name: 'Stereo', value: 90, min: 0, max: 180, suffix: '°', step: 1 },          // 5
        { name: 'LFO Shape', value: 0, min: 0, max: 3, suffix: '', step: 1 },           // 6
        { name: 'FB Damp', value: 8000, min: 1000, max: 20000, suffix: 'Hz', step: 1 }, // 7
        { name: 'TZ Mode', value: 0, min: 0, max: 1, suffix: '', step: 1 },             // 8
    ],
    distortion: [
        { name: 'Drive', value: 30, min: 0, max: 100, suffix: '%', step: 1 },           // 0
        { name: 'Tone', value: 50, min: 0, max: 100, suffix: '%', step: 1 },            // 1
        { name: 'Mix', value: 100, min: 0, max: 100, suffix: '%', step: 1 },            // 2
        { name: 'Mode', value: 0, min: 0, max: 4, suffix: '', step: 1 },                // 3
        { name: 'Output', value: 0, min: -24, max: 6, suffix: 'dB', step: 0.1 },        // 4
        { name: 'Cab Sim', value: 1, min: 0, max: 1, suffix: '', step: 1 },             // 5
        { name: 'Tight', value: 50, min: 0, max: 100, suffix: '%', step: 1 },           // 6
        { name: 'Bias', value: 0, min: -100, max: 100, suffix: '%', step: 1 },          // 7
    ],
    bitcrusher: [
        { name: 'Bits', value: 16, min: 1, max: 32, suffix: '', step: 1 },              // 0
        { name: 'Down', value: 1, min: 1, max: 64, suffix: 'x', step: 1 },              // 1
        { name: 'Mix', value: 100, min: 0, max: 100, suffix: '%', step: 1 },            // 2
        { name: 'Jitter', value: 0, min: 0, max: 100, suffix: '%', step: 1 },           // 3
        { name: 'Pre Freq', value: 20000, min: 200, max: 20000, suffix: 'Hz', step: 1 },// 4
        { name: 'Post Freq', value: 20000, min: 200, max: 20000, suffix: 'Hz', step: 1 },// 5
        { name: 'Stereo', value: 0, min: 0, max: 1, suffix: '', step: 1 },              // 6
        { name: 'Dither', value: 0, min: 0, max: 100, suffix: '%', step: 1 },           // 7
    ],
    noiseMachine: [
        { name: 'Level', value: -12, min: -60, max: 0, suffix: 'dB', step: 0.5 },        // 0  BUG-P01 FIX: was Type! Backend 0=volume
        { name: 'Type', value: 0, min: 0, max: 5, suffix: '', step: 1 },                // 1  BUG-P01 FIX: was Level! Backend 1=type
        { name: 'Stereo', value: 100, min: 0, max: 100, suffix: '%', step: 1 },         // 2
        { name: 'LPFreq', value: 20000, min: 200, max: 20000, suffix: 'Hz', step: 1 },  // 3
        { name: 'HPFreq', value: 20, min: 20, max: 5000, suffix: 'Hz', step: 1 },       // 4
        { name: 'Pan', value: 0, min: -100, max: 100, suffix: '%', step: 1 },           // 5
    ],
    spectrum: [],
    analyzer: [
        { name: 'Reset', value: 0, min: 0, max: 1, suffix: '', step: 1 },
    ],
    midiPitch: [{ name: 'Semitones', value: 0, min: -48, max: 48, suffix: 'st', step: 1 }],
    midiScale: [
        { name: 'Root', value: 0, min: 0, max: 11, suffix: '', step: 1 },
        { name: 'Mask', value: 4095, min: 1, max: 4095, suffix: '', step: 1 },
    ],
    midiVelocity: [
        { name: 'Gain', value: 1, min: 0, max: 4, suffix: 'x', step: 0.01 },
        { name: 'Offset', value: 0, min: -127, max: 127, suffix: '', step: 1 },
    ],
    midiRandom: [
        { name: 'Semitones', value: 0, min: -24, max: 24, suffix: 'st', step: 1 },
        { name: 'Chance', value: 1, min: 0, max: 1, suffix: '', step: 0.01 },
    ],
    // BUG-33/34/35/36/37 FIX: New MIDI effect param sets.
    midiChord: [
        { name: 'Root', value: 0, min: 0, max: 11, suffix: '', step: 1 },
        { name: 'Octaves', value: 1, min: 1, max: 4, suffix: '', step: 1 },
        { name: 'Inversion', value: 0, min: 0, max: 3, suffix: '', step: 1 },
    ],
    midiNoteLength: [
        { name: 'Length', value: 100, min: 1, max: 2000, suffix: 'ms', step: 1 },
        { name: 'Gate', value: 100, min: 0, max: 200, suffix: '%', step: 1 },
    ],
    midiCcControl: [
        { name: 'CC', value: 1, min: 0, max: 127, suffix: '', step: 1 },
        { name: 'Value', value: 64, min: 0, max: 127, suffix: '', step: 1 },
    ],
    midiExpressionControl: [
        { name: 'CC', value: 11, min: 0, max: 127, suffix: '', step: 1 },
        { name: 'Value', value: 127, min: 0, max: 127, suffix: '', step: 1 },
    ],
    midiArpeggiator: [
        { name: 'Rate', value: 1, min: 0.25, max: 8, suffix: 'x', step: 0.25 },
        { name: 'Pattern', value: 0, min: 0, max: 5, suffix: '', step: 1 },
        { name: 'Octaves', value: 1, min: 1, max: 4, suffix: '', step: 1 },
        { name: 'Gate', value: 80, min: 5, max: 200, suffix: '%', step: 1 },
    ],
    sample_rack: [],
    rack: [],
};
