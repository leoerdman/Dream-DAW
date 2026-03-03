import React from 'react';
import { useFlowSynthStore } from '../model/useFlowSynthStore';
import type { SynthNode } from '../model/useFlowSynthStore';
import {
    PORT_REGISTRY,
    FLOW_PORT_SIZE,
    FLOW_PORT_ROW_HEIGHT,
    FLOW_NODE_HEADER_HEIGHT,
    FLOW_NODE_BODY_PADDING,
    portCenterY,
    type PortDefinition,
    type SynthNodeType,
} from '../model/portRegistry';
import { viewportProxy } from '../lib/ViewportProxy';
import { OscillatorControls } from './nodes/OscillatorControls';
import { FilterControls } from './nodes/FilterControls';
import { EnvelopeControls } from './nodes/EnvelopeControls';
import { EqControls } from './nodes/EqControls';
import { AutoFilterControls } from './nodes/AutoFilterControls';
import { ReverseControls } from './nodes/ReverseControls';
import { OutputControls } from './nodes/OutputControls';
import { MidiInControls } from './nodes/MidiInControls';

export const FLOW_NODE_WIDTH = 240;
const FLOW_GRID_SNAP = 20;

interface Props {
    node: SynthNode;
    interactionDisabled?: boolean;
}

// ── Per-type controls renderer ─────────────────────────────────
function NodeControlsBody({ node }: { node: SynthNode }) {
    switch (node.type) {
        case 'oscillator':
            return <OscillatorControls node={node} />;
        case 'filter':
            return <FilterControls node={node} />;
        case 'envelope':
            return <EnvelopeControls node={node} />;
        case 'eq':
            return <EqControls node={node} />;
        case 'autofilter':
            return <AutoFilterControls node={node} />;
        case 'reverse':
            return <ReverseControls node={node} />;
        case 'output':
            return <OutputControls node={node} />;
        case 'midiIn':
            return <MidiInControls node={node} />;
        case 'audioIn':
            return null; // Audio In is a passthrough — no controls needed
        default:
            return null;
    }
}

// ── Single Port Dot ────────────────────────────────────────────
function PortDot({
    port,
    side,
    index,
    nodeId,
    interactionDisabled,
}: {
    port: PortDefinition;
    side: 'in' | 'out';
    index: number;
    nodeId: string;
    interactionDisabled: boolean;
}) {
    const startConnectionDrag = useFlowSynthStore((s) => s.startConnectionDrag);
    const commitConnection = useFlowSynthStore((s) => s.commitConnection);
    const pendingConnection = useFlowSynthStore((s) => s.pendingConnection);
    const updatePendingConnection = useFlowSynthStore((s) => s.updatePendingConnection);

    const cy = portCenterY(index);
    const signalType: 'audio' | 'midi' | 'control' = port.type === 'midi' ? 'midi' : port.type === 'control' ? 'control' : 'audio';
    const isAudio = port.type === 'audio';
    const isMidi = port.type === 'midi';

    const dotColor = isMidi
        ? 'var(--color-signal-midi)'
        : isAudio
            ? 'var(--color-signal-audio)'
            : 'var(--color-accent-tertiary)';

    const handlePointerDown = (e: React.PointerEvent) => {
        if (side !== 'out' || interactionDisabled) return;
        e.stopPropagation();
        e.preventDefault();

        const node = useFlowSynthStore.getState().nodes.find((n) => n.id === nodeId);
        if (!node) return;

        const startX = node.position.x + FLOW_NODE_WIDTH;
        const startY = node.position.y + FLOW_NODE_HEADER_HEIGHT + cy;

        startConnectionDrag({
            fromNode: nodeId,
            fromPort: port.id,
            signalType,
            startX,
            startY,
        });

        const canvas = (e.currentTarget as HTMLElement).closest('.flow-canvas');
        if (canvas) {
            const vp = viewportProxy.getViewport();
            const rect = (canvas as HTMLElement).getBoundingClientRect();
            const worldX = (e.clientX - rect.left - vp.x) / vp.zoom;
            const worldY = (e.clientY - rect.top - vp.y) / vp.zoom;
            updatePendingConnection(worldX, worldY);
        }
    };

    const handlePointerUp = (e: React.PointerEvent) => {
        if (side !== 'in' || !pendingConnection || interactionDisabled) return;
        e.stopPropagation();
        commitConnection(nodeId, port.id, signalType);
    };

    // ENTERPRISE: Port hover state for scale + glow effect (UDS FlowPort pattern)
    const [isHovered, setIsHovered] = React.useState(false);

    return (
        <div
            onPointerDown={handlePointerDown}
            onPointerUp={handlePointerUp}
            onPointerEnter={() => setIsHovered(true)}
            onPointerLeave={() => setIsHovered(false)}
            style={{
                position: 'absolute',
                [side === 'in' ? 'left' : 'right']: -(FLOW_PORT_SIZE / 2),
                top: cy - FLOW_PORT_SIZE / 2,
                width: FLOW_PORT_SIZE,
                height: FLOW_PORT_SIZE,
                borderRadius: '50%',
                backgroundColor: side === 'out' ? dotColor : 'var(--color-bg-elevated)',
                border: `2.5px solid ${dotColor}`,
                cursor: interactionDisabled ? 'default' : 'crosshair',
                boxShadow: isHovered
                    ? `0 0 14px ${dotColor}, 0 0 4px rgba(255,255,255,0.3)`
                    : (side === 'out' ? `0 0 8px ${dotColor}` : '0 0 0 3px var(--color-overlay-dark)'),
                transition: 'transform 0.1s ease-out, box-shadow 0.12s',
                transform: isHovered ? 'scale(1.3)' : 'scale(1)',
                zIndex: 5,
                // Enlarged hit area via padding trick
                padding: 4,
                margin: -4,
            }}
        />
    );
}

