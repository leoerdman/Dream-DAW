import { Bot, Check, Copy } from 'lucide-react';
import { AgentActionCard, LiveAgentCard } from './AgentActionCard';
import { isActionGroup, type ActionGroup } from './AgentActionGrouping';
import type { ChatMessage } from '@/shared/api/assistantService';
import { useState } from 'react';

interface LiveAction {
    toolName: string;
    args: Record<string, unknown>;
    result: string | null;
    index: number;
}

interface LiveAgentState {
    thinking: string;
    actions: LiveAction[];
    finalText: string;
}

const CopyButton = ({ text }: { text: string }) => {
    const [copied, setCopied] = useState(false);
    return (
        <button
            className="assistant-copy-btn"
            title="Copy message"
            onClick={() => {
                navigator.clipboard.writeText(text);
                setCopied(true);
                setTimeout(() => setCopied(false), 2000);
            }}
        >
            {copied ? <Check size={12} className="success" /> : <Copy size={12} />}
        </button>
    );
};

interface AssistantChatMessagesProps {
    groupedItems: (ChatMessage | ActionGroup)[];
    isStreaming: boolean;
    liveAgent: LiveAgentState | null;
    messagesEndRef: React.RefObject<HTMLDivElement | null>;
}

export function AssistantChatMessages({
    groupedItems,
    isStreaming,
    liveAgent,
    messagesEndRef,
}: AssistantChatMessagesProps) {
    return (
        <div className="assistant-messages">
            {groupedItems.length === 0 && !isStreaming && (
                <div className="assistant-empty">
                    <div className="assistant-empty-icon">
                        <Bot size={24} />
                    </div>
                    <h3>Dream AI</h3>
                    <p>
                        I can control your DAW — manage tracks, playback, clips, mix levels, and more. Ask me anything about your project.
                    </p>
                </div>
            )}

            {groupedItems.map((item, i) => {
                if (isActionGroup(item)) return <AgentActionCard key={`action-${i}`} group={item} />;
                const msg = item as ChatMessage;
                return (
                    <div key={i} className={`assistant-msg ${msg.role}`}>
                        {msg.role === 'user' && <span className="msg-label">You</span>}
                        {msg.role === 'assistant' && (
                            <div className="msg-header">
                                <span className="msg-label">Dream AI</span>
                                <CopyButton text={msg.content} />
                            </div>
                        )}
                        <div className={`msg-bubble ${msg.role}`}>
                            {msg.role === 'assistant' && msg.thinking && (
                                <details className="assistant-thinking-log">
                                    <summary>💭 Анализ и размышления...</summary>
                                    <div className="assistant-thinking-content">{msg.thinking}</div>
                                </details>
                            )}
                            {msg.role === 'assistant' && msg.actions && msg.actions.length > 0 && (
                                <details className="assistant-actions-log" open>
                                    <summary>🔧 Выполнено действий: {msg.actions.length}</summary>
                                    <div className="assistant-actions-list">
                                        {msg.actions.map((action, idx) => (
                                            <div key={idx} className={`action-item ${action.result !== null ? 'completed' : 'pending'}`}>
                                                <span className="action-name">{action.toolName}</span>
                                                <span className="action-args">{Object.keys(action.args).join(', ')}</span>
                                                {action.result !== null && <span className="action-result">✅</span>}
                                            </div>
                                        ))}
                                    </div>
                                </details>
                            )}
                            {msg.content}
                        </div>
                    </div>
                );
            })}

            {isStreaming && liveAgent && <LiveAgentCard live={liveAgent} />}
            <div ref={messagesEndRef} />
        </div>
    );
}
