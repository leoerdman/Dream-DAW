import type { AssistantToolDefinition } from '@/shared/api/assistant/tools.types';

export const TOOL_DEFS_ADV_B: AssistantToolDefinition[] = [
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
            description: 'Set the color of a track. Use hex color (e.g. "var(--token-color-hex-ff5733)").',
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

];