// ── Port Label ─────────────────────────────────────────────────
function PortLabel({
    port,
    side,
    index,
}: {
    port: PortDefinition;
    side: 'in' | 'out';
    index: number;
}) {
    const cy = portCenterY(index);
    return (
        <span
            style={{
                position: 'absolute',
                [side === 'in' ? 'left' : 'right']: FLOW_PORT_SIZE + 4,
                top: cy - 7,
                fontSize: 'var(--font-size-2xs)',
                fontFamily: 'var(--font-role-data)',
                fontWeight: 'var(--font-weight-semibold)',
                color: 'var(--color-text-tertiary)',
                textTransform: 'uppercase',
                letterSpacing: '0.06em',
                lineHeight: '14px',
                pointerEvents: 'none',
                userSelect: 'none',
                whiteSpace: 'nowrap',
            }}
        >
            {port.label}
        </span>
    );
}

// ── Main SynthNodeComponent ────────────────────────────────────
export function SynthNodeComponent({ node, interactionDisabled = false }: Props) {
    const updateNodePosition = useFlowSynthStore((s) => s.updateNodePosition);
    const selectNode = useFlowSynthStore((s) => s.selectNode);
    const selectedNodeIds = useFlowSynthStore((s) => s.selectedNodeIds);
    const isSelected = selectedNodeIds.includes(node.id);

    const config = PORT_REGISTRY[node.type as SynthNodeType];
    if (!config) return null;

    const maxPorts = Math.max(config.inputs.length, config.outputs.length, 1);
    const portsHeight = maxPorts * FLOW_PORT_ROW_HEIGHT;

    const handlePointerDown = (e: React.PointerEvent) => {
        if (e.button !== 0 || interactionDisabled) return;
        e.stopPropagation();
        const handle = e.currentTarget as HTMLElement;
        handle.setPointerCapture?.(e.pointerId);
        handle.style.cursor = 'grabbing';

        const startX = e.clientX;
        const startY = e.clientY;
        const startNodeX = node.position.x;
        const startNodeY = node.position.y;
        const zoom = viewportProxy.getViewport().zoom;
        let raf = 0;
        let pendingX = startNodeX;
        let pendingY = startNodeY;

        const onMove = (me: PointerEvent) => {
            const dx = (me.clientX - startX) / zoom;
            const dy = (me.clientY - startY) / zoom;
            pendingX = startNodeX + dx;
            pendingY = startNodeY + dy;
            if (raf !== 0) return;
            raf = requestAnimationFrame(() => {
                raf = 0;
                updateNodePosition(node.id, pendingX, pendingY);
            });
        };

        const onUp = () => {
            document.removeEventListener('pointermove', onMove);
            document.removeEventListener('pointerup', onUp);
            document.removeEventListener('pointercancel', onUp);
            handle.removeEventListener('lostpointercapture', onUp);
            handle.style.cursor = 'grab';
            if (raf !== 0) {
                cancelAnimationFrame(raf);
                raf = 0;
            }
            const snapX = Math.round(pendingX / FLOW_GRID_SNAP) * FLOW_GRID_SNAP;
            const snapY = Math.round(pendingY / FLOW_GRID_SNAP) * FLOW_GRID_SNAP;
            updateNodePosition(node.id, snapX, snapY);
        };

        document.addEventListener('pointermove', onMove);
        document.addEventListener('pointerup', onUp);
        document.addEventListener('pointercancel', onUp);
        handle.addEventListener('lostpointercapture', onUp);
    };

    return (
        <div
            data-flow-node-root="true"
            onMouseDown={(e) => {
                if (interactionDisabled) return;
                e.stopPropagation();
                selectNode(node.id, e.metaKey || e.ctrlKey || e.shiftKey);
            }}
            style={{
                position: 'absolute',
                left: node.position.x,
                top: node.position.y,
                width: FLOW_NODE_WIDTH,
                background: 'color-mix(in srgb, var(--color-bg-panel) 92%, transparent)',
                backdropFilter: 'blur(var(--blur-lg))',
                WebkitBackdropFilter: 'blur(var(--blur-lg))',
                borderRadius: 'var(--radius-xl)',
                // ENTERPRISE: Base border always subtle — selection handled via ::after overlay
                border: '1px solid color-mix(in srgb, var(--color-text-primary) 12%, transparent)',
                boxShadow: '0 2px 8px rgba(0,0,0,0.18)',
                pointerEvents: interactionDisabled ? 'none' : 'auto',
                display: 'flex',
                flexDirection: 'column',
                // ENTERPRISE: No transition — prevents drag jitter (UDS pattern)
                zIndex: isSelected ? 50 : 10,
                overflow: 'visible',
            }}
        >
            {/* ── SELECTION OVERLAY (UDS ::after pattern) ── */}
            {isSelected && (
                <div
                    style={{
                        position: 'absolute',
                        inset: -2,
                        borderRadius: 'calc(var(--radius-xl) + 1px)',
                        border: '2px solid rgba(255, 255, 255, 0.85)',
                        pointerEvents: 'none',
                        zIndex: 100,
                        boxShadow: '0 0 0 1px color-mix(in srgb, var(--color-accent-primary) 50%, transparent)',
                    }}
                />
            )}

            {/* ── HEADER ── */}
            <div
                onPointerDown={handlePointerDown}
                style={{
                    padding: '0 14px',
                    cursor: interactionDisabled ? 'default' : 'grab',
                    touchAction: 'none',
                    display: 'flex',
                    alignItems: 'center',
                    gap: 'var(--space-2)',
                    borderBottom: '1px solid var(--color-divider)',
                    background: 'linear-gradient(180deg, color-mix(in srgb, var(--color-text-primary) 5%, transparent), transparent)',
                    borderTopLeftRadius: 'var(--radius-xl)',
                    borderTopRightRadius: 'var(--radius-xl)',
                    height: FLOW_NODE_HEADER_HEIGHT,
                    boxSizing: 'border-box',
                    flexShrink: 0,
                }}
            >
                <div style={{
                    width: 8, height: 8, borderRadius: '50%',
                    backgroundColor: config.color,
                    boxShadow: `0 0 8px ${config.color}`,
                    flexShrink: 0,
                }} />
                <span style={{
                    fontWeight: 'var(--font-weight-bold)',
                    fontSize: 'var(--font-size-sm)',
                    color: 'var(--color-text-primary)',
                    textTransform: 'uppercase',
                    letterSpacing: '0.08em',
                    fontFamily: 'var(--font-role-data)',
                    userSelect: 'none',
                }}>
                    {config.title}
                </span>
            </div>

            {/* ── PORTS ZONE ── */}
            <div style={{
                position: 'relative',
                height: portsHeight,
                flexShrink: 0,
            }}>
                {/* Input ports (left) */}
                {config.inputs.map((port, idx) => (
                    <React.Fragment key={`in-${port.id}`}>
                        <PortDot port={port} side="in" index={idx} nodeId={node.id} interactionDisabled={interactionDisabled} />
                        <PortLabel port={port} side="in" index={idx} />
                    </React.Fragment>
                ))}
                {/* Output ports (right) */}
                {config.outputs.map((port, idx) => (
                    <React.Fragment key={`out-${port.id}`}>
                        <PortDot port={port} side="out" index={idx} nodeId={node.id} interactionDisabled={interactionDisabled} />
                        <PortLabel port={port} side="out" index={idx} />
                    </React.Fragment>
                ))}
            </div>

            {/* ── CONTROLS ── */}
            <NodeControlsBody node={node} />

            {/* ── FOOTER PAD ── */}
            <div style={{ height: FLOW_NODE_BODY_PADDING }} />
        </div>
    );
}
