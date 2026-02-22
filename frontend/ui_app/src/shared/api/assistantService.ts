/* ═══════════════════════════════════════════════════════════════════════════
 * Dream DAW — AI Assistant Service (Enterprise)
 *
 * OpenRouter API ▸ Streaming ▸ 22 DAW tools ▸ Chain-of-Thought loop
 *
 * CRITICAL FIX: tool_calls are now included in assistant messages and
 * properly serialized for the API. This fixes Claude/Anthropic 400 errors
 * where tool_result blocks couldn't find matching tool_use blocks.
 * ═══════════════════════════════════════════════════════════════════════════ */

import { useEngineStore } from '@/shared/stores/useEngineStore';
import { useAgentActionStore, getToolLabel } from '@/shared/stores/useAgentActionStore';
import * as engineApi from '@/shared/api/engine';
import { resolveSampleRate } from '@/shared/lib/audioMath';

// ─── Types ──────────────────────────────────────────────────────────────────

export interface ChatMessage {
    role: 'user' | 'assistant' | 'tool';
    content: string;
    name?: string;           // tool name (for role=tool)
    tool_call_id?: string;   // matches the tool_call id
    thinking?: string;       // CoT trace
    /** Completed tool actions persisted after streaming ends. */
    actions?: Array<{
        toolName: string;
        args: Record<string, unknown>;
        result: string | null;
        index: number;
    }>;
    /** Tool calls made by the assistant in this message (needed for API round-trips). */
    tool_calls?: ToolCall[];
}

interface ToolCall {
    id: string;
    type: 'function';
    function: { name: string; arguments: string };
}

// ─── Tool definitions ───────────────────────────────────────────────────────

