import React from 'react';
import { useFlowSynthStore } from '../model/useFlowSynthStore';
import type { SynthNode } from '../model/useFlowSynthStore';
import {
    PORT_REGISTRY,
    FLOW_PORT_ROW_HEIGHT,
    FLOW_NODE_HEADER_HEIGHT,
    FLOW_NODE_BODY_PADDING,
    portCenterY,
    type PortDefinition,
    type SynthNodeType,
} from '../model/portRegistry';
import { viewportProxy } from '../lib/ViewportProxy';
import {
    FLOW_PORT_DOT_SIZE,
    signalColor,
    nodeShellStyle,
    selectionOverlayStyle,
    nodeHeaderStyle,
    nodeTypeDotStyle,
    nodeTitleStyle,
    portLabelStyle,
} from './FlowNodeStyles';
import { OscillatorControls } from './nodes/OscillatorControls';
import { FilterControls } from './nodes/FilterControls';
import { EnvelopeControls } from './nodes/EnvelopeControls';
import { EqControls } from './nodes/EqControls';
import { AutoFilterControls } from './nodes/AutoFilterControls';
import { ReverseControls } from './nodes/ReverseControls';
import { OutputControls } from './nodes/OutputControls';
import { MidiInControls } from './nodes/MidiInControls';
import { nodeMotionProxy } from '../lib/NodeMotionProxy';
import { LfoControls } from './nodes/LfoControls';
import { NoiseControls } from './nodes/NoiseControls';
import { UtilityControls } from './nodes/UtilityControls';
import { DelayControls } from './nodes/DelayControls';
import { DistortionControls } from './nodes/DistortionControls';
import { Vst3Controls } from './nodes/Vst3Controls';

import { PortRowFader } from './nodes/PortRowFader';

export const FLOW_NODE_WIDTH = 260;
const FLOW_GRID_SNAP = 20;

interface Props {
    node: SynthNode;
    interactionDisabled?: boolean;
}

