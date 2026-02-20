/* ═══════════════════════════════════════════════════════════════════════════
 * Dream DAW — Agent Action Card (Enterprise)
 *
 * Two rendering modes:
 *   1. LiveAgentCard  — real-time streaming: scrollable window (max ~10 lines)
 *                       auto-scrolls as reasoning + actions appear, freezes
 *                       when done, final response below.
 *   2. AgentActionCard — completed: collapsed summary, expandable action log.
 *
 * UX flow per agent turn:
 *   [user msg] → [scrollable live window] → [final response]
 *   After completion the live window becomes a collapsed AgentActionCard.
 * ═══════════════════════════════════════════════════════════════════════════ */

import { useState, useRef, useEffect, memo, useMemo } from 'react';
import {
    ChevronDown, ChevronRight,
    Play, Square, Volume2, PanelTop, Trash2, Plus,
    Zap, Eye, MousePointer, Undo2, Redo2,
    SlidersHorizontal, ToggleLeft, ToggleRight,
    Loader,
} from 'lucide-react';
import type { ChatMessage } from '@/shared/api/assistantService';
import type { LiveAgentState } from './AssistantChat';

// ── Tool metadata for rich display ──────────────────────────────────────────

interface ToolMeta {
    icon: typeof Play;
    category: string;
    categoryColor: string;
    describe: (args: Record<string, unknown>) => string;
}

const TOOL_META: Record<string, ToolMeta> = {
    // Transport
    transport_play: { icon: Play, category: 'Transport', categoryColor: '#22c55e', describe: () => 'Start playback' },
    transport_stop: { icon: Square, category: 'Transport', categoryColor: '#22c55e', describe: () => 'Stop playback' },
    set_bpm: { icon: Zap, category: 'Transport', categoryColor: '#22c55e', describe: (a) => `Set BPM to ${a.bpm}` },
    seek_to_beat: { icon: Play, category: 'Transport', categoryColor: '#22c55e', describe: (a) => `Seek to beat ${a.beat}` },

    // Track management
    set_track_volume: { icon: Volume2, category: 'Track', categoryColor: '#3b82f6', describe: (a) => `Set track ${a.trackIndex} volume to ${Math.round((a.volume as number) * 100)}%` },
    set_track_pan: { icon: SlidersHorizontal, category: 'Track', categoryColor: '#3b82f6', describe: (a) => `Set track ${a.trackIndex} pan to ${a.pan}` },
    set_track_mute: { icon: ToggleLeft, category: 'Track', categoryColor: '#3b82f6', describe: (a) => `${a.muted ? 'Mute' : 'Unmute'} track ${a.trackIndex}` },
    set_track_solo: { icon: ToggleRight, category: 'Track', categoryColor: '#eab308', describe: (a) => `${a.soloed ? 'Solo' : 'Unsolo'} track ${a.trackIndex}` },
    add_track: { icon: Plus, category: 'Track', categoryColor: '#3b82f6', describe: (a) => a.name ? `Add track "${a.name}"` : 'Add new track' },
    rename_track: { icon: PanelTop, category: 'Track', categoryColor: '#3b82f6', describe: (a) => `Rename track ${a.trackIndex} → "${a.name}"` },
    delete_track: { icon: Trash2, category: 'Track', categoryColor: '#ef4444', describe: (a) => `Delete track ${a.trackIndex}` },

    // Clips
    select_clips: { icon: MousePointer, category: 'Clip', categoryColor: '#a855f7', describe: (a) => `Select ${(a.clipIds as string[])?.length || 0} clips` },
    select_all_clips_on_track: { icon: MousePointer, category: 'Clip', categoryColor: '#a855f7', describe: (a) => `Select all clips on track "${a.track}"` },
    delete_clip: { icon: Trash2, category: 'Clip', categoryColor: '#ef4444', describe: (a) => `Delete clip ${(a.clipId as string)?.slice(0, 8)}…` },
    set_clip_muted: { icon: ToggleLeft, category: 'Clip', categoryColor: '#a855f7', describe: (a) => `${a.muted ? 'Mute' : 'Unmute'} clip` },

    // Inspect
    get_project_overview: { icon: Eye, category: 'Inspect', categoryColor: '#06b6d4', describe: () => 'Get project overview' },
    get_track_clips: { icon: Eye, category: 'Inspect', categoryColor: '#06b6d4', describe: (a) => `Get clips on track "${a.track}"` },
    get_clip_details: { icon: Eye, category: 'Inspect', categoryColor: '#06b6d4', describe: () => 'Get clip details' },
    get_transport_state: { icon: Eye, category: 'Inspect', categoryColor: '#06b6d4', describe: () => 'Get transport state' },

    // Mix
    set_master_volume: { icon: Volume2, category: 'Mix', categoryColor: '#f97316', describe: (a) => `Set master volume to ${Math.round((a.volume as number) * 100)}%` },

    // Undo/Redo
    undo: { icon: Undo2, category: 'Edit', categoryColor: '#8b5cf6', describe: () => 'Undo last action' },
    redo: { icon: Redo2, category: 'Edit', categoryColor: '#8b5cf6', describe: () => 'Redo last action' },
};

