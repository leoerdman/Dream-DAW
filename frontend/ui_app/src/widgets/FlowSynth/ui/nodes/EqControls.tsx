import { useCallback } from 'react';
import { nodeControlsContainerStyle } from './FlowNodeControlStyles';
import type { SynthNode } from '../../model/useFlowSynthStore';
import { useFlowSynthStore } from '../../model/useFlowSynthStore';
import { RotaryKnob } from './RotaryKnob';

interface Props {
    node: SynthNode;
}

/**
 * EQ Controls — 3-Band EQ (Band EQ / Bitwig-style)
 *
 * Low/Mid/High gain values are driven by inline port faders (dataKeys: lowGain, midGain, highGain).
 * The controls section provides crossover frequency knobs to define the band boundaries.
 */
export function EqControls({ node }: Props) {
    const updateNodeData = useFlowSynthStore((s) => s.updateNodeData);
    const lowFreq = Number(node.data?.lowFreq ?? 200);
    const highFreq = Number(node.data?.highFreq ?? 5000);

    const setParam = useCallback((key: string, value: number) => {
        updateNodeData(node.id, { [key]: value });
    }, [node.id, updateNodeData]);

    return (
        <div style={{
            ...nodeControlsContainerStyle,
            flexDirection: 'row',
            justifyContent: 'space-around',
        }}>
            <RotaryKnob
                nodeId={node.id}
                paramId="lowFreq"
                value={lowFreq}
                min={40}
                max={800}
                step={1}
                label="Low Freq"
                unit="Hz"
                color="var(--color-accent-warm)"
                onChange={(v) => setParam('lowFreq', v)}
            />
            <RotaryKnob
                nodeId={node.id}
                paramId="highFreq"
                value={highFreq}
                min={1000}
                max={16000}
                step={10}
                label="High Freq"
                unit="Hz"
                color="var(--color-accent-cool)"
                onChange={(v) => setParam('highFreq', v)}
            />
        </div>
    );
}
