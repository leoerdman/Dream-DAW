import type { AssistantToolDefinition } from '@/shared/api/assistant/tools.types';

export const TOOL_DEFS_EXT_A: AssistantToolDefinition[] = [
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

];
