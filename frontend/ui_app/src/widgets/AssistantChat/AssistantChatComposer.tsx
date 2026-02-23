import { Mic, MicOff, Send, Square } from 'lucide-react';
import type { RefObject } from 'react';

interface AssistantChatComposerProps {
    input: string;
    isStreaming: boolean;
    isListening: boolean;
    apiKey: string;
    userMessageCount: number;
    inputRef: RefObject<HTMLTextAreaElement | null>;
    setInput: (value: string) => void;
    onKeyDown: (e: React.KeyboardEvent) => void;
    onToggleVoice: () => void;
    onStop: () => void;
    onSend: () => void;
}

export function AssistantChatComposer({
    input,
    isStreaming,
    isListening,
    apiKey,
    userMessageCount,
    inputRef,
    setInput,
    onKeyDown,
    onToggleVoice,
    onStop,
    onSend,
}: AssistantChatComposerProps) {
    const VoiceIcon = isListening ? MicOff : Mic;
    const voiceTitle = isListening ? 'Click to stop' : 'Voice input';
    const voiceClass = `assistant-voice-btn${isListening ? ' listening' : ''}`;

    return (
        <>
            <div className="assistant-input-area">
                <button className={voiceClass} onClick={onToggleVoice} title={voiceTitle}>
                    <VoiceIcon size={14} />
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
                    onKeyDown={onKeyDown}
                    rows={1}
                    disabled={isStreaming}
                />

                {isStreaming ? (
                    <button className="assistant-stop-btn" onClick={onStop} title="Stop generation">
                        <Square size={14} fill="currentColor" />
                    </button>
                ) : (
                    <button className="assistant-send-btn" onClick={onSend} disabled={!input.trim()} title="Send (Ctrl+Enter)">
                        <Send size={14} />
                    </button>
                )}
            </div>

            <div className="assistant-status">
                <span>
                    <span className={`dot ${apiKey ? 'connected' : 'disconnected'}`} />
                    {apiKey ? 'Connected' : 'No API key'}
                </span>
                <span>{userMessageCount} messages</span>
            </div>
        </>
    );
}