const TOOLS = [
    // ── Inspection ──
    {
        type: 'function' as const,
        function: {
            name: 'get_project_overview',
            description: 'Get full project overview: name, BPM, sample rate, time signature, track list with types and device counts.',
            parameters: { type: 'object', properties: {}, required: [] },
        },
    },
    {
        type: 'function' as const,
        function: {
            name: 'get_track_clips',
            description: 'Get all clips on a specific track by track name or 0-based index.',
            parameters: {
                type: 'object',
                properties: {
                    track: { type: 'string', description: 'Track name or 0-based index' },
                },
                required: ['track'],
            },
        },
    },
    {
        type: 'function' as const,
        function: {
            name: 'get_clip_details',
            description: 'Get full details for a clip by its UUID.',
            parameters: {
                type: 'object',
                properties: { clipId: { type: 'string' } },
                required: ['clipId'],
            },
        },
    },
    {
        type: 'function' as const,
        function: {
            name: 'get_transport_state',
            description: 'Get current transport state: playing, position, BPM, loop settings.',
            parameters: { type: 'object', properties: {}, required: [] },
        },
    },
    // ── Selection ──
    {
        type: 'function' as const,
        function: {
            name: 'select_clips',
            description: 'Select clips on timeline by their IDs.',
            parameters: {
                type: 'object',
                properties: { clipIds: { type: 'array', items: { type: 'string' } } },
                required: ['clipIds'],
            },
        },
    },
    {
        type: 'function' as const,
        function: {
            name: 'select_all_clips_on_track',
            description: 'Select all clips on a track by name or index.',
            parameters: {
                type: 'object',
                properties: { track: { type: 'string' } },
                required: ['track'],
            },
        },
    },
    // ── Transport ──
    {
        type: 'function' as const,
        function: {
            name: 'transport_play',
            description: 'Start playback.',
            parameters: { type: 'object', properties: {}, required: [] },
        },
    },
    {
        type: 'function' as const,
        function: {
            name: 'transport_stop',
            description: 'Stop playback.',
            parameters: { type: 'object', properties: {}, required: [] },
        },
    },
    {
        type: 'function' as const,
        function: {
            name: 'set_bpm',
            description: 'Set project BPM.',
            parameters: {
                type: 'object',
                properties: { bpm: { type: 'number' } },
                required: ['bpm'],
            },
        },
    },
    {
        type: 'function' as const,
        function: {
            name: 'seek_to_beat',
            description: 'Seek playhead to a specific beat position.',
            parameters: {
                type: 'object',
                properties: { beat: { type: 'number' } },
                required: ['beat'],
            },
        },
    },
    // ── Track management ──
    {
        type: 'function' as const,
        function: {
            name: 'set_track_volume',
            description: 'Set volume for a track (0.0-1.0). Index is 0-based.',
            parameters: {
                type: 'object',
                properties: {
                    trackIndex: { type: 'number' },
                    volume: { type: 'number' },
                },
                required: ['trackIndex', 'volume'],
            },
        },
    },
    {
        type: 'function' as const,
        function: {
            name: 'set_track_pan',
            description: 'Set panning for a track (-1.0 to 1.0, 0 = center). Index is 0-based.',
            parameters: {
                type: 'object',
                properties: {
                    trackIndex: { type: 'number' },
                    pan: { type: 'number' },
                },
                required: ['trackIndex', 'pan'],
            },
        },
    },
    {
        type: 'function' as const,
        function: {
            name: 'set_track_mute',
            description: 'Mute or unmute a track. Index is 0-based.',
            parameters: {
                type: 'object',
                properties: {
                    trackIndex: { type: 'number' },
                    muted: { type: 'boolean' },
                },
                required: ['trackIndex', 'muted'],
            },
        },
    },
    {
        type: 'function' as const,
        function: {
            name: 'set_track_solo',
            description: 'Solo or unsolo a track. Index is 0-based.',
            parameters: {
                type: 'object',
                properties: {
                    trackIndex: { type: 'number' },
                    soloed: { type: 'boolean' },
                },
                required: ['trackIndex', 'soloed'],
            },
        },
    },
    {
        type: 'function' as const,
        function: {
            name: 'add_track',
            description: 'Add a new track to the project. Optionally provide a name.',
            parameters: {
                type: 'object',
                properties: { name: { type: 'string' } },
                required: [],
            },
        },
    },
    {
        type: 'function' as const,
        function: {
            name: 'rename_track',
            description: 'Rename a track. Index is 0-based.',
            parameters: {
                type: 'object',
                properties: {
                    trackIndex: { type: 'number' },
                    name: { type: 'string' },
                },
                required: ['trackIndex', 'name'],
            },
        },
    },
    {
        type: 'function' as const,
        function: {
            name: 'delete_track',
            description: 'Delete a single track by its index. Warning: If deleting multiple tracks, use delete_tracks_batch instead, because deleting one track shifts the indices of all subsequent tracks.',
            parameters: {
                type: 'object',
                properties: {
                    trackIndex: { type: 'number', description: 'Zero-based index of track to delete' },
                },
                required: ['trackIndex'],
            }
        }
    },
    {
        type: 'function' as const,
        function: {
            name: 'delete_tracks_batch',
            description: 'Safely delete multiple tracks at once. Pass an array of exact track indices you want to delete. This safely resolves index-shifting issues automatically.',
            parameters: {
                type: 'object',
                properties: {
                    trackIndices: {
                        type: 'array',
                        items: { type: 'number' },
                        description: 'Array of zero-based track indices to delete'
                    }
                },
                required: ['trackIndices']
            }
        }
    },
    {
        type: 'function' as const,
        function: {
            name: 'delete_clip',
            description: 'Delete a clip by its UUID.',
            parameters: {
                type: 'object',
                properties: { clipId: { type: 'string' } },
                required: ['clipId'],
            },
        },
    },
    {
        type: 'function' as const,
        function: {
            name: 'set_clip_muted',
            description: 'Mute or unmute a specific clip.',
            parameters: {
                type: 'object',
                properties: {
                    clipId: { type: 'string' },
                    muted: { type: 'boolean' },
                },
                required: ['clipId', 'muted'],
            },
        },
    },
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
            name: 'add_effect',
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
            name: 'remove_effect',
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
    // ── Phase 2: Sample Rack Pad Controls ──
    {
        type: 'function' as const,
        function: {
            name: 'set_pad_volume',
            description: 'Set volume for a specific Drum Rack pad (0.0-1.0).',
            parameters: {
                type: 'object',
                properties: {
                    trackIndex: { type: 'number' },
                    padIndex: { type: 'number', description: '0-15' },
                    volume: { type: 'number', description: '0.0-1.0' },
                },
                required: ['trackIndex', 'padIndex', 'volume'],
            }
        }
    },
    {
        type: 'function' as const,
        function: {
            name: 'set_pad_mute',
            description: 'Mute/unmute a specific Drum Rack pad.',
            parameters: {
                type: 'object',
                properties: {
                    trackIndex: { type: 'number' },
                    padIndex: { type: 'number' },
                    muted: { type: 'boolean' },
                },
                required: ['trackIndex', 'padIndex', 'muted'],
            }
        }
    },
    {
        type: 'function' as const,
        function: {
            name: 'set_pad_adsr',
            description: 'Set ADSR envelope for a Drum Rack pad. All times in seconds.',
            parameters: {
                type: 'object',
                properties: {
                    trackIndex: { type: 'number' },
                    padIndex: { type: 'number' },
                    attack: { type: 'number', description: 'Attack time in seconds (0.001-2.0)' },
                    decay: { type: 'number', description: 'Decay time in seconds (0.01-5.0)' },
                    sustain: { type: 'number', description: 'Sustain level 0.0-1.0' },
                    release: { type: 'number', description: 'Release time in seconds (0.01-10.0)' },
                },
                required: ['trackIndex', 'padIndex', 'attack', 'decay', 'sustain', 'release'],
            }
        }
    },
    {
        type: 'function' as const,
        function: {
            name: 'set_pad_filter_cutoff',
            description: 'Set the low-pass filter cutoff on a Drum Rack pad (0.0-1.0, where 1.0 = fully open).',
            parameters: {
                type: 'object',
                properties: {
                    trackIndex: { type: 'number' },
                    padIndex: { type: 'number' },
                    cutoff: { type: 'number', description: '0.0-1.0' },
                },
                required: ['trackIndex', 'padIndex', 'cutoff'],
            }
        }
    },
    // ── Phase 2/3: Track Styling, Bypass, Preview ──
    {
        type: 'function' as const,
        function: {
            name: 'set_track_color',
            description: 'Set the color of a track. Use hex color (e.g. "#FF5733").',
            parameters: {
                type: 'object',
                properties: {
                    trackIndex: { type: 'number' },
                    colorHex: { type: 'string' },
                },
                required: ['trackIndex', 'colorHex'],
            }
        }
    },
    {
        type: 'function' as const,
        function: {
            name: 'bypass_effect',
            description: 'Bypass (disable) or enable an effect slot on a track.',
            parameters: {
                type: 'object',
                properties: {
                    trackIndex: { type: 'number' },
                    slotIndex: { type: 'number' },
                    bypassed: { type: 'boolean' },
                },
                required: ['trackIndex', 'slotIndex', 'bypassed'],
            }
        }
    },
    {
        type: 'function' as const,
        function: {
            name: 'preview_note',
            description: 'Play a sample/instrument preview note on a track (audition without recording). Good for testing Drum Rack pads.',
            parameters: {
                type: 'object',
                properties: {
                    trackIndex: { type: 'number' },
                    pitch: { type: 'number', description: 'MIDI note 0-127 (e.g. 36=C1 for kick pad)' },
                    velocity: { type: 'number', description: '1-127 (default 100)' },
                },
                required: ['trackIndex', 'pitch'],
            }
        }
    },
    // ── Phase 3: Intelligent Mixing ──
    {
        type: 'function' as const,
        function: {
            name: 'auto_gain_stage',
            description: 'Automatically normalize all track volumes to a target level. Sets all tracks to the specified volume level for a clean starting mix.',
            parameters: {
                type: 'object',
                properties: {
                    targetVolume: { type: 'number', description: 'Target linear volume for all tracks (0.0-1.0, default 0.7 ≈ -3dB)' },
                },
                required: [],
            }
        }
    },
    {
        type: 'function' as const,
        function: {
            name: 'auto_cleanup_mix',
            description: 'Automatically apply high-pass filters to tracks that typically don\'t need low-end (hats, vocals, synths). Removes mud from the mix.',
            parameters: {
                type: 'object',
                properties: {
                    excludeTrackIndices: { type: 'array', items: { type: 'number' }, description: 'Track indices to exclude from cleanup (e.g. kick, bass tracks)' },
                },
                required: [],
            }
        }
    },
    // ── Phase 4: Creative Arrangement ──
    {
        type: 'function' as const,
        function: {
            name: 'suggest_arrangement',
            description: 'Analyze current clips and suggest a full song arrangement structure. Returns a JSON plan of sections (Intro, Verse, Chorus, Bridge, Drop, Outro) with their beat positions.',
            parameters: {
                type: 'object',
                properties: {
                    genre: { type: 'string', description: 'Target genre (house, techno, dnb, hiphop, pop, lofi, ambient)' },
                    durationBars: { type: 'number', description: 'Target song length in bars (e.g. 64 for a 4-minute track at 128bpm)' },
                },
                required: ['genre'],
            }
        }
    },
    {
        type: 'function' as const,
        function: {
            name: 'get_metering',
            description: 'Get real-time peak and RMS metering for all tracks and master bus. Useful for mix analysis.',
            parameters: { type: 'object', properties: {}, required: [] },
        }
    },

    // ── Batch Operations (10x faster than individual calls) ──
    {
        type: 'function' as const,
        function: {
            name: 'add_audio_clips_batch',
            description: 'Add multiple audio clips at once. MUCH faster than calling add_audio_clip individually. Use this when placing repeated samples (kick on every beat, hi-hat pattern, etc).',
            parameters: {
                type: 'object',
                properties: {
                    clips: {
                        type: 'array',
                        description: 'Array of clip placements',
                        items: {
                            type: 'object',
                            properties: {
                                trackIndex: { type: 'number' },
                                samplePath: { type: 'string' },
                                startBeat: { type: 'number' },
                            },
                            required: ['trackIndex', 'samplePath', 'startBeat'],
                        },
                    },
                },
                required: ['clips'],
            }
        }
    },
    {
        type: 'function' as const,
        function: {
            name: 'delete_clips_batch',
            description: 'Delete multiple clips at once by their IDs. MUCH faster than calling delete_clip individually.',
            parameters: {
                type: 'object',
                properties: {
                    clipIds: { type: 'array', items: { type: 'string' }, description: 'Array of clip IDs to delete' },
                },
                required: ['clipIds'],
            }
        }
    },
    {
        type: 'function' as const,
        function: {
            name: 'delete_all_clips_on_track',
            description: 'Delete ALL clips on a specific track in one call. Use this to clear a track before rebuilding a pattern.',
            parameters: {
                type: 'object',
                properties: {
                    track: { type: 'string', description: 'Track index or name' },
                },
                required: ['track'],
            }
        }
    },

    // ── Beat Pattern Generator (AI Shortcut) ──
    {
        type: 'function' as const,
        function: {
            name: 'generate_beat_pattern',
            description: 'Generate a standard drum beat pattern for a given genre. Returns arrays of {pitch, startBeat, velocity} for kick, snare/clap, and hi-hat. Use this to quickly create genre-correct patterns instead of manually placing notes.',
            parameters: {
                type: 'object',
                properties: {
                    genre: { type: 'string', description: 'Genre: house, techno, dnb, hiphop, trap, lofi' },
                    bars: { type: 'number', description: 'Number of bars to generate (default: 4)' },
                    swing: { type: 'number', description: 'Swing amount 0.0-0.5 (0 = straight, 0.33 = shuffle). Default 0.' },
                },
                required: ['genre'],
            }
        }
    },

    // ═══════════════════════════════════════════════════════════════════════
    // PHASE 5: Deep Music Production Tools (20 new)
    // ═══════════════════════════════════════════════════════════════════════

    // ── MIDI Inspection (Piano Roll Read) ──
    {
        type: 'function' as const,
        function: {
            name: 'get_midi_clip_notes',
            description: 'Read all MIDI notes from a clip. Returns pitch, startBeat, durationBeats, velocity for every note. Use this to see pattern contents, analyze existing MIDI, or check what the agent previously wrote.',
            parameters: {
                type: 'object',
                properties: {
                    clipId: { type: 'string', description: 'Clip UUID' },
                },
                required: ['clipId'],
            }
        }
    },

    // ── Clip Editing: Resize, Warp, Source Offset ──
    {
        type: 'function' as const,
        function: {
            name: 'resize_clip',
            description: 'Resize a clip to a new start position and duration (in beats). Useful for trimming, extending, or adjusting clip boundaries.',
            parameters: {
                type: 'object',
                properties: {
                    clipId: { type: 'string' },
                    newStartBeat: { type: 'number', description: 'New start position in beats' },
                    newDurationBeats: { type: 'number', description: 'New duration in beats' },
                },
                required: ['clipId', 'newStartBeat', 'newDurationBeats'],
            }
        }
    },
    {
        type: 'function' as const,
        function: {
            name: 'set_clip_warp',
            description: 'Enable/disable time-stretching (warp) on a clip. Set warp mode and base BPM for tempo-synced playback.',
            parameters: {
                type: 'object',
                properties: {
                    clipId: { type: 'string' },
                    isWarped: { type: 'boolean', description: 'Enable warp (time-stretch to project BPM)' },
                    warpBaseBpm: { type: 'number', description: 'Original BPM of the sample (used to calculate stretch ratio)' },
                },
                required: ['clipId', 'isWarped'],
            }
        }
    },
    {
        type: 'function' as const,
        function: {
            name: 'set_clip_source_offset',
            description: 'Slip-edit a clip: shift the waveform inside the clip frame without moving the clip. Useful for finding the perfect loop point.',
            parameters: {
                type: 'object',
                properties: {
                    clipId: { type: 'string' },
                    offsetBeats: { type: 'number', description: 'Source offset in beats' },
                },
                required: ['clipId', 'offsetBeats'],
            }
        }
    },

    // ── Audio Preview (Audition) ──
    {
        type: 'function' as const,
        function: {
            name: 'preview_audio_file',
            description: 'Play an audio file through the system output for auditioning. Use search_browser first to find the file path, then preview it before committing to the arrangement.',
            parameters: {
                type: 'object',
                properties: {
                    path: { type: 'string', description: 'Absolute path to the audio file' },
                },
                required: ['path'],
            }
        }
    },
    {
        type: 'function' as const,
        function: {
            name: 'stop_preview',
            description: 'Stop the currently playing audio preview.',
            parameters: { type: 'object', properties: {}, required: [] },
        }
    },
    {
        type: 'function' as const,
        function: {
            name: 'get_audio_file_duration',
            description: 'Get the exact duration in seconds of an audio file. Useful for calculating how many beats a sample spans at the current BPM.',
            parameters: {
                type: 'object',
                properties: {
                    path: { type: 'string', description: 'Absolute path to the audio file' },
                },
                required: ['path'],
            }
        }
    },

    // ── Project Settings ──
    {
        type: 'function' as const,
        function: {
            name: 'set_arrangement_grid',
            description: 'Set the arrangement/editor grid size (e.g. 1/4, 1/8, 1/16 notes). Also controls snap-to-grid.',
            parameters: {
                type: 'object',
                properties: {
                    numerator: { type: 'number', description: 'Grid numerator (e.g. 1)' },
                    denominator: { type: 'number', description: 'Grid denominator (e.g. 4 for quarter, 8 for eighth, 16 for sixteenth)' },
                    snapToGrid: { type: 'boolean', description: 'Enable snap-to-grid' },
                },
                required: ['numerator', 'denominator'],
            }
        }
    },
    {
        type: 'function' as const,
        function: {
            name: 'set_key_signature',
            description: 'Set the project key signature. Helps constrain MIDI generation to correct pitches.',
            parameters: {
                type: 'object',
                properties: {
                    enabled: { type: 'boolean', description: 'Enable key signature display' },
                    tonic: { type: 'string', description: 'Root note: C, C#, D, D#, E, F, F#, G, G#, A, A#, B' },
                    mode: { type: 'string', description: 'Scale mode: major, minor, dorian, mixolydian, phrygian, lydian, locrian' },
                },
                required: ['tonic', 'mode'],
            }
        }
    },

    // ── Track Operations ──
    {
        type: 'function' as const,
        function: {
            name: 'duplicate_tracks',
            description: 'Duplicate one or more tracks with all their clips, effects, and settings.',
            parameters: {
                type: 'object',
                properties: {
                    trackIndices: { type: 'array', items: { type: 'number' }, description: 'Array of 0-based track indices to duplicate' },
                },
                required: ['trackIndices'],
            }
        }
    },
    {
        type: 'function' as const,
        function: {
            name: 'move_track',
            description: 'Move a track to a new position in the track list.',
            parameters: {
                type: 'object',
                properties: {
                    trackIndex: { type: 'number', description: 'Current 0-based track index' },
                    targetIndex: { type: 'number', description: 'New 0-based position' },
                },
                required: ['trackIndex', 'targetIndex'],
            }
        }
    },
    {
        type: 'function' as const,
        function: {
            name: 'set_track_routing',
            description: 'Route a track\'s audio output to another track (bus) or master. Use "master" to route to the master bus.',
            parameters: {
                type: 'object',
                properties: {
                    trackIndex: { type: 'number', description: '0-based track index' },
                    target: { type: 'string', description: '"master" or track name/index for bus routing' },
                },
                required: ['trackIndex', 'target'],
            }
        }
    },
    {
        type: 'function' as const,
        function: {
            name: 'arm_track',
            description: 'Arm a track for recording. When armed, the track will record audio input on play.',
            parameters: {
                type: 'object',
                properties: {
                    trackIndex: { type: 'number' },
                    armed: { type: 'boolean' },
                },
                required: ['trackIndex', 'armed'],
            }
        }
    },

    // ── Sampler Extended ──
    {
        type: 'function' as const,
        function: {
            name: 'set_pad_solo',
            description: 'Solo a pad in the drum rack. Only the soloed pad will sound.',
            parameters: {
                type: 'object',
                properties: {
                    trackIndex: { type: 'number' },
                    padIndex: { type: 'number' },
                    soloed: { type: 'boolean' },
                },
                required: ['trackIndex', 'padIndex', 'soloed'],
            }
        }
    },

    // ── Batch Clip Operations ──
    {
        type: 'function' as const,
        function: {
            name: 'set_clips_muted_batch',
            description: 'Mute or unmute multiple clips at once in an undo-safe batch.',
            parameters: {
                type: 'object',
                properties: {
                    clipIds: { type: 'array', items: { type: 'string' } },
                    muted: { type: 'boolean' },
                },
                required: ['clipIds', 'muted'],
            }
        }
    },

    // ── Bounce / Export ──
    {
        type: 'function' as const,
        function: {
            name: 'bounce_track',
            description: 'Bounce a track (with all its effects) to a new audio track. Useful for freezing CPU-heavy instruments or committing effects.',
            parameters: {
                type: 'object',
                properties: {
                    trackIndex: { type: 'number', description: '0-based track index to bounce' },
                },
                required: ['trackIndex'],
            }
        }
    },
    {
        type: 'function' as const,
        function: {
            name: 'export_mix',
            description: 'Export/bounce the full project or loop region to an audio file (WAV/MP3).',
            parameters: {
                type: 'object',
                properties: {
                    outputPath: { type: 'string', description: 'Full path for the output file' },
                    format: { type: 'string', description: '"wav" or "mp3"' },
                    sampleRate: { type: 'number', description: '44100, 48000, or 96000' },
                    bitDepth: { type: 'number', description: '16, 24, or 32' },
                    range: { type: 'string', description: '"full" (entire project) or "loop" (loop region only)' },
                    normalize: { type: 'boolean', description: 'Normalize to 0dBFS' },
                },
                required: ['outputPath'],
            }
        }
    },

    // ── Automation ──
    {
        type: 'function' as const,
        function: {
            name: 'set_automation_points',
            description: 'Write automation breakpoints for a track parameter. Enables complex evolving mixes (volume fades, filter sweeps, pan movements).',
            parameters: {
                type: 'object',
                properties: {
                    trackIndex: { type: 'number' },
                    paramId: { type: 'string', description: 'Parameter ID: "volume", "pan", or effect parameter name' },
                    points: {
                        type: 'array',
                        items: {
                            type: 'object',
                            properties: {
                                beat: { type: 'number' },
                                value: { type: 'number', description: 'Parameter value (0.0-1.0 for volume/pan)' },
                                curveType: { type: 'string', description: '"linear", "step", or "bezier"' },
                            },
                            required: ['beat', 'value'],
                        }
                    },
                },
                required: ['trackIndex', 'paramId', 'points'],
            }
        }
    },

    // ── Arrangement Overview (Read) ──
    {
        type: 'function' as const,
        function: {
            name: 'get_arrangement_overview',
            description: 'Get a high-level overview of the entire arrangement: all tracks with their clips, positions, durations, and MIDI note counts. Shows the full "bird\'s eye view" of the song structure.',
            parameters: { type: 'object', properties: {}, required: [] },
        }
    },
];