const DEFAULT_META: ToolMeta = {
    icon: Zap, category: 'Action', categoryColor: '#6b7280',
    describe: () => 'Execute action',
};

// ── Parse tool result for rich display ──────────────────────────────────────

function formatToolResult(name: string, resultJson: string): string {
    try {
        const data = JSON.parse(resultJson);
        if (data.error) return `❌ ${data.error}`;

        switch (name) {
            case 'get_project_overview':
                return `📁 ${data.projectName} • ${data.bpm} BPM • ${data.sampleRate}Hz • ${data.trackCount} tracks • ${data.totalClips ?? 0} clips`;
            case 'get_track_clips':
                return Array.isArray(data) ? `Found ${data.length} clip${data.length !== 1 ? 's' : ''}` : resultJson;
            case 'get_transport_state':
                return `${data.isPlaying ? '▶ Playing' : '⏹ Stopped'} • ${data.bpm} BPM • Loop ${data.loopEnabled ? 'ON' : 'OFF'}`;
            case 'transport_play': return '▶ Playing';
            case 'transport_stop': return '⏹ Stopped';
            case 'set_bpm': return `BPM → ${data.bpm}`;
            case 'set_track_mute': return data.muted ? '🔇 Muted' : '🔊 Unmuted';
            case 'set_track_solo': return data.soloed ? '🔆 Soloed' : '○ Unsoloed';
            case 'set_track_volume': return `Volume → ${Math.round(data.volume * 100)}%`;
            case 'set_track_pan': return `Pan → ${data.pan > 0 ? `R${Math.round(data.pan * 100)}` : data.pan < 0 ? `L${Math.round(-data.pan * 100)}` : 'C'}`;
            case 'add_track': return '✅ Track added';
            case 'rename_track': return `✅ Renamed → "${data.name}"`;
            case 'delete_track': return '✅ Track deleted';
            case 'delete_clip': return '✅ Clip deleted';
            case 'select_clips': return `✅ Selected ${data.selected} clip(s)`;
            case 'select_all_clips_on_track': return `✅ Selected ${data.selected} clip(s) on track ${data.trackIndex}`;
            case 'undo': return '↩ Undone';
            case 'redo': return '↪ Redone';
            case 'set_master_volume': return `Master → ${Math.round(data.masterVolume * 100)}%`;
            default: return '✅ Done';
        }
    } catch {
        return resultJson.slice(0, 100);
    }
}

// ── Types ───────────────────────────────────────────────────────────────────

export interface ActionGroup {
    thinking: string;
    actions: {
        toolName: string;
        args: Record<string, unknown>;
        result: string;
    }[];
    finalResponse: string;
}

/**
 * Groups raw conversation messages into ActionGroups for rich rendering.
 */
