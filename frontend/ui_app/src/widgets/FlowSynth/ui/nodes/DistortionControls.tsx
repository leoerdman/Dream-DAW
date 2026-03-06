import { nodeControlsContainerStyle } from './FlowNodeControlStyles';
import { ControlRow, NodeSelect } from './shared';
import type { SynthNode } from '../../model/useFlowSynthStore';
import { useFlowSynthStore } from '../../model/useFlowSynthStore';

interface Props {
    node: SynthNode;
}

/**
 * DistortionControls — Waveshaper Mode Selector
 *
 * Drive and Mix are handled by inline port faders.
 * This component provides the distortion mode selector (soft clip / hard clip / fold / tanh).
 */
export function DistortionControls({ node }: Props) {
    const updateNodeData = useFlowSynthStore((s) => s.updateNodeData);
    const mode = (node.data?.mode as string) ?? 'soft';


    return (
        <div style={nodeControlsContainerStyle}>
            <ControlRow label="Mode">
                <NodeSelect
                    value={mode}
                    options={[
                        { value: 'soft', label: 'Soft Clip' },
                        { value: 'hard', label: 'Hard Clip' },
                        { value: 'fold', label: 'Wavefold' },
                        { value: 'tanh', label: 'Tanh' },
                    ]}
                    onChange={(v) => updateNodeData(node.id, { mode: v })}
                />
            </ControlRow>
        </div>
    );
}
