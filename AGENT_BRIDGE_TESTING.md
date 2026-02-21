# Dream DAW — Agent Bridge Testing Guide

## Architecture

```
External Script ──WebSocket──► Vite HMR (port 5180) ──► useAgentBridge ──► sendMessage() ──► streamChat() ──► OpenRouter API
                                                                                                    │
                                                                                          Tool execution loop
                                                                                                    │
                                                                                          Tauri IPC ──► Rust Engine
```

The AI Agent in Dream DAW has a **bridge** that allows external tools to send messages
and receive responses via the Vite HMR WebSocket (port 5180).

## Quick Start

```bash
# 1. Make sure the app is running
cargo tauri dev

# 2. Run the bridge client
node scripts/agent_bridge_client.mjs "Create a house track at 126 BPM"
```

## Protocol

### Sending a message to the agent
Connect to `ws://localhost:5180` and send:
```json
{
  "type": "custom",
  "event": "agent-bridge:message",
  "data": {
    "type": "send",
    "message": "Create a house track at 126 BPM"
  }
}
```

### Receiving agent responses
The agent sends back events via `agent-bridge:response`:
```json
{ "type": "thinking", "text": "Let me analyze..." }
{ "type": "tool_start", "name": "set_bpm", "args": { "bpm": 126 } }
{ "type": "tool_result", "name": "set_bpm", "result": "..." }
{ "type": "delta", "text": "I've created..." }
{ "type": "done" }
{ "type": "error", "message": "..." }
```

## Bridge Client Script

See `scripts/agent_bridge_client.mjs` — a ready-to-use Node.js script that:
1. Connects to the Vite HMR WebSocket
2. Sends a message to the AI agent
3. Logs all tool calls, thinking, and final response
4. Exits when the agent finishes

## Example Prompts

### House Track
```bash
node scripts/agent_bridge_client.mjs "Create a full house track at 126 BPM in Am. \
Use drum rack: kick on pad 0, clap on pad 1, hi-hat on pad 6. \
Generate house beat pattern for 16 bars. \
Create a bass track with Am bassline. Set volumes."
```

### Techno Track
```bash
node scripts/agent_bridge_client.mjs "Create a dark techno track at 135 BPM in Dm. \
Hard 4/4 kick, industrial clap, fast 16th hi-hats. \
Dark bass in D minor. Add reverb to clap."
```

### Lo-fi Beat
```bash
node scripts/agent_bridge_client.mjs "Create a lo-fi hip hop beat at 85 BPM in C major. \
Lazy kick and snare, soft hi-hats with swing. \
Jazzy chord progression: Cmaj7-Am7-Dm7-G7."
```

## Debugging

- The agent logs all tool calls to the browser console (visible in Safari Web Inspector or Tauri devtools)
- If the agent is already streaming, the bridge returns an error: `"Agent is currently processing a request. Please wait."`
- Check `useSettingsStore` for `openRouterApiKey` — the API key must be set in Settings
