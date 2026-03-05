import { useCallback } from 'react';
import { ControlRow, NodeSlider, NodeValue } from './shared';
import { nodeControlsContainerStyle } from './FlowNodeControlStyles';
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
        <div style={nodeControlsContainerStyle}>
            {[1, 2, 3, 4].map((ch) => {
                const key = `gain${ch}` as const;
                const val = Number((node.data as Record<string, unknown>)?.[key] ?? 1.0);
                return (
                    <ControlRow key={ch} label={`Ch${ch}`}>
                        <NodeSlider
                            value={val}
                            min={0}
                            max={2}
                            step={0.01}
                            onChange={(v) => updateData({ [key]: v })}
                        />
                        <NodeValue value={(val * 100).toFixed(0)} unit="%" />
                    </ControlRow>
                );
            })}
        </div>
    );
}
