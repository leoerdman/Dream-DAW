import { useEffect, useState, useCallback, useRef } from 'react';
import { useFlowSynthStore } from '../model/useFlowSynthStore';
import { FlowCanvas } from './FlowCanvas';
import { useEngineStore } from '@/shared/stores/useEngineStore';
import { PluginWindow } from '@/widgets/PluginWindow/PluginWindow';
import { FACTORY_PRESETS } from '../model/flowPresets';

// ── Floating Preset Bar (sits above the canvas, top-right) ────────────
function FloatingPresetBar() {
    const presetName = useFlowSynthStore((s) => s.presetName);
    const presetIndex = useFlowSynthStore((s) => s.presetIndex);
    const nextPreset = useFlowSynthStore((s) => s.nextPreset);
    const prevPreset = useFlowSynthStore((s) => s.prevPreset);
    const loadPreset = useFlowSynthStore((s) => s.loadPreset);
    const nodes = useFlowSynthStore((s) => s.nodes);
    const connections = useFlowSynthStore((s) => s.connections);
    const [dropdownOpen, setDropdownOpen] = useState(false);
    const dropdownRef = useRef<HTMLDivElement>(null);

    // Outside-click handler to close dropdown
    useEffect(() => {
        if (!dropdownOpen) return;
        const handler = (e: MouseEvent) => {
            if (dropdownRef.current && !dropdownRef.current.contains(e.target as Node)) {
                setDropdownOpen(false);
            }
        };
        document.addEventListener('mousedown', handler, true);
        return () => document.removeEventListener('mousedown', handler, true);
    }, [dropdownOpen]);

    const handleSavePreset = useCallback(async () => {
        try {
            const name = window.prompt('Preset name:', presetName || 'My Preset');
            if (!name) return;
            const { invoke } = await import('@tauri-apps/api/core');
            const presetJson = JSON.stringify({
                name,
                nodes: nodes.map(n => ({ id: n.id, type: n.type, position: n.position, data: n.data })),
                connections: connections.map(c => ({ id: c.id, fromNode: c.fromNode, fromPort: c.fromPort, toNode: c.toNode, toPort: c.toPort, signalType: c.signalType })),
            }, null, 2);
            await invoke('save_flow_user_preset', { name, presetJson });
        } catch (err) {
            console.error('[FlowSynth] savePreset failed:', err);
        }
    }, [presetName, nodes, connections]);

    const handleLoadPreset = useCallback(async () => {
        try {
            const { invoke } = await import('@tauri-apps/api/core');
            const names = await invoke<string[]>('list_flow_user_presets');
            if (!names || names.length === 0) {
                window.alert('No user presets saved yet.');
                return;
            }
            const selected = window.prompt(
                `Available presets:\n${names.map((n, i) => `${i + 1}. ${n}`).join('\n')}\n\nEnter preset name:`
            );
            if (!selected) return;
            const text = await invoke<string>('load_flow_user_preset', { name: selected });
            const preset = JSON.parse(text);
            if (Array.isArray(preset.nodes) && Array.isArray(preset.connections)) {
                // BUG-8 FIX: Use setState directly since setNodes/setConnections don't exist in store
                useFlowSynthStore.setState({
                    nodes: preset.nodes,
                    connections: preset.connections,
                    presetName: preset.name || selected,
                });
                // Sync restored graph to engine
                void useFlowSynthStore.getState().syncFlowGraphToEngine().catch(console.error);
            }
        } catch (err) {
            console.error('[FlowSynth] loadPreset failed:', err);
        }
    }, []);

    return (
        <div
            ref={dropdownRef}
            style={{
                position: 'absolute',
                top: 8,
                right: 12,
                zIndex: 15,
                display: 'flex',
                alignItems: 'center',
                gap: 6,
                padding: '4px 10px',
                borderRadius: 8,
                background: 'color-mix(in srgb, var(--color-bg-panel) 90%, transparent)',
                backdropFilter: 'blur(var(--blur-md))',
                WebkitBackdropFilter: 'blur(var(--blur-md))',
                border: '1px solid color-mix(in srgb, var(--color-divider) 70%, transparent)',
                boxShadow: '0 2px 8px rgba(0,0,0,0.15)',
                fontFamily: 'var(--font-role-data)',
            }}
            onPointerDown={(e) => e.stopPropagation()}
        >
            <button onClick={prevPreset} style={presetNavBtn} title="Previous">◀</button>
            <span
                onClick={() => setDropdownOpen(!dropdownOpen)}
                style={{
                    fontSize: 'var(--font-size-sm)',
                    color: 'var(--color-text-secondary)',
                    fontWeight: 'var(--font-weight-medium)' as unknown as number,
                    minWidth: 60,
                    textAlign: 'center',
                    userSelect: 'none',
                    cursor: 'pointer',
                    position: 'relative',
                }}
            >
                {presetName || 'Init'}
            </span>
            <button onClick={nextPreset} style={presetNavBtn} title="Next">▶</button>
            <div style={{ width: 1, height: 14, background: 'var(--color-divider)', opacity: 0.5 }} />
            <button onClick={handleSavePreset} style={presetNavBtn} title="Save Preset">💾</button>
            <button onClick={handleLoadPreset} style={presetNavBtn} title="Open Preset">📂</button>

            {/* Preset dropdown */}
            {dropdownOpen && (
                <div
                    style={{
                        position: 'absolute',
                        top: '100%',
                        right: 0,
                        marginTop: 4,
                        minWidth: 180,
                        maxHeight: 300,
                        overflowY: 'auto',
                        background: 'var(--color-bg-panel)',
                        border: '1px solid var(--color-divider)',
                        borderRadius: 6,
                        boxShadow: '0 4px 12px rgba(0,0,0,0.25)',
                        zIndex: 20,
                        padding: '4px 0',
                    }}
                >
                    {FACTORY_PRESETS.map((p, i) => (
                        <div
                            key={p.name}
                            onClick={() => { loadPreset(i); setDropdownOpen(false); }}
                            style={{
                                padding: '6px 12px',
                                fontSize: 'var(--font-size-sm)',
                                color: i === presetIndex ? 'var(--color-accent-primary)' : 'var(--color-text-secondary)',
                                fontWeight: i === presetIndex ? 600 : 400,
                                cursor: 'pointer',
                                background: 'transparent',
                                transition: 'background 0.1s',
                            }}
                            onMouseEnter={e => { (e.currentTarget as HTMLElement).style.background = 'var(--color-bg-hover)'; }}
                            onMouseLeave={e => { (e.currentTarget as HTMLElement).style.background = 'transparent'; }}
                        >
                            {p.name}
                        </div>
                    ))}
                </div>
            )}
        </div>
    );
}

