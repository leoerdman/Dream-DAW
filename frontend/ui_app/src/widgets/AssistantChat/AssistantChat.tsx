import { useState, useRef, useEffect, useCallback } from 'react';
import { useSettingsStore } from '@/shared/stores/useSettingsStore';
import type { ChatMessage } from '@/shared/api/assistantService';
import { loadChatHistory, saveChatHistory, clearChatHistory } from '@/shared/api/chatHistoryService';
import { groupMessagesIntoActions } from './AgentActionGrouping';
import { useEngineStore } from '@/shared/stores/useEngineStore';
import { useAgentBridge } from '@/shared/hooks/useAgentBridge';
import { useAssistantVoiceInput, type SpeechRecognitionInstance } from './useAssistantVoiceInput';
import { AssistantChatHeader } from './AssistantChatHeader';
import { AssistantChatMessages } from './AssistantChatMessages';
import { AssistantChatComposer } from './AssistantChatComposer';
import { buildHistoryText } from './assistantHistory';
import { useAssistantSendMessage } from './useAssistantSendMessage';
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
    const projectId = useEngineStore((s) => `${s.tracks.allIds.length}:${s.projectBpm}`);
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
        // FIX: Never reload history while streaming — agent actions can change projectId
        // mid-stream (e.g. adding tracks changes track count), which would trigger this
        // effect and overwrite the live message list with stale/empty persisted history.
        if (isStreaming) return;

        let cancelled = false;
        const shouldResetLiveAgent =
            historyLoadedForId !== null && historyLoadedForId !== projectId;

        if (shouldResetLiveAgent) {
            abortRef.current?.abort();
            abortRef.current = null;
        }

        void loadChatHistory().then((history) => {
            if (cancelled) return;
            if (shouldResetLiveAgent) setLiveAgent(null);
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

    const { sendMessage, handleStop } = useAssistantSendMessage({
        apiKey,
        model,
        messages,
        isStreaming,
        onSelectClips,
        setMessages,
        setInput,
        setIsStreaming,
        setLiveAgent,
        abortRef,
    });

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

    const copyHistory = useCallback(() => {
        navigator.clipboard.writeText(buildHistoryText(messages)).catch(() => { /* clipboard unavailable */ });
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

            <AssistantChatComposer
                input={input}
                isStreaming={isStreaming}
                isListening={isListening}
                apiKey={apiKey}
                userMessageCount={messages.filter((m) => m.role === 'user').length}
                inputRef={inputRef}
                setInput={setInput}
                onKeyDown={handleKeyDown}
                onToggleVoice={toggleVoice}
                onStop={handleStop}
                onSend={handleSend}
            />
        </div>
    );
};
