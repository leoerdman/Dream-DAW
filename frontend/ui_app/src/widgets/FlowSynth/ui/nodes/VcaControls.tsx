import { useCallback } from 'react';
import { ControlRow, NodeSlider, NodeValue } from './shared';
import { nodeControlsContainerStyle } from './FlowNodeControlStyles';
import type { SynthNode } from '../../model/useFlowSynthStore';
import { useFlowSynthStore } from '../../model/useFlowSynthStore';

interface Props {
    node: SynthNode;
}

export function VcaControls({ node }: Props) {
    const updateNodeData = useFlowSynthStore((s) => s.updateNodeData);
    const bias = Number(node.data?.bias ?? 1.0);

    const updateData = useCallback((patch: Record<string, unknown>) => {
        updateNodeData(node.id, patch);
    }, [node.id, updateNodeData]);

    return (
        <div style={nodeControlsContainerStyle}>
            <ControlRow label="Bias">
                <NodeSlider
                    value={bias}
                    min={0}
                    max={2}
                    step={0.01}
                    onChange={(v) => updateData({ bias: v })}
                />
                <NodeValue value={(bias * 100).toFixed(0)} unit="%" />
            </ControlRow>
        </div>
    );
}