// ─── Resolve track index ────────────────────────────────────────────────────

function resolveTrackIndex(track: string): number {
    const idx = parseInt(track, 10);
    if (!isNaN(idx)) return idx;
    const tracks = useEngineStore.getState().projectTracks;
    const found = tracks.findIndex(
        (t) => t.name.toLowerCase() === track.toLowerCase(),
    );
    return found >= 0 ? found : -1;
}

// ─── Read-only tools (no fetchProject needed) ───────────────────────────────────
const READ_ONLY_TOOLS = new Set([
    'get_project_overview', 'get_track_clips', 'get_clip_details',
    'get_transport_state', 'select_clips', 'select_all_clips_on_track',
    'generate_chord', 'generate_scale', 'suggest_arrangement', 'get_metering',
    'generate_beat_pattern', 'get_midi_clip_notes', 'get_audio_file_duration',
    'get_arrangement_overview', 'preview_audio_file', 'stop_preview',
]);

async function executeTool(
    name: string,
    args: Record<string, unknown>,
    onSelectClips?: (ids: string[]) => void,
): Promise<string> {
    // Show visual feedback for every action
    useAgentActionStore.getState().showAction(getToolLabel(name));

    let result: string;
    try {
        result = await executeToolInner(name, args, onSelectClips);
    } catch (err: unknown) {
        const errorMsg = err instanceof Error ? err.message : String(err);
        console.warn(`[Assistant Tool Error] ${name}:`, errorMsg);
        return JSON.stringify({
            error: true,
            message: `Tool ${name} failed to execute: ${errorMsg}. Please revise your tool arguments or try an alternative approach.`
        });
    }

    // CRITICAL: Refresh frontend store after any mutation so UI shows
    // updated BPM, tracks, clips, etc. Without this, the Zustand store
    // stays stale and the timeline doesn't show newly created clips.
    if (!READ_ONLY_TOOLS.has(name)) {
        try {
            await useEngineStore.getState().fetchProject(`agent-tool:${name}`);
        } catch (e) {
            console.warn('[Agent] fetchProject after tool failed:', e);
        }
    }

    return result;
}

