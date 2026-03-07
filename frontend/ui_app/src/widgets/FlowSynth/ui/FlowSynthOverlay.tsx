import { useEffect, useState, useCallback, useRef } from 'react';
import { useFlowSynthStore } from '../model/useFlowSynthStore';
import { FlowCanvas } from './FlowCanvas';
import { useEngineStore } from '@/shared/stores/useEngineStore';
import { PluginWindow } from '@/widgets/PluginWindow/PluginWindow';
import { FACTORY_PRESETS } from '../model/flowPresets';
import { save, open } from '@tauri-apps/plugin-dialog';
import { invoke } from '@tauri-apps/api/core';
import { useStatusStore } from '@/shared/stores/useStatusStore';

// ── ENTERPRISE: Named constants ────────────────────────────────────────────
/** Floating preset bar positioning. */
const FLOATING_BAR_TOP = 8;
const FLOATING_BAR_RIGHT = 12;
const FLOATING_BAR_Z = 15;
const FLOATING_BAR_GAP = 6;
const FLOATING_BAR_PADDING = '4px 10px';
const FLOATING_BAR_RADIUS = 8;
const FLOATING_BAR_BG = 'color-mix(in srgb, var(--color-bg-panel) 90%, transparent)';
const FLOATING_BAR_SHADOW = '0 2px 8px rgba(0,0,0,0.15)';
const FLOATING_BAR_BORDER = '1px solid color-mix(in srgb, var(--color-divider) 70%, transparent)';
/** Preset dropdown dimensions. */
const DROPDOWN_MARGIN_TOP = 4;
const DROPDOWN_MIN_WIDTH = 180;
const DROPDOWN_MAX_HEIGHT = 300;
const DROPDOWN_RADIUS = 6;
const DROPDOWN_SHADOW = '0 4px 12px rgba(0,0,0,0.25)';
const DROPDOWN_Z = 20;
const DROPDOWN_ITEM_PADDING = '6px 12px';
/** Preset divider dimension. */
const DIVIDER_WIDTH = 1;
const DIVIDER_HEIGHT = 14;
/** Preset nav button size. */
const PRESET_BTN_SIZE = 18;
const PRESET_BTN_RADIUS = 4;

