import { useCallback } from 'react';
import { ControlRow, NodeSelect, NodeSlider, NodeValue } from './shared';
import { nodeControlsContainerStyle } from './FlowNodeControlStyles';
import type { SynthNode } from '../../model/useFlowSynthStore';
import { useFlowSynthStore } from '../../model/useFlowSynthStore';

const NOISE_COLORS = [
    { value: 'white', label: 'White' },
    { value: 'pink', label: 'Pink' },
];

interface Props {
    node: SynthNode;
}

export function NoiseControls({ node }: Props) {
    const updateNodeData = useFlowSynthStore((s) => s.updateNodeData);
    const color = String(node.data?.color || 'white');
    const level = Number(node.data?.level ?? 1.0);

    const updateData = useCallback((patch: Record<string, unknown>) => {
        updateNodeData(node.id, patch);
    }, [node.id, updateNodeData]);

    return (
        <div style={nodeControlsContainerStyle}>
            <ControlRow label="Color">
                <NodeSelect
                    value={color}
                    options={NOISE_COLORS}
                    onChange={(v) => updateData({ color: v })}
                />
            </ControlRow>
            <ControlRow label="Level">
                <NodeSlider
                    value={level}
                    min={0}
                    max={1}
                    step={0.01}
                    onChange={(v) => updateData({ level: v })}
                />
                <NodeValue value={(level * 100).toFixed(0)} unit="%" />
            </ControlRow>
        </div>
    );
}
