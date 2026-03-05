import { useCallback } from 'react';
import { ControlRow, NodeValue } from './shared';
import type { SynthNode } from '../../model/useFlowSynthStore';
import { useFlowSynthStore } from '../../model/useFlowSynthStore';

interface Props {
    node: SynthNode;
}

export function VcaControls({ node }: Props) {
    const updateNodeData = useFlowSynthStore((s) => s.updateNodeData);
    const bias = Number(node.data?.bias ?? 1.0);

    const updateData = useCallback((patch: Record<string, unknown>) => {
        updateNodeData(node.id, patch);
    }, [node.id, updateNodeData]);

    return (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-2)', padding: '8px 12px' }}>
            <ControlRow label="Bias">
                <input
                    type="range"
                    min={0}
                    max={2}
                    step={0.01}
                    value={bias}
                    onChange={(e) => updateData({ bias: Number(e.target.value) })}
                    onPointerDown={(e) => e.stopPropagation()}
                    style={{ width: 90 }}
                />
                <NodeValue value={(bias * 100).toFixed(0)} unit="%" />
            </ControlRow>
        </div>
    );
}
