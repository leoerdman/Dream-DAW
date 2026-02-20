// ═══════════════════════════════════════════════════════════════════════════
// Dream DAW — AI Assistant Service
// ═══════════════════════════════════════════════════════════════════════════
//
// Connects to OpenRouter API with tool calling for DAW project control.
// Enterprise-grade: streaming, retry, CoT reasoning, context injection.
//
// ═══════════════════════════════════════════════════════════════════════════

import { useEngineStore } from '@/shared/stores/useEngineStore';

// ── Types ─────────────────────────────────────────────────────────────────

export interface ChatMessage {
    id: string;
    role: 'user' | 'assistant' | 'system' | 'tool';
    content: string;
    toolCallId?: string;
    toolName?: string;
    timestamp: number;
    isStreaming?: boolean;
    thinking?: string;
}

export interface ToolCall {
    id: string;
    type: 'function';
    function: {
        name: string;
        arguments: string;
    };
}

export type AssistantModel =
    | 'google/gemini-3.1-pro-preview'
    | 'anthropic/claude-sonnet-4.6';

export const MODEL_LABELS: Record<AssistantModel, string> = {
    'google/gemini-3.1-pro-preview': 'Gemini 3.1 Pro',
    'anthropic/claude-sonnet-4.6': 'Claude Sonnet 4.6',
};

// ── Tool Definitions ──────────────────────────────────────────────────────

const TOOLS = [
    {
        type: 'function' as const,
        function: {
            name: 'get_project_overview',
            description:
                'Get a complete overview of the current DAW project: track names, types, clip counts, BPM, sample rate, time signature, transport state.',
            parameters: { type: 'object', properties: {}, required: [] },
        },
    },
    {
        type: 'function' as const,
        function: {
            name: 'get_track_clips',
            description:
                'Get all clips on a specific track. Identify the track by name (case-insensitive partial match) or by 0-based index.',
            parameters: {
                type: 'object',
                properties: {
                    track_name: {
                        type: 'string',
                        description: 'Track name (partial, case-insensitive). Use this OR track_index.',
                    },
                    track_index: {
                        type: 'number',
                        description: '0-based track index. Use this OR track_name.',
                    },
                },
                required: [],
            },
        },
    },
    {
        type: 'function' as const,
        function: {
            name: 'get_clip_details',
            description: 'Get detailed information about a specific clip by its ID.',
            parameters: {
                type: 'object',
                properties: {
                    clip_id: { type: 'string', description: 'UUID of the clip.' },
                },
                required: ['clip_id'],
            },
        },
    },
    {
        type: 'function' as const,
        function: {
            name: 'select_clips',
            description:
                'Select one or more clips in the timeline by their IDs. This highlights them in the UI.',
            parameters: {
                type: 'object',
                properties: {
                    clip_ids: {
                        type: 'array',
                        items: { type: 'string' },
                        description: 'Array of clip UUIDs to select.',
                    },
                },
                required: ['clip_ids'],
            },
        },
    },
    {
        type: 'function' as const,
        function: {
            name: 'select_all_clips_on_track',
            description:
                'Select all clips on a specific track by name (case-insensitive partial match) or index.',
            parameters: {
                type: 'object',
                properties: {
                    track_name: { type: 'string', description: 'Track name (partial match).' },
                    track_index: { type: 'number', description: '0-based track index.' },
                },
                required: [],
            },
        },
    },
    {
        type: 'function' as const,
        function: {
            name: 'get_transport_state',
            description:
                'Get current transport state: playing/stopped, position in beats/bars, loop enabled, loop region, BPM.',
            parameters: { type: 'object', properties: {}, required: [] },
        },
    },
];

// ── Tool Executor ─────────────────────────────────────────────────────────

type ClipSelector = (ids: string[]) => void;

function findTrackIndex(nameOrIndex: { track_name?: string; track_index?: number }): number {
    const store = useEngineStore.getState();
    const tracks = store.projectTracks;
    if (typeof nameOrIndex.track_index === 'number') {
        return nameOrIndex.track_index;
    }
    if (nameOrIndex.track_name) {
        const needle = nameOrIndex.track_name.toLowerCase();
        const idx = tracks.findIndex((t) => t.name.toLowerCase().includes(needle));
        return idx;
    }
    return -1;
}

