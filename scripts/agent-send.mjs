#!/usr/bin/env node
/**
 * Dream DAW — Agent Bridge CLI
 *
 * Send messages to the Dream AI agent from the terminal.
 *
 * Usage:
 *   node scripts/agent-send.mjs "mute track 3"
 *   node scripts/agent-send.mjs "set bpm to 140"
 *   node scripts/agent-send.mjs "get project overview"
 *
 * The message will appear in the chat UI and the agent will execute it.
 * Response events are printed to stdout in real-time.
 */

import { createConnection } from 'net';
import { createHash } from 'crypto';

const BRIDGE_HOST = '127.0.0.1';
const BRIDGE_PORT = 5180;
const message = process.argv.slice(2).join(' ');

if (!message) {
    console.error('Usage: node scripts/agent-send.mjs "<message>"');
    process.exit(1);
}

// ── WebSocket handshake over raw TCP ────────────────────────────────────────

const wsKey = createHash('sha1').update(Date.now().toString()).digest('base64');

const socket = createConnection(BRIDGE_PORT, BRIDGE_HOST, () => {
    const request = [
        `GET / HTTP/1.1`,
        `Host: ${BRIDGE_HOST}:${BRIDGE_PORT}`,
        `Upgrade: websocket`,
        `Connection: Upgrade`,
        `Sec-WebSocket-Key: ${wsKey}`,
        `Sec-WebSocket-Version: 13`,
        '',
        '',
    ].join('\r\n');

    socket.write(request);
});

let handshakeDone = false;
let buffer = Buffer.alloc(0);

socket.on('data', (chunk) => {
    buffer = Buffer.concat([buffer, chunk]);

    if (!handshakeDone) {
        const headerEnd = buffer.indexOf('\r\n\r\n');
        if (headerEnd === -1) return;

        // Handshake complete — send the message
        handshakeDone = true;
        buffer = buffer.subarray(headerEnd + 4);

        const payload = JSON.stringify({ type: 'send', message });
        sendWsFrame(payload);

        console.log(`\x1b[36m→ Sent:\x1b[0m ${message}\n`);

        // Process any remaining data
        processFrames();
        return;
    }

    processFrames();
});

socket.on('error', (err) => {
    if (err.message.includes('ECONNREFUSED')) {
        console.error('❌ Agent Bridge not running. Start the DAW dev server first.');
    } else {
        console.error('❌ Connection error:', err.message);
    }
    process.exit(1);
});

socket.on('close', () => {
    process.exit(0);
});

// ── WebSocket frame helpers ─────────────────────────────────────────────────

function sendWsFrame(data) {
    const payload = Buffer.from(data, 'utf-8');
    const mask = Buffer.alloc(4);
    for (let i = 0; i < 4; i++) mask[i] = Math.floor(Math.random() * 256);

    let header;
    if (payload.length < 126) {
        header = Buffer.alloc(2);
        header[0] = 0x81;
        header[1] = 0x80 | payload.length;
    } else if (payload.length < 65536) {
        header = Buffer.alloc(4);
        header[0] = 0x81;
        header[1] = 0x80 | 126;
        header.writeUInt16BE(payload.length, 2);
    } else {
        header = Buffer.alloc(10);
        header[0] = 0x81;
        header[1] = 0x80 | 127;
        header.writeBigUInt64BE(BigInt(payload.length), 2);
    }

    const masked = Buffer.alloc(payload.length);
    for (let i = 0; i < payload.length; i++) {
        masked[i] = payload[i] ^ mask[i % 4];
    }

    socket.write(Buffer.concat([header, mask, masked]));
}

function processFrames() {
    while (buffer.length >= 2) {
        const secondByte = buffer[1];
        let payloadLength = secondByte & 0x7F;
        let offset = 2;

        if (payloadLength === 126) {
            if (buffer.length < 4) return;
            payloadLength = buffer.readUInt16BE(2);
            offset = 4;
        } else if (payloadLength === 127) {
            if (buffer.length < 10) return;
            payloadLength = Number(buffer.readBigUInt64BE(2));
            offset = 10;
        }

        if (buffer.length < offset + payloadLength) return;

        const payload = buffer.subarray(offset, offset + payloadLength).toString('utf-8');
        buffer = buffer.subarray(offset + payloadLength);

        try {
            const event = JSON.parse(payload);
            formatEvent(event);

            // Exit after done or error
            if (event.type === 'done' || event.type === 'error') {
                setTimeout(() => process.exit(0), 100);
            }
        } catch {
            // Non-JSON frame, ignore
        }
    }
}

function formatEvent(event) {
    switch (event.type) {
        case 'thinking':
            process.stdout.write(`\x1b[33m💭\x1b[0m ${event.text}`);
            break;
        case 'tool-start':
            console.log(`\x1b[34m⚡ ${event.toolName}\x1b[0m(${JSON.stringify(event.args)})`);
            break;
        case 'tool-end':
            console.log(`\x1b[32m  ✓\x1b[0m ${event.result?.slice?.(0, 100) ?? ''}`);
            break;
        case 'delta':
            process.stdout.write(event.text);
            break;
        case 'done':
            console.log(`\n\x1b[32m✅ Done\x1b[0m`);
            break;
        case 'error':
            console.log(`\n\x1b[31m❌ ${event.message}\x1b[0m`);
            break;
        default:
            console.log(JSON.stringify(event));
    }
}
