import { useCallback } from 'react';
import { ControlRow, NodeSelect, NodeValue } from './shared';
import { nodeControlsContainerStyle } from './FlowNodeControlStyles';
import type { SynthNode } from '../../model/useFlowSynthStore';
import { useFlowSynthStore } from '../../model/useFlowSynthStore';

const CHANNELS = [
    { value: 'omni', label: 'Omni' },
    ...Array.from({ length: 16 }, (_, i) => ({
        value: String(i + 1),
        label: `Ch ${i + 1}`,
    })),
];

interface Props {
    node: SynthNode;
}

export function MidiInControls({ node }: Props) {
    const updateNodeData = useFlowSynthStore((s) => s.updateNodeData);

    const channel = String(node.data?.channel || 'omni');
    const transpose = Number(node.data?.transpose ?? 0);

    const updateData = useCallback((patch: Record<string, unknown>) => {
        updateNodeData(node.id, patch);
    }, [node.id, updateNodeData]);

    return (
        <div style={nodeControlsContainerStyle}>
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