export function executeTool(
    toolName: string,
    argsJson: string,
    clipSelector: ClipSelector,
): string {
    const store = useEngineStore.getState();
    const tracks = store.projectTracks;
    const clips = store.timelineClips;
    const transport = store.transport;

    try {
        const args = JSON.parse(argsJson || '{}');

        switch (toolName) {
            case 'get_project_overview': {
                const overview = {
                    project_name: 'Current Project',
                    bpm: store.projectBpm || transport.bpm || 120,
                    sample_rate: store.projectSampleRate || 44100,
                    track_count: tracks.length,
                    total_clips: clips.length,
                    is_playing: transport.is_playing,
                    tracks: tracks.map((t, i) => ({
                        index: i,
                        name: t.name,
                        type: t.track_type,
                        clip_count: clips.filter((c) => c.trackIndex === i).length,
                        is_muted: t.is_mute,
                        is_solo: t.is_solo,
                        is_armed: t.is_armed,
                        volume: t.volume,
                        pan: t.pan,
                    })),
                };
                return JSON.stringify(overview, null, 2);
            }

            case 'get_track_clips': {
                const idx = findTrackIndex(args);
                if (idx < 0 || idx >= tracks.length) {
                    return JSON.stringify({ error: `Track not found: ${JSON.stringify(args)}` });
                }
                const trackClips = clips
                    .filter((c) => c.trackIndex === idx)
                    .map((c) => ({
                        id: c.id,
                        name: c.name,
                        type: c.type,
                        start_beat: Math.round(c.startBeat * 100) / 100,
                        duration_beats: Math.round(c.durationBeats * 100) / 100,
                        is_warped: c.isWarped,
                        is_muted: c.muted,
                        color: c.color,
                    }));
                return JSON.stringify(
                    { track_name: tracks[idx].name, track_index: idx, clips: trackClips },
                    null,
                    2,
                );
            }

            case 'get_clip_details': {
                const clip = clips.find((c) => c.id === args.clip_id);
                if (!clip) return JSON.stringify({ error: `Clip not found: ${args.clip_id}` });
                return JSON.stringify(clip, null, 2);
            }

            case 'select_clips': {
                if (Array.isArray(args.clip_ids) && args.clip_ids.length > 0) {
                    clipSelector(args.clip_ids);
                    return JSON.stringify({
                        success: true,
                        selected_count: args.clip_ids.length,
                        message: `Selected ${args.clip_ids.length} clip(s).`,
                    });
                }
                return JSON.stringify({ error: 'No clip_ids provided.' });
            }

            case 'select_all_clips_on_track': {
                const idx = findTrackIndex(args);
                if (idx < 0 || idx >= tracks.length) {
                    return JSON.stringify({ error: `Track not found: ${JSON.stringify(args)}` });
                }
                const ids = clips.filter((c) => c.trackIndex === idx).map((c) => c.id);
                if (ids.length === 0) {
                    return JSON.stringify({
                        success: true,
                        message: `Track "${tracks[idx].name}" has no clips.`,
                    });
                }
                clipSelector(ids);
                return JSON.stringify({
                    success: true,
                    selected_count: ids.length,
                    track_name: tracks[idx].name,
                    message: `Selected all ${ids.length} clips on track "${tracks[idx].name}".`,
                });
            }

            case 'get_transport_state': {
                return JSON.stringify(
                    {
                        is_playing: transport.is_playing,
                        position_beats: transport.position_beats,
                        bpm: store.projectBpm || transport.bpm || 120,
                        loop_enabled: transport.loop_enabled,
                        loop_start: transport.loop_start,
                        loop_end: transport.loop_end,
                        sample_rate: transport.sample_rate,
                    },
                    null,
                    2,
                );
            }

            default:
                return JSON.stringify({ error: `Unknown tool: ${toolName}` });
        }
    } catch (err) {
        return JSON.stringify({ error: `Tool execution failed: ${err}` });
    }
}

// ── System Prompt ─────────────────────────────────────────────────────────

function buildSystemPrompt(): string {
    const store = useEngineStore.getState();
    const tracks = store.projectTracks;
    const bpm = store.projectBpm || store.transport.bpm || 120;

    const trackList = tracks
        .map(
            (t, i) =>
                `  ${i}: "${t.name}" (${t.track_type})${t.is_mute ? ' [MUTED]' : ''}${t.is_solo ? ' [SOLO]' : ''}`,
        )
        .join('\n');

    return `You are Dream DAW Assistant — an intelligent AI music production helper embedded directly inside a professional DAW (Digital Audio Workstation).

## Your Capabilities
- You can inspect the current project: tracks, clips, transport state, BPM, and more.
- You can select clips in the timeline to help the user find and work with specific audio/MIDI material.
- You provide expert advice on music production, mixing, arrangement, and sound design.
- You think step by step when performing multi-step actions.

## Current Project Context
- BPM: ${bpm}
- Sample Rate: ${store.projectSampleRate || 44100} Hz
- Tracks (${tracks.length}):
${trackList || '  (no tracks)'}

## Guidelines
1. Always use tools to inspect data before answering questions about the project.
2. When asked to select clips, use select_clips or select_all_clips_on_track.
3. Be concise but helpful. Use music production terminology naturally.
4. Format responses with markdown for readability.
5. When performing actions, explain what you're doing.
6. If the user references a track by name, use case-insensitive partial matching.`;
}