async function executeToolInner(
    name: string,
    args: Record<string, unknown>,
    onSelectClips?: (ids: string[]) => void,
): Promise<string> {
    const state = useEngineStore.getState();
    const tracks = state.projectTracks;
    const clips = state.timelineClips;

    switch (name) {
        case 'get_project_overview': {
            let projectName = 'Untitled';
            try {
                const status = await engineApi.getProjectStatus();
                if (status.filePath) {
                    const parts = status.filePath.replace(/\\/g, '/').split('/');
                    projectName = parts[parts.length - 1]?.replace(/\.dream$/, '') || 'Untitled';
                }
            } catch { /* fallback */ }
            return JSON.stringify({
                projectName,
                bpm: state.projectBpm || state.transport.bpm || 120,
                sampleRate: resolveSampleRate(state.projectSampleRate),
                isPlaying: state.transport.is_playing,
                positionBeats: state.transport.position_beats ?? 0,
                trackCount: tracks.length,
                totalClips: clips.length,
                tracks: tracks.map((t, i) => ({
                    index: i,
                    id: t.id,
                    name: t.name,
                    type: t.track_type,
                    volume: t.volume,
                    pan: t.pan,
                    muted: t.is_mute,
                    soloed: t.is_solo,
                    armed: t.is_armed,
                    color: t.color,
                    instrument: t.instrument?.name ?? null,
                    effects: (t.effects ?? []).map(e => e.name),
                    clipCount: clips.filter((c) => c.trackIndex === i).length,
                })),
            });
        }

        case 'get_track_clips': {
            const idx = resolveTrackIndex(args.track as string);
            const trackClips = clips.filter((c) => c.trackIndex === idx);
            return JSON.stringify(trackClips.map((c) => ({
                id: c.id,
                name: c.name,
                startBeat: c.startBeat,
                durationBeats: c.durationBeats,
                type: c.type,
                muted: c.muted,
            })));
        }

        case 'get_clip_details': {
            const clip = clips.find((c) => c.id === args.clipId);
            return clip ? JSON.stringify(clip) : JSON.stringify({ error: 'Clip not found' });
        }

        case 'get_transport_state': {
            const t = state.transport;
            return JSON.stringify({
                isPlaying: t.is_playing,
                positionFrames: t.position_frames,
                bpm: state.projectBpm || t.bpm,
                loopEnabled: t.loop_enabled,
                loopStartFrames: t.loop_start,
                loopEndFrames: t.loop_end,
            });
        }

        case 'select_clips': {
            const ids = args.clipIds as string[];
            onSelectClips?.(ids);
            return JSON.stringify({ selected: ids.length });
        }

        case 'select_all_clips_on_track': {
            const idx = resolveTrackIndex(args.track as string);
            const ids = clips.filter((c) => c.trackIndex === idx).map((c) => c.id);
            onSelectClips?.(ids);
            return JSON.stringify({ selected: ids.length, trackIndex: idx });
        }

        case 'transport_play':
            await engineApi.play();
            return JSON.stringify({ status: 'playing' });

        case 'transport_stop':
            await engineApi.stop();
            return JSON.stringify({ status: 'stopped' });

        case 'set_bpm':
            await engineApi.setBpm(args.bpm as number);
            return JSON.stringify({ bpm: args.bpm });

        case 'seek_to_beat':
            await engineApi.seekToBeat(args.beat as number);
            return JSON.stringify({ seekedTo: args.beat });

        case 'set_track_volume': {
            // BUG-13 FIX: Clamp volume to valid range
            const vol = Math.max(0, Math.min(1, args.volume as number));
            await engineApi.setTrackVolume(args.trackIndex as number, vol);
            return JSON.stringify({ trackIndex: args.trackIndex, volume: vol });
        }

        case 'set_track_pan': {
            // BUG-13 FIX: Clamp pan to valid range
            const pan = Math.max(-1, Math.min(1, args.pan as number));
            await engineApi.setTrackPan(args.trackIndex as number, pan);
            return JSON.stringify({ trackIndex: args.trackIndex, pan: pan });
        }

        case 'set_track_mute':
            await engineApi.setTrackMute(args.trackIndex as number, args.muted as boolean);
            return JSON.stringify({ trackIndex: args.trackIndex, muted: args.muted });

        case 'set_track_solo':
            await engineApi.setTrackSolo(args.trackIndex as number, args.soloed as boolean);
            return JSON.stringify({ trackIndex: args.trackIndex, soloed: args.soloed });

        case 'add_track': {
            const result = await engineApi.addTrack(args.name as string | undefined);
            return JSON.stringify({ added: true, result });
        }

        case 'rename_track':
            await engineApi.renameTrack(args.trackIndex as number, args.name as string);
            return JSON.stringify({ trackIndex: args.trackIndex, name: args.name });

        case 'delete_track':
            await engineApi.deleteTrack(args.trackIndex as number);
            return JSON.stringify({ deleted: args.trackIndex });

        case 'delete_tracks_batch': {
            const indices = args.trackIndices as number[];
            if (!Array.isArray(indices) || indices.length === 0) return JSON.stringify({ error: 'trackIndices array is required' });
            const stBatch = useEngineStore.getState();
            const idsToDelete = indices.map(idx => stBatch.projectTracks[idx]?.id).filter(Boolean);
            if (idsToDelete.length > 0) {
                await engineApi.deleteTracks(idsToDelete);
            }
            return JSON.stringify({ deletedIds: idsToDelete });
        }

        case 'delete_clip':
            await engineApi.deleteClip(args.clipId as string);
            return JSON.stringify({ deleted: args.clipId });

        // ── Batch Operations (10x faster) ──
        case 'add_audio_clips_batch': {
            const clipDefs = args.clips as { trackIndex: number; samplePath: string; startBeat: number }[];
            if (!Array.isArray(clipDefs) || clipDefs.length === 0) return JSON.stringify({ error: 'clips array is required' });
            const stBatch = useEngineStore.getState();
            const bpmBatch = stBatch.projectBpm || stBatch.transport.bpm || 120;
            const srBatch = resolveSampleRate(stBatch.projectSampleRate);
            const fpbBatch = (60.0 / bpmBatch) * srBatch;

            // BUG-7 FIX: Pre-delete overlapping clips for the entire batch
            let batchOverlapsRemoved = 0;
            for (const def of clipDefs) {
                const existing = clips.filter(c =>
                    c.trackIndex === def.trackIndex &&
                    c.startBeat <= def.startBeat &&
                    (c.startBeat + c.durationBeats) > def.startBeat
                );
                for (const oc of existing) {
                    try { await engineApi.deleteClip(oc.id); batchOverlapsRemoved++; } catch { /* skip */ }
                }
            }

            const results: { clipId: string; clipName: string; startBeat: number }[] = [];
            for (const def of clipDefs) {
                const startFrames = Math.round(def.startBeat * fpbBatch);
                const r = await engineApi.importAudioFile(def.samplePath, def.trackIndex, startFrames);
                results.push({ clipId: r.clip_id, clipName: r.clip_name, startBeat: def.startBeat });
            }
            return JSON.stringify({ success: true, clipsCreated: results.length, clips: results, overlapsRemoved: batchOverlapsRemoved });
        }

        case 'delete_clips_batch': {
            const idsToDelete = args.clipIds as string[];
            if (!Array.isArray(idsToDelete) || idsToDelete.length === 0) return JSON.stringify({ error: 'clipIds array is required' });
            let deleted = 0;
            for (const id of idsToDelete) {
                try { await engineApi.deleteClip(id); deleted++; } catch { /* skip missing */ }
            }
            return JSON.stringify({ success: true, deleted, total: idsToDelete.length });
        }

        case 'delete_all_clips_on_track': {
            const trackStr = args.track as string;
            const tIdx = resolveTrackIndex(trackStr);
            const toDelete = clips.filter(c => c.trackIndex === tIdx);
            for (const c of toDelete) {
                try { await engineApi.deleteClip(c.id); } catch { /* skip */ }
            }
            return JSON.stringify({ success: true, deleted: toDelete.length, trackIndex: tIdx });
        }

        case 'set_clip_muted':
            await engineApi.setClipMuted(args.clipId as string, args.muted as boolean);
            return JSON.stringify({ clipId: args.clipId, muted: args.muted });

        case 'undo':
            await engineApi.undo();
            return JSON.stringify({ undone: true });

        case 'redo':
            await engineApi.redo();
            return JSON.stringify({ redone: true });

        case 'set_master_volume':
            await engineApi.setMasterVolume(args.volume as number);
            return JSON.stringify({ masterVolume: args.volume });

        // ── MIDI Composition Tools ──
        case 'add_midi_track': {
            const trackName = (args.name as string) || undefined;
            await engineApi.addTrackAdvanced('midi', null, trackName);
            // Return the new track's index (it's appended at the end)
            const updatedState = useEngineStore.getState();
            const newIdx = updatedState.projectTracks.length - 1;
            const newTrackId = updatedState.projectTracks[newIdx]?.id;

            // Auto-assign instrument if requested
            const instrumentArg = (args.instrument as string | undefined)?.toLowerCase();
            let instrumentAssigned: string | null = null;
            if (instrumentArg && newTrackId) {
                const INSTRUMENT_MAP: Record<string, { pluginId: string; displayName: string }> = {
                    essence: { pluginId: 'internal://instrument/wave-synth', displayName: 'Essence' },
                    sampler: { pluginId: 'internal://instrument/sampler', displayName: 'Sampler' },
                };
                const entry = INSTRUMENT_MAP[instrumentArg];
                if (entry) {
                    await engineApi.addPluginToTrack(newTrackId, entry.pluginId, entry.displayName, 'instrument');
                    instrumentAssigned = entry.displayName;
                }
            }

            return JSON.stringify({ added: true, trackIndex: newIdx, name: trackName || `Track ${newIdx + 1}`, instrument: instrumentAssigned });
        }

        case 'set_track_instrument': {
            const siTrackIdx = args.trackIndex as number;
            const siTrackId = tracks[siTrackIdx]?.id;
            if (!siTrackId) return JSON.stringify({ error: `Track ${siTrackIdx} not found` });
            const siInstrument = ((args.instrument as string) || 'essence').toLowerCase();
            const SI_MAP: Record<string, { pluginId: string; displayName: string }> = {
                essence: { pluginId: 'internal://instrument/wave-synth', displayName: 'Essence' },
                sampler: { pluginId: 'internal://instrument/sampler', displayName: 'Sampler' },
            };
            const siEntry = SI_MAP[siInstrument];
            if (!siEntry) return JSON.stringify({ error: `Unknown instrument: ${siInstrument}. Use "essence" or "sampler".` });
            await engineApi.addPluginToTrack(siTrackId, siEntry.pluginId, siEntry.displayName, 'instrument');
            return JSON.stringify({ success: true, trackIndex: siTrackIdx, instrument: siEntry.displayName });
        }

        case 'set_synth_param': {
            const spTrackIdx = args.trackIndex as number;
            const spTrackId = tracks[spTrackIdx]?.id;
            if (!spTrackId) return JSON.stringify({ error: `Track ${spTrackIdx} not found` });
            const spParamId = args.paramId as string;
            const spValue = args.value as number;
            // Find the instrument slot ID on the track
            const spTrack = tracks[spTrackIdx];
            const instrumentSlotId = spTrack.instrument?.id;
            if (!instrumentSlotId) return JSON.stringify({ error: `Track ${spTrackIdx} has no instrument assigned. Use set_track_instrument first.` });
            await engineApi.setInternalPluginParam(spTrackId, instrumentSlotId, spParamId, spValue);
            return JSON.stringify({ success: true, trackIndex: spTrackIdx, paramId: spParamId, value: spValue });
        }

        case 'create_midi_clip': {
            const tIdx = args.trackIndex as number;
            const startBeat = args.startBeat as number;
            const durBeats = args.durationBeats as number;
            const clipName = (args.name as string) || undefined;

            // OVERLAP GUARD: Auto-delete clips that collide with the new clip's range.
            // This prevents the agent from stacking clips on top of each other.
            const endBeat = startBeat + durBeats;
            const overlapping = clips.filter(c =>
                c.trackIndex === tIdx &&
                c.startBeat < endBeat &&
                (c.startBeat + c.durationBeats) > startBeat
            );
            for (const oc of overlapping) {
                try { await engineApi.deleteClip(oc.id); } catch { /* skip missing */ }
            }

            // Convert beats to frames: frames = beats * 60 / BPM * sampleRate
            const st = useEngineStore.getState();
            const bpmVal = st.projectBpm || st.transport.bpm || 120;
            const srVal = resolveSampleRate(st.projectSampleRate);
            const framesPerBeat = (60.0 / bpmVal) * srVal;
            const posFrames = Math.round(startBeat * framesPerBeat);
            const durFrames = Math.round(durBeats * framesPerBeat);
            const result = await engineApi.createMidiClip(tIdx, posFrames, durFrames, clipName);
            return JSON.stringify({
                clipId: result.clip_id,
                clipName: result.clip_name,
                startBeat,
                durationBeats: durBeats,
                overlapsRemoved: overlapping.length,
            });
        }

        case 'set_clip_notes': {
            const clipId = args.clipId as string;
            const noteArgs = args.notes as Array<{ pitch: number; velocity: number; startBeat: number; durationBeats: number }>;
            const st2 = useEngineStore.getState();
            const bpm2 = st2.projectBpm || st2.transport.bpm || 120;
            const sr2 = resolveSampleRate(st2.projectSampleRate);
            const fpb2 = (60.0 / bpm2) * sr2;
            const engineNotes = noteArgs.map(n => ({
                pitch: n.pitch,
                velocity: n.velocity,
                startFrames: Math.round(n.startBeat * fpb2),
                durationFrames: Math.round(n.durationBeats * fpb2),
            }));
            await engineApi.updateMidiClip(clipId, engineNotes);
            return JSON.stringify({ clipId, notesWritten: engineNotes.length });
        }

        // ── AI Producer Tools ──
        case 'search_browser': {
            const query = (args.query as string).toLowerCase();
            const files = await engineApi.scanAllAudioSources();
            // Fuzzy match logic:
            const matches = files.filter(f => f.name.toLowerCase().includes(query));
            // Return top 10 matches to avoid blowing up context window
            const limited = matches.slice(0, 10).map(f => ({
                name: f.name,
                path: f.path,
                durationSeconds: f.duration_seconds
            }));
            return JSON.stringify({ matchesFound: matches.length, results: limited });
        }

        case 'add_sample_to_rack': {
            const trackIndex = args.trackIndex as number;
            const padIndex = args.padIndex as number;
            const samplePath = args.samplePath as string;
            const trackId = tracks[trackIndex]?.id;
            if (!trackId) return JSON.stringify({ error: `Track ${trackIndex} not found` });
            if (tracks[trackIndex].track_type.toLowerCase() !== 'midi') {
                return JSON.stringify({ error: `Track ${trackIndex} is not a MIDI track (type: ${tracks[trackIndex].track_type})` });
            }
            await engineApi.setSampleRackPadSample(trackId, padIndex, samplePath);
            return JSON.stringify({ success: true, trackIndex, padIndex, sampleLoaded: samplePath });
        }

        case 'add_audio_clip': {
            const trackIndex = args.trackIndex as number;
            const samplePath = args.samplePath as string;
            const startBeat = args.startBeat as number;

            // OVERLAP GUARD (BUG-4): auto-delete clips at the same position
            const overlapping = clips.filter(c =>
                c.trackIndex === trackIndex &&
                c.startBeat <= startBeat &&
                (c.startBeat + c.durationBeats) > startBeat
            );
            for (const oc of overlapping) {
                try { await engineApi.deleteClip(oc.id); } catch { /* skip missing */ }
            }

            const st3 = useEngineStore.getState();
            const bpm3 = st3.projectBpm || st3.transport.bpm || 120;
            const sr3 = resolveSampleRate(st3.projectSampleRate);
            const fpb3 = (60.0 / bpm3) * sr3;
            const startFrames = Math.round(startBeat * fpb3);

            const result = await engineApi.importAudioFile(samplePath, trackIndex, startFrames);
            return JSON.stringify({ success: true, clipId: result.clip_id, clipName: result.clip_name, startBeat, overlapsRemoved: overlapping.length });
        }

        // ── Phase 1: Core Operations ──
        case 'move_clip': {
            const clipId = args.clipId as string;
            const newTrackIndex = args.newTrackIndex as number;
            const newPositionBeats = args.newPositionBeats as number;

            const stMove = useEngineStore.getState();
            const fpbMove = (60.0 / (stMove.projectBpm || stMove.transport.bpm || 120)) * (resolveSampleRate(stMove.projectSampleRate));
            const posFrames = Math.round(newPositionBeats * fpbMove);

            await engineApi.moveClip(clipId, newTrackIndex, posFrames);
            return JSON.stringify({ success: true, clipId, newTrackIndex, newPositionBeats });
        }

        case 'duplicate_clip': {
            const clipId = args.clipId as string;
            let posFrames: number | undefined;
            if (args.newPositionBeats !== undefined) {
                const stDup = useEngineStore.getState();
                const fpbDup = (60.0 / (stDup.projectBpm || stDup.transport.bpm || 120)) * (resolveSampleRate(stDup.projectSampleRate));
                posFrames = Math.round((args.newPositionBeats as number) * fpbDup);
            }
            const result = await engineApi.duplicateClip(clipId, posFrames);
            return JSON.stringify({ success: true, duplicatedClipId: result.new_id });
        }

        case 'split_clip': {
            const clipId = args.clipId as string;
            const splitBeat = args.splitBeat as number;
            const stSplit = useEngineStore.getState();
            const fpbSplit = (60.0 / (stSplit.projectBpm || stSplit.transport.bpm || 120)) * (resolveSampleRate(stSplit.projectSampleRate));
            const splitFrames = Math.round(splitBeat * fpbSplit);
            const result = await engineApi.splitClip(clipId, splitFrames);
            return JSON.stringify({ success: true, originalClipId: clipId, leftId: result.left_id, rightId: result.right_id });
        }

        case 'set_clip_fade': {
            const clipId = args.clipId as string;
            const fIn = args.fadeInBeats as number;
            const fOut = args.fadeOutBeats as number;
            const stFade = useEngineStore.getState();
            const fpbFade = (60.0 / (stFade.projectBpm || stFade.transport.bpm || 120)) * (resolveSampleRate(stFade.projectSampleRate));
            await engineApi.setClipFades(clipId, Math.round(fIn * fpbFade), Math.round(fOut * fpbFade));
            return JSON.stringify({ success: true, clipId });
        }

        case 'merge_clips': {
            const clipIds = args.clipIds as string[];
            const result = await engineApi.mergeClips(clipIds);
            return JSON.stringify({ success: true, newClipId: result.new_id });
        }

        case 'add_effect': {
            const trackIndex = args.trackIndex as number;
            const slotIndex = args.slotIndex as number;
            const effectType = args.effectType as engineApi.BuiltinEffectType;
            await engineApi.addDevice(trackIndex, slotIndex, effectType);
            return JSON.stringify({ success: true, trackIndex, effectType });
        }

        case 'remove_effect': {
            const trackIndex = args.trackIndex as number;
            const slotId = args.slotId as string;
            const trackId = tracks[trackIndex]?.id;
            if (!trackId) return JSON.stringify({ error: `Track not found` });
            await engineApi.removePluginFromTrack(trackId, slotId);
            return JSON.stringify({ success: true, trackIndex, slotRemoved: slotId });
        }

        case 'set_effect_parameter': {
            const trackIndex = args.trackIndex as number;
            const slotId = args.slotId as string;
            const paramId = args.paramId as string;
            const val = args.value as number;
            const trackId = tracks[trackIndex]?.id;
            if (!trackId) return JSON.stringify({ error: `Track not found` });
            await engineApi.setInternalPluginParam(trackId, slotId, paramId, val);
            return JSON.stringify({ success: true, paramChanged: paramId, value: val });
        }

        case 'create_track_group': {
            const tIndices = args.trackIndices as number[];
            const name = args.groupName as string;
            const tIds = tIndices.map(i => tracks[i]?.id).filter(id => id) as string[];
            await engineApi.createGroup(tIds, name);
            return JSON.stringify({ success: true, groupName: name, tracksGrouped: tIds.length });
        }

        case 'set_loop_region': {
            const enabled = args.enabled as boolean;
            const stL = useEngineStore.getState();
            const fpbL = (60.0 / (stL.projectBpm || stL.transport.bpm || 120)) * (resolveSampleRate(stL.projectSampleRate));
            const startF = Math.round((args.startBeat as number) * fpbL);
            const endF = Math.round((args.endBeat as number) * fpbL);
            await engineApi.setLoop(enabled, startF, endF);
            return JSON.stringify({ success: true, loopEnabled: enabled, startBeat: args.startBeat, endBeat: args.endBeat });
        }

        // ── Phase 2: Music Theory & MIDI Algorithms ──
        case 'quantize_notes': {
            const clipId = args.clipId as string;
            const grid = args.gridBeats as number;
            const strength = (args.strength as number ?? 100) / 100;
            const clip = clips.find(c => c.id === clipId);
            if (!clip) return JSON.stringify({ error: 'Clip not found' });
            // Get existing notes, quantize them, write back
            const stQ = useEngineStore.getState();
            const bpmQ = stQ.projectBpm || stQ.transport.bpm || 120;
            const srQ = resolveSampleRate(stQ.projectSampleRate);
            const fpbQ = (60.0 / bpmQ) * srQ;
            const gridFrames = Math.round(grid * fpbQ);
            if (clip.midiNotes && clip.midiNotes.length > 0) {
                const quantized = clip.midiNotes.map(n => {
                    const startFrames = Math.round(n.startBeat * fpbQ);
                    const nearestGrid = Math.round(startFrames / gridFrames) * gridFrames;
                    const newStartFrames = Math.round(startFrames + (nearestGrid - startFrames) * strength);
                    return { pitch: n.pitch, velocity: n.velocity, startFrames: Math.max(0, newStartFrames), durationFrames: Math.round(n.durationBeats * fpbQ) };
                });
                await engineApi.updateMidiClip(clipId, quantized);
                return JSON.stringify({ success: true, notesQuantized: quantized.length, gridBeats: grid });
            }
            return JSON.stringify({ error: 'No MIDI notes found in clip' });
        }

        case 'humanize_velocity': {
            const clipId = args.clipId as string;
            const range = args.range as number;
            const clip = clips.find(c => c.id === clipId);
            if (!clip || !clip.midiNotes) return JSON.stringify({ error: 'Clip or notes not found' });
            const stH = useEngineStore.getState();
            const fpbH = (60.0 / (stH.projectBpm || stH.transport.bpm || 120)) * (resolveSampleRate(stH.projectSampleRate));
            const humanized = clip.midiNotes.map(n => {
                const delta = Math.round((Math.random() * 2 - 1) * range);
                return { pitch: n.pitch, velocity: Math.max(1, Math.min(127, n.velocity + delta)), startFrames: Math.round(n.startBeat * fpbH), durationFrames: Math.round(n.durationBeats * fpbH) };
            });
            await engineApi.updateMidiClip(clipId, humanized);
            return JSON.stringify({ success: true, notesHumanized: humanized.length });
        }

        case 'generate_chord': {
            const root = args.root as number;
            const quality = (args.quality as string).toLowerCase();
            const spread = (args.octaveSpread as number) || 1;
            const INTERVALS: Record<string, number[]> = {
                major: [0, 4, 7], minor: [0, 3, 7], dim: [0, 3, 6], aug: [0, 4, 8],
                dom7: [0, 4, 7, 10], maj7: [0, 4, 7, 11], min7: [0, 3, 7, 10],
                sus2: [0, 2, 7], sus4: [0, 5, 7], add9: [0, 4, 7, 14],
                min9: [0, 3, 7, 10, 14], maj9: [0, 4, 7, 11, 14],
                dim7: [0, 3, 6, 9], aug7: [0, 4, 8, 10],
                m7b5: [0, 3, 6, 10], '6': [0, 4, 7, 9], m6: [0, 3, 7, 9],
            };
            const intervals = INTERVALS[quality] || INTERVALS.major;
            let pitches: number[] = [];
            for (let oct = 0; oct < spread; oct++) {
                pitches = pitches.concat(intervals.map(i => root + i + oct * 12));
            }
            pitches = pitches.filter(p => p >= 0 && p <= 127);
            return JSON.stringify({ root, quality, pitches });
        }

        case 'generate_arpeggio': {
            const clipId = args.clipId as string;
            const pitches = args.pitches as number[];
            const direction = (args.direction as string) || 'up';
            const rate = args.rateBeats as number;
            const dur = args.durationBeats as number;
            const vel = (args.velocity as number) || 100;
            const gate = ((args.gatePercent as number) || 80) / 100;

            let sequence: number[] = [];
            if (direction === 'up') sequence = [...pitches];
            else if (direction === 'down') sequence = [...pitches].reverse();
            else if (direction === 'updown') sequence = [...pitches, ...[...pitches].reverse().slice(1, -1)];
            else { // random
                sequence = [...pitches];
                for (let i = sequence.length - 1; i > 0; i--) {
                    const j = Math.floor(Math.random() * (i + 1));
                    [sequence[i], sequence[j]] = [sequence[j], sequence[i]];
                }
            }
            const totalSteps = Math.floor(dur / rate);
            const stArp = useEngineStore.getState();
            const fpbArp = (60.0 / (stArp.projectBpm || stArp.transport.bpm || 120)) * (resolveSampleRate(stArp.projectSampleRate));
            const notes = [];
            for (let step = 0; step < totalSteps; step++) {
                const pitch = sequence[step % sequence.length];
                notes.push({ pitch, velocity: vel, startFrames: Math.round(step * rate * fpbArp), durationFrames: Math.round(rate * gate * fpbArp) });
            }
            await engineApi.updateMidiClip(clipId, notes);
            return JSON.stringify({ success: true, notesGenerated: notes.length, direction, rateBeats: rate });
        }

        case 'generate_scale': {
            const root = args.root as number;
            const scaleType = (args.scaleType as string).toLowerCase();
            const lo = (args.lowNote as number) || 24;
            const hi = (args.highNote as number) || 108;
            const SCALES: Record<string, number[]> = {
                major: [0, 2, 4, 5, 7, 9, 11], minor: [0, 2, 3, 5, 7, 8, 10],
                dorian: [0, 2, 3, 5, 7, 9, 10], phrygian: [0, 1, 3, 5, 7, 8, 10],
                lydian: [0, 2, 4, 6, 7, 9, 11], mixolydian: [0, 2, 4, 5, 7, 9, 10],
                aeolian: [0, 2, 3, 5, 7, 8, 10], locrian: [0, 1, 3, 5, 6, 8, 10],
                pentatonic_major: [0, 2, 4, 7, 9], pentatonic_minor: [0, 3, 5, 7, 10],
                blues: [0, 3, 5, 6, 7, 10], harmonic_minor: [0, 2, 3, 5, 7, 8, 11],
                melodic_minor: [0, 2, 3, 5, 7, 9, 11], whole_tone: [0, 2, 4, 6, 8, 10],
                chromatic: [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11],
            };
            // BUG-8 FIX: Return error instead of silently falling back to major
            const intervals = SCALES[scaleType];
            if (!intervals) return JSON.stringify({ error: `Unknown scale type: "${scaleType}". Valid types: ${Object.keys(SCALES).join(', ')}` });
            const pitches: number[] = [];
            for (let n = lo; n <= hi; n++) {
                if (intervals.includes((n - (root % 12) + 12) % 12)) pitches.push(n);
            }
            return JSON.stringify({ root, scaleType, pitches, count: pitches.length });
        }

        // ── Phase 2: Sample Rack Pad Controls ──
        case 'set_pad_volume': {
            const trackId = tracks[args.trackIndex as number]?.id;
            if (!trackId) return JSON.stringify({ error: 'Track not found' });
            await engineApi.setSampleRackPadVolumeCmd(trackId, args.padIndex as number, args.volume as number);
            return JSON.stringify({ success: true });
        }

        case 'set_pad_mute': {
            const trackId = tracks[args.trackIndex as number]?.id;
            if (!trackId) return JSON.stringify({ error: 'Track not found' });
            await engineApi.setSampleRackPadMuteCmd(trackId, args.padIndex as number, args.muted as boolean);
            return JSON.stringify({ success: true });
        }

        case 'set_pad_adsr': {
            const trackId = tracks[args.trackIndex as number]?.id;
            if (!trackId) return JSON.stringify({ error: 'Track not found' });
            await engineApi.setSampleRackPadAdsrCmd(
                trackId, args.padIndex as number,
                args.attack as number, args.decay as number,
                args.sustain as number, args.release as number
            );
            return JSON.stringify({ success: true });
        }

        case 'set_pad_filter_cutoff': {
            const trackId = tracks[args.trackIndex as number]?.id;
            if (!trackId) return JSON.stringify({ error: 'Track not found' });
            await engineApi.setSampleRackPadFilterCutoffCmd(trackId, args.padIndex as number, args.cutoff as number);
            return JSON.stringify({ success: true });
        }

        // ── Phase 2/3: Track Styling, Bypass, Preview ──
        case 'set_track_color': {
            const trackId = tracks[args.trackIndex as number]?.id;
            if (!trackId) return JSON.stringify({ error: 'Track not found' });
            await engineApi.setTrackColor(trackId, args.colorHex as string);
            return JSON.stringify({ success: true, color: args.colorHex });
        }

        case 'bypass_effect': {
            await engineApi.bypassDevice(args.trackIndex as number, args.slotIndex as number, args.bypassed as boolean);
            return JSON.stringify({ success: true });
        }

        case 'preview_note': {
            const pitch = args.pitch as number;
            const vel = (args.velocity as number) || 100;
            const tIdx = args.trackIndex as number;
            await engineApi.previewSamplerNoteOn(tIdx, pitch, vel);
            // BUG-6 FIX: Cancel previous preview timer to prevent leaked note-offs
            if ((globalThis as any).__dreamPreviewTimer) clearTimeout((globalThis as any).__dreamPreviewTimer);
            (globalThis as any).__dreamPreviewTimer = setTimeout(() => {
                engineApi.previewSamplerNoteOff(tIdx, pitch).catch(() => { });
                (globalThis as any).__dreamPreviewTimer = null;
            }, 500);
            return JSON.stringify({ success: true, pitch, velocity: vel });
        }

        // ── Phase 3: Intelligent Mixing ──
        case 'auto_gain_stage': {
            const target = (args.targetVolume as number) ?? 0.7;
            for (let i = 0; i < tracks.length; i++) {
                await engineApi.setTrackVolume(i, target);
            }
            return JSON.stringify({ success: true, tracksNormalized: tracks.length, targetVolume: target });
        }

        case 'auto_cleanup_mix': {
            const excludes = new Set((args.excludeTrackIndices as number[]) ?? []);
            let cleaned = 0;
            for (let i = 0; i < tracks.length; i++) {
                if (excludes.has(i)) continue;
                const t = tracks[i];
                const name = t.name.toLowerCase();
                // Auto high-pass tracks that don't need low-end
                if (name.includes('hat') || name.includes('hi-hat') || name.includes('hihat') ||
                    name.includes('vocal') || name.includes('vox') || name.includes('shaker') ||
                    name.includes('perc') || name.includes('clap') || name.includes('crash') ||
                    name.includes('ride') || name.includes('cymbal') || name.includes('fx') ||
                    name.includes('pad') || name.includes('syn') || name.includes('lead')) {
                    try {
                        // BUG-5 FIX: Use named constant instead of magic number
                        await engineApi.addDevice(i, 0, engineApi.BuiltinEffectType.AutoFilter);
                        cleaned++;
                    } catch { /* slot may be occupied */ }
                }
            }
            return JSON.stringify({ success: true, tracksCleaned: cleaned });
        }

        // ── Phase 4: Creative Arrangement ──
        case 'suggest_arrangement': {
            const genre = (args.genre as string).toLowerCase();
            const durBars = (args.durationBars as number) || 64;
            const beatsPerBar = 4;
            // Genre-aware arrangement templates
            const templates: Record<string, { name: string; startBar: number; endBar: number }[]> = {
                house: [
                    { name: 'Intro (Kick Only)', startBar: 0, endBar: 8 },
                    { name: 'Build-up (Add Hats + Clap)', startBar: 8, endBar: 16 },
                    { name: 'Breakdown (Remove Kick, Add Pads)', startBar: 16, endBar: 24 },
                    { name: 'Build-up (Riser + Filter Sweep)', startBar: 24, endBar: 28 },
                    { name: 'DROP (Full Energy)', startBar: 28, endBar: 44 },
                    { name: 'Breakdown 2 (Strip Back)', startBar: 44, endBar: 52 },
                    { name: 'DROP 2 (Full + Variation)', startBar: 52, endBar: 60 },
                    { name: 'Outro (Fade Elements)', startBar: 60, endBar: 64 },
                ],
                techno: [
                    { name: 'Intro (Ambient Textures)', startBar: 0, endBar: 8 },
                    { name: 'Build (Add Kick)', startBar: 8, endBar: 16 },
                    { name: 'Main Loop A', startBar: 16, endBar: 32 },
                    { name: 'Breakdown (Filter Down)', startBar: 32, endBar: 40 },
                    { name: 'Main Loop B (Variation)', startBar: 40, endBar: 56 },
                    { name: 'Outro (Dissolve)', startBar: 56, endBar: 64 },
                ],
                dnb: [
                    { name: 'Intro', startBar: 0, endBar: 8 },
                    { name: 'Build-up', startBar: 8, endBar: 16 },
                    { name: 'Drop 1', startBar: 16, endBar: 32 },
                    { name: 'Breakdown', startBar: 32, endBar: 40 },
                    { name: 'Drop 2', startBar: 40, endBar: 56 },
                    { name: 'Outro', startBar: 56, endBar: 64 },
                ],
                hiphop: [
                    { name: 'Intro', startBar: 0, endBar: 4 },
                    { name: 'Verse 1', startBar: 4, endBar: 20 },
                    { name: 'Hook/Chorus', startBar: 20, endBar: 28 },
                    { name: 'Verse 2', startBar: 28, endBar: 44 },
                    { name: 'Hook/Chorus', startBar: 44, endBar: 52 },
                    { name: 'Bridge', startBar: 52, endBar: 56 },
                    { name: 'Outro', startBar: 56, endBar: 64 },
                ],
                pop: [
                    { name: 'Intro', startBar: 0, endBar: 4 },
                    { name: 'Verse 1', startBar: 4, endBar: 12 },
                    { name: 'Pre-Chorus', startBar: 12, endBar: 16 },
                    { name: 'Chorus', startBar: 16, endBar: 24 },
                    { name: 'Verse 2', startBar: 24, endBar: 32 },
                    { name: 'Pre-Chorus 2', startBar: 32, endBar: 36 },
                    { name: 'Chorus 2', startBar: 36, endBar: 44 },
                    { name: 'Bridge', startBar: 44, endBar: 52 },
                    { name: 'Final Chorus', startBar: 52, endBar: 60 },
                    { name: 'Outro', startBar: 60, endBar: 64 },
                ],
            };
            const template = templates[genre] || templates.house;
            // Scale to target duration
            const scaleFactor = durBars / (template[template.length - 1]?.endBar || 64);
            const sections = template.map(s => ({
                ...s,
                startBar: Math.round(s.startBar * scaleFactor),
                endBar: Math.round(s.endBar * scaleFactor),
                startBeat: Math.round(s.startBar * scaleFactor * beatsPerBar),
                endBeat: Math.round(s.endBar * scaleFactor * beatsPerBar),
            }));
            return JSON.stringify({ genre, totalBars: durBars, sections });
        }

        case 'get_metering': {
            try {
                const meters = await engineApi.getMeters();
                const trackMeters = meters.tracks.map((t: [import('@/shared/api/engine').MeterReading, import('@/shared/api/engine').MeterReading], i: number) => ({
                    index: i,
                    name: tracks[i]?.name ?? `Track ${i}`,
                    leftRMS: t[0].rms.toFixed(3),
                    leftPeak: t[0].peak.toFixed(3),
                    rightRMS: t[1].rms.toFixed(3),
                    rightPeak: t[1].peak.toFixed(3),
                    clipping: t[0].clipping || t[1].clipping,
                }));
                return JSON.stringify({
                    master: {
                        leftRMS: meters.master_left.rms.toFixed(3),
                        leftPeak: meters.master_left.peak.toFixed(3),
                        rightRMS: meters.master_right.rms.toFixed(3),
                        rightPeak: meters.master_right.peak.toFixed(3),
                    },
                    tracks: trackMeters,
                });
            } catch {
                return JSON.stringify({ error: 'Metering not available' });
            }
        }

        // ── Beat Pattern Generator ──
        case 'generate_beat_pattern': {
            const genre = ((args.genre as string) || 'house').toLowerCase();
            const bars = Math.max(1, Math.min(64, (args.bars as number) || 4));
            const swing = Math.max(0, Math.min(0.5, (args.swing as number) || 0));

            // Define one-bar patterns per genre: {pitch, beatOffset, velocity}
            // Kick=36, Snare/Clap=37/38, ClosedHat=42, OpenHat=46, Ride=51
            type NoteHit = { pitch: number; beat: number; velocity: number; dur: number };
            const patterns: Record<string, NoteHit[]> = {
                house: [
                    // 4/4 kick
                    { pitch: 36, beat: 0, velocity: 120, dur: 0.25 },
                    { pitch: 36, beat: 1, velocity: 120, dur: 0.25 },
                    { pitch: 36, beat: 2, velocity: 120, dur: 0.25 },
                    { pitch: 36, beat: 3, velocity: 120, dur: 0.25 },
                    // Clap on 1, 3
                    { pitch: 37, beat: 1, velocity: 100, dur: 0.25 },
                    { pitch: 37, beat: 3, velocity: 100, dur: 0.25 },
                    // Closed hat offbeats
                    { pitch: 42, beat: 0.5, velocity: 80, dur: 0.125 },
                    { pitch: 42, beat: 1.5, velocity: 80, dur: 0.125 },
                    { pitch: 42, beat: 2.5, velocity: 80, dur: 0.125 },
                    { pitch: 42, beat: 3.5, velocity: 80, dur: 0.125 },
                ],
                techno: [
                    // Hard 4/4 kick
                    { pitch: 36, beat: 0, velocity: 127, dur: 0.25 },
                    { pitch: 36, beat: 1, velocity: 127, dur: 0.25 },
                    { pitch: 36, beat: 2, velocity: 127, dur: 0.25 },
                    { pitch: 36, beat: 3, velocity: 127, dur: 0.25 },
                    // Clap on 1, 3
                    { pitch: 37, beat: 1, velocity: 90, dur: 0.25 },
                    { pitch: 37, beat: 3, velocity: 90, dur: 0.25 },
                    // 16th hats
                    ...Array.from({ length: 16 }, (_, i) => ({
                        pitch: 42, beat: i * 0.25, velocity: i % 4 === 0 ? 100 : i % 2 === 0 ? 70 : 55, dur: 0.125,
                    })),
                ],
                dnb: [
                    // DnB kick (1, 2.75)
                    { pitch: 36, beat: 0, velocity: 120, dur: 0.25 },
                    { pitch: 36, beat: 2.75, velocity: 110, dur: 0.25 },
                    // Snare on 1, 3
                    { pitch: 38, beat: 1, velocity: 110, dur: 0.25 },
                    { pitch: 38, beat: 3, velocity: 110, dur: 0.25 },
                    // Fast hats (8th notes)
                    ...Array.from({ length: 8 }, (_, i) => ({
                        pitch: 42, beat: i * 0.5, velocity: i % 2 === 0 ? 90 : 65, dur: 0.125,
                    })),
                ],
                hiphop: [
                    // Boom bap kick
                    { pitch: 36, beat: 0, velocity: 110, dur: 0.5 },
                    { pitch: 36, beat: 2.5, velocity: 100, dur: 0.5 },
                    // Snare on 1, 3
                    { pitch: 38, beat: 1, velocity: 105, dur: 0.25 },
                    { pitch: 38, beat: 3, velocity: 105, dur: 0.25 },
                    // Hats with groove
                    { pitch: 42, beat: 0, velocity: 75, dur: 0.125 },
                    { pitch: 42, beat: 0.5, velocity: 60, dur: 0.125 },
                    { pitch: 42, beat: 1, velocity: 75, dur: 0.125 },
                    { pitch: 42, beat: 1.5, velocity: 60, dur: 0.125 },
                    { pitch: 42, beat: 2, velocity: 75, dur: 0.125 },
                    { pitch: 42, beat: 2.5, velocity: 60, dur: 0.125 },
                    { pitch: 42, beat: 3, velocity: 75, dur: 0.125 },
                    { pitch: 42, beat: 3.5, velocity: 60, dur: 0.125 },
                ],
                trap: [
                    // 808 kick
                    { pitch: 36, beat: 0, velocity: 127, dur: 0.5 },
                    { pitch: 36, beat: 1.75, velocity: 110, dur: 0.5 },
                    { pitch: 36, beat: 2.5, velocity: 115, dur: 0.5 },
                    // Snare on 1, 3
                    { pitch: 38, beat: 1, velocity: 120, dur: 0.25 },
                    { pitch: 38, beat: 3, velocity: 120, dur: 0.25 },
                    // Trap hi-hat rolls (32nd notes on offbeats)
                    { pitch: 42, beat: 0.5, velocity: 85, dur: 0.0625 },
                    { pitch: 42, beat: 0.5625, velocity: 70, dur: 0.0625 },
                    { pitch: 42, beat: 0.625, velocity: 60, dur: 0.0625 },
                    { pitch: 42, beat: 1.5, velocity: 85, dur: 0.0625 },
                    { pitch: 42, beat: 1.5625, velocity: 70, dur: 0.0625 },
                    { pitch: 42, beat: 1.625, velocity: 60, dur: 0.0625 },
                    { pitch: 42, beat: 2.5, velocity: 85, dur: 0.0625 },
                    { pitch: 42, beat: 2.5625, velocity: 70, dur: 0.0625 },
                    { pitch: 42, beat: 2.625, velocity: 60, dur: 0.0625 },
                    { pitch: 42, beat: 3.5, velocity: 85, dur: 0.0625 },
                    { pitch: 42, beat: 3.5625, velocity: 70, dur: 0.0625 },
                    { pitch: 42, beat: 3.625, velocity: 60, dur: 0.0625 },
                ],
                lofi: [
                    // Lazy boom bap
                    { pitch: 36, beat: 0, velocity: 95, dur: 0.5 },
                    { pitch: 36, beat: 2.33, velocity: 85, dur: 0.5 },
                    // Snare on 1, 3 (softer)
                    { pitch: 38, beat: 1, velocity: 80, dur: 0.25 },
                    { pitch: 38, beat: 3, velocity: 80, dur: 0.25 },
                    // Lazy hats
                    { pitch: 42, beat: 0.5, velocity: 55, dur: 0.125 },
                    { pitch: 42, beat: 1.5, velocity: 50, dur: 0.125 },
                    { pitch: 42, beat: 2.5, velocity: 55, dur: 0.125 },
                    { pitch: 42, beat: 3.5, velocity: 50, dur: 0.125 },
                ],
            };

            const oneBar = patterns[genre] || patterns['house'];

            // Expand to N bars + apply swing
            const notes: { pitch: number; startBeat: number; velocity: number; durationBeats: number }[] = [];
            for (let bar = 0; bar < bars; bar++) {
                for (const hit of oneBar) {
                    let beat = bar * 4 + hit.beat;
                    // Apply swing to offbeat notes
                    if (swing > 0 && hit.beat % 1 !== 0) {
                        const isOffbeat16th = (hit.beat * 4) % 2 !== 0;
                        if (isOffbeat16th) beat += swing;
                    }
                    notes.push({
                        pitch: hit.pitch,
                        startBeat: parseFloat(beat.toFixed(4)),
                        velocity: hit.velocity,
                        durationBeats: hit.dur,
                    });
                }
            }

            return JSON.stringify({
                genre,
                bars,
                swing,
                totalNotes: notes.length,
                notes,
                pitchMap: { kick: 36, snare: 38, clap: 37, closedHat: 42, openHat: 46 },
                usage: 'Use set_clip_notes with these notes after creating a MIDI clip on a drum rack track.',
            });
        }

        // ═══════════════════════════════════════════════════════════════════
        // Phase 5: Deep Music Production Tools (20 implementations)
        // ═══════════════════════════════════════════════════════════════════

        case 'get_midi_clip_notes': {
            const clipId = args.clipId as string;
            // BUG-2 FIX: Force fresh fetch to avoid stale store data
            try { await useEngineStore.getState().fetchProject('agent-tool:get_midi_clip_notes'); } catch { /* continue with stale */ }
            const freshState = useEngineStore.getState();
            const freshClips = freshState.timelineClips;
            const clip = freshClips.find(c => c.id === clipId);
            if (!clip) return JSON.stringify({ error: `Clip ${clipId} not found` });
            if (clip.type !== 'midi') return JSON.stringify({ error: `Clip ${clipId} is not a MIDI clip (type: ${clip.type})` });
            const notes = (clip as any).midiNotes ?? [];
            return JSON.stringify({
                clipId,
                clipName: clip.name,
                noteCount: notes.length,
                notes: notes.map((n: any) => ({
                    pitch: n.pitch,
                    noteName: ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'][n.pitch % 12] + (Math.floor(n.pitch / 12) - 1),
                    startBeat: n.startBeat,
                    durationBeats: n.durationBeats,
                    velocity: n.velocity,
                })),
            });
        }

        case 'resize_clip': {
            const st = useEngineStore.getState();
            const bpmVal = st.projectBpm || st.transport.bpm || 120;
            const srVal = resolveSampleRate(st.projectSampleRate);
            const fpb = (60.0 / bpmVal) * srVal;
            const newPosFrames = Math.round((args.newStartBeat as number) * fpb);
            const newDurFrames = Math.round((args.newDurationBeats as number) * fpb);
            await engineApi.resizeClip(args.clipId as string, newPosFrames, newDurFrames);
            return JSON.stringify({ success: true, clipId: args.clipId, newStartBeat: args.newStartBeat, newDurationBeats: args.newDurationBeats });
        }

        case 'set_clip_warp': {
            await engineApi.setClipWarp({
                clipId: args.clipId as string,
                isWarped: args.isWarped as boolean,
                warpBaseBpm: (args.warpBaseBpm as number) ?? null,
            });
            return JSON.stringify({ success: true, clipId: args.clipId, isWarped: args.isWarped, warpBaseBpm: args.warpBaseBpm ?? null });
        }

        case 'set_clip_source_offset': {
            const st = useEngineStore.getState();
            const bpmVal = st.projectBpm || st.transport.bpm || 120;
            const srVal = resolveSampleRate(st.projectSampleRate);
            const fpb = (60.0 / bpmVal) * srVal;
            const offsetFrames = Math.round((args.offsetBeats as number) * fpb);
            await engineApi.setClipSourceOffset(args.clipId as string, offsetFrames);
            return JSON.stringify({ success: true, clipId: args.clipId, offsetBeats: args.offsetBeats });
        }

        case 'preview_audio_file': {
            await engineApi.previewAudioFile(args.path as string);
            return JSON.stringify({ success: true, previewing: args.path });
        }

        case 'stop_preview': {
            await engineApi.stopPreview();
            return JSON.stringify({ success: true, stopped: true });
        }

        case 'get_audio_file_duration': {
            const duration = await engineApi.getAudioFileDuration(args.path as string);
            const st = useEngineStore.getState();
            const bpmVal = st.projectBpm || st.transport.bpm || 120;
            const beatsPerSecond = bpmVal / 60.0;
            return JSON.stringify({
                path: args.path,
                durationSeconds: duration,
                durationBeats: parseFloat((duration * beatsPerSecond).toFixed(2)),
                durationBars: parseFloat((duration * beatsPerSecond / 4).toFixed(2)),
            });
        }

        case 'set_arrangement_grid': {
            await engineApi.setArrangementGrid(
                args.numerator as number,
                args.denominator as number,
                1, // ntoles (default no tuplets)
                (args.snapToGrid as boolean) ?? true,
                false, // not fixed
            );
            return JSON.stringify({ success: true, grid: `${args.numerator}/${args.denominator}`, snapToGrid: args.snapToGrid ?? true });
        }

        case 'set_key_signature': {
            // Normalize tonic/mode to title-case for consistency with KEY_MODES/KEY_TONICS
            const rawTonic = (args.tonic as string).trim();
            const rawMode = (args.mode as string).trim();
            const tonic = rawTonic.charAt(0).toUpperCase() + rawTonic.slice(1).toLowerCase();
            const mode = rawMode.charAt(0).toUpperCase() + rawMode.slice(1).toLowerCase();
            await engineApi.setKeySignature(
                (args.enabled as boolean) ?? true,
                tonic,
                mode,
            );
            return JSON.stringify({ success: true, key: `${tonic} ${mode}` });
        }

        case 'duplicate_tracks': {
            const indices = args.trackIndices as number[];
            const trackIds = indices.map(i => tracks[i]?.id).filter(Boolean);
            if (trackIds.length === 0) return JSON.stringify({ error: 'No valid tracks to duplicate' });
            await engineApi.duplicateTracks(trackIds);
            return JSON.stringify({ success: true, duplicated: indices.length });
        }

        case 'move_track': {
            const trackId = tracks[args.trackIndex as number]?.id;
            if (!trackId) return JSON.stringify({ error: `Track ${args.trackIndex} not found` });
            await engineApi.moveTrackToIndex(trackId, args.targetIndex as number);
            return JSON.stringify({ success: true, from: args.trackIndex, to: args.targetIndex });
        }

        case 'set_track_routing': {
            const trackId = tracks[args.trackIndex as number]?.id;
            if (!trackId) return JSON.stringify({ error: `Track ${args.trackIndex} not found` });
            const target = args.target as string;
            let targetId = 'master';
            if (target !== 'master') {
                const tIdx = resolveTrackIndex(target);
                if (tIdx >= 0 && tracks[tIdx]) targetId = tracks[tIdx].id;
            }
            await engineApi.setTrackRouting(trackId, targetId);
            return JSON.stringify({ success: true, trackIndex: args.trackIndex, routedTo: target });
        }

        case 'arm_track': {
            await engineApi.armTrack(args.trackIndex as number, args.armed as boolean);
            return JSON.stringify({ success: true, trackIndex: args.trackIndex, armed: args.armed });
        }

        case 'set_pad_solo': {
            const trackId = tracks[args.trackIndex as number]?.id;
            if (!trackId) return JSON.stringify({ error: `Track ${args.trackIndex} not found` });
            await engineApi.setSampleRackPadSoloCmd(trackId, args.padIndex as number, args.soloed as boolean);
            return JSON.stringify({ success: true, padIndex: args.padIndex, soloed: args.soloed });
        }

        case 'set_clips_muted_batch': {
            const clipIds = args.clipIds as string[];
            const muted = args.muted as boolean;
            const result = await engineApi.setClipsMuted(clipIds, muted);
            return JSON.stringify({ success: true, muted, applied: result });
        }

        case 'bounce_track': {
            const trackId = tracks[args.trackIndex as number]?.id;
            if (!trackId) return JSON.stringify({ error: `Track ${args.trackIndex} not found` });
            await engineApi.bounceTrack(trackId);
            return JSON.stringify({ success: true, bounced: args.trackIndex });
        }

        case 'export_mix': {
            const settings: Record<string, unknown> = {
                outputPath: args.outputPath as string,
                format: (args.format as string) || 'wav',
                sampleRate: resolveSampleRate((args.sampleRate as number)),
                bitDepth: (args.bitDepth as number) || 24,
                range: (args.range as string) || 'full',
                normalize: (args.normalize as boolean) ?? false,
                tailMs: 500,
            };
            await engineApi.exportMix(settings as any);
            return JSON.stringify({ success: true, outputPath: settings.outputPath, format: settings.format });
        }

        case 'set_automation_points': {
            const trackId = tracks[args.trackIndex as number]?.id;
            if (!trackId) return JSON.stringify({ error: `Track ${args.trackIndex} not found` });
            const rawPoints = args.points as Array<{ beat: number; value: number; curveType?: string }>;
            const points = rawPoints.map(p => ({
                beat: p.beat,
                value: p.value,
                curveType: (p.curveType || 'linear') as 'linear' | 'bezier' | 'step',
            }));
            await engineApi.setAutomationPoints(trackId, args.paramId as string, points);
            return JSON.stringify({ success: true, trackIndex: args.trackIndex, paramId: args.paramId, pointsWritten: points.length });
        }

        case 'get_arrangement_overview': {
            const st = useEngineStore.getState();
            const bpmVal = st.projectBpm || st.transport.bpm || 120;
            const totalBeats = clips.reduce((max, c) => Math.max(max, c.startBeat + c.durationBeats), 0);
            const totalBars = Math.ceil(totalBeats / 4);
            const tracksOverview = tracks.map((t, i) => {
                const trackClips = clips.filter(c => c.trackIndex === i);
                return {
                    index: i,
                    name: t.name,
                    type: t.track_type,
                    color: t.color,
                    muted: t.is_mute,
                    soloed: t.is_solo,
                    volume: Math.round(t.volume * 100),
                    clipCount: trackClips.length,
                    fx: (t.effects ?? []).map(e => e.name),
                    instrument: t.instrument?.name ?? null,
                };
            });
            return JSON.stringify({
                bpm: bpmVal,
                totalBars,
                totalBeats: parseFloat(totalBeats.toFixed(1)),
                totalTracks: tracks.length,
                totalClips: clips.length,
                tracks: tracksOverview,
            });
        }

        default:
            return JSON.stringify({ error: `Unknown tool: ${name}` });
    }
}

