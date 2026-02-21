/**
 * Dream DAW - useAgentBridge hook
 *
 * Connects to the Agent Bridge (Vite WebSocket plugin on port 5180).
 * Allows external tools to:
 *   1. Send messages that appear in the chat and get processed by Dream AI
 *   2. Receive real-time agent responses (thinking, tool execution, final text)
 *
 * Usage in AssistantChat:
 *   useAgentBridge({
 *       onRemoteMessage: (text) => { ... inject into chat ... },
 *       isStreaming: isStreaming,
 *   });
 */

import { useEffect, useRef } from 'react';

interface AgentBridgeOptions {
    /** Called when an external client sends a message to inject into chat */
    onRemoteMessage: (text: string) => void;
    /** Whether the chat is currently streaming (prevents concurrent sends) */
    isStreaming: boolean;
}

/** Sends an agent response event back to external bridge clients via Vite HMR */
export function sendBridgeResponse(data: Record<string, unknown>): void {
    if (import.meta.hot) {
        import.meta.hot.send('agent-bridge:response', data);
    }
}

/**
 * Hook that listens for incoming messages from the Agent Bridge WebSocket.
 * When an external client (e.g., Antigravity) sends a message, it triggers
 * onRemoteMessage which injects the text into the chat flow.
 */
export function useAgentBridge({ onRemoteMessage, isStreaming }: AgentBridgeOptions): void {
    const isStreamingRef = useRef(isStreaming);
    isStreamingRef.current = isStreaming;

    const onMessageRef = useRef(onRemoteMessage);
    onMessageRef.current = onRemoteMessage;

    useEffect(() => {
        if (!import.meta.hot) return;

        const handler = (data: any) => {
            if (data?.type === 'send' && typeof data.message === 'string') {
                if (isStreamingRef.current) {
                    sendBridgeResponse({
                        type: 'error',
                        message: 'Agent is currently processing a request. Please wait.',
                    });
                    return;
                }
                onMessageRef.current(data.message);
            }
        };

        import.meta.hot.on('agent-bridge:message', handler);

        return () => {
            // Vite HMR cleanup handled by module disposal
        };
    }, []);
}
