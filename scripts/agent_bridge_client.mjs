#!/usr/bin/env node
/**
 * Dream DAW — Agent Bridge Client
 * 
 * Sends a message to the AI agent via the Agent Bridge WebSocket (port 5180)
 * and logs all responses.
 * 
 * Protocol: Raw JSON, NOT Vite HMR format
 *   Send:    { "type": "send", "message": "..." }
 *   Receive: { "type": "thinking"|"delta"|"tool_start"|"done"|"error", ... }
 * 
 * Usage:
 *   node scripts/agent_bridge_client.mjs "Create a house track at 126 BPM"
 *   node scripts/agent_bridge_client.mjs   (uses default house track prompt)
 */

import { WebSocket } from 'ws';

const BRIDGE_PORT = 5180;
const WS_URL = `ws://localhost:${BRIDGE_PORT}`;
const TIMEOUT_MS = 120_000; // 2 minutes max

const DEFAULT_PROMPT = `Create a full house track at 126 BPM in Am.
Step 1: Set BPM to 126 and key signature to Am.
Step 2: Create a MIDI drum track called "Drums". Search for kick, clap, and hi-hat samples. Load kick to pad 0, clap to pad 1, hi-hat to pad 6.
Step 3: Use generate_beat_pattern with genre "house" for 16 bars. Create a MIDI clip and write the notes.
Step 4: Create a MIDI track called "Bass". Write an Am bassline (A2, C3, D3, E3) over 16 bars.
Step 5: Set drum volume to 85%, bass to 75%. Set loop region to 16 bars.
Step 6: Press play.`;

const message = process.argv[2] || DEFAULT_PROMPT;

console.log('═══════════════════════════════════════════════════════════');
console.log('  Dream DAW — Agent Bridge Client');
console.log('═══════════════════════════════════════════════════════════');
console.log(`📡 Connecting to ${WS_URL}...`);

const ws = new WebSocket(WS_URL);
let done = false;
let toolCount = 0;

const timeout = setTimeout(() => {
    console.log('\n⏰ Timeout reached (2 minutes). Closing.');
    ws.close();
    process.exit(1);
}, TIMEOUT_MS);

ws.on('open', () => {
    console.log('✅ Connected to Agent Bridge');
    console.log(`📨 Sending message to agent:\n   "${message.substring(0, 120)}..."\n`);
    console.log('───────────────────────────────────────────────────────────');

    // Agent Bridge raw JSON protocol (NOT Vite HMR format)
    ws.send(JSON.stringify({
        type: 'send',
        message: message,
    }));
});

ws.on('message', (raw) => {
    try {
        const data = JSON.parse(raw.toString());

        switch (data.type) {
            case 'thinking':
                process.stdout.write(`💭 ${data.text}`);
                break;

            case 'delta':
                process.stdout.write(data.text);
                break;

            case 'tool_start':
            case 'tool-start':
                toolCount++;
                console.log(`\n🔧 [Tool #${toolCount}] ${data.name}(${JSON.stringify(data.args || data.arguments || {}).substring(0, 200)})`);
                break;

            case 'tool_result':
            case 'tool-end':
                const resultStr = typeof data.result === 'string' ? data.result : JSON.stringify(data.result || data);
                console.log(`   ✅ → ${resultStr.substring(0, 300)}`);
                break;

            case 'error':
                console.log(`\n❌ Error: ${data.message}`);
                break;

            case 'done':
                done = true;
                console.log('\n\n───────────────────────────────────────────────────────────');
                console.log(`🏁 Agent finished. Tools called: ${toolCount}`);
                if (data.finalText) {
                    console.log(`\n📝 Final response:\n${data.finalText}`);
                }
                console.log('═══════════════════════════════════════════════════════════');
                clearTimeout(timeout);
                setTimeout(() => { ws.close(); process.exit(0); }, 1000);
                break;

            default:
                console.log(`📦 [${data.type || 'unknown'}]`, JSON.stringify(data).substring(0, 200));
        }
    } catch {
        // Ignore non-JSON messages
    }
});

ws.on('error', (err) => {
    console.error(`❌ WebSocket error: ${err.message}`);
    console.log('\n💡 Make sure the app is running: cargo tauri dev');
    process.exit(1);
});

ws.on('close', () => {
    if (!done) {
        console.log('\n🔌 Connection closed.');
    }
    clearTimeout(timeout);
});
