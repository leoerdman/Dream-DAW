import { useCallback } from 'react';
import { ControlRow, NodeValue } from './shared';
import type { SynthNode } from '../../model/useFlowSynthStore';
import { useFlowSynthStore } from '../../model/useFlowSynthStore';

interface Props {
    node: SynthNode;
}

export function MixerControls({ node }: Props) {
    const updateNodeData = useFlowSynthStore((s) => s.updateNodeData);

    const updateData = useCallback((patch: Record<string, unknown>) => {
        updateNodeData(node.id, patch);
    }, [node.id, updateNodeData]);

    return (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-2)', padding: '8px 12px' }}>
            {[1, 2, 3, 4].map((ch) => {
                const key = `gain_${ch}` as const;
                const val = Number((node.data as Record<string, unknown>)?.[key] ?? 1.0);
                return (
                    <ControlRow key={ch} label={`Ch${ch}`}>
                        <input
                            type="range"
                            min={0}
                            max={2}
                            step={0.01}
                            value={val}
                            onChange={(e) => updateData({ [key]: Number(e.target.value) })}
                            onPointerDown={(e) => e.stopPropagation()}
                            style={{ width: 90 }}
                        />
                        <NodeValue value={(val * 100).toFixed(0)} unit="%" />
                    </ControlRow>
                );
            })}
        </div>
    );
}