// ─── System prompt builder ──────────────────────────────────────────────────

function buildSystemPrompt(): string {
    const s = useEngineStore.getState();
    const tracks = s.projectTracks;
    const clips = s.timelineClips;
    const bpm = s.projectBpm || s.transport.bpm || 120;
    const sr = resolveSampleRate(s.projectSampleRate);
    const transport = s.transport;

    // Build rich track list with full context
    const trackList = tracks
        .map((t, i) => {
            const trackClips = clips.filter(c => c.trackIndex === i);
            const fx = (t.effects ?? []).map(e => e.name).join(', ');
            const inst = t.instrument ? ` instrument="${t.instrument.name}"` : '';
            const routing = (t as any).output && (t as any).output !== 'master' ? ` → ${(t as any).output}` : (t as any).output_destination_id && (t as any).output_destination_id !== 'master' ? ` → ${(t as any).output_destination_id}` : '';
            const flags = [
                t.is_mute ? '🔇MUTED' : '',
                t.is_solo ? '🔆SOLO' : '',
                t.is_armed ? '🔴ARMED' : '',
            ].filter(Boolean).join(' ');

            return `  [${i}] "${t.name}" (${t.track_type})${inst} vol=${(t.volume * 100).toFixed(0)}% pan=${t.pan === 0 ? 'C' : t.pan > 0 ? `R${(t.pan * 100).toFixed(0)}` : `L${(-t.pan * 100).toFixed(0)}`}${flags ? ' ' + flags : ''} clips=${trackClips.length}${fx ? ` fx=[${fx}]` : ''}${routing}`;
        })
        .join('\n');

    const transportStatus = transport.is_playing ? '▶ Playing' : '⏹ Stopped';
    const totalClips = clips.length;

    return `You are **Dream AI** — the intelligent Producer-Composer built into Dream DAW. You are not just a chatbot; you are an autonomous musical co-author capable of building professional tracks from scratch.

## Your Identity & AI Producer Manifesto
1. **Absolute Order (Enterprise Hygiene)**: Consistently and logically name all tracks and clips (e.g. \`DRM_Kick_Main\`, \`SYN_Bass_Sub\`).
2. **Explainability**: NEVER act blindly. Explain *why* you chose a sample, *why* a note is placed on a specific beat, and how it fits the genre.
3. **Musical Theory & Rhythmology**: You understand beats, bars, syncopation. You know genre rules (e.g. House: 4/4 Kick on 0, 1, 2, 3; Clap on 1 and 3; Hat on offbeats 0.5, 1.5).
4. **Macro-Structure (Arrangement)**: You think in Intro -> Breakdown -> Build-up -> Drop/Chorus -> Outro.
5. **Step-by-Step Logic**: Seek sounds -> Draft Rhythm -> Draft Harmony -> Arrange -> Mix.

## Current Project State
- **Transport**: ${transportStatus} at beat ${transport.position_beats?.toFixed(1) ?? 0}
- **BPM**: ${bpm} | **Sample Rate**: ${sr} Hz
- **Tracks**: ${tracks.length} | **Total Clips**: ${totalClips}

### Track List
${trackList || '  (no tracks)'}



## Behavior Rules & Execution Patterns

### Chain-of-Thought
Before executing any action, briefly explain what you're about to do and why based on your music theory knowledge.
- "For a Tech House drop, we need a punchy 4/4 kick. I'll search for 'kick', load it into a drum rack on Track 0, and program notes on beats 0, 1, 2, and 3."

### Drum Programming (CRITICAL)
1. **Sample Racks (Drum Racks)**: Use a \\\`midi\\\` track for drums. Search for samples using \\\`search_browser\\\`. Load them into Drum Rack pads using \\\`add_sample_to_rack\\\`.
   - **Pad 0 (Pitch 36 / C1)**: Kick
   - **Pad 1 (Pitch 37 / C#1) or Pad 2**: Snare/Clap
   - **Pad 6 (Pitch 42 / F#1)**: Closed Hi-Hat
2. **Beat Patterns**: Use \\\`generate_beat_pattern\\\` for instant genre-correct rhythm patterns (house, techno, dnb, hiphop, trap, lofi). Feed the returned notes into \\\`set_clip_notes\\\`.
3. **MIDI Notes**: Use \\\`create_midi_clip\\\` followed by \\\`set_clip_notes\\\`. Note pitches must match the pads where you loaded the samples (e.g. Kick = 36, Clap = 37 or 38, Hat = 42).
4. **NEVER overlap clips** on the same track at the same time. The system will auto-delete overlapped clips, but you MUST still use the correct track index. **Check existing tracks and their clips before creating new ones.** Each musical element (kick, bass, melody, chords) should be on its OWN separate track.
5. **Pad Sound Design**: Sculpt each pad using \\\`set_pad_adsr\\\` (shape transients), \\\`set_pad_volume\\\` (level), and \\\`set_pad_filter_cutoff\\\` (brightness). Use \\\`preview_note\\\` to audition before programming.

### Instrument Assignment (CRITICAL)
1. **For melodic tracks** (bass, lead, pad, chord, melody, arp): ALWAYS use \\\`add_midi_track({ instrument: 'essence' })\\\` or call \\\`set_track_instrument({ trackIndex, instrument: 'essence' })\\\` to assign the Essence synth.
2. **Sound Design**: After assigning Essence, use \\\`set_synth_param\\\` to shape the sound. Key params: \\\`synth.osc1.wave\\\` (0-7), \\\`synth.filter.cutoff\\\` (0-1), \\\`synth.attack\\\`/\\\`synth.decay\\\`/\\\`synth.sustain\\\`/\\\`synth.release\\\`, \\\`synth.lfo.rate\\\`/\\\`synth.lfo.depth\\\`.
3. **For drum tracks**: Use \\\`add_midi_track\\\` WITHOUT instrument, then load samples into drum rack pads.
4. **NEVER write melodic notes to a drum rack track.** Always create a DEDICATED track with Essence synth for melodies.
5. **Track isolation**: Each musical role (kick, snare/clap, hats, bass, melody, chords, pads) should be on its OWN separate track with the right instrument.

### Music Theory Engine
1. **Chords**: Use \\\`generate_chord\\\` to compute exact MIDI pitches. Example: \\\`generate_chord(48, "min7")\\\` returns [48, 51, 55, 58].
2. **Scales**: Use \\\`generate_scale\\\` to constrain melodies/basslines to correct pitches. Always stay in key.
3. **Arpeggios**: Use \\\`generate_arpeggio\\\` for pulsing patterns — combine with generate_chord for instant harmonic movement.
4. **Quantize**: After recording or AI-generated patterns, use \\\`quantize_notes\\\` to tighten timing. Use \\\`humanize_velocity\\\` to add human feel (±10-20 range).

### Intelligent Mixing
1. First \\\`auto_gain_stage\\\` to normalize all tracks to -3dB (0.7).
2. Then \\\`auto_cleanup_mix\\\` to add high-pass filters to non-bass tracks.
3. Use \\\`get_metering\\\` to check levels and prevent clipping.
4. Color-code tracks (\\\`set_track_color\\\`) for visual organization.

### Response Quality
1. **Be concise but informative**. Every sentence should add value.
2. **Use pro audio terminology** — "gain staging", "signal flow", "groove", "syncopation".
3. **If a tool fails**, explain the error in plain language and suggest an alternative (e.g. if the sample isn't found, try a broader search).

### ⚡ CRITICAL: Batch Operations
**ALWAYS use batch tools instead of individual calls for repetitive operations:**
- To place a kick on every beat: use \\\`add_audio_clips_batch\\\` with a single array of all placements (NOT 16 individual \\\`add_audio_clip\\\` calls).
- To delete all clips on a track: use \\\`delete_all_clips_on_track\\\` (NOT individual \\\`delete_clip\\\` calls).
- To delete specific clips: use \\\`delete_clips_batch\\\` with an array of IDs (NOT individual \\\`delete_clip\\\` calls).
Batch tools are 10x faster and prevent crashes from too many rapid IPC calls.`;
}

