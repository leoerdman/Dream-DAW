import { useCallback, useEffect, useRef } from 'react';
import { ControlRow, NodeSelect, NodeValue } from './shared';
import { nodeControlsContainerStyle } from './FlowNodeControlStyles';
import type { SynthNode } from '../../model/useFlowSynthStore';
import { useFlowSynthStore } from '../../model/useFlowSynthStore';
import { useEngineStore } from '../../../../shared/stores/useEngineStore';

const CHANNELS = [
    { value: 'omni', label: 'Omni' },
    ...Array.from({ length: 16 }, (_, i) => ({
        value: String(i + 1),
        label: `Ch ${i + 1}`,
    })),
];

/** MIDI activity LED pulse duration in ms. */
const MIDI_PULSE_DURATION_MS = 150;

interface Props {
    node: SynthNode;
}

export function MidiInControls({ node }: Props) {
    const updateNodeData = useFlowSynthStore((s) => s.updateNodeData);

    const channel = String(node.data?.channel || 'omni');
    const transpose = Number(node.data?.transpose ?? 0);

    // MIDI Activity LED: Lights up when transport is playing
    // and pulses with each tick to show MIDI throughput.
    const ledRef = useRef<HTMLDivElement>(null);
    const prevTickRef = useRef(0);

    useEffect(() => {
        const unsub = useEngineStore.subscribe((state) => {
            const el = ledRef.current;
            if (!el) return;
            const isPlaying = state.transport.is_playing;
            const tick = state.transport.position_beats ?? 0;
            if (isPlaying && tick !== prevTickRef.current) {
                prevTickRef.current = tick;
                el.style.opacity = '1';
                el.style.boxShadow = '0 0 6px 2px var(--color-synth-midi-in, #4ade80)';
                // Fade out after pulse
                setTimeout(() => {
                    if (ledRef.current) {
                        ledRef.current.style.opacity = '0.3';
                        ledRef.current.style.boxShadow = 'none';
                    }
                }, MIDI_PULSE_DURATION_MS);
            } else if (!isPlaying) {
                el.style.opacity = '0.3';
                el.style.boxShadow = 'none';
            }
        });
        return unsub;
    }, []);

    const updateData = useCallback((patch: Record<string, unknown>) => {
        updateNodeData(node.id, patch);
    }, [node.id, updateNodeData]);

    return (
        <div style={nodeControlsContainerStyle}>
            <div style={{
                display: 'flex',
                alignItems: 'center',
                gap: 6,
                marginBottom: 4,
            }}>
                <div
                    ref={ledRef}
                    style={{
                        width: 8,
                        height: 8,
                        borderRadius: '50%',
                        background: 'var(--color-synth-midi-in, #4ade80)',
                        opacity: 0.3,
                        transition: `opacity ${MIDI_PULSE_DURATION_MS}ms ease, box-shadow ${MIDI_PULSE_DURATION_MS}ms ease`,
                        flexShrink: 0,
                    }}
                />
                <span style={{
                    fontSize: 'var(--font-size-2xs)',
                    color: 'var(--color-text-tertiary)',
                    fontWeight: 600,
                    letterSpacing: '0.04em',
                }}>
                    MIDI
                </span>
            </div>
            <ControlRow label="Ch">
                <NodeSelect
                    value={channel}
                    options={CHANNELS}
                    onChange={(v) => updateData({ channel: v })}
                />
            </ControlRow>
            <ControlRow label="Trans">
                <NodeValue value={transpose > 0 ? `+${transpose}` : String(transpose)} unit="st" />
            </ControlRow>
        </div>
    );
}
