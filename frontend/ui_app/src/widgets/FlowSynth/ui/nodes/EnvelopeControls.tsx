import { NodeValue } from './shared';
import type { SynthNode } from '../../model/useFlowSynthStore';

interface Props {
    node: SynthNode;
}

export function EnvelopeControls({ node }: Props) {
    const a = node.data?.attack ?? 0.01;
    const d = node.data?.decay ?? 0.1;
    const s = node.data?.sustain ?? 0.7;
    const r = node.data?.release ?? 0.3;

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
                    <NodeValue value={a.toFixed(2)} unit="s" />
                </div>
                <div>
                    <div style={{ fontSize: 'var(--font-size-2xs)', color: 'var(--color-text-tertiary)', textTransform: 'uppercase' }}>D</div>
                    <NodeValue value={d.toFixed(2)} unit="s" />
                </div>
                <div>
                    <div style={{ fontSize: 'var(--font-size-2xs)', color: 'var(--color-text-tertiary)', textTransform: 'uppercase' }}>S</div>
                    <NodeValue value={s.toFixed(2)} />
                </div>
                <div>
                    <div style={{ fontSize: 'var(--font-size-2xs)', color: 'var(--color-text-tertiary)', textTransform: 'uppercase' }}>R</div>
                    <NodeValue value={r.toFixed(2)} unit="s" />
                </div>
            </div>
        </div>
    );
}
