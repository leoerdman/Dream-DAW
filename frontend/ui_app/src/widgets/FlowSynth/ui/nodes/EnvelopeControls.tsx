import { useCallback } from 'react';
import { NodeValue } from './shared';
import type { SynthNode } from '../../model/useFlowSynthStore';
import { useFlowSynthStore } from '../../model/useFlowSynthStore';

interface Props {
    node: SynthNode;
}

export function EnvelopeControls({ node }: Props) {
    const updateNodeData = useFlowSynthStore((s) => s.updateNodeData);
    const a = node.data?.attack ?? 0.01;
    const d = node.data?.decay ?? 0.1;
    const s = node.data?.sustain ?? 0.7;
    const r = node.data?.release ?? 0.3;
    const setEnv = useCallback((patch: Record<string, unknown>) => {
        updateNodeData(node.id, patch);
    }, [node.id, updateNodeData]);

    return (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-2)', padding: '8px 12px' }}>
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
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr 1fr', gap: 4, textAlign: 'center' }}>
                <div>
                    <div style={{ fontSize: 'var(--font-size-2xs)', color: 'var(--color-text-tertiary)', textTransform: 'uppercase' }}>A</div>
                    <input type="range" min={0.001} max={5} step={0.001} value={a} onChange={(e) => setEnv({ attack: Number(e.target.value) })} style={{ width: '100%' }} />
                    <NodeValue value={a.toFixed(2)} unit="s" />
                </div>
                <div>
                    <div style={{ fontSize: 'var(--font-size-2xs)', color: 'var(--color-text-tertiary)', textTransform: 'uppercase' }}>D</div>
                    <input type="range" min={0.001} max={5} step={0.001} value={d} onChange={(e) => setEnv({ decay: Number(e.target.value) })} style={{ width: '100%' }} />
                    <NodeValue value={d.toFixed(2)} unit="s" />
                </div>
                <div>
                    <div style={{ fontSize: 'var(--font-size-2xs)', color: 'var(--color-text-tertiary)', textTransform: 'uppercase' }}>S</div>
                    <input type="range" min={0} max={1} step={0.01} value={s} onChange={(e) => setEnv({ sustain: Number(e.target.value) })} style={{ width: '100%' }} />
                    <NodeValue value={s.toFixed(2)} />
                </div>
                <div>
                    <div style={{ fontSize: 'var(--font-size-2xs)', color: 'var(--color-text-tertiary)', textTransform: 'uppercase' }}>R</div>
                    <input type="range" min={0.001} max={8} step={0.001} value={r} onChange={(e) => setEnv({ release: Number(e.target.value) })} style={{ width: '100%' }} />
                    <NodeValue value={r.toFixed(2)} unit="s" />
                </div>
            </div>
        </div>
    );
}
