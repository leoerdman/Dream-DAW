import { useCallback } from 'react';
import { ControlRow, NodeSelect } from './shared';
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

/**
 * Oscillator Controls — waveform selector only.
 * Freq slider is now an inline port fader.
 */
export function OscillatorControls({ node }: Props) {
    const updateNodeData = useFlowSynthStore((s) => s.updateNodeData);

    const waveform = String(node.data?.waveform || 'sine');

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
        </div>
    );
}
