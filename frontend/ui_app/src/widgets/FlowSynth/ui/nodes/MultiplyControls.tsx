import { useCallback } from 'react';
import { ControlRow, NodeSlider, NodeValue } from './shared';
import { nodeControlsContainerStyle } from './FlowNodeControlStyles';
import type { SynthNode } from '../../model/useFlowSynthStore';
import { useFlowSynthStore } from '../../model/useFlowSynthStore';

interface Props {
    node: SynthNode;
}

export function MultiplyControls({ node }: Props) {
    const updateNodeData = useFlowSynthStore((s) => s.updateNodeData);
    const scale = Number(node.data?.scale ?? 1.0);

    const updateData = useCallback((patch: Record<string, unknown>) => {
        updateNodeData(node.id, patch);
    }, [node.id, updateNodeData]);

    return (
        <div style={nodeControlsContainerStyle}>
            <ControlRow label="Scale">
                <NodeSlider
                    value={scale}
                    min={-2}
                    max={2}
                    step={0.01}
                    onChange={(v) => updateData({ scale: v })}
                />
                <NodeValue value={scale.toFixed(2)} unit="×" />
            </ControlRow>
        </div>
    );
}