// ── API Call ───────────────────────────────────────────────────────────────

interface StreamCallbacks {
    onToken: (token: string) => void;
    onToolCall: (toolCall: ToolCall) => void;
    onDone: (fullContent: string, toolCalls: ToolCall[]) => void;
    onError: (error: string) => void;
}

export async function sendChatMessage(
    apiKey: string,
    model: AssistantModel,
    messages: { role: string; content: string; tool_call_id?: string; name?: string }[],
    callbacks: StreamCallbacks,
): Promise<void> {
    const systemPrompt = buildSystemPrompt();

    const apiMessages = [{ role: 'system', content: systemPrompt }, ...messages];

    try {
        const response = await fetch('https://openrouter.ai/api/v1/chat/completions', {
            method: 'POST',
            headers: {
                Authorization: `Bearer ${apiKey}`,
                'Content-Type': 'application/json',
                'HTTP-Referer': 'https://dreamdaw.app',
                'X-Title': 'Dream DAW Assistant',
            },
            body: JSON.stringify({
                model,
                messages: apiMessages,
                tools: TOOLS,
                tool_choice: 'auto',
                stream: true,
                temperature: 0.3,
                max_tokens: 4096,
            }),
        });

        if (!response.ok) {
            const errorText = await response.text();
            callbacks.onError(`API error ${response.status}: ${errorText}`);
            return;
        }

        const reader = response.body?.getReader();
        if (!reader) {
            callbacks.onError('No response body');
            return;
        }

        const decoder = new TextDecoder();
        let buffer = '';
        let fullContent = '';
        const toolCalls: ToolCall[] = [];
        const toolCallArgs: Record<number, string> = {};

        while (true) {
            const { done, value } = await reader.read();
            if (done) break;

            buffer += decoder.decode(value, { stream: true });
            const lines = buffer.split('\n');
            buffer = lines.pop() || '';

            for (const line of lines) {
                const trimmed = line.trim();
                if (!trimmed.startsWith('data: ')) continue;
                const data = trimmed.slice(6);
                if (data === '[DONE]') break;

                try {
                    const parsed = JSON.parse(data);
                    const delta = parsed.choices?.[0]?.delta;
                    if (!delta) continue;

                    // Content streaming
                    if (delta.content) {
                        fullContent += delta.content;
                        callbacks.onToken(delta.content);
                    }

                    // Tool call streaming
                    if (delta.tool_calls) {
                        for (const tc of delta.tool_calls) {
                            const idx = tc.index ?? 0;
                            if (tc.id) {
                                // New tool call
                                toolCalls[idx] = {
                                    id: tc.id,
                                    type: 'function',
                                    function: {
                                        name: tc.function?.name || '',
                                        arguments: '',
                                    },
                                };
                                toolCallArgs[idx] = '';
                            }
                            if (tc.function?.name && toolCalls[idx]) {
                                toolCalls[idx].function.name = tc.function.name;
                            }
                            if (tc.function?.arguments) {
                                toolCallArgs[idx] = (toolCallArgs[idx] || '') + tc.function.arguments;
                                if (toolCalls[idx]) {
                                    toolCalls[idx].function.arguments = toolCallArgs[idx];
                                }
                            }
                        }
                    }
                } catch {
                    // Skip malformed JSON chunks
                }
            }
        }

        // Emit completed tool calls
        for (const tc of toolCalls) {
            if (tc) callbacks.onToolCall(tc);
        }

        callbacks.onDone(fullContent, toolCalls.filter(Boolean));
    } catch (err) {
        callbacks.onError(err instanceof Error ? err.message : String(err));
    }
}

// ── Message ID Generator ──────────────────────────────────────────────────

let _msgCounter = 0;
export function generateMessageId(): string {
    return `msg_${Date.now()}_${++_msgCounter}`;
}
