import { memo, useMemo, useState } from 'react';
import { Check, ChevronDown, ChevronRight, Copy, Zap } from 'lucide-react';
import type { LiveAgentState } from './AssistantChat';
import type { ActionGroup } from './AgentActionGrouping';
import { DEFAULT_META, TOOL_META } from './agentActionMeta';
import { formatToolResult } from './agentResultFormatter';
import { AgentActionLogContent } from './AgentActionLogContent';

interface AgentActionCardProps {
    group: ActionGroup;
}

export const AgentActionCard = memo(({ group }: AgentActionCardProps) => {
    const [expanded, setExpanded] = useState(true);
    const [copiedAll, setCopiedAll] = useState(false);

    const summary = useMemo(() => {
        if (group.actions.length === 0) return 'No actions';
        if (group.actions.length === 1) {
            const action = group.actions[0];
            return (TOOL_META[action.toolName] || DEFAULT_META).describe(action.args);
        }

        const categories = new Map<string, number>();
        for (const action of group.actions) {
            const category = (TOOL_META[action.toolName] || DEFAULT_META).category;
            categories.set(category, (categories.get(category) || 0) + 1);
        }

        return [...categories.entries()]
            .map(([category, count]) => `${count} ${category.toLowerCase()}${count > 1 ? ' actions' : ' action'}`)
            .join(', ');
    }, [group.actions]);

    const primaryColor = useMemo(() => {
        const first = group.actions[0];
        return first ? (TOOL_META[first.toolName] || DEFAULT_META).categoryColor : 'var(--token-color-hex-6b7280)';
    }, [group.actions]);

    const fullLogText = useMemo(() => {
        const parts: string[] = [];
        if (group.thinking) parts.push(`💭 Reasoning:\n${group.thinking}`);
        for (const action of group.actions) {
            const meta = TOOL_META[action.toolName] || DEFAULT_META;
            const description = meta.describe(action.args);
            const result = action.result ? formatToolResult(action.toolName, action.result) : '(pending)';
            parts.push(`🔧 ${description} → ${result}`);
        }
        if (group.finalResponse) parts.push(`\n📝 Summary: ${group.finalResponse}`);
        return parts.join('\n');
    }, [group]);

    const displayFinalResponse = group.finalResponse || (
        group.actions.length > 0
            ? `✅ Completed ${group.actions.length} action${group.actions.length !== 1 ? 's' : ''}: ${summary}.`
            : ''
    );

    return (
        <div className="assistant-msg assistant">
            <span className="msg-label">Dream AI</span>

            <div className="agent-action-card" style={{ '--action-accent': primaryColor } as React.CSSProperties}>
                <div className="agent-action-header" style={{ cursor: 'pointer' }}>
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
                        onClick={(event) => {
                            event.stopPropagation();
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
                        <AgentActionLogContent thinking={group.thinking} actions={group.actions} />
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

interface LiveAgentCardProps {
    live: LiveAgentState;
}

export const LiveAgentCard = memo(({ live }: LiveAgentCardProps) => {
    const hasActions = live.actions.length > 0;
    const hasThinking = live.thinking.length > 0;
    const hasFinal = live.finalText.length > 0;

    let statusText = 'Thinking...';
    if (hasActions && live.actions.some((action) => action.result === null)) {
        statusText = 'Executing...';
    } else if (hasActions && live.actions.every((action) => action.result !== null) && !hasFinal) {
        statusText = 'Preparing response...';
    } else if (hasFinal) {
        statusText = 'Responding...';
    } else if (hasThinking) {
        statusText = 'Reasoning...';
    }

    return (
        <div className="assistant-msg assistant">
            <span className="msg-label">Dream AI</span>
            <div className="agent-live-card">
                <div className="agent-live-header">
                    <div className="agent-live-dot" />
                    <span className="agent-live-status">{statusText}</span>
                </div>
                {(hasThinking || hasActions) && (
                    <AgentActionLogContent
                        thinking={live.thinking}
                        actions={live.actions}
                        isLive
                    />
                )}
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
