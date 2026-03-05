import { useCallback } from 'react';
import { ControlRow, NodeSelect, NodeSlider, NodeValue } from './shared';
import { nodeControlsContainerStyle } from './FlowNodeControlStyles';
import type { SynthNode } from '../../model/useFlowSynthStore';
import { useFlowSynthStore } from '../../model/useFlowSynthStore';

const FILTER_TYPES = [
    { value: 'lowpass', label: 'Low Pass' },
    { value: 'highpass', label: 'High Pass' },
    { value: 'bandpass', label: 'Band Pass' },
    { value: 'notch', label: 'Notch' },
];

interface Props {
    node: SynthNode;
}

export function FilterControls({ node }: Props) {
    const updateNodeData = useFlowSynthStore((s) => s.updateNodeData);

    const filterType = String(node.data?.filterType || 'lowpass');
    const cutoff = Number(node.data?.cutoff ?? 1000);
    const resonance = Number(node.data?.resonance ?? 0.5);

    const updateData = useCallback((patch: Record<string, unknown>) => {
        updateNodeData(node.id, patch);
    }, [node.id, updateNodeData]);

    return (
        <div style={nodeControlsContainerStyle}>
            <ControlRow label="Type">
                <NodeSelect
                    value={filterType}
                    options={FILTER_TYPES}
                    onChange={(v) => updateData({ filterType: v })}
                />
            </ControlRow>
            <ControlRow label="Cutoff">
                <NodeSlider
                    value={cutoff}
                    min={20}
                    max={20000}
                    step={1}
                    onChange={(v) => updateData({ cutoff: v })}
                />
                <NodeValue value={cutoff} unit="Hz" />
            </ControlRow>
            <ControlRow label="Res">
                <NodeSlider
                    value={resonance}
                    min={0}
                    max={0.99}
                    step={0.01}
                    onChange={(v) => updateData({ resonance: v })}
                />
                <NodeValue value={resonance.toFixed(2)} />
            </ControlRow>
        </div>
    );
}