/** Engine sync delay after Flow editor open (ms). */
const ENGINE_SYNC_DELAY_MS = 60;
/** PluginWindow default dimensions for floating Flow. */
const FLOW_FLOAT_WIDTH = 1120;
const FLOW_FLOAT_HEIGHT = 700;
const FLOW_FLOAT_X = 140;
const FLOW_FLOAT_Y = 84;

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
            let defaultDir: string | undefined;
            try {
                defaultDir = await invoke<string>('get_flow_presets_dir_cmd');
            } catch { /* ignore */ }

            // Ensure the default path ends with a valid filename separator
            const defaultPath = defaultDir ? `${defaultDir}/${presetName || 'FlowPreset'}.json` : undefined;

            const filePath = await save({
                title: 'Save Flow Preset',
                defaultPath,
                filters: [{ name: 'Flow Preset', extensions: ['json'] }],
            });

            if (!filePath) return;

            // Extract name from selected path (without .json extension)
            const parts = filePath.replace(/\\/g, '/').split('/');
            const fileName = parts[parts.length - 1] || 'Untitled';
            const name = fileName.replace(/\.json$/i, '');

            const presetJson = JSON.stringify({
                name,
                nodes: nodes.map(n => ({ id: n.id, type: n.type, position: n.position, data: n.data })),
                connections: connections.map(c => ({ id: c.id, fromNode: c.fromNode, fromPort: c.fromPort, toNode: c.toNode, toPort: c.toPort, signalType: c.signalType })),
            }, null, 2);
            await invoke('save_flow_user_preset', { name, presetJson });

            // Immediately load it back to update the store's current preset name
            useFlowSynthStore.setState({ presetName: name });
        } catch (err) {
            console.error('[FlowSynth] savePreset failed:', err);
            // Optionally could add a toast here
        }
    }, [presetName, nodes, connections]);

    const handleLoadPreset = useCallback(async () => {
        try {
            let defaultDir: string | undefined;
            try {
                defaultDir = await invoke<string>('get_flow_presets_dir_cmd');
            } catch { /* ignore */ }

            const filePath = await open({
                title: 'Open Flow Preset',
                defaultPath: defaultDir || undefined,
                multiple: false,
                directory: false,
                filters: [{ name: 'Flow Preset', extensions: ['json'] }],
            });
            if (!filePath) return;

            // Extract name from selected path
            const pathStr = typeof filePath === 'string' ? filePath : filePath[0];
            const parts = pathStr.replace(/\\/g, '/').split('/');
            const fileName = parts[parts.length - 1] || '';
            const name = fileName.replace(/\.json$/i, '');
            if (!name) return;

            const text = await invoke<string>('load_flow_user_preset', { name });
            const preset = JSON.parse(text);
            if (Array.isArray(preset.nodes) && Array.isArray(preset.connections)) {
                const { nodeMotionProxy } = await import('../lib/NodeMotionProxy');
                nodeMotionProxy.clearPositions();
                useFlowSynthStore.getState().setNodes(preset.nodes);
                useFlowSynthStore.getState().setConnections(preset.connections);
                useFlowSynthStore.setState({ presetName: preset.name || name });

                // BUG-C FIX: Seed proxy with new node positions immediately
                // so connections render at correct positions after preset load.
                for (const n of preset.nodes) {
                    if (n.position) {
                        nodeMotionProxy.syncInitial(n.id, n.position.x, n.position.y);
                    }
                }

                // Invalidate graph cache for current device
                const { activeDeviceId, graphsByDeviceId } = useFlowSynthStore.getState();
                if (activeDeviceId) {
                    const updated = { ...graphsByDeviceId };
                    delete updated[activeDeviceId];
                    useFlowSynthStore.setState({ graphsByDeviceId: updated });
                }
                void useFlowSynthStore.getState().syncFlowGraphToEngine().catch((err) => {
                    console.error('[FlowSynth] syncFlowGraphToEngine failed:', err);
                    useStatusStore.getState().setError(`Flow Synth sync failed: ${err instanceof Error ? err.message : String(err)}`);
                });
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
                top: FLOATING_BAR_TOP,
                right: FLOATING_BAR_RIGHT,
                zIndex: FLOATING_BAR_Z,
                display: 'flex',
                alignItems: 'center',
                gap: FLOATING_BAR_GAP,
                padding: FLOATING_BAR_PADDING,
                borderRadius: FLOATING_BAR_RADIUS,
                background: FLOATING_BAR_BG,
                backdropFilter: 'blur(var(--blur-md))',
                WebkitBackdropFilter: 'blur(var(--blur-md))',
                border: FLOATING_BAR_BORDER,
                boxShadow: FLOATING_BAR_SHADOW,
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
            <div style={{ width: DIVIDER_WIDTH, height: DIVIDER_HEIGHT, background: 'var(--color-divider)', opacity: 0.5 }} />
            <button onClick={handleSavePreset} style={presetNavBtn} title="Save Preset">💾</button>
            <button onClick={handleLoadPreset} style={presetNavBtn} title="Open Preset">📂</button>

            {/* Preset dropdown */}
            {dropdownOpen && (
                <div
                    style={{
                        position: 'absolute',
                        top: '100%',
                        right: 0,
                        marginTop: DROPDOWN_MARGIN_TOP,
                        minWidth: DROPDOWN_MIN_WIDTH,
                        maxHeight: DROPDOWN_MAX_HEIGHT,
                        overflowY: 'auto',
                        background: 'var(--color-bg-panel)',
                        border: '1px solid var(--color-divider)',
                        borderRadius: DROPDOWN_RADIUS,
                        boxShadow: DROPDOWN_SHADOW,
                        zIndex: DROPDOWN_Z,
                        padding: '4px 0',
                    }}
                >
                    {FACTORY_PRESETS.map((p, i) => (
                        <div
                            key={p.name}
                            onClick={() => { loadPreset(i); setDropdownOpen(false); }}
                            style={{
                                padding: DROPDOWN_ITEM_PADDING,
                                fontSize: 'var(--font-size-sm)',
                                color: i === presetIndex ? 'var(--color-accent-primary)' : 'var(--color-text-secondary)',
                                fontWeight: i === presetIndex ? 600 : 400,
                                cursor: 'pointer',
                                background: 'transparent',
                                transition: 'background var(--transition-micro)',
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
    width: PRESET_BTN_SIZE,
    height: PRESET_BTN_SIZE,
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    background: 'transparent',
    color: 'var(--color-text-tertiary)',
    border: 'none',
    fontSize: 'var(--font-size-2xs)',
    cursor: 'pointer',
    borderRadius: PRESET_BTN_RADIUS,
    transition: 'color var(--transition-fast)',
};

export function FlowSynthOverlay() {
    const isOpen = useFlowSynthStore((state) => state.isOpen);
    const displayMode = useFlowSynthStore((state) => state.displayMode);
    const closeFlowEditor = useFlowSynthStore((state) => state.closeFlowEditor);
    const setDisplayMode = useFlowSynthStore((state) => state.setDisplayMode);
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

        let wasActive = false;

        const unsubscribe = useEngineStore.subscribe((state) => {
            const flow = useFlowSynthStore.getState();
            if (!flow.activeTrackId) return;

            const trackIndex = state.tracks.allIds.indexOf(flow.activeTrackId);
            if (trackIndex < 0) return;

            // ENTERPRISE FIX: Flow Synth active voices telemetry is piped into plugin_metrics[15]
            // from the Rust audio thread (see audio_thread_runner.rs). This creates a single
            // source of truth so visual pulses perfectly match actual audio output.
            const metrics = state.meters?.track_plugin_metrics?.[trackIndex];
            const isActive = metrics && metrics[15] > 0.5;

            // Trigger pulse animation only on the rising edge to match note-on attacks.
            if (isActive && !wasActive) {
                let midiNode: { id: string } | undefined;
                let oscNode: { id: string } | undefined;
                for (const node of flow.nodes) {
                    if (node.type === 'midiIn' && !midiNode) midiNode = node;
                    if (node.type === 'oscillator' && !oscNode) oscNode = node;
                    if (midiNode && oscNode) break;
                }
                if (midiNode) flow.pulseFromNode(midiNode.id, 'midi');
                if (oscNode) flow.pulseFromNode(oscNode.id, 'audio');
            }
            wasActive = !!isActive;
        });

        return unsubscribe;
    }, [isOpen]);

    useEffect(() => {
        if (!isOpen || !activeTrackId) return;
        const timer = window.setTimeout(() => {
            void useFlowSynthStore.getState().syncFlowGraphToEngine().catch((err) => {
                console.warn('[FlowSynth] syncFlowGraphToEngine failed:', err);
            });
        }, ENGINE_SYNC_DELAY_MS);
        return () => window.clearTimeout(timer);
        // BUG-3 FIX: Only sync on editor open / track change. Do NOT include
        // `nodes` or `connections` — the undo/redo subscription also schedules
        // sync, creating an infinite loop if both fire.
    }, [isOpen, activeTrackId]);

    // ENTERPRISE: Only render floating window when in floating mode.
    // Inline mode is rendered by DawShellMainView via FlowSynthInlineView.
    if (!isOpen || displayMode !== 'floating') return null;

    return (
        <PluginWindow
            pluginId={activeDeviceId ?? 'flow'}
            pluginName="Flow"
            pluginType="effect"
            isBypassed={false}
            onToggleBypass={() => { }}
            onClose={closeFlowEditor}
            onMaximize={() => setDisplayMode('inline')}
            width={FLOW_FLOAT_WIDTH}
            height={FLOW_FLOAT_HEIGHT}
            initialX={FLOW_FLOAT_X}
            initialY={FLOW_FLOAT_Y}
            showPresetControls={false}
            showBypassControl={false}
            leftDotColor="var(--color-accent-primary)"
            headerBackground="linear-gradient(180deg, color-mix(in srgb, var(--color-bg-elevated) 98%, transparent), var(--color-bg-elevated))"
            headerBorderColor="color-mix(in srgb, var(--color-divider) 60%, transparent)"
            contentPadding="0"
        >
            <div style={{ width: '100%', height: '100%', position: 'relative', overflow: 'hidden', boxShadow: 'none' }}>
                <FlowCanvas />
                <FloatingPresetBar />
            </div>
        </PluginWindow>
    );
}
