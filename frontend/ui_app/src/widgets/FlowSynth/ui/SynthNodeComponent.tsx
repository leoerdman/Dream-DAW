import React from 'react';
import {
    FLOW_NODE_BODY_MIN_HEIGHT,
    FLOW_NODE_HEADER_HEIGHT,
    FLOW_NODE_WIDTH,
    useFlowSynthStore
} from '../model/useFlowSynthStore';
import type { SynthNode } from '../model/useFlowSynthStore';
import { viewportProxy } from '../lib/ViewportProxy';

interface Props {
    node: SynthNode;
}

export function SynthNodeComponent({ node }: Props) {
    const updateNodePosition = useFlowSynthStore((state) => state.updateNodePosition);
    const nodeThemeByType: Record<SynthNode['type'], { dot: string; title: string }> = {
        midiIn: { dot: 'var(--color-synth-osc)', title: 'MIDI In' },
        oscillator: { dot: 'var(--color-synth-osc)', title: 'Oscillator' },
        filter: { dot: 'var(--color-synth-filter)', title: 'Filter' },
        envelope: { dot: 'var(--color-synth-env)', title: 'Envelope' },
        output: { dot: 'var(--color-synth-out)', title: 'Output' },
    };
    const portsByType: Record<SynthNode['type'], { in: boolean; out: boolean; inIsMidi?: boolean; outIsMidi?: boolean }> = {
        midiIn: { in: false, out: true, outIsMidi: true },
        oscillator: { in: true, out: true, inIsMidi: true },
        filter: { in: true, out: true },
        envelope: { in: true, out: true },
        output: { in: true, out: false },
    };
    const theme = nodeThemeByType[node.type];
    const ports = portsByType[node.type];

    const handlePointerDown = (e: React.PointerEvent) => {
        // Only allow left click drag
        if (e.button !== 0) return;

        e.stopPropagation();
        const dragHandle = e.currentTarget as HTMLElement;
        dragHandle.setPointerCapture?.(e.pointerId);
        dragHandle.style.cursor = 'grabbing';

        const startX = e.clientX;
        const startY = e.clientY;
        const startNodeX = node.position.x;
        const startNodeY = node.position.y;

        const zoom = viewportProxy.getViewport().zoom;

        const handlePointerMove = (moveEvent: PointerEvent) => {
            const dx = (moveEvent.clientX - startX) / zoom;
            const dy = (moveEvent.clientY - startY) / zoom;
            updateNodePosition(node.id, startNodeX + dx, startNodeY + dy);
        };

        const handlePointerUp = () => {
            document.removeEventListener('pointermove', handlePointerMove);
            document.removeEventListener('pointerup', handlePointerUp);
            document.removeEventListener('pointercancel', handlePointerUp);
            dragHandle.removeEventListener('lostpointercapture', handlePointerUp);
            dragHandle.style.cursor = 'grab';
        };

        document.addEventListener('pointermove', handlePointerMove);
        document.addEventListener('pointerup', handlePointerUp);
        document.addEventListener('pointercancel', handlePointerUp);
        dragHandle.addEventListener('lostpointercapture', handlePointerUp);
    };

    return (
        <div
            style={{
                position: 'absolute',
                left: node.position.x,
                top: node.position.y,
                width: FLOW_NODE_WIDTH,
                background: 'color-mix(in srgb, var(--color-bg-panel) 86%, transparent)',
                backdropFilter: 'blur(var(--blur-lg))',
                WebkitBackdropFilter: 'blur(var(--blur-lg))',
                borderRadius: 'var(--radius-2xl)',
                border: 'var(--space-px) solid var(--color-divider)',
                boxShadow: 'var(--shadow-xl)',
                pointerEvents: 'auto',
                display: 'flex',
                flexDirection: 'column',
                transition: 'box-shadow 0.2s ease, transform 0.1s ease-out',
                zIndex: 10,
            }}
        >
            {/* Header / Drag Handle */}
            <div
                onPointerDown={handlePointerDown}
                style={{
                    padding: 'var(--space-3-5) var(--space-4)',
                    cursor: 'grab',
                    touchAction: 'none',
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'space-between',
                    borderBottom: 'var(--space-px) solid var(--color-divider)',
                    background: 'linear-gradient(180deg, color-mix(in srgb, var(--color-text-primary) 7%, transparent) 0%, transparent 100%)',
                    borderTopLeftRadius: 'var(--radius-2xl)',
                    borderTopRightRadius: 'var(--radius-2xl)',
                    minHeight: FLOW_NODE_HEADER_HEIGHT,
                    boxSizing: 'border-box',
                }}
            >
                <div style={{ display: 'flex', alignItems: 'center', gap: 'var(--space-2-5)' }}>
                    <div style={{
                        width: 10, height: 10, borderRadius: '50%',
                        backgroundColor: theme.dot,
                        boxShadow: `0 0 12px ${theme.dot}`
                    }} />
                    <span style={{
                        fontWeight: 'var(--font-weight-bold)',
                        fontSize: 'var(--font-size-md)',
                        color: 'var(--color-text-primary)',
                        textTransform: 'uppercase',
                        letterSpacing: '0.06em',
                        fontFamily: 'var(--font-role-data)',
                    }}>
                        {theme.title}
                    </span>
                </div>
            </div>

            {/* Body */}
            <div style={{
                padding: 'var(--space-6) var(--space-4)',
                color: 'var(--color-text-secondary)',
                fontSize: 'var(--font-size-md)',
                minHeight: FLOW_NODE_BODY_MIN_HEIGHT,
                fontFamily: 'var(--font-role-body)',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                textAlign: 'center'
            }}>
                {node.data?.label || 'Empty Node'}
            </div>

            {/* IN port (left) */}
            {ports.in && (
                <div
                    style={{
                        position: 'absolute',
                        left: -6,
                        top: '50%',
                        transform: 'translateY(-50%)',
                        width: 12,
                        height: 12,
                        backgroundColor: ports.inIsMidi ? 'var(--color-bg-base)' : 'var(--color-bg-elevated)',
                        borderRadius: '50%',
                        border: ports.inIsMidi ? '2px solid var(--color-signal-midi)' : '2px solid var(--color-border-default)',
                        cursor: 'crosshair',
                        boxShadow: '0 0 0 4px var(--color-overlay-dark)',
                        transition: 'border-color 0.2s, background-color 0.2s',
                    }}
                />
            )}
            {/* OUT port (right) */}
            {ports.out && (
                <div
                    style={{
                        position: 'absolute',
                        right: -6,
                        top: '50%',
                        transform: 'translateY(-50%)',
                        width: 12,
                        height: 12,
                        backgroundColor: ports.outIsMidi ? 'var(--color-signal-midi)' : 'var(--color-signal-audio)',
                        borderRadius: '50%',
                        border: ports.outIsMidi ? '2px solid var(--color-text-primary)' : '2px solid var(--color-border-highlight)',
                        cursor: 'crosshair',
                        boxShadow: ports.outIsMidi ? '0 0 12px var(--color-signal-midi)' : '0 0 12px var(--color-signal-audio)',
                        transition: 'box-shadow 0.2s',
                    }}
                />
            )}
        </div>
    );
}
