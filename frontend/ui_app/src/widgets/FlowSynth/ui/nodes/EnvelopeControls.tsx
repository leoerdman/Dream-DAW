import { nodeControlsContainerStyle } from './FlowNodeControlStyles';
import type { SynthNode } from '../../model/useFlowSynthStore';

interface Props {
    node: SynthNode;
}

/**
 * ADSR Envelope Controls — mini ADSR visualizer only.
 * Slider controls are now inline port faders in the port row zone.
 */
export function EnvelopeControls({ node }: Props) {
    const a = Number(node.data?.attack ?? 0.01);
    const d = Number(node.data?.decay ?? 0.1);
    const s = Number(node.data?.sustain ?? 0.7);
    const r = Number(node.data?.release ?? 0.3);

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
        </div>
    );
}
