import { useEffect } from 'react';
import { useFlowSynthStore } from '../model/useFlowSynthStore';
import { FlowCanvas } from './FlowCanvas';
import { useEngineStore } from '@/shared/stores/useEngineStore';
import { PluginWindow } from '@/widgets/PluginWindow/PluginWindow';

// ── Floating Preset Bar (sits above the canvas, top-right) ────────────
function FloatingPresetBar() {
    const presetName = useFlowSynthStore((s) => s.presetName);
    const nextPreset = useFlowSynthStore((s) => s.nextPreset);
    const prevPreset = useFlowSynthStore((s) => s.prevPreset);

    return (
        <div
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
            <span style={{
                fontSize: 'var(--font-size-sm)',
                color: 'var(--color-text-secondary)',
                fontWeight: 'var(--font-weight-medium)',
                minWidth: 60,
                textAlign: 'center',
                userSelect: 'none',
            }}>
                {presetName || 'Init'}
            </span>
            <button onClick={nextPreset} style={presetNavBtn} title="Next">▶</button>
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
    const nodes = useFlowSynthStore((state) => state.nodes);
    const connections = useFlowSynthStore((state) => state.connections);

    // Close on Escape key
    useEffect(() => {
        if (!isOpen) return;
        const handleKeyDown = (e: KeyboardEvent) => {
            if (e.key === 'Escape') {
                closeFlowEditor();
            }
        };
        document.addEventListener('keydown', handleKeyDown);
        return () => document.removeEventListener('keydown', handleKeyDown);
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
    }, [isOpen, activeTrackId, nodes, connections]);

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
