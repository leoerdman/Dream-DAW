const WebSocket = require('ws');
const ws = new WebSocket('ws://localhost:5180');
const cmd = process.argv.slice(2).join(' ');

if (!cmd) {
    console.error('No command provided');
    process.exit(1);
}

ws.on('open', () => {
    console.log(`\n--- Sending Command: "${cmd}" ---`);
    ws.send(JSON.stringify({ type: 'send', message: cmd }));
});

ws.on('message', (data) => {
    const text = data.toString('utf-8');
    try {
        const msg = JSON.parse(text);
        if (msg.type === 'delta') {
            process.stdout.write(msg.delta || msg.text || '');
        } else if (msg.type === 'error') {
            console.error('\n[Error]:', msg.message);
            process.exit(1);
        } else if (msg.type === 'done') {
            console.log('\n[Done]: Command completed.');
            process.exit(0);
        } else if (msg.type === 'tool-start') {
            console.log(`\n[Tool Executing...] ${msg.toolName}`);
        } else if (msg.type === 'thinking') {
            // silent or indicator
        }
    } catch (e) {
        console.log('Raw:', text);
    }
});

ws.on('error', (err) => {
    console.error('WS Error:', err);
    process.exit(1);
});
