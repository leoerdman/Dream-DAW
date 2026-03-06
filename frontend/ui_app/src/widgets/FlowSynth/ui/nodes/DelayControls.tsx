import { useCallback } from 'react';
import { ControlRow, NodeSlider, NodeValue } from './shared';
import { nodeControlsContainerStyle } from './FlowNodeControlStyles';
import type { SynthNode } from '../../model/useFlowSynthStore';
import { useFlowSynthStore } from '../../model/useFlowSynthStore';

interface Props {
    node: SynthNode;
}

/**
 * Delay body controls — only Mix slider.
 * Time and Feedback are handled by inline port faders (no duplication).
 */
export function DelayControls({ node }: Props) {
    const updateNodeData = useFlowSynthStore((s) => s.updateNodeData);
    const mix = Number(node.data?.mix ?? 0.5);

    const updateData = useCallback((patch: Record<string, unknown>) => {
        updateNodeData(node.id, patch);
    }, [node.id, updateNodeData]);

    return (
        <div style={nodeControlsContainerStyle}>
            <ControlRow label="Mix">
                <NodeSlider
                    value={mix}
                    min={0}
                    max={1}
                    step={0.01}
                    onChange={(v) => updateData({ mix: v })}
                />
                <NodeValue value={(mix * 100).toFixed(0)} unit="%" />
            </ControlRow>
        </div>
    );
}
