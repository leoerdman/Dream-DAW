import type { AssistantToolDefinition } from '@/shared/api/assistant/tools.types';

export const TOOL_DEFS_ADV_A: AssistantToolDefinition[] = [
    // ── AI Producer Tools ──
    {
        type: 'function' as const,
        function: {
            name: 'search_browser',
            description: 'Search the asset browser for audio samples (e.g. kicks, claps, loops) by generic name. Returns matching file paths and durations.',
            parameters: {
                type: 'object',
                properties: {
                    query: { type: 'string', description: 'Search term (e.g. "kick", "clap", "bass")' },
                },
                required: ['query'],
            },
        },
    },
    {
        type: 'function' as const,
        function: {
            name: 'add_sample_to_rack',
            description: 'Load an audio sample into a specific pad (0-15) of a MIDI track\'s Drum Rack. Automatically instantiates the Drum Rack if it doesn\'t exist.',
            parameters: {
                type: 'object',
                properties: {
                    trackIndex: { type: 'number', description: '0-based index of the MIDI track' },
                    padIndex: { type: 'number', description: '0-15 (0=C1 usually Kick, 1=C#1 Snare/Clap, 2=D1 Closed Hat)' },
                    samplePath: { type: 'string', description: 'Absolute path to the audio file from search_browser' },
                },
                required: ['trackIndex', 'padIndex', 'samplePath'],
            },
        },
    },
    {
        type: 'function' as const,
        function: {
            name: 'add_audio_clip',
            description: 'Import an audio file (e.g. a loop) directly onto an audio track timeline at a specific beat.',
            parameters: {
                type: 'object',
                properties: {
                    trackIndex: { type: 'number', description: '0-based index of the audio track' },
                    samplePath: { type: 'string', description: 'Absolute path to the audio file from search_browser' },
                    startBeat: { type: 'number', description: 'Start position in beats (e.g. 0 for bar 1)' },
                },
                required: ['trackIndex', 'samplePath', 'startBeat'],
            },
        },
    },
    // ── Phase 1: Core Operations ──
    {
        type: 'function' as const,
        function: {
            name: 'move_clip',
            description: 'Move an existing clip to a new track or position (in beats).',
            parameters: {
                type: 'object',
                properties: {
                    clipId: { type: 'string' },
                    newTrackIndex: { type: 'number' },
                    newPositionBeats: { type: 'number' },
                },
                required: ['clipId', 'newTrackIndex', 'newPositionBeats'],
            }
        }
    },
    {
        type: 'function' as const,
        function: {
            name: 'duplicate_clip',
            description: 'Duplicate a clip. Optionally specify a new position in beats.',
            parameters: {
                type: 'object',
                properties: {
                    clipId: { type: 'string' },
                    newPositionBeats: { type: 'number' },
                },
                required: ['clipId'],
            }
        }
    },
    {
        type: 'function' as const,
        function: {
            name: 'split_clip',
            description: 'Split a clip at a specific beat position.',
            parameters: {
                type: 'object',
                properties: {
                    clipId: { type: 'string' },
                    splitBeat: { type: 'number' },
                },
                required: ['clipId', 'splitBeat'],
            }
        }
    },
    {
        type: 'function' as const,
        function: {
            name: 'set_clip_fade',
            description: 'Set fade-in and fade-out durations (in beats) for an audio clip.',
            parameters: {
                type: 'object',
                properties: {
                    clipId: { type: 'string' },
                    fadeInBeats: { type: 'number' },
                    fadeOutBeats: { type: 'number' },
                },
                required: ['clipId', 'fadeInBeats', 'fadeOutBeats'],
            }
        }
    },
    {
        type: 'function' as const,
        function: {
            name: 'merge_clips',
            description: 'Consolidate multiple clips on the same track into one continuous clip.',
            parameters: {
                type: 'object',
                properties: {
                    clipIds: { type: 'array', items: { type: 'string' } },
                },
                required: ['clipIds'],
            }
        }
    },
    {
        type: 'function' as const,
        function: {
            name: 'add_device',
            description: 'Add a builtin effect plugin to a track slot. effectType can be: eq, compressor, reverb, delay, distortion, chorus, flanger, phaser, limiter, utility, filter, saturation, stereo_imager, tremolo, vibrato, auto_pan, bit_crusher, ring_modulator, vocoder, gater, pitch_shifter.',
            parameters: {
                type: 'object',
                properties: {
                    trackIndex: { type: 'number' },
                    slotIndex: { type: 'number', description: '0-based effect slot index (e.g. 0 for first)' },
                    effectType: { type: 'string' },
                },
                required: ['trackIndex', 'slotIndex', 'effectType'],
            }
        }
    },
    {
        type: 'function' as const,
        function: {
            name: 'remove_device',
            description: 'Remove an effect plugin from a track slot.',
            parameters: {
                type: 'object',
                properties: {
                    trackIndex: { type: 'number' },
                    slotId: { type: 'string', description: 'The UUID of the plugin slot to remove' },
                },
                required: ['trackIndex', 'slotId'],
            }
        }
    },
    {
        type: 'function' as const,
        function: {
            name: 'set_effect_parameter',
            description: 'Set a specific parameter on an effect plugin.',
            parameters: {
                type: 'object',
                properties: {
                    trackIndex: { type: 'number' },
                    slotId: { type: 'string', description: 'The UUID of the plugin slot' },
                    paramId: { type: 'string', description: 'Internal parameter name (e.g. "cutoff", "gain", "threshold", "ratio")' },
                    value: { type: 'number' },
                },
                required: ['trackIndex', 'slotId', 'paramId', 'value'],
            }
        }
    },
    {
        type: 'function' as const,
        function: {
            name: 'create_track_group',
            description: 'Group multiple tracks into a new bus track for collective processing.',
            parameters: {
                type: 'object',
                properties: {
                    trackIndices: { type: 'array', items: { type: 'number' } },
                    groupName: { type: 'string' },
                },
                required: ['trackIndices', 'groupName'],
            }
        }
    },
    {
        type: 'function' as const,
        function: {
            name: 'set_loop_region',
            description: 'Enable loop and set start and end positions (in beats).',
            parameters: {
                type: 'object',
                properties: {
                    enabled: { type: 'boolean' },
                    startBeat: { type: 'number' },
                    endBeat: { type: 'number' },
                },
                required: ['enabled', 'startBeat', 'endBeat'],
            }
        }
    },
    // ── Phase 2: Music Theory & MIDI ──
    {
        type: 'function' as const,
        function: {
            name: 'quantize_notes',
            description: 'Quantize MIDI notes in a clip to the nearest grid. Grid can be: 1 (whole), 0.5 (half), 0.25 (quarter), 0.125 (8th), 0.0625 (16th). Strength 0-100% controls how far notes snap toward the grid.',
            parameters: {
                type: 'object',
                properties: {
                    clipId: { type: 'string' },
                    gridBeats: { type: 'number', description: 'Grid resolution in beats (e.g. 0.25 for quarter-note)' },
                    strength: { type: 'number', description: 'Quantize strength 0-100 (100=full snap)' },
                },
                required: ['clipId', 'gridBeats'],
            }
        }
    },
    {
        type: 'function' as const,
        function: {
            name: 'humanize_velocity',
            description: 'Add humanization to MIDI note velocities in a clip. Adds random variation within a range around each note\'s current velocity to make it sound less robotic.',
            parameters: {
                type: 'object',
                properties: {
                    clipId: { type: 'string' },
                    range: { type: 'number', description: 'Max random deviation from current velocity (e.g. 15 means ±15)' },
                },
                required: ['clipId', 'range'],
            }
        }
    },
    {
        type: 'function' as const,
        function: {
            name: 'generate_chord',
            description: 'Generate MIDI notes for a specific chord. Returns pitch array. Root is MIDI note number (e.g. 60=C4). Quality: major, minor, dim, aug, dom7, maj7, min7, sus2, sus4, add9, min9, maj9.',
            parameters: {
                type: 'object',
                properties: {
                    root: { type: 'number', description: 'MIDI root note (e.g. 60=C4, 48=C3)' },
                    quality: { type: 'string', description: 'Chord quality: major, minor, dim, aug, dom7, maj7, min7, sus2, sus4' },
                    octaveSpread: { type: 'number', description: 'Spread notes across N octaves (default 1)' },
                },
                required: ['root', 'quality'],
            }
        }
    },
    {
        type: 'function' as const,
        function: {
            name: 'generate_arpeggio',
            description: 'Generate an arpeggiated MIDI pattern from chord notes. Direction: up, down, updown, random. Rate in beats (0.25=16th, 0.5=8th).',
            parameters: {
                type: 'object',
                properties: {
                    clipId: { type: 'string', description: 'Target clip to write arpeggio into' },
                    pitches: { type: 'array', items: { type: 'number' }, description: 'Array of MIDI pitches to arpeggiate' },
                    direction: { type: 'string', description: 'up, down, updown, random' },
                    rateBeats: { type: 'number', description: 'Note rate in beats (0.25=16th)' },
                    durationBeats: { type: 'number', description: 'Total arpeggio duration in beats' },
                    velocity: { type: 'number', description: 'Note velocity 1-127' },
                    gatePercent: { type: 'number', description: 'Gate length as % of rate (50=staccato, 100=legato)' },
                },
                required: ['clipId', 'pitches', 'direction', 'rateBeats', 'durationBeats'],
            }
        }
    },
    {
        type: 'function' as const,
        function: {
            name: 'generate_scale',
            description: 'Returns all MIDI pitches in a given scale within a range. Useful for constraining melodies.',
            parameters: {
                type: 'object',
                properties: {
                    root: { type: 'number', description: 'Root MIDI note (e.g. 60=C4)' },
                    scaleType: { type: 'string', description: 'major, minor, dorian, phrygian, lydian, mixolydian, aeolian, locrian, pentatonic_major, pentatonic_minor, blues, harmonic_minor, melodic_minor, whole_tone, chromatic' },
                    lowNote: { type: 'number', description: 'Lowest MIDI note (e.g. 36)' },
                    highNote: { type: 'number', description: 'Highest MIDI note (e.g. 96)' },
                },
                required: ['root', 'scaleType'],
            }
        }
    },
];
