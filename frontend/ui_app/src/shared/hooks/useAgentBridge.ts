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
 *
 * CRITICAL FIX: Uses a module-level dedup lock + proper handler cleanup
 * to prevent StrictMode / HMR from registering multiple handlers,
 * which would cause N×API cost multiplication (money leak).
 */

import { useEffect, useRef } from 'react';

interface AgentBridgeOptions {
    /** Called when an external client sends a message to inject into chat */
    onRemoteMessage: (text: string) => void;
    /** Whether the chat is currently streaming (prevents concurrent sends) */
    isStreaming: boolean;
}

// ── Module-level dedup lock ─────────────────────────────────────────────
// Prevents StrictMode double-mount and HMR re-registration from
// creating multiple handlers (which would fan out 1 message → N API calls).
type AgentBridgeMessage = {
    type?: string;
    message?: string;
};

type HmrBus = {
    on(event: string, cb: (data: unknown) => void): void;
    off?(event: string, cb: (data: unknown) => void): void;
    send(event: string, data: unknown): void;
};

let _activeHandler: ((data: unknown) => void) | null = null;
let _isProcessing = false; // Synchronous lock — React state is async and racy

/** Sends an agent response event back to external bridge clients via Vite HMR */
export function sendBridgeResponse(data: Record<string, unknown>): void {
    const hmr = import.meta.hot as unknown as HmrBus | undefined;
    if (hmr) {
        hmr.send('agent-bridge:response', data);
    }
}

/**
 * Hook that listens for incoming messages from the Agent Bridge WebSocket.
 * When an external client (e.g., Antigravity) sends a message, it triggers
 * onRemoteMessage which injects the text into the chat flow.
 */
export function useAgentBridge({ onRemoteMessage, isStreaming }: AgentBridgeOptions): void {
    const isStreamingRef = useRef(isStreaming);
    useEffect(() => {
        isStreamingRef.current = isStreaming;
    }, [isStreaming]);

    // Reset the processing lock when streaming ends
    useEffect(() => {
        if (!isStreaming) {
            _isProcessing = false;
        }
    }, [isStreaming]);

    const onMessageRef = useRef(onRemoteMessage);
    useEffect(() => {
        onMessageRef.current = onRemoteMessage;
    }, [onRemoteMessage]);

    useEffect(() => {
        const hmr = import.meta.hot as unknown as HmrBus | undefined;
        if (!hmr) return;

        // ── Tear down any stale handler from previous mount / HMR cycle ──
        if (_activeHandler) {
            // Vite exposes .off() on the HMR client since v5
            try {
                hmr.off?.('agent-bridge:message', _activeHandler);
            } catch { /* older Vite — no .off(), we rely on dedup lock */ }
            _activeHandler = null;
        }

        const handler = (data: unknown) => {
            const msg = data as AgentBridgeMessage;
            if (msg?.type === 'send' && typeof msg.message === 'string') {
                // ── Synchronous dedup lock (React setState is async/racy) ──
                if (_isProcessing || isStreamingRef.current) {
                    sendBridgeResponse({
                        type: 'error',
                        message: 'Agent is currently processing a request. Please wait.',
                    });
                    return;
                }
                _isProcessing = true; // Lock BEFORE async sendMessage fires
                try {
                    onMessageRef.current(msg.message);
                } catch (err) {
                    _isProcessing = false;
                    sendBridgeResponse({
                        type: 'error',
                        message: err instanceof Error ? err.message : String(err),
                    });
                }
            }
        };

        _activeHandler = handler;
        hmr.on('agent-bridge:message', handler);

        return () => {
            // Proper cleanup — remove THIS handler
            if (_activeHandler === handler) {
                try {
                    hmr.off?.('agent-bridge:message', handler);
                } catch { /* fallback: dedup lock handles it */ }
                _activeHandler = null;
            }
        };
    }, []);
}