// ── Per-type controls renderer ─────────────────────────────────
// Only renders non-port controls (dropdowns, visualizers).
// Slider parameters are now inline port faders in the port row zone.
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
        case 'lfo':
            return <LfoControls node={node} />;
        case 'noise':
            return <NoiseControls node={node} />;
        case 'delay':
            return <DelayControls node={node} />;
        case 'mixer':
        case 'vca':
        case 'multiply':
            return null;
        case 'utility':
            return <UtilityControls node={node} />;
        case 'distortion':
            return <DistortionControls node={node} />;
        case 'vst3':
            return <Vst3Controls node={node} />;
        // Stateless nodes with no additional controls:
        case 'add':
        case 'sampleHold':
        case 'audioIn':
        case 'pitch':
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
    // Optimized subscription: only re-render when drag state or type changes, not on every X/Y move
    const isDragging = useFlowSynthStore((s) => s.pendingConnection !== null);
    const dragType = useFlowSynthStore((s) => s.pendingConnection?.signalType);


    const cy = portCenterY(index);
    // ENTERPRISE: Pass actual port type as signalType — enables per-type cable colors (Bitwig Grid pattern)
    const signalType = port.type as 'audio' | 'midi' | 'control' | 'gate' | 'phase';

    const dotColor = signalColor(port.type);

    const dotSize = FLOW_PORT_DOT_SIZE;

    const handlePointerDown = (e: React.PointerEvent) => {
        if (side !== 'out' || interactionDisabled) return;
        e.stopPropagation();
        e.preventDefault();

        const node = useFlowSynthStore.getState().nodes.find((n) => n.id === nodeId);
        if (!node) return;
        const px = node?.position?.x ?? 0;
        const py = node?.position?.y ?? 0;

        const startX = px + FLOW_NODE_WIDTH;
        const startY = py + FLOW_NODE_HEADER_HEIGHT + cy;

        startConnectionDrag({
            fromNode: nodeId,
            fromPort: port.id,
            signalType,
            startX,
            startY,
        });
    };

    const handlePointerUp = (e: React.PointerEvent) => {
        if (side !== 'in' || !isDragging || interactionDisabled) return;
        e.stopPropagation();
        commitConnection(nodeId, port.id, signalType);
    };

    // ENTERPRISE: Port hover state for scale + glow effect (UDS FlowPort pattern)
    const [isHovered, setIsHovered] = React.useState(false);

    // ENTERPRISE FIX: Strict port matching. No exceptions.
    const isCompatibleTarget = isDragging && side === 'in' && dragType === signalType;
    const showTargetGlow = isCompatibleTarget && !isHovered;



    // ENTERPRISE: Filled circle = output (produces signal), outlined = input (receives signal)
    // Matches Bitwig Grid convention for intuitive I/O distinction.
    const isFilled = true;

    return (
        <div
            onPointerDown={handlePointerDown}
            onPointerUp={handlePointerUp}
            onPointerEnter={() => setIsHovered(true)}
            onPointerLeave={() => setIsHovered(false)}
            style={{
                position: 'absolute',
                [side === 'in' ? 'left' : 'right']: -(dotSize / 2),
                top: cy - dotSize / 2,
                width: dotSize,
                height: dotSize,
                borderRadius: '50%',
                transform: isHovered
                    ? 'scale(1.35)'
                    : showTargetGlow
                        ? 'scale(1.15)'
                        : 'none',
                backgroundColor: isFilled ? dotColor : 'transparent',
                border: `2px solid ${dotColor}`,
                cursor: interactionDisabled ? 'default' : 'crosshair',
                boxShadow: isHovered
                    ? `0 0 14px ${dotColor}, 0 0 4px rgba(255,255,255,0.4)`
                    : showTargetGlow
                        ? `0 0 10px ${dotColor}`
                        : `0 0 5px ${dotColor}`,
                transition: 'transform var(--transition-fast) cubic-bezier(0.34, 1.56, 0.64, 1), box-shadow var(--transition-fast)',
                zIndex: isHovered ? 10 : 5,
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
    // Skip label for input ports that have inline faders (fader occupies that space)
    if (side === 'in' && port.fader) return null;
    const cy = portCenterY(index);
    return (
        <span
            style={{
                ...portLabelStyle,
                [side === 'in' ? 'left' : 'right']: FLOW_PORT_DOT_SIZE / 2 + 6,
                top: cy - 7,
            }}
        >
            {port.label}
        </span>
    );
}

// ── Inline Port Fader ──────────────────────────────────────────
function InlinePortFader({
    port,
    index,
    node,
}: {
    port: PortDefinition;
    index: number;
    node: SynthNode;
}) {
    const updateNodeData = useFlowSynthStore((s) => s.updateNodeData);
    if (!port.fader) return null;

    const fader = port.fader;
    const value = Number(node.data?.[fader.dataKey] ?? fader.default ?? fader.min);
    const cy = portCenterY(index);

    return (
        <div
            style={{
                position: 'absolute',
                left: FLOW_PORT_DOT_SIZE / 2 + 10,
                right: FLOW_PORT_DOT_SIZE / 2 + 10,
                top: cy - 10,
                height: 20,
                display: 'flex',
                alignItems: 'center',
            }}
        >
            <span style={{
                ...portLabelStyle,
                position: 'static',
                fontSize: 'var(--font-size-2xs)',
                marginRight: 4,
                flexShrink: 0,
                minWidth: 22,
            }}>
                {port.label}
            </span>
            <PortRowFader
                nodeId={node.id}
                portId={fader.dataKey}
                value={value}
                config={fader}
                onChange={(v) => updateNodeData(node.id, { [fader.dataKey]: v })}
            />
        </div>
    );
}

export const SynthNodeComponent = React.memo(function SynthNodeComponentBase({ node, interactionDisabled = false }: Props) {
    const updateNodePosition = useFlowSynthStore((s) => s.updateNodePosition);
    const selectNode = useFlowSynthStore((s) => s.selectNode);
    // ENTERPRISE FIX: Direct boolean selector prevents O(N) re-renders across all nodes when selection changes
    const isSelected = useFlowSynthStore((s) => s.selectedNodeIds.includes(node.id));
    const nodeRef = React.useRef<HTMLDivElement>(null);

    // ENTERPRISE: Sync proxy to React prop on mount/change, allowing proxy to take over during drag 
    React.useLayoutEffect(() => {
        const px = node.position?.x ?? 0;
        const py = node.position?.y ?? 0;
        nodeMotionProxy.syncInitial(node.id, px, py);
        if (nodeRef.current) {
            nodeRef.current.style.transform = `translate(${px}px, ${py}px)`;
        }
    }, [node.position?.x, node.position?.y, node.id]);

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
        const startNodeX = node.position?.x ?? 0;
        const startNodeY = node.position?.y ?? 0;
        const zoom = viewportProxy.getViewport().zoom;
        let raf = 0;
        let pendingX = startNodeX;
        let pendingY = startNodeY;

        const onMove = (me: PointerEvent) => {
            const dx = (me.clientX - startX) / zoom;
            const dy = (me.clientY - startY) / zoom;
            pendingX = startNodeX + dx;
            pendingY = startNodeY + dy;

            // 11.2: Zero-React Updates
            nodeMotionProxy.publish(node.id, pendingX, pendingY);
            if (raf !== 0) return;
            raf = requestAnimationFrame(() => {
                raf = 0;
                if (nodeRef.current) {
                    nodeRef.current.style.transform = `translate(${pendingX}px, ${pendingY}px)`;
                }
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
            ref={nodeRef}
            data-flow-node-root="true"
            onMouseDown={(e) => {
                if (interactionDisabled) return;
                e.stopPropagation();
                selectNode(node.id, e.metaKey || e.ctrlKey || e.shiftKey);
            }}
            style={{
                ...nodeShellStyle,
                width: FLOW_NODE_WIDTH,
                pointerEvents: interactionDisabled ? 'none' : 'auto',
                zIndex: isSelected ? 50 : 10,
            }}
        >
            {/* ── SELECTION OVERLAY (UDS ::after pattern) ── */}
            {isSelected && <div style={selectionOverlayStyle} />}

            {/* ── HEADER ── */}
            <div
                onPointerDown={handlePointerDown}
                style={{
                    ...nodeHeaderStyle,
                    cursor: interactionDisabled ? 'default' : 'grab',
                    height: FLOW_NODE_HEADER_HEIGHT,
                }}
            >
                <div style={{
                    ...nodeTypeDotStyle,
                    backgroundColor: config.color,
                    boxShadow: `0 0 8px ${config.color}`,
                }} />
                <span style={nodeTitleStyle}>
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
                        <InlinePortFader port={port} index={idx} node={node} />
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
        </div >
    );
});
