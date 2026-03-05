import { useCallback } from 'react';
import { ControlRow, NodeSelect, NodeSlider, NodeValue } from './shared';
import { nodeControlsContainerStyle } from './FlowNodeControlStyles';
import type { SynthNode } from '../../model/useFlowSynthStore';
import { useFlowSynthStore } from '../../model/useFlowSynthStore';

const LFO_SHAPES = [
    { value: 'sine', label: 'Sine' },
    { value: 'triangle', label: 'Triangle' },
    { value: 'saw', label: 'Saw' },
    { value: 'square', label: 'Square' },
    { value: 'random', label: 'Random' },
];

interface Props {
    node: SynthNode;
}

export function LfoControls({ node }: Props) {
    const updateNodeData = useFlowSynthStore((s) => s.updateNodeData);
    const shape = String(node.data?.shape || 'sine');
    const rate = Number(node.data?.rate ?? 1.0);
    const bipolar = Boolean(node.data?.bipolar ?? true);

    const updateData = useCallback((patch: Record<string, unknown>) => {
        updateNodeData(node.id, patch);
    }, [node.id, updateNodeData]);

    return (
        <div style={nodeControlsContainerStyle}>
            <ControlRow label="Shape">
                <NodeSelect
                    value={shape}
                    options={LFO_SHAPES}
                    onChange={(v) => updateData({ shape: v })}
                />
            </ControlRow>
            <ControlRow label="Rate">
                <NodeSlider
                    value={rate}
                    min={0.01}
                    max={40}
                    step={0.01}
                    onChange={(v) => updateData({ rate: v })}
                />
                <NodeValue value={rate.toFixed(2)} unit="Hz" />
            </ControlRow>
            <ControlRow label="Mode">
                <NodeSelect
                    value={bipolar ? 'bipolar' : 'unipolar'}
                    options={[
                        { value: 'bipolar', label: 'Bipolar' },
                        { value: 'unipolar', label: 'Unipolar' },
                    ]}
                    onChange={(v) => updateData({ bipolar: v === 'bipolar' })}
                />
            </ControlRow>
        </div>
    );
}
