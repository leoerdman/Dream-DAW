import { useState, useRef, useEffect, useCallback } from 'react';
import { Send, Square, Mic, MicOff } from 'lucide-react';
import { useSettingsStore } from '@/shared/stores/useSettingsStore';
import { streamChat, type ChatMessage } from '@/shared/api/assistantService';
import { loadChatHistory, saveChatHistory, clearChatHistory } from '@/shared/api/chatHistoryService';
import { groupMessagesIntoActions } from './AgentActionGrouping';
import { useEngineStore } from '@/shared/stores/useEngineStore';
import { useAgentBridge, sendBridgeResponse } from '@/shared/hooks/useAgentBridge';
import { useAssistantVoiceInput, type SpeechRecognitionInstance } from './useAssistantVoiceInput';
import { AssistantChatHeader } from './AssistantChatHeader';
import { AssistantChatMessages } from './AssistantChatMessages';
import './AgentActionCard.css';
import './AssistantChat.css';

const MODELS = [
    { id: 'google/gemini-3-flash-preview', label: 'Gemini 3 Flash' },
    { id: 'minimax/minimax-m2.5', label: 'MiniMax M2.5' },
    { id: 'anthropic/claude-sonnet-4', label: 'Claude Sonnet 4' },
];

export interface LiveAction {
    toolName: string;
    args: Record<string, unknown>;
    result: string | null;
    index: number;
}

export interface LiveAgentState {
    thinking: string;
    actions: LiveAction[];
    finalText: string;
}

interface AssistantChatProps {
    open: boolean;
    onClose: () => void;
    onOpen: () => void;
    onSelectClips?: (ids: string[]) => void;
}

let isSendingLocked = false;

