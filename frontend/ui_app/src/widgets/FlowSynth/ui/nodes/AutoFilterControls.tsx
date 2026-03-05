import { useCallback } from 'react';
import { ControlRow, NodeSelect } from './shared';
import { nodeControlsContainerStyle } from './FlowNodeControlStyles';
import type { SynthNode } from '../../model/useFlowSynthStore';
import { useFlowSynthStore } from '../../model/useFlowSynthStore';
import { RotaryKnob } from './RotaryKnob';

const FILTER_TYPES = [
    { value: 'lowpass', label: 'Low Pass' },
    { value: 'highpass', label: 'High Pass' },
    { value: 'bandpass', label: 'Band Pass' },
    { value: 'notch', label: 'Notch' },
];

interface Props {
    node: SynthNode;
}

export function AutoFilterControls({ node }: Props) {
    const updateNodeData = useFlowSynthStore((s) => s.updateNodeData);

    const filterType = String(node.data?.filterType || 'lowpass');
    const rate = Number(node.data?.rate ?? 1.0);
    const depth = Number(node.data?.depth ?? 0.5);

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
            <div style={{
                display: 'flex',
                justifyContent: 'space-around',
                alignItems: 'center',
                paddingTop: 'var(--space-1)',
            }}>
                <RotaryKnob
                    value={rate}
                    min={0.05}
                    max={20}
                    step={0.05}
                    label="Rate"
                    unit="Hz"
                    color="var(--color-synth-filter)"
                    onChange={(v) => updateData({ rate: v })}
                />
                <RotaryKnob
                    value={depth}
                    min={0}
                    max={1}
                    step={0.01}
                    label="Depth"
                    color="var(--color-synth-filter)"
                    onChange={(v) => updateData({ depth: v })}
                />
            </div>
        </div>
    );
}
