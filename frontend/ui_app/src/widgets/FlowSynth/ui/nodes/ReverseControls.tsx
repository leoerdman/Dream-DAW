import { useCallback } from 'react';
import { nodeControlsContainerStyle } from './FlowNodeControlStyles';
import type { SynthNode } from '../../model/useFlowSynthStore';
import { useFlowSynthStore } from '../../model/useFlowSynthStore';
import { RotaryKnob } from './RotaryKnob';

interface Props {
    node: SynthNode;
}

export function ReverseControls({ node }: Props) {
    const updateNodeData = useFlowSynthStore((s) => s.updateNodeData);

    const windowMs = Number(node.data?.windowMs ?? 200);
    const feedback = Number(node.data?.feedback ?? 0.3);

    const updateData = useCallback((patch: Record<string, unknown>) => {
        updateNodeData(node.id, patch);
    }, [node.id, updateNodeData]);

    return (
        <div style={{
            ...nodeControlsContainerStyle,
            flexDirection: 'row',
            justifyContent: 'space-around',
        }}>
            <RotaryKnob
                nodeId={node.id}
                paramId="windowMs"
                value={windowMs}
                min={50}
                max={2000}
                step={10}
                label="Window"
                unit="ms"
                color="var(--color-accent-primary)"
                onChange={(v) => updateData({ windowMs: v })}
            />
            <RotaryKnob
                nodeId={node.id}
                paramId="feedback"
                value={feedback}
                min={0}
                max={0.95}
                step={0.01}
                label="Feed"
                color="var(--color-accent-primary)"
                onChange={(v) => updateData({ feedback: v })}
            />
        </div>
    );
}
