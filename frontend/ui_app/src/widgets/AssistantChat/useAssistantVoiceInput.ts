import { useCallback } from 'react';
import type { ChatMessage } from '@/shared/api/assistantService';
import type { Dispatch, MutableRefObject, SetStateAction } from 'react';

export type SpeechRecognitionInstance = {
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
    const Ctor = (w.SpeechRecognition ?? w.webkitSpeechRecognition) as (new () => SpeechRecognitionInstance) | undefined;
    if (!Ctor) return null;
    try {
        return new Ctor();
    } catch {
        return null;
    }
}

interface VoiceInputOptions {
    isListening: boolean;
    setIsListening: (value: boolean) => void;
    setMessages: Dispatch<SetStateAction<ChatMessage[]>>;
    setInput: Dispatch<SetStateAction<string>>;
    recognitionRef: MutableRefObject<SpeechRecognitionInstance | null>;
    mediaRecorderRef: MutableRefObject<MediaRecorder | null>;
    intentionalStopRef: MutableRefObject<boolean>;
}

export function useAssistantVoiceInput({
    isListening,
    setIsListening,
    setMessages,
    setInput,
    recognitionRef,
    mediaRecorderRef,
    intentionalStopRef,
}: VoiceInputOptions) {
    return useCallback(async () => {
        try {
            if (isListening) {
                intentionalStopRef.current = true;
                try { recognitionRef.current?.stop(); } catch { /* noop */ }
                try { mediaRecorderRef.current?.stop(); } catch { /* noop */ }
                setIsListening(false);
                return;
            }

            intentionalStopRef.current = false;
            const isTauri = !!((window as unknown as Record<string, unknown>).__TAURI__ || (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__);
            const micPermCacheKey = 'dream-ai-mic-permission';
            const cachedPermission = localStorage.getItem(micPermCacheKey);

            if (!isTauri && cachedPermission !== 'granted' && navigator.mediaDevices?.getUserMedia) {
                try {
                    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
                    stream.getTracks().forEach((t) => t.stop());
                    localStorage.setItem(micPermCacheKey, 'granted');
                } catch (err) {
                    console.warn('[Dream] Microphone permission denied:', err);
                    setMessages((prev) => [
                        ...prev,
                        { role: 'assistant', content: '⚠️ Доступ к микрофону отклонён. Разрешите доступ: Системные настройки → Конфиденциальность → Микрофон. / Microphone access denied. Grant permission in System Preferences → Privacy & Security → Microphone.' },
                    ]);
                    return;
                }
            }

            const recognition = isTauri ? null : createSpeechRecognition();
            if (recognition) {
                recognition.continuous = true;
                recognition.interimResults = false;
                recognition.lang = navigator.language || 'en-US';

                let hasStarted = false;
                recognition.onstart = () => { hasStarted = true; };
                recognition.onresult = (event) => {
                    let transcript = '';
                    for (let i = event.resultIndex; i < event.results.length; i++) transcript += event.results[i][0].transcript;
                    if (transcript) {
                        setInput((prev) => {
                            const spacer = prev.length > 0 && !prev.endsWith(' ') ? ' ' : '';
                            return prev + spacer + transcript;
                        });
                    }
                };
                recognition.onerror = (event) => {
                    console.warn('[Dream] Speech recognition error:', event.error);
                    setIsListening(false);
                    recognitionRef.current = null;
                    if (event.error === 'not-allowed' || event.error === 'service-not-allowed') {
                        localStorage.removeItem(micPermCacheKey);
                        setMessages((prev) => [
                            ...prev,
                            { role: 'assistant', content: '⚠️ Доступ к микрофону заблокирован. Проверьте настройки Конфиденциальности. / Microphone blocked. Check Privacy settings.' },
                        ]);
                    } else if (event.error !== 'no-speech') {
                        setMessages((prev) => [...prev, { role: 'assistant', content: `⚠️ Ошибка распознавания: ${event.error}. Попробуйте ещё раз.` }]);
                    }
                };
                recognition.onend = () => {
                    if (!intentionalStopRef.current && !hasStarted) {
                        setIsListening(false);
                        setMessages((prev) => [...prev, { role: 'assistant', content: '⚠️ Распознавание не удалось запустить. Используйте текстовый ввод.' }]);
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
                    console.warn('[Dream] Speech recognition start failed:', err);
                    setIsListening(false);
                    recognitionRef.current = null;
                    setMessages((prev) => [...prev, { role: 'assistant', content: '⚠️ Не удалось запустить распознавание речи. Используйте текстовый ввод.' }]);
                }
                return;
            }

            setMessages((prev) => [
                ...prev,
                { role: 'assistant', content: '⚠️ Голосовой ввод недоступен в этой среде. macOS WebView не поддерживает Web Speech API. Используйте текстовый ввод.' },
            ]);
        } catch (err) {
            console.error('[Dream] toggleVoice unexpected crash:', err);
            setIsListening(false);
            recognitionRef.current = null;
            setMessages((prev) => [...prev, { role: 'assistant', content: '⚠️ Произошла ошибка при активации микрофона. Используйте текстовый ввод.' }]);
        }
    }, [intentionalStopRef, isListening, mediaRecorderRef, recognitionRef, setInput, setIsListening, setMessages]);
}
