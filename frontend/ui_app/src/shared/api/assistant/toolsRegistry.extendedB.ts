import type { AssistantToolDefinition } from '@/shared/api/assistant/tools.types';

export const TOOL_DEFS_EXT_B: AssistantToolDefinition[] = [
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
                    sampleRate: { type: 'number', description: 'Target sample rate in Hz (e.g. 44100, 48000, 88200, 96000, 192000)' },
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
