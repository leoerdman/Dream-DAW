/* ═══════════════════════════════════════════════════════════════════════════
 * Dream DAW — AI Assistant Chat Widget (Enterprise)
 *
 * Multi-turn chat ▸ Stop button ▸ Native voice input ▸ Model selector
 * Key events isolated from DAW global shortcuts
 * ═══════════════════════════════════════════════════════════════════════════ */

import { useState, useRef, useEffect, useCallback } from 'react';
import { Bot, X, Send, Square, Mic, MicOff, Sparkles, Trash2 } from 'lucide-react';
import { useSettingsStore } from '@/shared/stores/useSettingsStore';
import { streamChat, type ChatMessage } from '@/shared/api/assistantService';
import { loadChatHistory, saveChatHistory, clearChatHistory } from '@/shared/api/chatHistoryService';
import { AgentActionCard, LiveAgentCard, groupMessagesIntoActions, isActionGroup } from './AgentActionCard';
import { useEngineStore } from '@/shared/stores/useEngineStore';
import { useAgentBridge, sendBridgeResponse } from '@/shared/hooks/useAgentBridge';
import './AgentActionCard.css';
import './AssistantChat.css';

// ── Supported models ────────────────────────────────────────────────────────

const MODELS = [
    { id: 'google/gemini-2.5-pro-preview-06-05', label: 'Gemini' },
    { id: 'anthropic/claude-sonnet-4', label: 'Claude' },
];

// ── Live streaming state types ───────────────────────────────────────────────

/** A tool action being tracked in real-time during streaming. */
export interface LiveAction {
    toolName: string;
    args: Record<string, unknown>;
    result: string | null;   // null = still executing, string = complete
    index: number;
}

/** Real-time agent streaming state shown during execution. */
export interface LiveAgentState {
    thinking: string;        // accumulated reasoning text
    actions: LiveAction[];   // tool calls (in-progress + completed)
    finalText: string;       // final response text (streamed)
}

// ── Props ───────────────────────────────────────────────────────────────────

interface AssistantChatProps {
    open: boolean;
    onClose: () => void;
    onSelectClips?: (ids: string[]) => void;
}

// ── Native speech recognition helper ────────────────────────────────────────

type SpeechRecognitionInstance = {
    continuous: boolean;
    interimResults: boolean;
    lang: string;
    onresult: ((event: { resultIndex: number; results: { length: number;[i: number]: { [j: number]: { transcript: string } } } }) => void) | null;
    onerror: ((event: { error: string; message?: string }) => void) | null;
    onend: (() => void) | null;
    onstart: (() => void) | null;
    start: () => void;
    stop: () => void;
    abort: () => void;
};

function createSpeechRecognition(): SpeechRecognitionInstance | null {
    const w = window as unknown as Record<string, unknown>;
    const Ctor = (w.SpeechRecognition ?? w.webkitSpeechRecognition) as
        | (new () => SpeechRecognitionInstance)
        | undefined;
    if (!Ctor) return null;
    try {
        return new Ctor();
    } catch {
        return null;
    }
}

// ═══════════════════════════════════════════════════════════════════════════

