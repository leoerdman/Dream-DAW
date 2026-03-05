import { useCallback } from 'react';
import { ControlRow, NodeValue } from './shared';
import type { SynthNode } from '../../model/useFlowSynthStore';
import { useFlowSynthStore } from '../../model/useFlowSynthStore';

interface Props {
    node: SynthNode;
}

export function MultiplyControls({ node }: Props) {
    const updateNodeData = useFlowSynthStore((s) => s.updateNodeData);
    const scale = Number(node.data?.scale ?? 1.0);

    const updateData = useCallback((patch: Record<string, unknown>) => {
        updateNodeData(node.id, patch);
    }, [node.id, updateNodeData]);

    return (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-2)', padding: '8px 12px' }}>
            <ControlRow label="Scale">
                <input
                    type="range"
                    min={-2}
                    max={2}
                    step={0.01}
                    value={scale}
                    onChange={(e) => updateData({ scale: Number(e.target.value) })}
                    onPointerDown={(e) => e.stopPropagation()}
                    style={{ width: 90 }}
                />
                <NodeValue value={scale.toFixed(2)} unit="×" />
            </ControlRow>
        </div>
    );
}