// ─── Prepare messages for API ───────────────────────────────────────────────

/**
 * Converts internal ChatMessage[] to the OpenRouter/OpenAI API format.
 *
 * CRITICAL: Assistant messages that triggered tool calls MUST include
 * the `tool_calls` array. Without this, Claude/Anthropic returns a 400
 * because tool_result blocks can't find matching tool_use blocks.
 */
function toApiMessages(
    conversation: ChatMessage[],
    systemPrompt: string,
): Record<string, unknown>[] {
    const msgs: Record<string, unknown>[] = [
        { role: 'system', content: systemPrompt },
    ];

    for (const m of conversation) {
        if (m.role === 'tool') {
            msgs.push({
                role: 'tool',
                content: m.content,
                tool_call_id: m.tool_call_id,
            });
        } else if (m.role === 'assistant' && m.tool_calls && m.tool_calls.length > 0) {
            // Assistant message WITH tool calls — must include tool_calls for API
            msgs.push({
                role: 'assistant',
                content: m.content || null,
                tool_calls: m.tool_calls,
            });
        } else {
            msgs.push({ role: m.role, content: m.content });
        }
    }

    return msgs;
}

// ─── Stream event types ─────────────────────────────────────────────────────

/** Structured events emitted during agent streaming for real-time UI. */
export type StreamEvent =
    | { type: 'thinking'; text: string }
    | { type: 'tool-start'; toolName: string; args: Record<string, unknown>; index: number }
    | { type: 'tool-end'; toolName: string; result: string; index: number }
    | { type: 'delta'; text: string }
    | { type: 'done'; conversation: ChatMessage[] }
    | { type: 'error'; message: string };

