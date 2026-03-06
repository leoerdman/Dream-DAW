import { useCallback } from 'react';
import { nodeControlsContainerStyle } from './FlowNodeControlStyles';
import type { SynthNode } from '../../model/useFlowSynthStore';
import { useFlowSynthStore } from '../../model/useFlowSynthStore';
import { RotaryKnob } from './RotaryKnob';

interface Props {
    node: SynthNode;
}

// P3 FIX: Named constants for mute toggle dimensions (were hardcoded 32/20/16).
const MUTE_TOGGLE_W = 32;
const MUTE_TOGGLE_H = 20;
const MUTE_THUMB_SIZE = 16;

// P3 FIX: Extracted to module-level (were inline objects recreated every render).
const muteToggleBase: React.CSSProperties = {
    width: MUTE_TOGGLE_W,
    height: MUTE_TOGGLE_H,
    borderRadius: 'var(--radius-full)',
    border: 'none',
    cursor: 'pointer',
    transition: 'background var(--transition-fast)',
    display: 'flex',
    alignItems: 'center',
    padding: 'var(--space-0-5)',
};

const muteThumbStyle: React.CSSProperties = {
    width: MUTE_THUMB_SIZE,
    height: MUTE_THUMB_SIZE,
    borderRadius: '50%',
    background: 'var(--color-text-primary)',
    transition: 'transform var(--transition-fast)',
};

export function OutputControls({ node }: Props) {
    const updateNodeData = useFlowSynthStore((s) => s.updateNodeData);

    const gain = Number(node.data?.gain ?? 0.8);
    const muted = Boolean(node.data?.muted);

    const updateData = useCallback((patch: Record<string, unknown>) => {
        updateNodeData(node.id, patch);
    }, [node.id, updateNodeData]);

    const handleMuteClick = useCallback((e: React.MouseEvent) => {
        e.stopPropagation();
        updateData({ muted: !muted });
    }, [muted, updateData]);

    return (
        <div style={{
            ...nodeControlsContainerStyle,
            flexDirection: 'row',
            alignItems: 'center',
            justifyContent: 'space-around',
        }}>
            <RotaryKnob
                nodeId={node.id}
                paramId="gain"
                value={gain}
                min={0}
                max={1}
                step={0.01}
                label="Gain"
                color="var(--color-synth-out)"
                onChange={(v) => updateData({ gain: v })}
            />
            <button
                onClick={handleMuteClick}
                style={{
                    ...muteToggleBase,
                    background: muted
                        ? 'color-mix(in srgb, var(--color-accent-error) 60%, transparent)'
                        : 'color-mix(in srgb, var(--color-synth-out) 50%, transparent)',
                    justifyContent: muted ? 'flex-start' : 'flex-end',
                }}
            >
                <div style={muteThumbStyle} />
            </button>
        </div>
    );
}
