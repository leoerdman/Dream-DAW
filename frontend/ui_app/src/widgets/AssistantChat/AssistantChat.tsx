// ═══════════════════════════════════════════════════════════════════════════
// Dream DAW — AI Assistant Chat Widget
// ═══════════════════════════════════════════════════════════════════════════

import { useState, useRef, useCallback, useEffect } from 'react';
import { Bot, Send, X, Trash2, Sparkles } from 'lucide-react';
import { useSettingsStore } from '@/shared/stores/useSettingsStore';
import {
    sendChatMessage,
    executeTool,
    generateMessageId,
    MODEL_LABELS,
    type ChatMessage,
    type AssistantModel,
    type ToolCall,
} from '@/shared/api/assistantService';
import './AssistantChat.css';

interface AssistantChatProps {
    open: boolean;
    onClose: () => void;
    onSelectClips: (ids: string[]) => void;
}

const AVAILABLE_MODELS: AssistantModel[] = [
    'google/gemini-3.1-pro-preview',
    'anthropic/claude-sonnet-4.6',
];

export const AssistantChat = ({ open, onClose, onSelectClips }: AssistantChatProps) => {
    const [messages, setMessages] = useState<ChatMessage[]>([]);
    const [input, setInput] = useState('');
    const [isLoading, setIsLoading] = useState(false);
    const [model, setModel] = useState<AssistantModel>('google/gemini-3.1-pro-preview');
    const messagesEndRef = useRef<HTMLDivElement>(null);
    const inputRef = useRef<HTMLTextAreaElement>(null);
    const apiKey = useSettingsStore((s) => s.settings.openRouterApiKey);

    // Auto-scroll to bottom
    useEffect(() => {
        messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
    }, [messages]);

    // Auto-focus input when opening
    useEffect(() => {
        if (open) {
            setTimeout(() => inputRef.current?.focus(), 100);
        }
    }, [open]);

    // Close on Escape
    useEffect(() => {
        if (!open) return;
        const onKey = (e: KeyboardEvent) => {
            if (e.key === 'Escape') onClose();
        };
        document.addEventListener('keydown', onKey);
        return () => document.removeEventListener('keydown', onKey);
    }, [open, onClose]);

    const clearChat = useCallback(() => {
        setMessages([]);
    }, []);

    const handleSend = useCallback(async () => {
        const text = input.trim();
        if (!text || isLoading) return;
        if (!apiKey) {
            setMessages((prev) => [
                ...prev,
                {
                    id: generateMessageId(),
                    role: 'assistant',
                    content: '⚠️ No OpenRouter API key configured. Go to **Settings → AI** and add your key.',
                    timestamp: Date.now(),
                },
            ]);
            return;
        }

        const userMsg: ChatMessage = {
            id: generateMessageId(),
            role: 'user',
            content: text,
            timestamp: Date.now(),
        };
        setMessages((prev) => [...prev, userMsg]);
        setInput('');
        setIsLoading(true);

        // Build message history for API
        const allMessages = [...messages, userMsg];

        const runConversation = async (
            currentMessages: ChatMessage[],
            depth = 0,
        ): Promise<void> => {
            if (depth > 8) {
                setMessages((prev) => [
                    ...prev,
                    {
                        id: generateMessageId(),
                        role: 'assistant',
                        content: 'Reached maximum reasoning depth. Please try a simpler request.',
                        timestamp: Date.now(),
                    },
                ]);
                return;
            }

            // Create streaming assistant message
            const assistantId = generateMessageId();
            let accumulatedContent = '';

            setMessages((prev) => [
                ...prev,
                {
                    id: assistantId,
                    role: 'assistant',
                    content: '',
                    timestamp: Date.now(),
                    isStreaming: true,
                },
            ]);

            // Convert to API format
            const apiMessages = currentMessages
                .filter((m) => m.role !== 'system')
                .map((m) => {
                    if (m.role === 'tool') {
                        return {
                            role: 'tool' as const,
                            content: m.content,
                            tool_call_id: m.toolCallId || '',
                            name: m.toolName || '',
                        };
                    }
                    return { role: m.role, content: m.content };
                });

            const collectedToolCalls: ToolCall[] = [];

            await sendChatMessage(apiKey, model, apiMessages, {
                onToken: (token) => {
                    accumulatedContent += token;
                    setMessages((prev) =>
                        prev.map((m) =>
                            m.id === assistantId
                                ? { ...m, content: accumulatedContent }
                                : m,
                        ),
                    );
                },

                onToolCall: (tc) => {
                    collectedToolCalls.push(tc);
                },

                onDone: () => {
                    // Finalize streaming
                    setMessages((prev) =>
                        prev.map((m) =>
                            m.id === assistantId
                                ? { ...m, content: accumulatedContent, isStreaming: false }
                                : m,
                        ),
                    );
                },

                onError: (error) => {
                    setMessages((prev) =>
                        prev.map((m) =>
                            m.id === assistantId
                                ? {
                                    ...m,
                                    content: `❌ Error: ${error}`,
                                    isStreaming: false,
                                }
                                : m,
                        ),
                    );
                    setIsLoading(false);
                },
            });

            // Handle tool calls
            if (collectedToolCalls.length > 0) {
                const toolResults: ChatMessage[] = [];

                for (const tc of collectedToolCalls) {
                    const result = executeTool(
                        tc.function.name,
                        tc.function.arguments,
                        onSelectClips,
                    );

                    const toolMsg: ChatMessage = {
                        id: generateMessageId(),
                        role: 'tool',
                        content: result,
                        toolCallId: tc.id,
                        toolName: tc.function.name,
                        timestamp: Date.now(),
                    };
                    toolResults.push(toolMsg);
                }

                // Add tool results to messages
                setMessages((prev) => [...prev, ...toolResults]);

                // Build new message list including tool results for next API call
                const updatedMessages: ChatMessage[] = [
                    ...currentMessages,
                    {
                        id: assistantId,
                        role: 'assistant',
                        content: accumulatedContent,
                        timestamp: Date.now(),
                    },
                    ...toolResults,
                ];

                // Continue the conversation with tool results
                await runConversation(updatedMessages, depth + 1);
            } else {
                setIsLoading(false);
            }
        };

        try {
            await runConversation(allMessages);
        } catch (err) {
            console.error('[AssistantChat] Conversation failed:', err);
            setIsLoading(false);
        }
    }, [input, isLoading, apiKey, messages, model, onSelectClips]);

    const handleKeyDown = (e: React.KeyboardEvent) => {
        if (e.key === 'Enter' && !e.shiftKey) {
            e.preventDefault();
            void handleSend();
        }
    };

    if (!open) return null;

    return (
        <div className="assistant-chat-overlay">
            {/* Header */}
            <div className="assistant-header">
                <div className="assistant-header-left">
                    <div className="assistant-header-icon">
                        <Bot size={16} />
                    </div>
                    <span className="assistant-header-title">Dream Assistant</span>
                </div>
                <div className="assistant-header-actions">
                    <div className="model-selector">
                        {AVAILABLE_MODELS.map((m) => (
                            <button
                                key={m}
                                className={`model-selector-btn${model === m ? ' active' : ''}`}
                                onClick={() => setModel(m)}
                                title={m}
                            >
                                {MODEL_LABELS[m]}
                            </button>
                        ))}
                    </div>
                    <button className="assistant-mini-btn" onClick={clearChat} title="Clear chat">
                        <Trash2 size={14} />
                    </button>
                    <button className="assistant-mini-btn" onClick={onClose} title="Close (Esc)">
                        <X size={14} />
                    </button>
                </div>
            </div>

            {/* Messages */}
            <div className="assistant-messages">
                {messages.length === 0 ? (
                    <div className="assistant-empty">
                        <div className="assistant-empty-icon">
                            <Sparkles size={24} />
                        </div>
                        <h3>Dream Assistant</h3>
                        <p>
                            Ask me anything about your project. I can inspect tracks, clips,
                            select elements, and give production advice.
                        </p>
                    </div>
                ) : (
                    messages.map((msg) => (
                        <div key={msg.id} className={`assistant-msg ${msg.role}`}>
                            {msg.role === 'tool' && (
                                <span className="msg-label">
                                    🔧 {msg.toolName}
                                </span>
                            )}
                            <div className={`msg-bubble ${msg.role}`}>
                                {msg.content || (msg.isStreaming ? '' : '...')}
                                {msg.isStreaming && <span className="streaming-cursor" />}
                            </div>
                        </div>
                    ))
                )}
                <div ref={messagesEndRef} />
            </div>

            {/* Input */}
            <div className="assistant-input-area">
                <textarea
                    ref={inputRef}
                    className="assistant-input"
                    placeholder="Ask about your project..."
                    value={input}
                    onChange={(e) => setInput(e.target.value)}
                    onKeyDown={handleKeyDown}
                    rows={1}
                    disabled={isLoading}
                />
                <button
                    className="assistant-send-btn"
                    onClick={() => void handleSend()}
                    disabled={!input.trim() || isLoading}
                    title="Send (Enter)"
                >
                    <Send size={16} />
                </button>
            </div>

            {/* Status */}
            <div className="assistant-status">
                <span>
                    <span className={`dot ${apiKey ? 'connected' : 'disconnected'}`} />
                    {apiKey ? MODEL_LABELS[model] : 'No API key'}
                </span>
                <span>{messages.filter((m) => m.role === 'user').length} messages</span>
            </div>
        </div>
    );
};
