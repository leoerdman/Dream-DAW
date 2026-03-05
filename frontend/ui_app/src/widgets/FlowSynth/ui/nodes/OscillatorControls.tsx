import { useCallback } from 'react';
import { ControlRow, NodeSelect, NodeSlider, NodeValue } from './shared';
import { nodeControlsContainerStyle } from './FlowNodeControlStyles';
import type { SynthNode } from '../../model/useFlowSynthStore';
import { useFlowSynthStore } from '../../model/useFlowSynthStore';

const WAVEFORMS = [
    { value: 'sine', label: 'Sine' },
    { value: 'saw', label: 'Saw' },
    { value: 'square', label: 'Square' },
    { value: 'triangle', label: 'Triangle' },
];

interface Props {
    node: SynthNode;
}

export function OscillatorControls({ node }: Props) {
    const updateNodeData = useFlowSynthStore((s) => s.updateNodeData);

    const waveform = String(node.data?.waveform || 'sine');
    const freq = Number(node.data?.frequency ?? 440);

    const updateData = useCallback((patch: Record<string, unknown>) => {
        updateNodeData(node.id, patch);
    }, [node.id, updateNodeData]);

    return (
        <div style={nodeControlsContainerStyle}>
            <ControlRow label="Wave">
                <NodeSelect
                    value={waveform}
                    options={WAVEFORMS}
                    onChange={(v) => updateData({ waveform: v })}
                />
            </ControlRow>
            <ControlRow label="Freq">
                <NodeSlider
                    value={freq}
                    min={20}
                    max={20000}
                    step={1}
                    onChange={(v) => updateData({ frequency: v })}
                />
                <NodeValue value={freq} unit="Hz" />
            </ControlRow>
        </div>
    );
}
