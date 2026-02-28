import { useEffect } from 'react';
import { useFlowSynthStore } from '../model/useFlowSynthStore';
import { FlowCanvas } from './FlowCanvas';
import { useEngineStore } from '@/shared/stores/useEngineStore';
import { PluginWindow } from '@/widgets/PluginWindow/PluginWindow';

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
            pluginName="Flow"
            pluginType="instrument"
            isBypassed={false}
            onToggleBypass={() => { }}
            onClose={closeFlowEditor}
            width={1120}
            height={700}
            initialX={140}
            initialY={84}
            showPresetControls={false}
            showBypassControl={false}
            headerBackground="color-mix(in srgb, var(--color-bg-header) 92%, black 8%)"
            headerBorderColor="color-mix(in srgb, var(--color-divider) 82%, transparent)"
            leftDotColor="var(--color-signal-audio)"
            contentPadding="0"
        >
            <div style={{ width: '100%', height: '100%', position: 'relative', overflow: 'hidden', boxShadow: 'none' }}>
                <FlowCanvas />
            </div>
        </PluginWindow>
    );
}
