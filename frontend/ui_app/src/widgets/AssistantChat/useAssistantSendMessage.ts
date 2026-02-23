import { useCallback } from 'react';
import { streamChat, type ChatMessage } from '@/shared/api/assistantService';
import { sendBridgeResponse } from '@/shared/hooks/useAgentBridge';
import type { LiveAction, LiveAgentState } from './AssistantChat';

let isSendingLocked = false;

interface UseAssistantSendMessageParams {
    apiKey: string;
    model: string;
    messages: ChatMessage[];
    isStreaming: boolean;
    onSelectClips?: (ids: string[]) => void;
    setMessages: React.Dispatch<React.SetStateAction<ChatMessage[]>>;
    setInput: React.Dispatch<React.SetStateAction<string>>;
    setIsStreaming: React.Dispatch<React.SetStateAction<boolean>>;
    setLiveAgent: React.Dispatch<React.SetStateAction<LiveAgentState | null>>;
    abortRef: React.MutableRefObject<AbortController | null>;
}

export function useAssistantSendMessage({
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
}: UseAssistantSendMessageParams) {
    const handleStop = useCallback(() => {
        abortRef.current?.abort();
        abortRef.current = null;
        setIsStreaming(false);
        isSendingLocked = false;
    }, [abortRef, setIsStreaming]);

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
    }, [
        abortRef,
        apiKey,
        isStreaming,
        messages,
        model,
        onSelectClips,
        setInput,
        setIsStreaming,
        setLiveAgent,
        setMessages,
    ]);

    return { sendMessage, handleStop };
}

