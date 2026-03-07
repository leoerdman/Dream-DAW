import { useCallback, useEffect, useRef } from 'react';
import { nodeControlsContainerStyle } from './FlowNodeControlStyles';
import type { SynthNode } from '../../model/useFlowSynthStore';
import { useFlowSynthStore } from '../../model/useFlowSynthStore';
import { RotaryKnob } from './RotaryKnob';
import { useEngineStore } from '../../../../shared/stores/useEngineStore';

interface Props {
    node: SynthNode;
}

// P3 FIX: Named constants for mute toggle dimensions (were hardcoded 32/20/16).
const MUTE_TOGGLE_W = 32;
const MUTE_TOGGLE_H = 20;
const MUTE_THUMB_SIZE = 16;

/** Meter bar height. */
const METER_BAR_H = 4;
/** Meter animation transition. */
const METER_TRANSITION = 'width 60ms linear';

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

    // ENTERPRISE: Live output meter — ref-based DOM mutation for zero re-renders.
    // Uses the same subscription pattern as MixerChannelMeters / MasterStrip.
    const meterLRef = useRef<HTMLDivElement>(null);
    const meterRRef = useRef<HTMLDivElement>(null);

    useEffect(() => {
        const unsub = useEngineStore.subscribe((state) => {
            const masterL = Number(state.meters?.master_left ?? 0);
            const masterR = Number(state.meters?.master_right ?? 0);
            // Scale to percentage (meters are 0..1 range)
            const pctL = Math.min(100, Math.max(0, masterL * 100));
            const pctR = Math.min(100, Math.max(0, masterR * 100));
            if (meterLRef.current) meterLRef.current.style.width = `${pctL}%`;
            if (meterRRef.current) meterRRef.current.style.width = `${pctR}%`;
        });
        return unsub;
    }, []);

    return (
        <div style={{
            ...nodeControlsContainerStyle,
            flexDirection: 'column',
            gap: 6,
        }}>
            {/* Output Level Meter */}
            <div style={{
                width: '100%',
                display: 'flex',
                flexDirection: 'column',
                gap: 2,
                padding: '0 4px',
            }}>
                {/* Left channel */}
                <div style={{
                    width: '100%',
                    height: METER_BAR_H,
                    borderRadius: METER_BAR_H / 2,
                    background: 'color-mix(in srgb, var(--color-text-primary) 10%, transparent)',
                    overflow: 'hidden',
                }}>
                    <div
                        ref={meterLRef}
                        style={{
                            height: '100%',
                            width: '0%',
                            borderRadius: METER_BAR_H / 2,
                            background: 'var(--color-synth-out, #60a5fa)',
                            transition: METER_TRANSITION,
                        }}
                    />
                </div>
                {/* Right channel */}
                <div style={{
                    width: '100%',
                    height: METER_BAR_H,
                    borderRadius: METER_BAR_H / 2,
                    background: 'color-mix(in srgb, var(--color-text-primary) 10%, transparent)',
                    overflow: 'hidden',
                }}>
                    <div
                        ref={meterRRef}
                        style={{
                            height: '100%',
                            width: '0%',
                            borderRadius: METER_BAR_H / 2,
                            background: 'var(--color-synth-out, #60a5fa)',
                            transition: METER_TRANSITION,
                        }}
                    />
                </div>
            </div>

            {/* Gain + Mute row */}
            <div style={{
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'space-around',
                width: '100%',
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
        </div>
    );
}
