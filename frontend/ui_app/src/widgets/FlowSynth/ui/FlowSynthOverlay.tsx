import { useEffect } from 'react';
import { useFlowSynthStore } from '../model/useFlowSynthStore';
import { CloseButton } from '@/shared/ui/CloseButton';
import { FlowCanvas } from './FlowCanvas';
import { useEngineStore } from '@/shared/stores/useEngineStore';

export function FlowSynthOverlay() {
    const isOpen = useFlowSynthStore((state) => state.isOpen);
    const closeFlowEditor = useFlowSynthStore((state) => state.closeFlowEditor);
    const activeDeviceId = useFlowSynthStore((state) => state.activeDeviceId);

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

    if (!isOpen) return null;

    return (
        <div
            className="flow-synth-overlay-root"
            style={{
                position: 'fixed',
                top: 0,
                left: 0,
                right: 0,
                bottom: 0,
                backgroundColor: 'var(--color-bg-app)',
                zIndex: 'var(--z-modal)',
                display: 'flex',
                flexDirection: 'column',
            }}
        >
            <div
                style={{
                    height: 48,
                    borderBottom: 'var(--space-px) solid var(--color-divider)',
                    display: 'flex',
                    alignItems: 'center',
                    padding: '0 var(--space-4)',
                    justifyContent: 'space-between',
                    backgroundColor: 'var(--color-bg-panel)',
                }}
            >
                <div style={{ display: 'flex', alignItems: 'center', gap: 'var(--space-2)' }}>
                    <div
                        style={{
                            width: 24,
                            height: 24,
                            borderRadius: 4,
                            background: 'var(--color-plugin-internal)',
                            display: 'flex',
                            alignItems: 'center',
                            justifyContent: 'center',
                            color: 'var(--color-text-primary)',
                            fontWeight: 'var(--font-weight-bold)',
                            fontSize: 'var(--font-size-sm)',
                            fontFamily: 'var(--font-role-data)',
                        }}
                    >
                        F
                    </div>
                    <span style={{ fontWeight: 'var(--font-weight-semibold)', color: 'var(--color-text-primary)' }}>
                        Flow Modular Synth
                    </span>
                    <span style={{ fontSize: 'var(--font-size-xs)', color: 'var(--color-text-tertiary)', fontFamily: 'var(--font-role-data)' }}>
                        {activeDeviceId}
                    </span>
                </div>

                <CloseButton onClick={closeFlowEditor} />
            </div>

            <div style={{ flex: 1, position: 'relative', overflow: 'hidden' }}>
                <FlowCanvas />
            </div>
        </div>
    );
}
