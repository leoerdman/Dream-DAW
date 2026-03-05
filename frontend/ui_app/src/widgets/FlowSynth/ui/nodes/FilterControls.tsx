import { useCallback } from 'react';
import { ControlRow, NodeSelect } from './shared';
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

/**
 * Filter Controls — filter type selector only.
 * Cutoff/Resonance sliders are now inline port faders.
 */
export function FilterControls({ node }: Props) {
    const updateNodeData = useFlowSynthStore((s) => s.updateNodeData);

    const filterType = String(node.data?.filterType || 'lowpass');

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
        </div>
    );
}
