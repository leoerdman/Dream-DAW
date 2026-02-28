import { useCallback } from 'react';
import { ControlRow, NodeSelect, NodeValue } from './shared';
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

    const waveform = node.data?.waveform || 'sine';
    const freq = node.data?.frequency ?? 440;

    const updateData = useCallback((patch: Record<string, unknown>) => {
        updateNodeData(node.id, patch);
    }, [node.id, updateNodeData]);

    return (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-2)', padding: '8px 12px' }}>
            <ControlRow label="Wave">
                <NodeSelect
                    value={waveform}
                    options={WAVEFORMS}
                    onChange={(v) => updateData({ waveform: v })}
                />
            </ControlRow>
            <ControlRow label="Freq">
                <input
                    type="range"
                    min={20}
                    max={20000}
                    step={1}
                    value={freq}
                    onChange={(e) => updateData({ frequency: Number(e.target.value) })}
                    style={{ width: 90 }}
                />
                <NodeValue value={freq} unit="Hz" />
            </ControlRow>
        </div>
    );
}