// ─── Streaming chat (event-driven) ──────────────────────────────────────────

export async function streamChat(
    messages: ChatMessage[],
    apiKey: string,
    model: string,
    onEvent: (event: StreamEvent) => void,
    onSelectClips?: (ids: string[]) => void,
    signal?: AbortSignal,
): Promise<ChatMessage[]> {
    const MAX_TOOL_DEPTH = 25; // BUG-14 FIX: Raised from 15 for complex multi-track sessions
    let depth = 0;
    let conversation = [...messages];
    let globalToolIndex = 0;

    while (depth < MAX_TOOL_DEPTH) {
        depth++;

        const systemPrompt = buildSystemPrompt();
        const apiMessages = toApiMessages(conversation, systemPrompt);

        const response = await fetch('https://openrouter.ai/api/v1/chat/completions', {
            method: 'POST',
            headers: {
                Authorization: `Bearer ${apiKey}`,
                'Content-Type': 'application/json',
                'HTTP-Referer': 'https://dreamdaw.app',
                'X-Title': 'Dream DAW AI Assistant',
            },
            body: JSON.stringify({
                model,
                messages: apiMessages,
                tools: TOOLS,
                tool_choice: 'auto',
                stream: true,
                max_tokens: 4096,
            }),
            signal,
        });

        if (!response.ok) {
            const errText = await response.text().catch(() => 'Unknown error');
            let humanError = `API error (${response.status})`;
            try {
                const parsed = JSON.parse(errText);
                if (parsed.error?.message) {
                    humanError = parsed.error.message;
                } else if (parsed.error?.metadata?.raw) {
                    const raw = JSON.parse(parsed.error.metadata.raw);
                    humanError = raw.error?.message || humanError;
                }
            } catch { /* use default */ }
            onEvent({ type: 'error', message: humanError });
            throw new Error(humanError);
        }

        const reader = response.body?.getReader();
        if (!reader) throw new Error('No response stream');

        const decoder = new TextDecoder();
        let assistantContent = '';
        let toolCalls: ToolCall[] = [];
        let buffer = '';
        let hasEmittedContent = false;

        while (true) {
            const { done, value } = await reader.read();
            if (done) break;

            buffer += decoder.decode(value, { stream: true });
            const lines = buffer.split('\n');
            buffer = lines.pop() || '';

            for (const line of lines) {
                if (!line.startsWith('data: ')) continue;
                const data = line.slice(6).trim();
                if (data === '[DONE]') continue;

                try {
                    const parsed = JSON.parse(data);
                    const delta = parsed.choices?.[0]?.delta;
                    if (!delta) continue;

                    if (delta.content) {
                        assistantContent += delta.content;
                        // If we're in a tool loop (depth > 1), this is intermediate thinking.
                        // If depth === 1 and no tool calls yet, could be thinking OR final response.
                        // Emit as 'thinking' during tool loops, 'delta' for final response.
                        if (depth > 1 || toolCalls.length > 0) {
                            onEvent({ type: 'thinking', text: delta.content });
                        } else {
                            // Might become thinking if tool_calls appear later.
                            // Buffer and re-emit correctly at the end.
                            if (!hasEmittedContent) {
                                hasEmittedContent = true;
                            }
                            onEvent({ type: 'delta', text: delta.content });
                        }
                    }

                    if (delta.tool_calls) {
                        for (const tc of delta.tool_calls) {
                            const idx = tc.index ?? 0;
                            if (!toolCalls[idx]) {
                                toolCalls[idx] = {
                                    id: tc.id || `tc_${idx}`,
                                    type: 'function',
                                    function: { name: '', arguments: '' },
                                };
                            }
                            if (tc.function?.name) toolCalls[idx].function.name += tc.function.name;
                            if (tc.function?.arguments) toolCalls[idx].function.arguments += tc.function.arguments;
                            if (tc.id) toolCalls[idx].id = tc.id;
                        }
                    }
                } catch {
                    /* skip malformed SSE chunk */
                }
            }
        }

        // Filter out empty tool calls
        toolCalls = toolCalls.filter((tc) => tc.function.name);

        // No tool calls → conversation ends with final response
        if (toolCalls.length === 0) {
            conversation.push({ role: 'assistant', content: assistantContent });
            onEvent({ type: 'done', conversation });
            return conversation;
        }

        // If we emitted deltas for content that turned out to be thinking
        // (because tool_calls appeared), the UI already received 'delta' events.
        // Re-classify: emit a 'thinking' retroactive signal is not needed because
        // the UI will see the subsequent tool-start events and understand.

        // Push assistant message WITH tool_calls to conversation
        conversation.push({
            role: 'assistant',
            content: assistantContent,
            tool_calls: toolCalls,
        });

        // Execute each tool call — emit events for each step
        for (const tc of toolCalls) {
            let args: Record<string, unknown> = {};
            try { args = JSON.parse(tc.function.arguments); } catch { /* empty */ }

            // 🔴 LIVE: Emit tool-start so UI shows the action beginning
            onEvent({
                type: 'tool-start',
                toolName: tc.function.name,
                args,
                index: globalToolIndex,
            });

            const result = await executeTool(tc.function.name, args, onSelectClips);

            conversation.push({
                role: 'tool',
                content: result,
                name: tc.function.name,
                tool_call_id: tc.id,
            });

            // 🟢 LIVE: Emit tool-end so UI shows the result
            onEvent({
                type: 'tool-end',
                toolName: tc.function.name,
                result,
                index: globalToolIndex,
            });

            globalToolIndex++;

            // BUG-15 FIX: Check abort signal between tool calls
            if (signal?.aborted) {
                onEvent({ type: 'done', conversation });
                return conversation;
            }
        }

        // Reset for next loop iteration
        assistantContent = '';
        toolCalls = [];
    }

    onEvent({ type: 'done', conversation });
    return conversation;
}