export const AssistantChat = ({ open, onClose, onSelectClips }: AssistantChatProps) => {
    const [messages, setMessages] = useState<ChatMessage[]>([]);
    const [input, setInput] = useState('');
    const [isStreaming, setIsStreaming] = useState(false);
    const [streamText, setStreamText] = useState('');
    const [model, setModel] = useState(MODELS[0].id);
    const [isListening, setIsListening] = useState(false);

    // ── Live agent state (real-time during streaming) ──
    const [liveAgent, setLiveAgent] = useState<LiveAgentState | null>(null);

    const messagesEndRef = useRef<HTMLDivElement>(null);
    const inputRef = useRef<HTMLTextAreaElement>(null);
    const abortRef = useRef<AbortController | null>(null);
    const recognitionRef = useRef<SpeechRecognitionInstance | null>(null);
    const mediaRecorderRef = useRef<MediaRecorder | null>(null);

    const intentionalStopRef = useRef(false);

    const apiKey = useSettingsStore((s) => s.settings.openRouterApiKey);

    // ── Auto scroll & focus ──
    useEffect(() => {
        messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
    }, [messages, streamText, liveAgent]);

    // Get a dependency for project ID (so chat resets when project changes)
    const projectId = useEngineStore((s) => s.projectTracks.length.toString() + s.projectBpm.toString());

    // ── Load history from localStorage on open or project change ──
    const [historyLoadedForId, setHistoryLoadedForId] = useState<string | null>(null);

    useEffect(() => {
        if (!open) return;
        let cancelled = false;

        // Reset active stream states when project conceptually changes
        if (historyLoadedForId !== null && historyLoadedForId !== projectId) {
            abortRef.current?.abort();
            abortRef.current = null;
            setIsStreaming(false);
            setStreamText('');
            setLiveAgent(null);
        }

        void loadChatHistory().then((history) => {
            if (!cancelled) {
                if (history.length > 0) {
                    setMessages(history);
                } else if (historyLoadedForId !== projectId) {
                    setMessages([]); // Clear chat if new project has no history
                }
                setHistoryLoadedForId(projectId);
            }
        });
        return () => { cancelled = true; };
    }, [open, projectId /* re-run when project conceptually changes */]);

    // ── Persist history on every message change ──
    const lastSavedRef = useRef('');
    useEffect(() => {
        if (messages.length === 0) return;
        // Avoid redundant saves: check if messages actually changed.
        const serialized = JSON.stringify(messages);
        if (serialized === lastSavedRef.current) return;
        lastSavedRef.current = serialized;
        void saveChatHistory(messages);
    }, [messages]);

    useEffect(() => {
        if (open) setTimeout(() => inputRef.current?.focus(), 100);
    }, [open]);

    // ── Escape to close ──
    useEffect(() => {
        if (!open) return;
        const onKey = (e: KeyboardEvent) => {
            if (e.key === 'Escape') onClose();
        };
        document.addEventListener('keydown', onKey);
        return () => document.removeEventListener('keydown', onKey);
    }, [open, onClose]);

    // ── Cleanup on unmount ──
    useEffect(() => {
        return () => {
            recognitionRef.current?.abort();
            mediaRecorderRef.current?.stop();
        };
    }, []);

    // ── Stop streaming ──
    const handleStop = useCallback(() => {
        abortRef.current?.abort();
        abortRef.current = null;
        setIsStreaming(false);
    }, []);

    // ── Send message (core function — accepts text directly) ──
    const sendMessage = useCallback(async (text: string) => {
        if (!text.trim() || isStreaming) return;
        if (!apiKey) {
            setMessages((prev) => [
                ...prev,
                { role: 'user', content: text },
                { role: 'assistant', content: '⚠️ No API key configured. Go to **Settings → AI** and enter your OpenRouter API key.' },
            ]);
            sendBridgeResponse({ type: 'error', message: 'No API key configured' });
            return;
        }

        const userMsg: ChatMessage = { role: 'user', content: text.trim() };
        const newMessages = [...messages, userMsg];
        setMessages(newMessages);
        setInput('');
        setIsStreaming(true);
        setStreamText('');
        setLiveAgent({ thinking: '', actions: [], finalText: '' });

        const controller = new AbortController();
        abortRef.current = controller;

        try {
            const result = await streamChat(
                newMessages, apiKey, model,
                (event) => {
                    // Relay all events to bridge clients (Antigravity)
                    sendBridgeResponse(event as unknown as Record<string, unknown>);

                    switch (event.type) {
                        case 'thinking':
                            setLiveAgent(prev => prev ? {
                                ...prev,
                                thinking: prev.thinking + event.text,
                            } : prev);
                            break;

                        case 'tool-start':
                            setLiveAgent(prev => prev ? {
                                ...prev,
                                actions: [...prev.actions, {
                                    toolName: event.toolName,
                                    args: event.args,
                                    result: null,
                                    index: event.index,
                                }],
                            } : prev);
                            break;

                        case 'tool-end':
                            setLiveAgent(prev => {
                                if (!prev) return prev;
                                const updated = prev.actions.map(a =>
                                    a.index === event.index
                                        ? { ...a, result: event.result }
                                        : a
                                );
                                return { ...prev, actions: updated };
                            });
                            break;

                        case 'delta':
                            // Route model's text generation into the 'thinking' block
                            // This ensures the user sees the '💭 Reasoning' stream in real-time.
                            setLiveAgent(prev => prev ? {
                                ...prev,
                                thinking: prev.thinking + event.text,
                            } : prev);
                            break;

                        case 'error':
                            break;

                        case 'done':
                            break;
                    }
                },
                onSelectClips, controller.signal,
            );
            setMessages(result);
            // Send final done event with the complete final text
            sendBridgeResponse({ type: 'done', finalText: result[result.length - 1]?.content ?? '' });
        } catch (err: unknown) {
            if ((err as Error).name === 'AbortError') {
                setMessages(prev => [...prev, { role: 'assistant', content: streamText || '(stopped)' }]);
                sendBridgeResponse({ type: 'error', message: 'Aborted' });
            } else {
                const errMsg = (err as Error).message;
                setMessages(prev => [...prev, { role: 'assistant', content: `❌ Error: ${errMsg}` }]);
                sendBridgeResponse({ type: 'error', message: errMsg });
            }
        } finally {
            setIsStreaming(false);
            setStreamText('');
            setLiveAgent(null);
            abortRef.current = null;
        }
    }, [isStreaming, apiKey, messages, model, onSelectClips, streamText]);

    // ── UI send handler (reads from input field) ──
    const handleSend = useCallback(() => {
        sendMessage(input);
    }, [input, sendMessage]);

    // ── Agent Bridge: receive remote messages from external tools ──
    useAgentBridge({
        onRemoteMessage: sendMessage,
        isStreaming,
    });

    // ── Voice input (native SpeechRecognition with getUserMedia pre-request) ──
    const toggleVoice = useCallback(async () => {
        try {
            // ── STOP ──
            if (isListening) {
                intentionalStopRef.current = true;
                try { recognitionRef.current?.stop(); } catch { /* ignore */ }
                try { mediaRecorderRef.current?.stop(); } catch { /* ignore */ }
                setIsListening(false);
                return;
            }

            intentionalStopRef.current = false;

            // ── Step 1: Ensure microphone permission via getUserMedia ──
            // CRITICAL: In Tauri WKWebView (macOS), calling getUserMedia
            // causes a NATIVE-level crash (webview process dies before JS
            // Promise rejects). This happens because dev builds lack the
            // signed bundle entitlements required for media capture.
            // Solution: detect Tauri and skip getUserMedia entirely.
            // SpeechRecognition handles its own permissions gracefully.
            const isTauri = !!(window as unknown as Record<string, unknown>).__TAURI__;
            const micPermCacheKey = 'dream-ai-mic-permission';
            const cachedPermission = localStorage.getItem(micPermCacheKey);

            if (!isTauri && cachedPermission !== 'granted' && navigator.mediaDevices?.getUserMedia) {
                try {
                    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
                    // Release the stream immediately — we just needed the permission prompt.
                    stream.getTracks().forEach((t) => t.stop());
                    localStorage.setItem(micPermCacheKey, 'granted');
                } catch (err) {
                    console.warn('[DreamAI] Microphone permission denied:', err);
                    setMessages((prev) => [
                        ...prev,
                        {
                            role: 'assistant',
                            content: '⚠️ Доступ к микрофону отклонён. Разрешите доступ: Системные настройки → Конфиденциальность → Микрофон. / Microphone access denied. Grant permission in System Preferences → Privacy & Security → Microphone.',
                        },
                    ]);
                    return;
                }
            }

            // ── Step 2: Try native SpeechRecognition ──
            const recognition = createSpeechRecognition();
            if (recognition) {
                recognition.continuous = true;
                recognition.interimResults = false;
                // Auto-detect user's language
                recognition.lang = navigator.language || 'en-US';

                let hasStarted = false;

                recognition.onstart = () => {
                    hasStarted = true;
                };

                recognition.onresult = (event) => {
                    let transcript = '';
                    for (let i = event.resultIndex; i < event.results.length; i++) {
                        transcript += event.results[i][0].transcript;
                    }
                    if (transcript) {
                        setInput((prev) => {
                            const spacer = prev.length > 0 && !prev.endsWith(' ') ? ' ' : '';
                            return prev + spacer + transcript;
                        });
                    }
                };

                recognition.onerror = (event) => {
                    console.warn('[DreamAI] Speech recognition error:', event.error);
                    setIsListening(false);
                    recognitionRef.current = null;

                    if (event.error === 'no-speech') {
                        // Silence — not an error, just nothing to transcribe
                    } else if (event.error === 'not-allowed' || event.error === 'service-not-allowed') {
                        // Clear cached permission so we re-prompt next time
                        localStorage.removeItem(micPermCacheKey);
                        setMessages((prev) => [
                            ...prev,
                            { role: 'assistant', content: '⚠️ Доступ к микрофону заблокирован. Проверьте настройки Конфиденциальности. / Microphone blocked. Check Privacy settings.' },
                        ]);
                    } else {
                        setMessages((prev) => [
                            ...prev,
                            { role: 'assistant', content: `⚠️ Ошибка распознавания: ${event.error}. Попробуйте ещё раз.` },
                        ]);
                    }
                };

                recognition.onend = () => {
                    if (!intentionalStopRef.current && !hasStarted) {
                        setIsListening(false);
                        setMessages((prev) => [
                            ...prev,
                            { role: 'assistant', content: '⚠️ Распознавание не удалось запустить. Используйте текстовый ввод.' },
                        ]);
                        return;
                    }
                    setIsListening(false);
                    recognitionRef.current = null;
                };

                recognitionRef.current = recognition;
                setIsListening(true);

                try {
                    recognition.start();
                } catch (err) {
                    console.warn('[DreamAI] Speech recognition start failed:', err);
                    setIsListening(false);
                    recognitionRef.current = null;
                    setMessages((prev) => [
                        ...prev,
                        { role: 'assistant', content: '⚠️ Не удалось запустить распознавание речи. Используйте текстовый ввод.' },
                    ]);
                }
                return;
            }

            // ── No native support — inform user ──
            setMessages((prev) => [
                ...prev,
                { role: 'assistant', content: '⚠️ Голосовой ввод недоступен в этой среде. macOS WebView не поддерживает Web Speech API. Используйте текстовый ввод.' },
            ]);
        } catch (err) {
            // Top-level crash guard — should never happen, but prevents app crash
            console.error('[DreamAI] toggleVoice unexpected crash:', err);
            setIsListening(false);
            recognitionRef.current = null;
            setMessages((prev) => [
                ...prev,
                { role: 'assistant', content: '⚠️ Произошла ошибка при активации микрофона. Используйте текстовый ввод.' },
            ]);
        }
    }, [isListening]);

    // Voice input is native-only (SpeechRecognition API). No external API fallback.

    // ── Key handler (MUST stopPropagation to prevent DAW shortcuts) ──
    const handleKeyDown = useCallback((e: React.KeyboardEvent) => {
        e.stopPropagation();
        // Ctrl+Enter (or Cmd+Enter on macOS) to send
        if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
            e.preventDefault();
            handleSend();
        }
    }, [handleSend]);

    // ── Don't render when closed ──
    if (!open) return null;

    // ── Render ──────────────────────────────────────────────────────────────

    // Group messages into rich action groups for premium rendering
    const groupedItems = groupMessagesIntoActions(messages);

    // Voice button icon
    const VoiceIcon = isListening ? MicOff : Mic;
    const voiceTitle = isListening ? 'Click to stop' : 'Voice input';
    const voiceClass = `assistant-voice-btn${isListening ? ' listening' : ''}`;

    return (
        <div
            className="assistant-chat-overlay"
            data-keyboard-scope="text-input"
            onKeyDown={(e) => e.stopPropagation()}
            onKeyDownCapture={(e) => {
                // Prevent DAW global shortcuts (Space=play, Delete=delete clip, etc.)
                // from firing while the user is typing in the AI chat.
                // This must be in the CAPTURE phase because useKeyboardShortcuts
                // also listens in capture phase ({ capture: true }).
                const tag = (e.target as HTMLElement)?.tagName;
                if (tag === 'TEXTAREA' || tag === 'INPUT') {
                    e.stopPropagation();
                }
            }}
        >
            {/* ── Header ── */}
            <div className="assistant-header">
                <div className="assistant-header-left">
                    <div className="assistant-header-icon">
                        <Sparkles size={14} />
                    </div>
                    <span className="assistant-header-title">Dream AI</span>
                </div>

                <div className="assistant-header-actions">
                    <div className="model-selector">
                        {MODELS.map((m) => (
                            <button
                                key={m.id}
                                className={`model-selector-btn ${model === m.id ? 'active' : ''}`}
                                onClick={() => setModel(m.id)}
                            >
                                {m.label}
                            </button>
                        ))}
                    </div>
                    <button className="assistant-mini-btn" onClick={() => {
                        setMessages([]);
                        lastSavedRef.current = '';
                        void clearChatHistory();
                    }} title="Clear history">
                        <Trash2 size={14} />
                    </button>
                    <button className="assistant-mini-btn" onClick={onClose} title="Close">
                        <X size={14} />
                    </button>
                </div>
            </div>

            {/* ── Messages ── */}
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
                    if (isActionGroup(item)) {
                        return <AgentActionCard key={`action-${i}`} group={item} />;
                    }
                    const msg = item as ChatMessage;
                    return (
                        <div key={i} className={`assistant-msg ${msg.role}`}>
                            {msg.role === 'user' && <span className="msg-label">You</span>}
                            {msg.role === 'assistant' && <span className="msg-label">Dream AI</span>}
                            <div className={`msg-bubble ${msg.role}`}>{msg.content}</div>
                        </div>
                    );
                })}

                {/* ── Live Agent Card (real-time streaming) ── */}
                {isStreaming && liveAgent && (
                    <LiveAgentCard live={liveAgent} />
                )}

                <div ref={messagesEndRef} />
            </div>

            {/* ── Input Area ── */}
            <div className="assistant-input-area">
                <button
                    className={voiceClass}
                    onClick={toggleVoice}
                    title={voiceTitle}
                >
                    <VoiceIcon size={14} />
                </button>

                <textarea
                    ref={inputRef}
                    className="assistant-input"
                    placeholder="Спроси Dream AI… (Ctrl+Enter — отправить)"
                    value={input}
                    onChange={(e) => {
                        setInput(e.target.value);
                        // Auto-resize textarea
                        const el = e.target;
                        el.style.height = 'auto';
                        el.style.height = Math.min(el.scrollHeight, 120) + 'px';
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
                    <button
                        className="assistant-send-btn"
                        onClick={handleSend}
                        disabled={!input.trim()}
                        title="Send (Ctrl+Enter)"
                    >
                        <Send size={14} />
                    </button>
                )}
            </div>

            {/* ── Status ── */}
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
