import { useCallback } from 'react';
import { nodeControlsContainerStyle } from './FlowNodeControlStyles';
import { ControlRow, NodeSelect } from './shared';
import type { SynthNode } from '../../model/useFlowSynthStore';
import { useFlowSynthStore } from '../../model/useFlowSynthStore';

// P3 FIX: Extracted to module-level constant (was inline array).
const DISTORTION_MODES = [
    { value: 'soft', label: 'Soft Clip' },
    { value: 'hard', label: 'Hard Clip' },
    { value: 'fold', label: 'Wavefold' },
    { value: 'tanh', label: 'Tanh' },
] as const;

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

    // P3 FIX: Added useCallback wrapper (was direct call — inconsistent with all other controls).
    const updateData = useCallback((patch: Record<string, unknown>) => {
        updateNodeData(node.id, patch);
    }, [node.id, updateNodeData]);

    return (
        <div style={nodeControlsContainerStyle}>
            <ControlRow label="Mode">
                <NodeSelect
                    value={mode}
                    options={DISTORTION_MODES}
                    onChange={(v) => updateData({ mode: v })}
                />
            </ControlRow>
        </div>
    );
}
