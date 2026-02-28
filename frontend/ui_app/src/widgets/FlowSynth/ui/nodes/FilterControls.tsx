import { useCallback } from 'react';
import { ControlRow, NodeSelect, NodeValue } from './shared';
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

    const filterType = node.data?.filterType || 'lowpass';
    const cutoff = node.data?.cutoff ?? 1000;
    const resonance = node.data?.resonance ?? 0.5;

    const updateData = useCallback((patch: Record<string, unknown>) => {
        updateNodeData(node.id, patch);
    }, [node.id, updateNodeData]);

    return (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-2)', padding: '8px 12px' }}>
            <ControlRow label="Type">
                <NodeSelect
                    value={filterType}
                    options={FILTER_TYPES}
                    onChange={(v) => updateData({ filterType: v })}
                />
            </ControlRow>
            <ControlRow label="Cutoff">
                <input
                    type="range"
                    min={20}
                    max={20000}
                    step={1}
                    value={cutoff}
                    onChange={(e) => updateData({ cutoff: Number(e.target.value) })}
                    style={{ width: 90 }}
                />
                <NodeValue value={cutoff} unit="Hz" />
            </ControlRow>
            <ControlRow label="Res">
                <input
                    type="range"
                    min={0}
                    max={0.99}
                    step={0.01}
                    value={resonance}
                    onChange={(e) => updateData({ resonance: Number(e.target.value) })}
                    style={{ width: 90 }}
                />
                <NodeValue value={resonance} />
            </ControlRow>
        </div>
    );
}
