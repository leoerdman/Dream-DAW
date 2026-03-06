import { useFlowSynthStore } from '../../model/useFlowSynthStore';
import type { SynthNode } from '../../model/useFlowSynthStore';

interface Props {
    node: SynthNode;
}

/** Controls for the Utility node: phase invert toggle. */
export function UtilityControls({ node }: Props) {
    const updateNodeData = useFlowSynthStore((s) => s.updateNodeData);
    const inverted = Boolean(node.data?.phaseInvert);

    return (
        <div style={{
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            gap: 6,
            padding: '4px 8px',
        }}>
            <button
                onClick={(e) => {
                    e.stopPropagation();
                    updateNodeData(node.id, { phaseInvert: !inverted });
                }}
                style={{
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                    gap: 4,
                    fontSize: 'var(--font-size-2xs)',
                    fontFamily: 'var(--font-role-data)',
                    fontWeight: 'var(--font-weight-semibold)',
                    color: inverted ? 'var(--color-accent-primary)' : 'var(--color-text-tertiary)',
                    background: inverted
                        ? 'color-mix(in srgb, var(--color-accent-primary) 15%, transparent)'
                        : 'color-mix(in srgb, var(--color-text-primary) 6%, transparent)',
                    border: inverted
                        ? '1px solid color-mix(in srgb, var(--color-accent-primary) 40%, transparent)'
                        : '1px solid color-mix(in srgb, var(--color-text-primary) 10%, transparent)',
                    borderRadius: 'var(--radius-sm)',
                    padding: '2px 8px',
                    cursor: 'pointer',
                    transition: 'all 0.15s',
                    userSelect: 'none',
                }}
            >
                ⌀ Phase Invert
            </button>
        </div>
    );
}
