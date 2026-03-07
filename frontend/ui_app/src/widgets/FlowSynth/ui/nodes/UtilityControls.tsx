import { useCallback } from 'react';
import { useFlowSynthStore } from '../../model/useFlowSynthStore';
import type { SynthNode } from '../../model/useFlowSynthStore';

interface Props {
    node: SynthNode;
}

// P3 FIX: Extracted inline styles to module-level constants.
const utilityContainerStyle: React.CSSProperties = {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 'var(--space-1-5)',
    padding: 'var(--space-1) var(--space-2)',
};

const phaseInvertBtnBase: React.CSSProperties = {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 'var(--space-1)',
    fontSize: 'var(--font-size-2xs)',
    fontFamily: 'var(--font-role-data)',
    fontWeight: 'var(--font-weight-semibold)',
    borderRadius: 'var(--radius-sm)',
    padding: 'var(--space-0-5) var(--space-2)',
    cursor: 'pointer',
    transition: 'all var(--transition-fast)',
    userSelect: 'none',
};

const phaseInvertActiveStyle: React.CSSProperties = {
    ...phaseInvertBtnBase,
    color: 'var(--color-accent-primary)',
    background: 'color-mix(in srgb, var(--color-accent-primary) 15%, transparent)',
    border: '1px solid color-mix(in srgb, var(--color-accent-primary) 40%, transparent)',
};

const phaseInvertInactiveStyle: React.CSSProperties = {
    ...phaseInvertBtnBase,
    color: 'var(--color-text-tertiary)',
    background: 'color-mix(in srgb, var(--color-text-primary) 6%, transparent)',
    border: '1px solid color-mix(in srgb, var(--color-text-primary) 10%, transparent)',
};

/** Controls for the Utility node: phase invert toggle. */
export function UtilityControls({ node }: Props) {
    const updateNodeData = useFlowSynthStore((s) => s.updateNodeData);
    const inverted = Boolean(node.data?.phaseInvert);

    const handleClick = useCallback((e: React.MouseEvent) => {
        e.stopPropagation();
        updateNodeData(node.id, { phaseInvert: !inverted });
    }, [node.id, inverted, updateNodeData]);

    return (
        <div style={utilityContainerStyle}>
            <button
                onClick={handleClick}
                style={inverted ? phaseInvertActiveStyle : phaseInvertInactiveStyle}
            >
                ⌀ Phase Invert
            </button>
        </div>
    );
}
