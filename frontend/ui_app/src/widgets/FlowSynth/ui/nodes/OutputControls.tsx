import { useCallback } from 'react';
import { nodeControlsContainerStyle } from './FlowNodeControlStyles';
import type { SynthNode } from '../../model/useFlowSynthStore';
import { useFlowSynthStore } from '../../model/useFlowSynthStore';
import { RotaryKnob } from './RotaryKnob';

interface Props {
    node: SynthNode;
}

export function OutputControls({ node }: Props) {
    const updateNodeData = useFlowSynthStore((s) => s.updateNodeData);

    const gain = Number(node.data?.gain ?? 0.8);
    const muted = Boolean(node.data?.muted);

    const updateData = useCallback((patch: Record<string, unknown>) => {
        updateNodeData(node.id, patch);
    }, [node.id, updateNodeData]);

    return (
        <div style={{
            ...nodeControlsContainerStyle,
            flexDirection: 'row',
            alignItems: 'center',
            justifyContent: 'space-around',
        }}>
            <RotaryKnob
                nodeId={node.id}
                paramId="gain"
                value={gain}
                min={0}
                max={1}
                step={0.01}
                label="Gain"
                color="var(--color-synth-out)"
                onChange={(v) => updateData({ gain: v })}
            />
            <button
                onClick={(e) => { e.stopPropagation(); updateData({ muted: !muted }); }}
                style={{
                    width: 32,
                    height: 20,
                    borderRadius: 'var(--radius-full)',
                    border: 'none',
                    cursor: 'pointer',
                    background: muted
                        ? 'color-mix(in srgb, var(--color-accent-error) 60%, transparent)'
                        : 'color-mix(in srgb, var(--color-synth-out) 50%, transparent)',
                    transition: 'background var(--transition-fast)',
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: muted ? 'flex-start' : 'flex-end',
                    padding: 'var(--space-0-5)',
                }}
            >
                <div style={{
                    width: 16,
                    height: 16,
                    borderRadius: '50%',
                    background: 'var(--color-text-primary)',
                    transition: 'transform var(--transition-fast)',
                }} />
            </button>
        </div>
    );
}
