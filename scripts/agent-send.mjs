#!/usr/bin/env node
/**
 * Dream DAW — Agent Bridge CLI
 *
 * Send messages to the Dream AI agent from the terminal.
 * Uses Node.js native WebSocket (v22+) — no npm dependencies needed.
 *
 * Usage:
 *   node scripts/agent-send.mjs "mute track 3"
 *   node scripts/agent-send.mjs "покажи обзор проекта"
 */

const BRIDGE_URL = 'ws://127.0.0.1:5180';
const message = process.argv.slice(2).join(' ');

if (!message) {
    console.error('Usage: node scripts/agent-send.mjs "<message>"');
    process.exit(1);
}

const ws = new WebSocket(BRIDGE_URL);

ws.addEventListener('open', () => {
    ws.send(JSON.stringify({ type: 'send', message }));
    console.log(`\x1b[36m→ Sent:\x1b[0m ${message}\n`);
});

ws.addEventListener('message', (event) => {
    try {
        const data = JSON.parse(event.data);
        formatEvent(data);

        if (data.type === 'done' || data.type === 'error') {
            setTimeout(() => { ws.close(); process.exit(0); }, 200);
        }
    } catch { /* ignore */ }
});

ws.addEventListener('error', (event) => {
    const msg = event.message || 'unknown error';
    if (msg.includes('ECONNREFUSED')) {
        console.error('❌ Agent Bridge not running. Start the DAW dev server first.');
    } else {
        console.error('❌ Connection error:', msg);
    }
    process.exit(1);
});

ws.addEventListener('close', () => { process.exit(0); });

// Auto-timeout after 60 seconds
setTimeout(() => {
    console.log('\n\x1b[33m⏰ Timeout (60s)\x1b[0m');
    ws.close();
    process.exit(0);
}, 60000);

function formatEvent(event) {
    switch (event.type) {
        case 'thinking':
            process.stdout.write(`\x1b[33m💭\x1b[0m ${event.text}`);
            break;
        case 'tool-start':
            console.log(`\n\x1b[34m⚡ ${event.toolName}\x1b[0m(${JSON.stringify(event.args)})`);
            break;
        case 'tool-end':
            console.log(`\x1b[32m  ✓\x1b[0m ${(event.result || '').slice(0, 200)}`);
            break;
        case 'delta':
            process.stdout.write(event.text);
            break;
        case 'done':
            console.log(`\n\n\x1b[32m✅ Done\x1b[0m`);
            break;
        case 'error':
            console.log(`\n\x1b[31m❌ ${event.message}\x1b[0m`);
            break;
        default:
            console.log(JSON.stringify(event));
    }
}
