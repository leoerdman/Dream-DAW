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
    const setNodes = useFlowSynthStore((s) => s.setNodes);
    const nodes = useFlowSynthStore((s) => s.nodes);

    const filterType = node.data?.filterType || 'lowpass';
    const cutoff = node.data?.cutoff ?? 1000;
    const resonance = node.data?.resonance ?? 0.5;

    const updateData = useCallback((patch: Record<string, unknown>) => {
        const next = nodes.map((n) =>
            n.id === node.id ? { ...n, data: { ...n.data, ...patch } } : n,
        );
        setNodes(next);
    }, [node.id, nodes, setNodes]);

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
                <NodeValue value={cutoff} unit="Hz" />
            </ControlRow>
            <ControlRow label="Res">
                <NodeValue value={resonance} />
            </ControlRow>
        </div>
    );
}
