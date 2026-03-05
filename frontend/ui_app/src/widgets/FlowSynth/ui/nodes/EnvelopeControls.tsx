import { useCallback } from 'react';
import { NodeSlider, NodeValue } from './shared';
import { nodeControlsContainerStyle } from './FlowNodeControlStyles';
import type { SynthNode } from '../../model/useFlowSynthStore';
import { useFlowSynthStore } from '../../model/useFlowSynthStore';

interface Props {
    node: SynthNode;
}

/**
 * ADSR Envelope Controls — compact 4-column grid layout with mini visualizer.
 * Uses token-based styling throughout.
 */
export function EnvelopeControls({ node }: Props) {
    const updateNodeData = useFlowSynthStore((s) => s.updateNodeData);
    const a = Number(node.data?.attack ?? 0.01);
    const d = Number(node.data?.decay ?? 0.1);
    const s = Number(node.data?.sustain ?? 0.7);
    const r = Number(node.data?.release ?? 0.3);
    const setEnv = useCallback((patch: Record<string, unknown>) => {
        updateNodeData(node.id, patch);
    }, [node.id, updateNodeData]);

    return (
        <div style={nodeControlsContainerStyle}>
            {/* Mini ADSR visualizer */}
            <svg viewBox="0 0 120 32" style={{
                width: '100%',
                height: 32,
                overflow: 'visible',
            }}>
                {/* Background */}
                <rect x="0" y="0" width="120" height="32" rx="4" fill="color-mix(in srgb, var(--color-text-primary) 6%, transparent)" />
                {/* ADSR curve */}
                <polyline
                    points={`0,32 ${a * 100},2 ${a * 100 + d * 80},${32 - s * 28} ${90},${32 - s * 28} 120,32`}
                    fill="none"
                    stroke="var(--color-synth-env)"
                    strokeWidth="1.5"
                    strokeLinejoin="round"
                />
                {/* Fill under curve */}
                <polyline
                    points={`0,32 ${a * 100},2 ${a * 100 + d * 80},${32 - s * 28} ${90},${32 - s * 28} 120,32`}
                    fill="color-mix(in srgb, var(--color-synth-env) 15%, transparent)"
                    stroke="none"
                />
            </svg>
            <div style={{
                display: 'grid',
                gridTemplateColumns: '1fr 1fr 1fr 1fr',
                gap: 'var(--space-1)',
                textAlign: 'center',
            }}>
                {([
                    { key: 'attack', label: 'A', val: a, min: 0.001, max: 5, step: 0.001, unit: 's' },
                    { key: 'decay', label: 'D', val: d, min: 0.001, max: 5, step: 0.001, unit: 's' },
                    { key: 'sustain', label: 'S', val: s, min: 0, max: 1, step: 0.01, unit: '' },
                    { key: 'release', label: 'R', val: r, min: 0.001, max: 8, step: 0.001, unit: 's' },
                ] as const).map((param) => (
                    <div key={param.key}>
                        <div style={{
                            fontSize: 'var(--font-size-2xs)',
                            color: 'var(--color-text-tertiary)',
                            textTransform: 'uppercase',
                            fontFamily: 'var(--font-role-data)',
                            fontWeight: 'var(--font-weight-semibold)',
                        }}>{param.label}</div>
                        <NodeSlider
                            value={param.val}
                            min={param.min}
                            max={param.max}
                            step={param.step}
                            onChange={(v) => setEnv({ [param.key]: v })}
                        />
                        <NodeValue value={param.val.toFixed(2)} unit={param.unit} />
                    </div>
                ))}
            </div>
        </div>
    );
}
