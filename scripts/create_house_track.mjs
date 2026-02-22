#!/usr/bin/env node
/**
 * Dream DAW — Create House Track via Tauri IPC
 * 
 * This script connects to the running Dream DAW Tauri app's WebSocket
 * inspector and executes JavaScript to create a full house track
 * using the engine API directly.
 * 
 * Usage: node scripts/create_house_track.mjs
 */

import WebSocket from 'ws';
import http from 'http';

// ─── Step 1: Get WebSocket debugger URL from WebKit inspector ──────────
async function getDebuggerUrl() {
    // Try WebKit inspector protocol  
    const endpoints = [
        'http://localhost:9222/json/list',
        'http://localhost:9222/json',
        'http://localhost:9222/json/version',
    ];

    for (const url of endpoints) {
        try {
            const data = await new Promise((resolve, reject) => {
                http.get(url, (res) => {
                    let body = '';
                    res.on('data', (chunk) => body += chunk);
                    res.on('end', () => {
                        try { resolve(JSON.parse(body)); }
                        catch { reject(new Error('Not JSON')); }
                    });
                }).on('error', reject);
            });
            if (Array.isArray(data) && data[0]?.webSocketDebuggerUrl) {
                return data[0].webSocketDebuggerUrl;
            }
            if (data?.webSocketDebuggerUrl) {
                return data.webSocketDebuggerUrl;
            }
        } catch { /* continue */ }
    }

    // Fallback: direct WebSocket to port 9222  
    return 'ws://localhost:9222';
}

// ─── Step 2: Execute JS in the webview context ──────────────────────────
async function executeInWebview(ws, expression) {
    return new Promise((resolve, reject) => {
        const id = Math.floor(Math.random() * 10000);
        const timeout = setTimeout(() => reject(new Error('Timeout')), 15000);

        const handler = (raw) => {
            try {
                const msg = JSON.parse(raw.toString());
                if (msg.id === id) {
                    clearTimeout(timeout);
                    ws.off('message', handler);
                    if (msg.error) reject(new Error(JSON.stringify(msg.error)));
                    else resolve(msg.result?.result?.value ?? msg.result);
                }
            } catch { /* ignore non-JSON */ }
        };

        ws.on('message', handler);
        ws.send(JSON.stringify({
            id,
            method: 'Runtime.evaluate',
            params: {
                expression,
                returnByValue: true,
                awaitPromise: true,
            }
        }));
    });
}

