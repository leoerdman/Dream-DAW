import type { AssistantToolDefinition } from '@/shared/api/assistant/tools.types';

export const TOOL_DEFS_CORE_A: AssistantToolDefinition[] = [
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
            name: 'set_track_disabled',
            description: 'Enable or disable a track. Index is 0-based.',
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
];
