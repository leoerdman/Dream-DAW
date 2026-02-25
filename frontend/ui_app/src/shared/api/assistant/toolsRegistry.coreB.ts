import type { AssistantToolDefinition } from '@/shared/api/assistant/tools.types';

export const TOOL_DEFS_CORE_B: AssistantToolDefinition[] = [
    // ── Undo/Redo ──
    {
        type: 'function' as const,
        function: {
            name: 'undo',
            description: 'Undo the last action.',
            parameters: { type: 'object', properties: {}, required: [] },
        },
    },
    {
        type: 'function' as const,
        function: {
            name: 'redo',
            description: 'Redo the last undone action.',
            parameters: { type: 'object', properties: {}, required: [] },
        },
    },
    // ── Master ──
    {
        type: 'function' as const,
        function: {
            name: 'set_master_volume',
            description: 'Set master output volume (0.0-1.0).',
            parameters: {
                type: 'object',
                properties: { volume: { type: 'number' } },
                required: ['volume'],
            },
        },
    },
    // ── MIDI Composition Tools ──
    {
        type: 'function' as const,
        function: {
            name: 'add_midi_track',
            description: 'Add a new MIDI track to the project. Returns the new track index. Use instrument param to auto-assign Essence synth (for melodies, chords, pads, leads) or leave empty for drum rack tracks.',
            parameters: {
                type: 'object',
                properties: {
                    name: { type: 'string', description: 'Track name (optional)' },
                    instrument: { type: 'string', enum: ['essence', 'sampler'], description: 'Auto-assign instrument. Use "essence" for melodic tracks (bass, lead, pad, chord). Leave empty for drum rack tracks.' },
                },
                required: [],
            },
        },
    },
    {
        type: 'function' as const,
        function: {
            name: 'set_track_instrument',
            description: 'Set the instrument plugin on a MIDI track. Use "essence" for the built-in Essence synth (melodies, bass, leads, pads). Use "sampler" for drum racks. Replaces any existing instrument on the track.',
            parameters: {
                type: 'object',
                properties: {
                    trackIndex: { type: 'number', description: '0-based track index' },
                    instrument: { type: 'string', enum: ['essence', 'sampler'], description: '"essence" = Essence wavetable synth, "sampler" = Sampler/Drum Rack' },
                },
                required: ['trackIndex', 'instrument'],
            },
        },
    },
    {
        type: 'function' as const,
        function: {
            name: 'set_synth_param',
            description: 'Set a parameter on the Essence synth (or sampler). Use after set_track_instrument to shape the sound. Common params: "synth.osc1.wave" (0-7), "synth.osc2.wave" (0-7), "synth.osc.mix" (0-1), "synth.filter.cutoff" (0-1), "synth.filter.resonance" (0-1), "synth.filter.type" (0=LP,1=HP,2=BP,3=Notch), "synth.attack" (0.001-5), "synth.decay" (0.01-5), "synth.sustain" (0-1), "synth.release" (0.01-10), "synth.lfo.rate" (0.01-20), "synth.lfo.depth" (0-1), "synth.lfo.target" (0=filter,1=pitch,2=volume), "synth.pulse_width" (0.05-0.95), "synth.detune" (-100 to 100 cents), "synth.sub_level" (0-1).',
            parameters: {
                type: 'object',
                properties: {
                    trackIndex: { type: 'number', description: '0-based track index' },
                    paramId: { type: 'string', description: 'Parameter ID (e.g. "synth.filter.cutoff")' },
                    value: { type: 'number', description: 'Parameter value' },
                },
                required: ['trackIndex', 'paramId', 'value'],
            },
        },
    },
    {
        type: 'function' as const,
        function: {
            name: 'create_midi_clip',
            description: 'Create an empty MIDI clip on a track. Position and duration are in BEATS (will be converted to frames automatically). Returns the clip_id to use with set_clip_notes.',
            parameters: {
                type: 'object',
                properties: {
                    trackIndex: { type: 'number', description: '0-based track index' },
                    startBeat: { type: 'number', description: 'Start position in beats (e.g. 0 for bar 1, 4 for bar 2)' },
                    durationBeats: { type: 'number', description: 'Duration in beats (e.g. 4 for 1 bar, 8 for 2 bars)' },
                    name: { type: 'string', description: 'Clip name (optional)' },
                },
                required: ['trackIndex', 'startBeat', 'durationBeats'],
            },
        },
    },
    {
        type: 'function' as const,
        function: {
            name: 'set_clip_notes',
            description: 'Set MIDI notes in a clip. Each note has pitch (0-127, C4=60, kick=36, snare=38, hihat=42), velocity (1-127), startBeat (beat offset within clip, 0-based), durationBeats. For DnB: use 170-180 BPM, put kick on beats 0 and 2.5, snare on 1 and 3.',
            parameters: {
                type: 'object',
                properties: {
                    clipId: { type: 'string', description: 'Clip UUID from create_midi_clip' },
                    notes: {
                        type: 'array',
                        items: {
                            type: 'object',
                            properties: {
                                pitch: { type: 'number', description: 'MIDI note 0-127 (C4=60, kick=36, snare=38, closed hihat=42, open hihat=46, ride=51, crash=49)' },
                                velocity: { type: 'number', description: '1-127' },
                                startBeat: { type: 'number', description: 'Beat offset within clip (0-based)' },
                                durationBeats: { type: 'number', description: 'Note duration in beats' },
                            },
                            required: ['pitch', 'velocity', 'startBeat', 'durationBeats'],
                        },
                        description: 'Array of MIDI notes',
                    },
                },
                required: ['clipId', 'notes'],
            },
        },
    },
];
