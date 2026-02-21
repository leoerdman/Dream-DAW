/* eslint-disable @typescript-eslint/no-explicit-any */
/**
 * Dream DAW - Agent Bridge (Vite Plugin)
 *
 * Creates a WebSocket server on port 5180 during development.
 * Allows external tools (e.g., Antigravity AI) to send messages to the
 * Dream AI agent and receive responses -- all appearing in the chat UI.
 *
 * Protocol (JSON over WebSocket):
 *
 *   TO FRONTEND (from external):
 *     { "type": "send", "message": "mute track 3" }
 *
 *   FROM FRONTEND (to external):
 *     { "type": "thinking", "text": "..." }
 *     { "type": "tool-start", "toolName": "...", "args": {...} }
 *     { "type": "tool-end", "toolName": "...", "result": "..." }
 *     { "type": "delta", "text": "..." }
 *     { "type": "done", "finalText": "..." }
 *     { "type": "error", "message": "..." }
 */

import type { Plugin } from 'vite';
import { createServer } from 'http';

const BRIDGE_PORT = 5180;

export function agentBridgePlugin(): Plugin {
    let httpServer: ReturnType<typeof createServer> | null = null;
    const clients = new Set<import('stream').Duplex>();

    return {
        name: 'dream-daw-agent-bridge',
        enforce: 'post',

        configureServer(server) {
            // Use a raw HTTP server + manual WebSocket upgrade (no external deps)
            httpServer = createServer((_req, res) => {
                res.writeHead(200, { 'Content-Type': 'text/plain' });
                res.end('Dream DAW Agent Bridge');
            });

            httpServer.on('upgrade', (request, socket, _head) => {
                // Manual WebSocket handshake (RFC 6455)
                const crypto = require('crypto') as typeof import('crypto');
                const key = request.headers['sec-websocket-key'];
                if (!key) { socket.destroy(); return; }

                const acceptKey = crypto
                    .createHash('sha1')
                    .update(key + '258EAFA5-E914-47DA-95CA-5AB5DC11D04E')
                    .digest('base64');

                const responseHeaders = [
                    'HTTP/1.1 101 Switching Protocols',
                    'Upgrade: websocket',
                    'Connection: Upgrade',
                    `Sec-WebSocket-Accept: ${acceptKey}`,
                    '',
                    '',
                ].join('\r\n');

                socket.write(responseHeaders);
                clients.add(socket);

                console.log('  \u{1F309} Agent Bridge: client connected');

                socket.on('data', (buf: Buffer) => {
                    // Decode WebSocket frame
                    const decoded = decodeFrame(buf);
                    if (!decoded) return;

                    try {
                        const data = JSON.parse(decoded);
                        // Relay to frontend via Vite HMR
                        server.ws.send('agent-bridge:message', data);
                    } catch {
                        // Ignore non-JSON messages
                    }
                });

                socket.on('close', () => {
                    clients.delete(socket);
                    console.log('  \u{1F309} Agent Bridge: client disconnected');
                });

                socket.on('error', () => {
                    clients.delete(socket);
                });
            });

            httpServer.listen(BRIDGE_PORT, () => {
                console.log(`  \u{1F309} Agent Bridge WebSocket on ws://localhost:${BRIDGE_PORT}`);
            });

            // Listen for frontend responses and relay to external clients
            server.ws.on('agent-bridge:response', (data: any) => {
                const frame = encodeFrame(JSON.stringify(data));
                for (const client of clients) {
                    try { client.write(frame); } catch { /* dead socket */ }
                }
            });
        },

        closeBundle() {
            if (httpServer) {
                httpServer.close();
                httpServer = null;
            }
        },
    };
}

// ── Minimal WebSocket frame decoder (text frames only) ──────────────────────

function decodeFrame(buf: Buffer): string | null {
    if (buf.length < 2) return null;

    const secondByte = buf[1];
    const isMasked = (secondByte & 0x80) !== 0;
    let payloadLength = secondByte & 0x7F;
    let offset = 2;

    if (payloadLength === 126) {
        payloadLength = buf.readUInt16BE(2);
        offset = 4;
    } else if (payloadLength === 127) {
        // 64-bit length — not needed for chat messages
        return null;
    }

    let mask: Buffer | null = null;
    if (isMasked) {
        mask = buf.subarray(offset, offset + 4);
        offset += 4;
    }

    const payload = buf.subarray(offset, offset + payloadLength);
    if (mask) {
        for (let i = 0; i < payload.length; i++) {
            payload[i] ^= mask[i % 4];
        }
    }

    return payload.toString('utf-8');
}

// ── Minimal WebSocket frame encoder (text frames, no mask) ──────────────────

function encodeFrame(data: string): Buffer {
    const payload = Buffer.from(data, 'utf-8');
    const len = payload.length;

    let header: Buffer;
    if (len < 126) {
        header = Buffer.alloc(2);
        header[0] = 0x81; // FIN + text opcode
        header[1] = len;
    } else if (len < 65536) {
        header = Buffer.alloc(4);
        header[0] = 0x81;
        header[1] = 126;
        header.writeUInt16BE(len, 2);
    } else {
        header = Buffer.alloc(10);
        header[0] = 0x81;
        header[1] = 127;
        header.writeBigUInt64BE(BigInt(len), 2);
    }

    return Buffer.concat([header, payload]);
}
