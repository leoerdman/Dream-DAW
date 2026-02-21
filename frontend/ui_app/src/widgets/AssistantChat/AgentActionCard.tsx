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
    Loader, Music, Search, Copy, Check, Palette,
    Repeat, FileAudio, Scissors, Merge, Gauge,
    Piano, Wand2,
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
    add_audio_clip: { icon: FileAudio, category: 'Clip', categoryColor: '#a855f7', describe: (a) => `Add audio "${(a.samplePath as string)?.split('/').pop() || ''}" at beat ${a.startBeat}` },
    move_clip: { icon: MousePointer, category: 'Clip', categoryColor: '#a855f7', describe: (a) => `Move clip to beat ${a.newStartBeat}` },
    resize_clip: { icon: SlidersHorizontal, category: 'Clip', categoryColor: '#a855f7', describe: (a) => `Resize clip to ${a.newDurationBeats} beats` },
    duplicate_clip: { icon: Plus, category: 'Clip', categoryColor: '#a855f7', describe: (a) => `Duplicate clip at beat ${a.newPositionBeats}` },
    split_clip: { icon: Scissors, category: 'Clip', categoryColor: '#a855f7', describe: (a) => `Split clip at beat ${a.splitBeat}` },
    merge_clips: { icon: Merge, category: 'Clip', categoryColor: '#a855f7', describe: () => 'Merge clips' },

    // Batch Operations
    add_audio_clips_batch: { icon: FileAudio, category: 'Batch', categoryColor: '#10b981', describe: (a) => `Add ${(a.clips as unknown[])?.length || 0} audio clips` },
    delete_clips_batch: { icon: Trash2, category: 'Batch', categoryColor: '#10b981', describe: (a) => `Delete ${(a.clipIds as unknown[])?.length || 0} clips` },
    delete_all_clips_on_track: { icon: Trash2, category: 'Batch', categoryColor: '#10b981', describe: (a) => `Clear all clips on track "${a.track}"` },

    // Browser / Samples
    search_browser: { icon: Search, category: 'Browser', categoryColor: '#14b8a6', describe: (a) => `Search: "${a.query}"` },
    add_sample_to_rack: { icon: Music, category: 'Sample', categoryColor: '#f43f5e', describe: (a) => `Load sample to pad ${a.padIndex}` },

    // Effects / Devices
    add_effect: { icon: Plus, category: 'FX', categoryColor: '#f97316', describe: (a) => `Add ${a.effectType} to track ${a.trackIndex}` },
    remove_effect: { icon: Trash2, category: 'FX', categoryColor: '#f97316', describe: (a) => `Remove effect slot ${a.slotIndex}` },
    bypass_effect: { icon: ToggleLeft, category: 'FX', categoryColor: '#f97316', describe: (a) => `${a.bypassed ? 'Bypass' : 'Enable'} effect slot ${a.slotIndex}` },
    set_device_param: { icon: SlidersHorizontal, category: 'FX', categoryColor: '#f97316', describe: (a) => `Set param ${a.paramIndex} = ${a.value}` },

    // Track colors
    set_track_color: { icon: Palette, category: 'Track', categoryColor: '#3b82f6', describe: (a) => `Color track ${a.trackIndex} → ${a.colorHex}` },

    // Loop
    set_loop_region: { icon: Repeat, category: 'Transport', categoryColor: '#22c55e', describe: (a) => `Loop ${a.startBeat}–${a.endBeat} beats ${a.enabled ? 'ON' : 'OFF'}` },

    // MIDI Composition
    add_midi_track: { icon: Plus, category: 'MIDI', categoryColor: '#f43f5e', describe: (a) => a.name ? `Create MIDI track "${a.name}"` : 'Create MIDI track' },
    create_midi_clip: { icon: PanelTop, category: 'MIDI', categoryColor: '#f43f5e', describe: (a) => `Create ${a.durationBeats}-beat MIDI clip` },
    set_clip_notes: { icon: Zap, category: 'MIDI', categoryColor: '#f43f5e', describe: (a) => `Write ${(a.notes as unknown[])?.length || 0} MIDI notes` },

    // Phase 2: Music Theory
    quantize_notes: { icon: Gauge, category: 'MIDI', categoryColor: '#f43f5e', describe: (a) => `Quantize to ${a.gridBeats}-beat grid` },
    humanize_velocity: { icon: Wand2, category: 'MIDI', categoryColor: '#f43f5e', describe: (a) => `Humanize velocity ±${a.range || 10}` },
    generate_chord: { icon: Music, category: 'Theory', categoryColor: '#8b5cf6', describe: (a) => `Generate ${a.root}${a.quality} chord` },
    generate_scale: { icon: Music, category: 'Theory', categoryColor: '#8b5cf6', describe: (a) => `Generate ${a.root} ${a.scaleName} scale` },
    generate_arpeggio: { icon: Music, category: 'Theory', categoryColor: '#8b5cf6', describe: (a) => `Arpeggio ${a.root}${a.quality} ${a.pattern}` },
    preview_note: { icon: Piano, category: 'Sample', categoryColor: '#f43f5e', describe: (a) => `Preview note ${a.pitch} on track ${a.trackIndex}` },

    // Phase 2: Sample Rack
    set_pad_volume: { icon: Volume2, category: 'Sample', categoryColor: '#f43f5e', describe: (a) => `Pad ${a.padIndex} volume → ${a.volume}` },
    set_pad_mute: { icon: ToggleLeft, category: 'Sample', categoryColor: '#f43f5e', describe: (a) => `${a.muted ? 'Mute' : 'Unmute'} pad ${a.padIndex}` },
    set_pad_adsr: { icon: SlidersHorizontal, category: 'Sample', categoryColor: '#f43f5e', describe: () => 'Set pad ADSR envelope' },
    set_pad_filter_cutoff: { icon: SlidersHorizontal, category: 'Sample', categoryColor: '#f43f5e', describe: (a) => `Pad ${a.padIndex} cutoff → ${a.cutoff}` },

    // Phase 3: Mixing
    auto_gain_stage: { icon: Gauge, category: 'Mix', categoryColor: '#f97316', describe: () => 'Auto gain staging' },
    auto_cleanup_mix: { icon: Wand2, category: 'Mix', categoryColor: '#f97316', describe: () => 'Auto cleanup mix' },
    get_metering: { icon: Eye, category: 'Mix', categoryColor: '#f97316', describe: () => 'Get metering data' },

    // Phase 4: Arrangement
    suggest_arrangement: { icon: Wand2, category: 'Arrange', categoryColor: '#ec4899', describe: (a) => `Suggest ${a.genre} arrangement` },
    generate_beat_pattern: { icon: Music, category: 'Pattern', categoryColor: '#ec4899', describe: (a) => `Generate ${a.genre} pattern (${a.bars || 4} bars)` },

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
            case 'add_midi_track': return '✅ Track created';
            case 'create_midi_clip': return '✅ Clip created';
            case 'set_clip_notes': return `✅ ${data.notesWritten || 0} notes written`;
            case 'add_audio_clip': return `✅ Clip "${data.clipName}" at beat ${data.startBeat}`;
            case 'duplicate_clip': return `✅ Duplicated → ${data.duplicatedClipId?.slice(0, 8)}`;
            case 'split_clip': return '✅ Clip split';
            case 'merge_clips': return '✅ Clips merged';
            case 'move_clip': return `✅ Moved to beat ${data.newStartBeat}`;
            case 'resize_clip': return `✅ Resized to ${data.newDuration} beats`;
            case 'search_browser': return `🔍 ${data.matchesFound} results` + (data.results?.[0]?.name ? ` • "${data.results[0].name}"` : '');
            case 'add_sample_to_rack': return '✅ Sample loaded';
            case 'add_effect': return `✅ ${data.effectType || 'Effect'} added`;
            case 'remove_effect': return '✅ Effect removed';
            case 'bypass_effect': return data.bypassed ? '⏸ Bypassed' : '▶ Enabled';
            case 'set_device_param': return '✅ Param set';
            case 'set_track_color': return `🎨 Color → ${data.color}`;
            case 'set_loop_region': return `🔁 Loop ${data.loopEnabled ? 'ON' : 'OFF'} (${data.startBeat}–${data.endBeat})`;
            case 'quantize_notes': return `✅ ${data.notesQuantized || 0} notes quantized`;
            case 'humanize_velocity': return `✅ ${data.notesHumanized || 0} notes humanized`;
            case 'generate_chord': return `🎵 Chord: ${(data.notes || []).join(', ')}`;
            case 'generate_scale': return `🎵 Scale: ${(data.notes || []).length} notes`;
            case 'generate_arpeggio': return `🎵 Arpeggio: ${(data.notes || []).length} notes`;
            case 'preview_note': return '🔊 Note previewed';
            case 'set_pad_volume': return '✅ Pad volume set';
            case 'set_pad_mute': return data.muted ? '🔇 Pad muted' : '🔊 Pad unmuted';
            case 'set_pad_adsr': return '✅ ADSR set';
            case 'set_pad_filter_cutoff': return '✅ Cutoff set';
            case 'auto_gain_stage': return '✅ Gain staged';
            case 'auto_cleanup_mix': return '✅ Mix cleaned up';
            case 'get_metering': return '📊 Metering data received';
            case 'suggest_arrangement': return `📋 ${(data.sections || []).length} sections suggested`;
            case 'add_audio_clips_batch': return `✅ ${data.clipsCreated} clips added`;
            case 'delete_clips_batch': return `✅ ${data.deleted}/${data.total} clips deleted`;
            case 'delete_all_clips_on_track': return `✅ ${data.deleted} clips cleared on track ${data.trackIndex}`;
            default: return data.success ? '✅ Done' : JSON.stringify(data).slice(0, 80);
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
    const [copied, setCopied] = useState(false);

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
                    <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
                        <span className="agent-thinking-label">💭 Reasoning</span>
                        <button
                            className="assistant-copy-btn"
                            title="Copy reasoning"
                            onClick={() => {
                                navigator.clipboard.writeText(thinking);
                                setCopied(true);
                                setTimeout(() => setCopied(false), 2000);
                            }}
                            style={{ padding: '2px 4px', marginLeft: 4 }}
                        >
                            {copied ? <Check size={10} style={{ color: 'var(--color-status-success)' }} /> : <Copy size={10} />}
                        </button>
                    </div>
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
    const [expanded, setExpanded] = useState(true);
    const [copiedAll, setCopiedAll] = useState(false);

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

    // Build full copyable text: thinking + actions + results
    const fullLogText = useMemo(() => {
        const parts: string[] = [];
        if (group.thinking) parts.push(`💭 Reasoning:\n${group.thinking}`);
        for (const a of group.actions) {
            const meta = TOOL_META[a.toolName] || DEFAULT_META;
            const desc = meta.describe(a.args);
            const result = a.result ? formatToolResult(a.toolName, a.result) : '(pending)';
            parts.push(`🔧 ${desc} → ${result}`);
        }
        if (group.finalResponse) parts.push(`\n📝 Summary: ${group.finalResponse}`);
        return parts.join('\n');
    }, [group]);

    // Auto-generate finalResponse if LLM didn't provide one
    const displayFinalResponse = group.finalResponse || (
        group.actions.length > 0
            ? `✅ Completed ${group.actions.length} action${group.actions.length !== 1 ? 's' : ''}: ${summary}.`
            : ''
    );

    return (
        <div className="assistant-msg assistant">
            <span className="msg-label">Dream AI</span>

            <div className="agent-action-card" style={{ '--action-accent': primaryColor } as React.CSSProperties}>
                <div
                    className="agent-action-header"
                    style={{ cursor: 'pointer' }}
                >
                    <div
                        className="agent-action-header-left"
                        onClick={() => setExpanded(!expanded)}
                        style={{ flex: 1, cursor: 'pointer' }}
                    >
                        <div className="agent-action-icon" style={{ background: primaryColor }}>
                            <Zap size={11} />
                        </div>
                        <span className="agent-action-summary">{summary}</span>
                        <span className="agent-action-count">
                            {group.actions.length} step{group.actions.length !== 1 ? 's' : ''}
                        </span>
                    </div>
                    <button
                        className="assistant-copy-btn"
                        title="Copy full log"
                        onClick={(e) => {
                            e.stopPropagation();
                            navigator.clipboard.writeText(fullLogText);
                            setCopiedAll(true);
                            setTimeout(() => setCopiedAll(false), 2000);
                        }}
                        style={{ padding: '2px 6px', marginRight: 4 }}
                    >
                        {copiedAll ? <Check size={11} style={{ color: 'var(--color-status-success)' }} /> : <Copy size={11} />}
                    </button>
                    <div
                        className={`agent-action-chevron ${expanded ? 'expanded' : ''}`}
                        onClick={() => setExpanded(!expanded)}
                        style={{ cursor: 'pointer' }}
                    >
                        {expanded ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
                    </div>
                </div>

                {expanded && (
                    <div className="agent-action-details">
                        <ActionLogContent
                            thinking={group.thinking}
                            actions={group.actions}
                        />
                    </div>
                )}
            </div>

            {displayFinalResponse && (
                <div className="msg-bubble assistant agent-final-response">
                    {displayFinalResponse}
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
