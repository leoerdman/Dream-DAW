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

// ─── Types ──────────────────────────────────────────────────────────────────

export interface ChatMessage {
    role: 'user' | 'assistant' | 'tool';
    content: string;
    name?: string;           // tool name (for role=tool)
    tool_call_id?: string;   // matches the tool_call id
    thinking?: string;       // CoT trace
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
            description: 'Delete a track by 0-based index.',
            parameters: {
                type: 'object',
                properties: { trackIndex: { type: 'number' } },
                required: ['trackIndex'],
            },
        },
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
            description: 'Add a new MIDI track to the project. Returns the new track index. Optionally provide a name.',
            parameters: {
                type: 'object',
                properties: {
                    name: { type: 'string', description: 'Track name (optional)' },
                },
                required: [],
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
]);

async function executeTool(
    name: string,
    args: Record<string, unknown>,
    onSelectClips?: (ids: string[]) => void,
): Promise<string> {
    // Show visual feedback for every action
    useAgentActionStore.getState().showAction(getToolLabel(name));

    const result = await executeToolInner(name, args, onSelectClips);

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
                sampleRate: state.projectSampleRate || 44100,
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

        case 'set_track_volume':
            await engineApi.setTrackVolume(args.trackIndex as number, args.volume as number);
            return JSON.stringify({ trackIndex: args.trackIndex, volume: args.volume });

        case 'set_track_pan':
            await engineApi.setTrackPan(args.trackIndex as number, args.pan as number);
            return JSON.stringify({ trackIndex: args.trackIndex, pan: args.pan });

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

        case 'delete_clip':
            await engineApi.deleteClip(args.clipId as string);
            return JSON.stringify({ deleted: args.clipId });

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
            return JSON.stringify({ added: true, trackIndex: newIdx, name: trackName || `Track ${newIdx + 1}` });
        }

        case 'create_midi_clip': {
            const tIdx = args.trackIndex as number;
            const startBeat = args.startBeat as number;
            const durBeats = args.durationBeats as number;
            const clipName = (args.name as string) || undefined;
            // Convert beats to frames: frames = beats * 60 / BPM * sampleRate
            const st = useEngineStore.getState();
            const bpmVal = st.projectBpm || st.transport.bpm || 120;
            const srVal = st.projectSampleRate || 44100;
            const framesPerBeat = (60.0 / bpmVal) * srVal;
            const posFrames = Math.round(startBeat * framesPerBeat);
            const durFrames = Math.round(durBeats * framesPerBeat);
            const result = await engineApi.createMidiClip(tIdx, posFrames, durFrames, clipName);
            return JSON.stringify({ clipId: result.clip_id, clipName: result.clip_name, startBeat, durationBeats: durBeats });
        }

        case 'set_clip_notes': {
            const clipId = args.clipId as string;
            const noteArgs = args.notes as Array<{ pitch: number; velocity: number; startBeat: number; durationBeats: number }>;
            const st2 = useEngineStore.getState();
            const bpm2 = st2.projectBpm || st2.transport.bpm || 120;
            const sr2 = st2.projectSampleRate || 44100;
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
    const sr = s.projectSampleRate || 44100;
    const transport = s.transport;

    // Build rich track list with full context
    const trackList = tracks
        .map((t, i) => {
            const trackClips = clips.filter(c => c.trackIndex === i);
            const fx = (t.effects ?? []).map(e => e.name).join(', ');
            const inst = t.instrument ? ` instrument="${t.instrument.name}"` : '';
            const routing = t.output && t.output !== 'master' ? ` → ${t.output}` : '';
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

    return `You are **Dream AI** — the intelligent co-producer built into Dream DAW, a professional digital audio workstation.

## Identity
You are a world-class music producer and mixing engineer with deep DAW expertise. You think like a pro — understanding signal flow, gain staging, track organization, and production workflow. You are the DAW's built-in intelligence, not an external chatbot.

## Language
ALWAYS respond in the user's language. If they write in Russian, respond in Russian. If in English, respond in English. Match their language exactly.

## Current Project State
- **Transport**: ${transportStatus} at beat ${transport.position_beats?.toFixed(1) ?? 0}
- **BPM**: ${bpm} | **Sample Rate**: ${sr} Hz
- **Tracks**: ${tracks.length} | **Total Clips**: ${totalClips}

### Track List
${trackList || '  (no tracks)'}

## Your Tools (${TOOLS.length} available)
| Category | Tools |
|----------|-------|
| 🔍 Inspect | get_project_overview, get_track_clips, get_clip_details, get_transport_state |
| 🎵 Transport | transport_play, transport_stop, set_bpm, seek_to_beat |
| 🎛️ Track | add_track, delete_track, rename_track, set_track_volume, set_track_pan, set_track_mute, set_track_solo |
| ✂️ Clips | select_clips, select_all_clips_on_track, delete_clip, set_clip_muted |
| 🔊 Mix | set_master_volume |
| ↩️ Edit | undo, redo |

## Behavior Rules

### Chain-of-Thought
Before executing any action, briefly explain what you're about to do and why. This thinking appears in the UI so the user can follow your reasoning. Example:
- "I'll mute the Shaker track (index 5) since you want to hear the mix without it."
- "Let me check the project overview first to understand the full track layout."

### Execution Patterns
1. **Always use tools** — never simulate or guess the outcome of an action.
2. **Resolve tracks by name** → use the Track List above to find the correct index. Track names are case-insensitive. If ambiguous, ask.
3. **Multi-step tasks** → plan first, then execute tools sequentially. Explain each step.
4. **Verify before destructive actions** — before delete_track or delete_clip, confirm with the user or use get_track_clips to check what will be lost.
5. **Batch operations** → when muting/soloing multiple tracks, execute them all in one response.

### Response Quality
1. **Be concise but informative** — no filler text. Every sentence should add value.
2. **Use pro audio terminology** — "gain staging", "signal flow", "bus routing", not generic language.
3. **After actions, confirm what changed** — "Muted tracks Snare and Hihat (indices 0, 2)."
4. **If a tool fails**, explain the error in plain language and suggest an alternative.
5. **For creative requests you can't do** (generating audio, recording, editing waveforms), explain what IS possible and suggest a workflow.

### Context Awareness
- You can see ALL tracks, their routing, effects chains, and instruments in the Track List above.
- Use this context to give intelligent suggestions — e.g., "Track 3 'Bass' has no effects, want me to check its volume?"
- If the user asks about the mix, inspect relevant tracks before answering.`;
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
    const MAX_TOOL_DEPTH = 8;
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
        }

        // Reset for next loop iteration
        assistantContent = '';
        toolCalls = [];
    }

    onEvent({ type: 'done', conversation });
    return conversation;
}
