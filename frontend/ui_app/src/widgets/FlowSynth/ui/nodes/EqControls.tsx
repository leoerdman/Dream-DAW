import { useCallback } from 'react';
import { nodeControlsContainerStyle } from './FlowNodeControlStyles';
import type { SynthNode } from '../../model/useFlowSynthStore';
import { useFlowSynthStore } from '../../model/useFlowSynthStore';
import { RotaryKnob } from './RotaryKnob';

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
        <div style={{
            ...nodeControlsContainerStyle,
            flexDirection: 'row',
            justifyContent: 'space-around',
        }}>
            <RotaryKnob
                value={low}
                min={-18}
                max={18}
                step={0.5}
                label="Low"
                unit="dB"
                color="var(--color-accent-warm)"
                onChange={(v) => setBand('eqLow', v)}
            />
            <RotaryKnob
                value={mid}
                min={-18}
                max={18}
                step={0.5}
                label="Mid"
                unit="dB"
                color="var(--color-accent-primary)"
                onChange={(v) => setBand('eqMid', v)}
            />
            <RotaryKnob
                value={high}
                min={-18}
                max={18}
                step={0.5}
                label="High"
                unit="dB"
                color="var(--color-accent-cool)"
                onChange={(v) => setBand('eqHigh', v)}
            />
        </div>
    );
}