// ─── Step 3: Main — Create House Track ──────────────────────────────────
async function main() {
    console.log('🏠 Dream DAW — Creating House Track...');
    console.log('──────────────────────────────────────────');

    const wsUrl = await getDebuggerUrl();
    console.log(`📡 Connecting to: ${wsUrl}`);

    const ws = new WebSocket(wsUrl);

    await new Promise((resolve, reject) => {
        ws.on('open', resolve);
        ws.on('error', reject);
        setTimeout(() => reject(new Error('Connection timeout')), 5000);
    });

    console.log('✅ Connected to Tauri webview');

    // Enable Runtime domain
    ws.send(JSON.stringify({ id: 0, method: 'Runtime.enable' }));
    await new Promise(r => setTimeout(r, 500));

    // ── The house track creation script (runs in the webview context) ──
    const houseTrackScript = `
    (async () => {
        // Import the engine API from the running app
        const { __TAURI__ } = window;
        if (!__TAURI__) return { error: 'Tauri API not available' };
        
        const invoke = __TAURI__.core?.invoke || __TAURI__.invoke || 
            window.__TAURI_INTERNALS__?.invoke;
        if (!invoke) return { error: 'invoke not found' };

        const log = [];
        const safeInvoke = async (cmd, args) => {
            try {
                const result = await invoke(cmd, args || {});
                log.push({ ok: cmd, args: Object.keys(args || {}) });
                return result;
            } catch (e) {
                log.push({ err: cmd, msg: String(e) });
                return null;
            }
        };

        // ── 1. Set BPM to 126 ──
        await safeInvoke('set_bpm', { bpm: 126 });
        log.push('🎵 BPM → 126');

        // ── 2. Set key signature: Am ──
        await safeInvoke('set_key_signature_cmd', { enabled: true, tonic: 'A', mode: 'minor' });
        log.push('🎼 Key → Am');

        // ── 3. Create Drum Track ──
        const drumTrack = await safeInvoke('add_track_advanced', { 
            name: 'Drums', trackType: 'midi', color: '#FF6B35' 
        });
        log.push('🥁 Drum track created');

        // ── 4. Search for kick sample ──
        const allSamples = await safeInvoke('scan_all_audio_sources', {});
        let kickPath = null, clapPath = null, hatPath = null;
        
        if (allSamples && Array.isArray(allSamples)) {
            for (const s of allSamples) {
                const name = s.name?.toLowerCase() || '';
                if (!kickPath && (name.includes('kick') || name.includes('bd'))) kickPath = s.path;
                if (!clapPath && (name.includes('clap') || name.includes('cp') || name.includes('snare'))) clapPath = s.path;
                if (!hatPath && (name.includes('hat') || name.includes('hh') || name.includes('hihat'))) hatPath = s.path;
            }
        }
        log.push('🔍 Samples found: kick=' + !!kickPath + ' clap=' + !!clapPath + ' hat=' + !!hatPath);

        // ── 5. Load samples into drum rack pads ──
        // Read current project state directly from engine state.
        const state1 = await safeInvoke('get_state', {});
        const project = state1?.project ?? null;
        const tracks = project?.tracks || [];
        const drumTrackData = tracks.find(t => t.name === 'Drums');
        const drumTrackId = drumTrackData?.id;
        
        if (drumTrackId) {
            if (kickPath) await safeInvoke('set_sample_rack_pad_sample_cmd', { trackId: drumTrackId, padIndex: 0, samplePath: kickPath });
            if (clapPath) await safeInvoke('set_sample_rack_pad_sample_cmd', { trackId: drumTrackId, padIndex: 1, samplePath: clapPath });
            if (hatPath)  await safeInvoke('set_sample_rack_pad_sample_cmd', { trackId: drumTrackId, padIndex: 6, samplePath: hatPath });
            log.push('🎹 Samples loaded into pads');
        }

        // ── 6. Create MIDI clip for drums (16 bars = 64 beats) ──
        const drumTrackIdx = tracks.findIndex(t => t.name === 'Drums');
        const bpm = 126;
        const sr = 44100;
        const fpb = (60.0 / bpm) * sr;
        
        if (drumTrackIdx >= 0) {
            const clipResult = await safeInvoke('create_midi_clip_cmd', {
                trackIndex: drumTrackIdx,
                startFrame: 0,
                durationBeats: 64,
                clipName: 'House Beat',
            });
            log.push('📝 MIDI clip created: 16 bars');

            // ── 7. Write house drum pattern (4/4 kick, offbeat hats, clap on 2&4) ──
            const notes = [];
            for (let bar = 0; bar < 16; bar++) {
                const barStart = bar * 4;
                // 4/4 kick
                for (let beat = 0; beat < 4; beat++) {
                    notes.push({
                        start_frame: Math.round((barStart + beat) * fpb),
                        duration_frames: Math.round(0.25 * fpb),
                        pitch: 36,
                        velocity: 120,
                    });
                }
                // Clap on 2 and 4
                notes.push({ start_frame: Math.round((barStart + 1) * fpb), duration_frames: Math.round(0.25 * fpb), pitch: 37, velocity: 100 });
                notes.push({ start_frame: Math.round((barStart + 3) * fpb), duration_frames: Math.round(0.25 * fpb), pitch: 37, velocity: 100 });
                // Offbeat hats
                for (let i = 0; i < 4; i++) {
                    notes.push({
                        start_frame: Math.round((barStart + i + 0.5) * fpb),
                        duration_frames: Math.round(0.125 * fpb),
                        pitch: 42,
                        velocity: 80,
                    });
                }
            }
            
            const clipId = clipResult?.id || clipResult;
            if (clipId) {
                await safeInvoke('update_midi_clip_cmd', {
                    clipId: clipId,
                    notes: notes,
                });
                log.push('🎶 House beat pattern written: ' + notes.length + ' notes');
            }
        }

        // ── 8. Create Bass Track ──
        const bassTrack = await safeInvoke('add_track_advanced', {
            name: 'Bass', trackType: 'midi', color: '#4ECDC4'
        });
        log.push('🎸 Bass track created');

        // Re-fetch current state to get updated track list
        const state2 = await safeInvoke('get_state', {});
        const project2 = state2?.project ?? null;
        const tracks2 = project2?.tracks || [];
        const bassTrackIdx = tracks2.findIndex(t => t.name === 'Bass');
        
        if (bassTrackIdx >= 0) {
            // Create bass MIDI clip
            const bassClip = await safeInvoke('create_midi_clip_cmd', {
                trackIndex: bassTrackIdx,
                startFrame: 0,
                durationBeats: 64,
                clipName: 'House Bass',
            });
            log.push('📝 Bass clip created');

            // Am pentatonic bassline (A2=45, C3=48, D3=50, E3=52, G3=55)
            const bassNotes = [45, 45, 48, 45, 50, 48, 45, 52];
            const bassPattern = [];
            for (let bar = 0; bar < 16; bar++) {
                const barStart = bar * 4;
                for (let beat = 0; beat < 4; beat++) {
                    const noteIdx = (bar * 4 + beat) % bassNotes.length;
                    bassPattern.push({
                        start_frame: Math.round((barStart + beat) * fpb),
                        duration_frames: Math.round(0.75 * fpb),
                        pitch: bassNotes[noteIdx],
                        velocity: 100 + Math.floor(Math.random() * 15),
                    });
                }
            }

            const bassClipId = bassClip?.id || bassClip;
            if (bassClipId) {
                await safeInvoke('update_midi_clip_cmd', {
                    clipId: bassClipId,
                    notes: bassPattern,
                });
                log.push('🎶 Bass pattern written: ' + bassPattern.length + ' notes');
            }
        }

        // ── 9. Set volumes ──
        if (drumTrackIdx >= 0) await safeInvoke('set_track_volume', { trackIndex: drumTrackIdx, volume: 0.85 });
        if (bassTrackIdx >= 0) await safeInvoke('set_track_volume', { trackIndex: bassTrackIdx, volume: 0.75 });
        log.push('🔊 Volumes set');

        // ── 10. Set loop region (16 bars) ──
        const loopEndFrame = Math.round(64 * fpb);
        await safeInvoke('set_loop', { enabled: true, startFrames: 0, endFrames: loopEndFrame });
        log.push('🔁 Loop set: 16 bars');

        return { success: true, log };
    })()
    `;

    try {
        const result = await executeInWebview(ws, houseTrackScript);
        console.log('\n📊 Result:');
        console.log(JSON.stringify(result, null, 2));
    } catch (e) {
        console.error('❌ Error:', e.message);
    }

    ws.close();
    console.log('\n────────────────────────────────────────');
    console.log('🏁 Done!');
}

main().catch(console.error);
