import { useCallback } from 'react';
import { ControlRow, NodeSlider, NodeValue } from './shared';
import { nodeControlsContainerStyle } from './FlowNodeControlStyles';
import type { SynthNode } from '../../model/useFlowSynthStore';
import { useFlowSynthStore } from '../../model/useFlowSynthStore';

interface Props {
    node: SynthNode;
}

export function DelayControls({ node }: Props) {
    const updateNodeData = useFlowSynthStore((s) => s.updateNodeData);
    const time = Number(node.data?.time ?? 250);
    const feedback = Number(node.data?.feedback ?? 0.3);
    const mix = Number(node.data?.mix ?? 0.5);

    const updateData = useCallback((patch: Record<string, unknown>) => {
        updateNodeData(node.id, patch);
    }, [node.id, updateNodeData]);

    return (
        <div style={nodeControlsContainerStyle}>
            <ControlRow label="Time">
                <NodeSlider
                    value={time}
                    min={1}
                    max={2000}
                    step={1}
                    onChange={(v) => updateData({ time: v })}
                />
                <NodeValue value={time} unit="ms" />
            </ControlRow>
            <ControlRow label="Fdbk">
                <NodeSlider
                    value={feedback}
                    min={0}
                    max={0.95}
                    step={0.01}
                    onChange={(v) => updateData({ feedback: v })}
                />
                <NodeValue value={(feedback * 100).toFixed(0)} unit="%" />
            </ControlRow>
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
