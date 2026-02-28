/**
 * Dream DAW - Agent Bridge (Vite Plugin)
 *
 * Creates a WebSocket server on port 5180 during development.
 * External tools (Antigravity) connect here to send messages to Dream AI.
 *
 * Protocol (JSON over WebSocket):
 *   Inbound:  { "type": "send", "message": "mute track 3" }
 *   Outbound: { "type": "thinking"|"tool-start"|"tool-end"|"delta"|"done"|"error", ... }
 */

import type { Plugin } from 'vite';
import { WebSocketServer, WebSocket } from 'ws';

const BRIDGE_PORT = 5180;
const MAX_BRIDGE_MESSAGE_BYTES = 64 * 1024;

type AgentBridgeIncomingMessage = {
    type?: string;
    message?: string;
};

export function agentBridgePlugin(): Plugin {
    let wss: WebSocketServer | null = null;

    return {
        name: 'dream-daw-agent-bridge',
        enforce: 'post',

        configureServer(server) {
            try {
                wss = new WebSocketServer({ port: BRIDGE_PORT });
            } catch (err) {
                const message = err instanceof Error ? err.message : String(err);
                console.warn(`  \u{1F309} Agent Bridge disabled: ${message}`);
                wss = null;
                return;
            }
            console.debug(`  \u{1F309} Agent Bridge listening on ws://localhost:${BRIDGE_PORT}`);

            wss.on('connection', (ws: WebSocket) => {
                console.debug('  \u{1F309} Agent Bridge: client connected');

                ws.on('message', (raw: Buffer | string) => {
                    try {
                        const text = typeof raw === 'string' ? raw : raw.toString('utf-8');
                        if (text.length > MAX_BRIDGE_MESSAGE_BYTES) {
                            console.warn(`  🌉 Agent Bridge: payload too large (${text.length} bytes), ignored`);
                            return;
                        }
                        const data = JSON.parse(text) as AgentBridgeIncomingMessage;
                        if (data?.type !== 'send' || typeof data.message !== 'string') {
                            console.warn('  🌉 Agent Bridge: invalid payload shape');
                            return;
                        }
                        console.debug('  \u{1F309} Agent Bridge ← received:', JSON.stringify(data).slice(0, 120));

                        // Relay to all frontend clients via Vite HMR
                        server.ws.send('agent-bridge:message', data);
                    } catch (err) {
                        console.warn('  \u{1F309} Agent Bridge: invalid message', err);
                    }
                });

                ws.on('close', () => {
                    console.debug('  \u{1F309} Agent Bridge: client disconnected');
                });

                ws.on('error', (err: Error) => {
                    console.warn('  \u{1F309} Agent Bridge: ws error', err.message);
                });
            });

            // Listen for frontend responses and relay back to external clients
            server.ws.on('agent-bridge:response', (data: unknown) => {
                if (!wss) return;
                const msg = JSON.stringify(data);
                for (const client of wss.clients) {
                    if (client.readyState === WebSocket.OPEN) {
                        client.send(msg);
                    }
                }
            });

            wss.on('error', (err: Error) => {
                if ((err as NodeJS.ErrnoException).code === 'EADDRINUSE') {
                    console.warn(`  \u{1F309} Agent Bridge disabled: port ${BRIDGE_PORT} is already in use`);
                    try {
                        wss?.close();
                    } catch {
                        // best effort shutdown
                    }
                    wss = null;
                    return;
                }
                console.warn('  \u{1F309} Agent Bridge server error:', err.message);
            });
        },

        closeBundle() {
            if (wss) {
                wss.close();
                wss = null;
            }
        },
    };
}