export function groupMessagesIntoActions(messages: ChatMessage[]): (ChatMessage | ActionGroup)[] {
    const result: (ChatMessage | ActionGroup)[] = [];
    let i = 0;

    while (i < messages.length) {
        const msg = messages[i];

        if (msg.role === 'user') {
            result.push(msg);
            i++;
            continue;
        }

        if (msg.role === 'assistant' && msg.tool_calls && msg.tool_calls.length > 0) {
            const group: ActionGroup = {
                thinking: msg.content || '',
                actions: [],
                finalResponse: '',
            };

            for (const tc of msg.tool_calls) {
                let args: Record<string, unknown> = {};
                try { args = JSON.parse(tc.function.arguments); } catch { /* empty */ }
                group.actions.push({ toolName: tc.function.name, args, result: '' });
            }

            let j = i + 1;
            while (j < messages.length && messages[j].role === 'tool') {
                const toolMsg = messages[j];
                const matchAction = group.actions.find(
                    (a) => !a.result && a.toolName === toolMsg.name,
                );
                if (matchAction) matchAction.result = toolMsg.content;
                j++;
            }

            while (j < messages.length) {
                const nextMsg = messages[j];
                if (nextMsg.role === 'assistant' && nextMsg.tool_calls && nextMsg.tool_calls.length > 0) {
                    if (nextMsg.content) group.thinking += '\n' + nextMsg.content;
                    for (const tc of nextMsg.tool_calls) {
                        let args: Record<string, unknown> = {};
                        try { args = JSON.parse(tc.function.arguments); } catch { /* empty */ }
                        group.actions.push({ toolName: tc.function.name, args, result: '' });
                    }
                    j++;
                    while (j < messages.length && messages[j].role === 'tool') {
                        const toolMsg = messages[j];
                        const matchAction = group.actions.find(
                            (a) => !a.result && a.toolName === toolMsg.name,
                        );
                        if (matchAction) matchAction.result = toolMsg.content;
                        j++;
                    }
                } else if (nextMsg.role === 'assistant' && !nextMsg.tool_calls) {
                    group.finalResponse = nextMsg.content;
                    j++;
                    break;
                } else {
                    break;
                }
            }

            result.push(group);
            i = j;
            continue;
        }

        if (msg.role === 'assistant') {
            result.push(msg);
            i++;
            continue;
        }

        i++;
    }

    return result;
}

export function isActionGroup(item: ChatMessage | ActionGroup): item is ActionGroup {
    return 'actions' in item && Array.isArray((item as ActionGroup).actions);
}

// ── Shared step renderer ────────────────────────────────────────────────────

function ActionStep({ toolName, args, result, isExecuting }: {
    toolName: string;
    args: Record<string, unknown>;
    result: string | null;
    isExecuting?: boolean;
}) {
    const meta = TOOL_META[toolName] || DEFAULT_META;
    const Icon = meta.icon;
    const resultText = result !== null ? formatToolResult(toolName, result) : null;

    return (
        <div className={`agent-step ${isExecuting ? 'executing' : ''}`}>
            <div className="agent-step-header">
                <div className="agent-step-icon" style={{ color: meta.categoryColor }}>
                    {isExecuting ? (
                        <Loader size={12} className="spin-icon" />
                    ) : (
                        <Icon size={12} />
                    )}
                </div>
                <span className="agent-step-name">{meta.describe(args)}</span>
                <span className="agent-step-badge" style={{ background: meta.categoryColor }}>
                    {meta.category}
                </span>
            </div>
            {resultText !== null && (
                <div className="agent-step-result">
                    {resultText}
                </div>
            )}
        </div>
    );
}

// ── Scrollable action log content (shared between live and completed) ───────

function ActionLogContent({ thinking, actions, isLive }: {
    thinking: string;
    actions: { toolName: string; args: Record<string, unknown>; result: string | null }[];
    isLive?: boolean;
}) {
    const scrollRef = useRef<HTMLDivElement>(null);

    // Auto-scroll to bottom when content changes (for live mode)
    useEffect(() => {
        if (isLive && scrollRef.current) {
            scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
        }
    }, [thinking, actions, isLive]);

    return (
        <div className="agent-log-scroll" ref={scrollRef}>
            {/* Thinking */}
            {thinking && (
                <div className="agent-thinking">
                    <span className="agent-thinking-label">💭 Reasoning</span>
                    <p>
                        {thinking}
                        {isLive && <span className="streaming-cursor" />}
                    </p>
                </div>
            )}

            {/* Action Steps */}
            {actions.length > 0 && (
                <div className="agent-steps">
                    {actions.map((action, idx) => (
                        <ActionStep
                            key={idx}
                            toolName={action.toolName}
                            args={action.args}
                            result={action.result}
                            isExecuting={isLive && action.result === null}
                        />
                    ))}
                </div>
            )}
        </div>
    );
}

// ═══════════════════════════════════════════════════════════════════════════
// COMPLETED ACTION CARD (collapsed summary → expandable scrollable log)
// ═══════════════════════════════════════════════════════════════════════════