export const AssistantChat = ({ open, onClose, onOpen, onSelectClips }: AssistantChatProps) => {
    const [messages, setMessages] = useState<ChatMessage[]>([]);
    const [input, setInput] = useState('');
    const [isStreaming, setIsStreaming] = useState(false);
    const [model, setModel] = useState(MODELS[0].id);
    const [isListening, setIsListening] = useState(false);
    const [liveAgent, setLiveAgent] = useState<LiveAgentState | null>(null);
    const [dragPos, setDragPos] = useState<{ x: number; y: number } | null>(null);

    const messagesEndRef = useRef<HTMLDivElement>(null);
    const inputRef = useRef<HTMLTextAreaElement>(null);
    const abortRef = useRef<AbortController | null>(null);
    const recognitionRef = useRef<SpeechRecognitionInstance | null>(null);
    const mediaRecorderRef = useRef<MediaRecorder | null>(null);
    const intentionalStopRef = useRef(false);
    const dragRef = useRef<{ startX: number; startY: number; origX: number; origY: number } | null>(null);
    const lastSavedRef = useRef('');

    const apiKey = useSettingsStore((s) => s.settings.openRouterApiKey);
    const projectId = useEngineStore((s) => s.projectTracks.length.toString() + s.projectBpm.toString());
    const [historyLoadedForId, setHistoryLoadedForId] = useState<string | null>(null);

    const handleHeaderMouseDown = useCallback((e: React.MouseEvent) => {
        if ((e.target as HTMLElement).closest('button, select, input')) return;
        e.preventDefault();
        const overlay = (e.currentTarget as HTMLElement).closest('.assistant-chat-overlay') as HTMLElement;
        if (!overlay) return;
        const rect = overlay.getBoundingClientRect();
        const origX = dragPos?.x ?? rect.left;
        const origY = dragPos?.y ?? rect.top;
        dragRef.current = { startX: e.clientX, startY: e.clientY, origX, origY };

        const onMove = (me: MouseEvent) => {
            if (!dragRef.current) return;
            const dx = me.clientX - dragRef.current.startX;
            const dy = me.clientY - dragRef.current.startY;
            const newX = Math.max(0, Math.min(window.innerWidth - 200, dragRef.current.origX + dx));
            const newY = Math.max(0, Math.min(window.innerHeight - 80, dragRef.current.origY + dy));
            setDragPos({ x: newX, y: newY });
        };
        const onUp = () => {
            dragRef.current = null;
            window.removeEventListener('mousemove', onMove);
            window.removeEventListener('mouseup', onUp);
        };
        window.addEventListener('mousemove', onMove);
        window.addEventListener('mouseup', onUp);
    }, [dragPos]);

    useEffect(() => {
        messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
    }, [messages, liveAgent]);

    useEffect(() => {
        if (!open) return;
        let cancelled = false;

        if (historyLoadedForId !== null && historyLoadedForId !== projectId && !isStreaming) {
            abortRef.current?.abort();
            abortRef.current = null;
            setIsStreaming(false);
            setLiveAgent(null);
        }

        void loadChatHistory().then((history) => {
            if (cancelled) return;
            if (history.length > 0) setMessages(history);
            else if (historyLoadedForId !== projectId) setMessages([]);
            setHistoryLoadedForId(projectId);
        });

        return () => {
            cancelled = true;
        };
    }, [open, projectId, historyLoadedForId, isStreaming]);

    useEffect(() => {
        if (messages.length === 0) return;
        const serialized = JSON.stringify(messages);
        if (serialized === lastSavedRef.current) return;
        lastSavedRef.current = serialized;
        void saveChatHistory(messages);
    }, [messages]);

    useEffect(() => {
        if (open) setTimeout(() => inputRef.current?.focus(), 100);
    }, [open]);

    useEffect(() => {
        if (!open) return;
        const onKey = (e: KeyboardEvent) => {
            if (e.key === 'Escape') onClose();
        };
        document.addEventListener('keydown', onKey);
        return () => document.removeEventListener('keydown', onKey);
    }, [open, onClose]);

    useEffect(() => {
        const recorder = mediaRecorderRef.current;
        const recognition = recognitionRef.current;
        return () => {
            recognition?.abort();
            recorder?.stop();
        };
    }, []);

    const handleStop = useCallback(() => {
        abortRef.current?.abort();
        abortRef.current = null;
        setIsStreaming(false);
        isSendingLocked = false;
    }, []);

    const sendMessage = useCallback(async (text: string) => {
        if (!text.trim() || isStreaming || isSendingLocked) return;
        isSendingLocked = true;

        if (!apiKey) {
            setMessages((prev) => [
                ...prev,
                { role: 'user', content: text },
                { role: 'assistant', content: '⚠️ No API key configured. Go to **Settings → AI** and enter your OpenRouter API key.' },
            ]);
            sendBridgeResponse({ type: 'error', message: 'No API key configured' });
            isSendingLocked = false;
            return;
        }

        const userMsg: ChatMessage = { role: 'user', content: text.trim() };
        const newMessages = [...messages, userMsg];
        setMessages(newMessages);
        setInput('');
        setIsStreaming(true);

        const liveRef = { thinking: '', actions: [] as LiveAction[], finalText: '' };
        setLiveAgent({ thinking: '', actions: [], finalText: '' });

        const controller = new AbortController();
        abortRef.current = controller;

        try {
            const result = await streamChat(
                newMessages,
                apiKey,
                model,
                (event) => {
                    sendBridgeResponse(event as unknown as Record<string, unknown>);
                    switch (event.type) {
                        case 'thinking':
                            liveRef.thinking += event.text;
                            setLiveAgent((prev) => (prev ? { ...prev, thinking: liveRef.thinking } : prev));
                            break;
                        case 'tool-start':
                            liveRef.actions.push({ toolName: event.toolName, args: event.args, result: null, index: event.index });
                            setLiveAgent((prev) => (prev ? { ...prev, actions: [...liveRef.actions] } : prev));
                            break;
                        case 'tool-end':
                            liveRef.actions = liveRef.actions.map((a) => (a.index === event.index ? { ...a, result: event.result } : a));
                            setLiveAgent((prev) => (prev ? { ...prev, actions: [...liveRef.actions] } : prev));
                            break;
                        case 'delta':
                            liveRef.finalText += event.text;
                            setLiveAgent((prev) => (prev ? { ...prev, finalText: liveRef.finalText } : prev));
                            break;
                        default:
                            break;
                    }
                },
                onSelectClips,
                controller.signal,
            );

            const finalMsg = result[result.length - 1];
            if (finalMsg && finalMsg.role === 'assistant') {
                finalMsg.thinking = liveRef.thinking || undefined;
                finalMsg.actions = liveRef.actions.length > 0 ? liveRef.actions : undefined;
            }
            setMessages(result);
            sendBridgeResponse({ type: 'done', finalText: finalMsg?.content ?? '' });
        } catch (err: unknown) {
            const abortContent = liveRef.thinking
                ? `💭 ${liveRef.thinking.slice(0, 500)}${liveRef.thinking.length > 500 ? '...' : ''}\n\n(stopped by user)`
                : '(stopped by user)';

            if ((err as Error).name === 'AbortError') {
                setMessages((prev) => [
                    ...prev,
                    { role: 'assistant', content: abortContent, actions: liveRef.actions.length > 0 ? liveRef.actions : undefined } as ChatMessage,
                ]);
                sendBridgeResponse({ type: 'error', message: 'Aborted' });
            } else {
                const errMsg = (err as Error).message;
                setMessages((prev) => [
                    ...prev,
                    {
                        role: 'assistant',
                        content: `❌ Error: ${errMsg}`,
                        thinking: liveRef.thinking || undefined,
                        actions: liveRef.actions.length > 0 ? liveRef.actions : undefined,
                    } as ChatMessage,
                ]);
                sendBridgeResponse({ type: 'error', message: errMsg });
            }
        } finally {
            setIsStreaming(false);
            setLiveAgent(null);
            abortRef.current = null;
            isSendingLocked = false;
        }
    }, [isStreaming, apiKey, messages, model, onSelectClips]);

    const handleSend = useCallback(() => {
        if (!input.trim()) return;
        sendMessage(input);
        inputRef.current?.blur();
    }, [input, sendMessage]);

    useAgentBridge({
        onRemoteMessage: (text) => {
            if (!open) onOpen();
            sendMessage(text);
        },
        isStreaming,
    });

    const toggleVoice = useAssistantVoiceInput({
        isListening,
        setIsListening,
        setMessages,
        setInput,
        recognitionRef,
        mediaRecorderRef,
        intentionalStopRef,
    });

    const handleKeyDown = useCallback((e: React.KeyboardEvent) => {
        e.stopPropagation();
        if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
            e.preventDefault();
            handleSend();
        }
    }, [handleSend]);

    const groupedItems = groupMessagesIntoActions(messages);
    const voiceIcon = isListening ? MicOff : Mic;
    const voiceTitle = isListening ? 'Click to stop' : 'Voice input';
    const voiceClass = `assistant-voice-btn${isListening ? ' listening' : ''}`;

    const copyHistory = useCallback(() => {
        const historyText = messages.map((m) => {
            let text = `[${m.role.toUpperCase()}${m.role === 'tool' && m.name ? `: ${m.name}` : ''}]\n`;
            if (m.content) text += `${m.content}\n`;
            if (m.thinking) text += `[THINKING]\n${m.thinking}\n`;
            if (m.actions && m.actions.length > 0) {
                text += '[ACTIONS]\n';
                m.actions.forEach((a) => {
                    text += ` - ${a.toolName}(${JSON.stringify(a.args)})\n   Result: ${a.result}\n`;
                });
            }
            return `${text}\n============================\n`;
        }).join('\n');
        navigator.clipboard.writeText(historyText);
    }, [messages]);

    const clearHistoryClick = useCallback(() => {
        setMessages([]);
        lastSavedRef.current = '';
        void clearChatHistory();
    }, []);

    if (!open) return <div style={{ display: 'none' }} />;

    return (
        <div
            className="assistant-chat-overlay"
            data-keyboard-scope="text-input"
            style={
                dragPos
                    ? { position: 'fixed', left: dragPos.x, top: dragPos.y, right: 'auto', bottom: 'auto' }
                    : undefined
            }
        >
            <AssistantChatHeader
                model={model}
                setModel={setModel}
                models={MODELS}
                onCopyHistory={copyHistory}
                onClearHistory={clearHistoryClick}
                onClose={onClose}
                onHeaderMouseDown={handleHeaderMouseDown}
            />

            <AssistantChatMessages
                groupedItems={groupedItems}
                isStreaming={isStreaming}
                liveAgent={liveAgent}
                messagesEndRef={messagesEndRef}
            />

            <div className="assistant-input-area">
                <button className={voiceClass} onClick={toggleVoice} title={voiceTitle}>
                    {voiceIcon({ size: 14 })}
                </button>

                <textarea
                    ref={inputRef}
                    className="assistant-input"
                    placeholder=""
                    value={input}
                    onChange={(e) => {
                        setInput(e.target.value);
                        const el = e.target;
                        el.style.height = 'auto';
                        el.style.height = `${Math.min(el.scrollHeight, 120)}px`;
                    }}
                    onKeyDown={handleKeyDown}
                    rows={1}
                    disabled={isStreaming}
                />

                {isStreaming ? (
                    <button className="assistant-stop-btn" onClick={handleStop} title="Stop generation">
                        <Square size={14} fill="currentColor" />
                    </button>
                ) : (
                    <button className="assistant-send-btn" onClick={handleSend} disabled={!input.trim()} title="Send (Ctrl+Enter)">
                        <Send size={14} />
                    </button>
                )}
            </div>

            <div className="assistant-status">
                <span>
                    <span className={`dot ${apiKey ? 'connected' : 'disconnected'}`} />
                    {apiKey ? 'Connected' : 'No API key'}
                </span>
                <span>{messages.filter((m) => m.role === 'user').length} messages</span>
            </div>
        </div>
    );
};
