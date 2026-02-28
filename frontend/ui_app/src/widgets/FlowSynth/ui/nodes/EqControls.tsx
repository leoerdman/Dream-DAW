import { useCallback } from 'react';
import { ControlRow, NodeValue } from './shared';
import type { SynthNode } from '../../model/useFlowSynthStore';
import { useFlowSynthStore } from '../../model/useFlowSynthStore';

interface Props {
    node: SynthNode;
}

export function EqControls({ node }: Props) {
    const updateNodeData = useFlowSynthStore((s) => s.updateNodeData);
    const low = Number(node.data?.eqLow ?? 0);
    const mid = Number(node.data?.eqMid ?? 0);
    const high = Number(node.data?.eqHigh ?? 0);

    const setBand = useCallback((band: 'eqLow' | 'eqMid' | 'eqHigh', value: number) => {
        updateNodeData(node.id, { [band]: value });
    }, [node.id, updateNodeData]);

    return (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-2)', padding: '8px 12px' }}>
            <ControlRow label="Low">
                <input
                    type="range"
                    min={-18}
                    max={18}
                    step={0.5}
                    value={low}
                    onChange={(e) => setBand('eqLow', Number(e.target.value))}
                    style={{ width: 90 }}
                />
                <NodeValue value={low.toFixed(1)} unit="dB" />
            </ControlRow>
            <ControlRow label="Mid">
                <input
                    type="range"
                    min={-18}
                    max={18}
                    step={0.5}
                    value={mid}
                    onChange={(e) => setBand('eqMid', Number(e.target.value))}
                    style={{ width: 90 }}
                />
                <NodeValue value={mid.toFixed(1)} unit="dB" />
            </ControlRow>
            <ControlRow label="High">
                <input
                    type="range"
                    min={-18}
                    max={18}
                    step={0.5}
                    value={high}
                    onChange={(e) => setBand('eqHigh', Number(e.target.value))}
                    style={{ width: 90 }}
                />
                <NodeValue value={high.toFixed(1)} unit="dB" />
            </ControlRow>
        </div>
    );
}