const presetNavBtn: React.CSSProperties = {
    width: 18,
    height: 18,
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    background: 'transparent',
    color: 'var(--color-text-tertiary)',
    border: 'none',
    fontSize: 'var(--font-size-2xs)',
    cursor: 'pointer',
    borderRadius: 4,
    transition: 'color var(--transition-fast)',
};

export function FlowSynthOverlay() {
    const isOpen = useFlowSynthStore((state) => state.isOpen);
    const closeFlowEditor = useFlowSynthStore((state) => state.closeFlowEditor);
    const activeDeviceId = useFlowSynthStore((state) => state.activeDeviceId);
    const activeTrackId = useFlowSynthStore((state) => state.activeTrackId);

    // Close on Escape key
    useEffect(() => {
        if (!isOpen) return;
        const handleKeyDown = (e: KeyboardEvent) => {
            if (e.key === 'Escape') {
                closeFlowEditor();
            }
        };
        document.addEventListener('keydown', handleKeyDown, true);
        return () => document.removeEventListener('keydown', handleKeyDown, true);
    }, [isOpen, closeFlowEditor]);

    useEffect(() => {
        if (!isOpen) return;

        let intervalId: number | null = null;
        let lastFreeRunBucket = -1;
        const activeNotes = new Set<string>();

        const tick = () => {
            const flow = useFlowSynthStore.getState();
            const engine = useEngineStore.getState();
            if (!flow.activeTrackId || !engine.transport.is_playing) {
                activeNotes.clear();
                return;
            }

            const trackIndex = engine.tracks.allIds.indexOf(flow.activeTrackId);
            if (trackIndex < 0) {
                activeNotes.clear();
                return;
            }

            const playheadBeat = engine.transport.position_beats;
            const midiClips = engine.timelineClips.filter((clip) =>
                clip.type === 'midi'
                && clip.trackIndex === trackIndex
                && playheadBeat >= clip.startBeat
                && playheadBeat < (clip.startBeat + clip.durationBeats),
            );

            let hasMidiAtPlayhead = false;
            const nextNotes = new Set<string>();

            for (const clip of midiClips) {
                const localBeat = playheadBeat - clip.startBeat;
                for (const note of clip.midiNotes ?? []) {
                    if (localBeat < note.startBeat || localBeat >= (note.startBeat + note.durationBeats)) continue;
                    hasMidiAtPlayhead = true;
                    const noteKey = `${clip.id}:${note.id ?? `${note.pitch}:${note.startBeat}`}`;
                    nextNotes.add(noteKey);
                    if (!activeNotes.has(noteKey)) {
                        const midiNode = flow.nodes.find((node) => node.type === 'midiIn');
                        if (midiNode) flow.pulseFromNode(midiNode.id, 'midi');
                        const oscNode = flow.nodes.find((node) => node.type === 'oscillator');
                        if (oscNode) flow.pulseFromNode(oscNode.id, 'audio');
                    }
                }
            }

            activeNotes.clear();
            for (const noteKey of nextNotes) activeNotes.add(noteKey);

            // Free-run pulse path when there is no MIDI note at playhead.
            if (!hasMidiAtPlayhead) {
                const beatBucket = Math.floor(playheadBeat * 2);
                if (beatBucket !== lastFreeRunBucket) {
                    const oscNode = flow.nodes.find((node) => node.type === 'oscillator');
                    if (oscNode) flow.pulseFromNode(oscNode.id, 'audio');
                    lastFreeRunBucket = beatBucket;
                }
            }
        };

        intervalId = window.setInterval(tick, 40);
        return () => {
            if (intervalId !== null) window.clearInterval(intervalId);
        };
    }, [isOpen]);

    useEffect(() => {
        if (!isOpen || !activeTrackId) return;
        const timer = window.setTimeout(() => {
            void useFlowSynthStore.getState().syncFlowGraphToEngine().catch((err) => {
                console.warn('[FlowSynth] syncFlowGraphToEngine failed:', err);
            });
        }, 60);
        return () => window.clearTimeout(timer);
        // BUG-3 FIX: Only sync on editor open / track change. Do NOT include
        // `nodes` or `connections` — the undo/redo subscription also schedules
        // sync, creating an infinite loop if both fire.
    }, [isOpen, activeTrackId]);

    if (!isOpen) return null;

    return (
        <PluginWindow
            pluginId={activeDeviceId ?? 'flow'}
            pluginName=""
            pluginType="effect"
            isBypassed={false}
            onToggleBypass={() => { }}
            onClose={closeFlowEditor}
            width={1120}
            height={700}
            initialX={140}
            initialY={84}
            showPresetControls={false}
            showBypassControl={false}
            headerBackground="linear-gradient(135deg, color-mix(in srgb, var(--color-bg-elevated) 95%, var(--color-accent-primary) 5%), var(--color-bg-elevated))"
            headerBorderColor="color-mix(in srgb, var(--color-divider) 82%, transparent)"
            contentPadding="0"
        >
            <div style={{ width: '100%', height: '100%', position: 'relative', overflow: 'hidden', boxShadow: 'none' }}>
                <FlowCanvas />
                <FloatingPresetBar />
            </div>
        </PluginWindow>
    );
}