interface AgentActionCardProps {
    group: ActionGroup;
}

export const AgentActionCard = memo(({ group }: AgentActionCardProps) => {
    const [expanded, setExpanded] = useState(false);

    const summary = useMemo(() => {
        if (group.actions.length === 0) return 'No actions';
        if (group.actions.length === 1) {
            const a = group.actions[0];
            const meta = TOOL_META[a.toolName] || DEFAULT_META;
            return meta.describe(a.args);
        }
        const categories = new Map<string, number>();
        for (const a of group.actions) {
            const meta = TOOL_META[a.toolName] || DEFAULT_META;
            categories.set(meta.category, (categories.get(meta.category) || 0) + 1);
        }
        return [...categories.entries()]
            .map(([cat, count]) => `${count} ${cat.toLowerCase()}${count > 1 ? ' actions' : ' action'}`)
            .join(', ');
    }, [group.actions]);

    const primaryColor = useMemo(() => {
        const first = group.actions[0];
        if (!first) return '#6b7280';
        return (TOOL_META[first.toolName] || DEFAULT_META).categoryColor;
    }, [group.actions]);

    return (
        <div className="assistant-msg assistant">
            <span className="msg-label">Dream AI</span>

            <div className="agent-action-card" style={{ '--action-accent': primaryColor } as React.CSSProperties}>
                <button
                    className="agent-action-header"
                    onClick={() => setExpanded(!expanded)}
                >
                    <div className="agent-action-header-left">
                        <div className="agent-action-icon" style={{ background: primaryColor }}>
                            <Zap size={11} />
                        </div>
                        <span className="agent-action-summary">{summary}</span>
                        <span className="agent-action-count">
                            {group.actions.length} step{group.actions.length !== 1 ? 's' : ''}
                        </span>
                    </div>
                    <div className={`agent-action-chevron ${expanded ? 'expanded' : ''}`}>
                        {expanded ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
                    </div>
                </button>

                {expanded && (
                    <div className="agent-action-details">
                        <ActionLogContent
                            thinking={group.thinking}
                            actions={group.actions}
                        />
                    </div>
                )}
            </div>

            {group.finalResponse && (
                <div className="msg-bubble assistant agent-final-response">
                    {group.finalResponse}
                </div>
            )}
        </div>
    );
});

AgentActionCard.displayName = 'AgentActionCard';

// ═══════════════════════════════════════════════════════════════════════════
// LIVE AGENT CARD — Scrollable real-time window
// Max ~10 lines height, auto-scrolls as content appears.
// When streaming ends, this card disappears and becomes an AgentActionCard.
// ═══════════════════════════════════════════════════════════════════════════

interface LiveAgentCardProps {
    live: LiveAgentState;
}

export const LiveAgentCard = memo(({ live }: LiveAgentCardProps) => {
    const hasActions = live.actions.length > 0;
    const hasThinking = live.thinking.length > 0;
    const hasFinal = live.finalText.length > 0;

    // Determine status text
    let statusText = 'Thinking…';
    if (hasActions && live.actions.some(a => a.result === null)) {
        statusText = 'Executing…';
    } else if (hasActions && live.actions.every(a => a.result !== null) && !hasFinal) {
        statusText = 'Preparing response…';
    } else if (hasFinal) {
        statusText = 'Responding…';
    } else if (hasThinking) {
        statusText = 'Reasoning…';
    }

    return (
        <div className="assistant-msg assistant">
            <span className="msg-label">Dream AI</span>

            <div className="agent-live-card">
                {/* ── Live header with pulsing dot ── */}
                <div className="agent-live-header">
                    <div className="agent-live-dot" />
                    <span className="agent-live-status">{statusText}</span>
                </div>

                {/* ── Scrollable action log (max ~10 lines, auto-scroll) ── */}
                {(hasThinking || hasActions) && (
                    <ActionLogContent
                        thinking={live.thinking}
                        actions={live.actions}
                        isLive
                    />
                )}

                {/* ── Final response (appears below the log when ready) ── */}
                {hasFinal && (
                    <div className="agent-live-response">
                        {live.finalText}
                        <span className="streaming-cursor" />
                    </div>
                )}
            </div>
        </div>
    );
});

LiveAgentCard.displayName = 'LiveAgentCard';
