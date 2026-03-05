import { useCallback } from 'react';
import { ControlRow, NodeValue } from './shared';
import type { SynthNode } from '../../model/useFlowSynthStore';
import { useFlowSynthStore } from '../../model/useFlowSynthStore';

interface Props {
    node: SynthNode;
}

export function DelayControls({ node }: Props) {
    const updateNodeData = useFlowSynthStore((s) => s.updateNodeData);
    const time = Number(node.data?.time ?? 250);
    const feedback = Number(node.data?.feedback ?? 0.3);
    const mix = Number(node.data?.mix ?? 0.5);

    const updateData = useCallback((patch: Record<string, unknown>) => {
        updateNodeData(node.id, patch);
    }, [node.id, updateNodeData]);

    return (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-2)', padding: '8px 12px' }}>
            <ControlRow label="Time">
                <input
                    type="range"
                    min={1}
                    max={2000}
                    step={1}
                    value={time}
                    onChange={(e) => updateData({ time: Number(e.target.value) })}
                    onPointerDown={(e) => e.stopPropagation()}
                    style={{ width: 90 }}
                />
                <NodeValue value={time} unit="ms" />
            </ControlRow>
            <ControlRow label="Feedback">
                <input
                    type="range"
                    min={0}
                    max={0.95}
                    step={0.01}
                    value={feedback}
                    onChange={(e) => updateData({ feedback: Number(e.target.value) })}
                    onPointerDown={(e) => e.stopPropagation()}
                    style={{ width: 90 }}
                />
                <NodeValue value={(feedback * 100).toFixed(0)} unit="%" />
            </ControlRow>
            <ControlRow label="Mix">
                <input
                    type="range"
                    min={0}
                    max={1}
                    step={0.01}
                    value={mix}
                    onChange={(e) => updateData({ mix: Number(e.target.value) })}
                    onPointerDown={(e) => e.stopPropagation()}
                    style={{ width: 90 }}
                />
                <NodeValue value={(mix * 100).toFixed(0)} unit="%" />
            </ControlRow>
        </div>
    );
}
